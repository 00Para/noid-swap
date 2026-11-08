"use strict";
/*
 * HTLCPoseidonV2: unit tests. The lock addresses used here come from the VENDOR vectors file
 * (test/vectors/addr-vectors.bin, made by equiv-ref), so every claim that succeeds proves that the
 * contract pays out exactly when `lockAddr` is the address the Parano1d node computes for the secret.
 * The random-sequence campaign against this contract (and its planted-bug mutants) is in fuzz.test.js.
 *
 * Memory: every claim that reaches the permutation costs the Hardhat runtime ~30-45 MB until the
 * provider is recreated, so the chain is recycled between tests (test/helpers/chain-budget.js).
 * This file never skips and never shrinks: a machine that cannot run it fails with a message.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createChainBudget } = require("./helpers/chain-budget.js");

const HOUR = 3600;
const VEC = fs.readFileSync(path.resolve(__dirname, "vectors/addr-vectors.bin"));
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const vec = (i) => ({ secret: hex(VEC.subarray(i * 64, i * 64 + 32)), addr: hex(VEC.subarray(i * 64 + 32, i * 64 + 64)) });
const V_ZERO = vec(0); // all-zero secret (cheapest calldata)
const V_ONES = vec(1); // all-0xff secret (dearest calldata)
const V_PUBLISHED = vec(2); // 00 01 .. 1f -> o1lqvrmv...9xw2
const V_OTHER = vec(5000);

/** Pinned runtime code hash of the production contract (docs/poseidon-leg.md). Any edit to the contract, to
 *  Poseidon2b.sol or to a compiler setting changes it; update it here, in the doc and in the swap tool together. */
const PINNED_CODE_HASH = "0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3";

const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const increaseTime = async (s) => {
  await ethers.provider.send("evm_increaseTime", [s]);
  await ethers.provider.send("evm_mine", []);
};
const setNextTimestamp = (t) => ethers.provider.send("evm_setNextBlockTimestamp", [t]);

describe("HTLCPoseidonV2 (ETH locked on a Parano1d address)", function () {
  this.timeout(900000);
  const amount = ethers.parseEther("1");
  let htlc = null;
  let alice, bob, carol;
  let factory;
  const gas = { claims: [], notes: {} };

  const chain = createChainBudget(ethers, {
    what: "HTLCPoseidonV2 tests",
    onRecycle: () => {
      htlc = null;
    },
    probe: async (n) => {
      const H = await (await ethers.getContractFactory("Poseidon2bHarness")).deploy();
      for (let i = 0; i < n; i++) await H.addr(V_PUBLISHED.secret);
    },
  });
  /** The contract on the current chain, with room for `perms` permutation-sized calls (it may redeploy after a recycle). */
  async function need(perms) {
    await chain.budget(perms);
    if (!htlc) {
      [alice, bob, carol] = await ethers.getSigners();
      htlc = await factory.deploy();
    }
    return htlc;
  }
  async function newLock(lockAddr, receiver, { value = amount, delta = 2 * HOUR, from = alice } = {}) {
    const timelock = (await now()) + delta;
    const rcv = receiver || bob.address;
    await htlc.connect(from).newLock(lockAddr, timelock, rcv, { value });
    const lockId = await htlc.computeLockId(from.address, rcv, value, lockAddr, timelock);
    return { lockId, timelock, receiver: rcv, value };
  }
  const errOf = (e) => {
    if (e && e.data !== undefined && e.data !== "0x") {
      try {
        const x = htlc.interface.parseError(e.data);
        if (x) return x.name;
      } catch (_) {
        /* fall through */
      }
      return "UNKNOWN:" + String(e.data).slice(0, 10);
    }
    if (e && /out of gas/i.test(String(e.message))) return "OOG";
    if (e && e.data === "0x") return "EMPTY";
    throw e;
  };
  /** Send claim with an explicit gas limit; never throws on a revert. */
  async function tryClaim(lockId, secret, gasLimit, from = carol) {
    try {
      const tx = await htlc.connect(from).claim(lockId, secret, { gasLimit });
      const rc = await tx.wait();
      return { ok: true, gasUsed: Number(rc.gasUsed) };
    } catch (e) {
      return { ok: false, err: errOf(e) };
    }
  }

  before(async () => {
    factory = await ethers.getContractFactory("HTLCPoseidonV2");
    [alice, bob, carol] = await ethers.getSigners();
    await chain.calibrate();
    await chain.recycle(); // start on a clean chain
  });

  describe("interface and bytecode", () => {
    it("exposes exactly the HTLC.sol functions plus two gas constants, and no function that computes Addr", async () => {
      await need(0);
      const names = htlc.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
      expect(names).to.deep.equal(["MIN_CLAIM_GAS", "RECOMMENDED_CLAIM_GAS_LIMIT", "claim", "computeLockId", "getLock", "newLock", "refund"]);
      const code = await ethers.provider.getCode(await htlc.getAddress());
      for (const sig of ["addrOf(bytes32)", "addr(bytes32)", "derive(bytes32,uint32)", "addrStock(bytes32)", "permute(uint256[4])"]) {
        const sel = ethers.id(sig).slice(2, 10);
        expect(code.includes(sel), `selector of ${sig} must not be in the deployed code`).to.equal(false);
      }
    });

    it("error set = HTLC.sol's plus BadCalldataLength and InsufficientGas; events equal HTLC.sol's", async () => {
      await need(0);
      const errs = htlc.interface.fragments.filter((f) => f.type === "error").map((f) => f.name).sort();
      const old = (await ethers.getContractFactory("HTLC")).interface.fragments.filter((f) => f.type === "error").map((f) => f.name);
      expect(errs).to.deep.equal([...old, "BadCalldataLength", "InsufficientGas"].sort());
      const evs = htlc.interface.fragments.filter((f) => f.type === "event").map((f) => f.format("sighash")).sort();
      expect(evs).to.deep.equal(["Locked(bytes32,address,address,uint256,bytes32,uint256)", "Claimed(bytes32,bytes32)", "Refunded(bytes32)"].sort());
    });

    it("code size is within the 24,576-byte limit and the runtime code hash matches the pin", async () => {
      await need(0);
      const code = await ethers.provider.getCode(await htlc.getAddress());
      const size = (code.length - 2) / 2;
      const hash = ethers.keccak256(code);
      const dep = await htlc.deploymentTransaction().wait();
      console.log(`        HTLCPoseidonV2 deployed size ${size} bytes, deployment gas ${dep.gasUsed}, runtime code hash ${hash}`);
      expect(size).to.be.lessThan(24576);
      expect(hash, "runtime code hash changed: update PINNED_CODE_HASH here, docs/poseidon-leg.md and the swap tool pin together").to.equal(PINNED_CODE_HASH);
    });
  });

  describe("newLock", () => {
    it("stores every term, emits Locked with lockAddr and all terms, and the lock id is deterministic", async () => {
      await need(0);
      const timelock = (await now()) + 2 * HOUR;
      const tx = await htlc.connect(alice).newLock(V_PUBLISHED.addr, timelock, bob.address, { value: amount });
      const lockId = await htlc.computeLockId(alice.address, bob.address, amount, V_PUBLISHED.addr, timelock);
      expect(lockId).to.equal(
        ethers.solidityPackedKeccak256(["address", "address", "uint256", "bytes32", "uint256"], [alice.address, bob.address, amount, V_PUBLISHED.addr, timelock])
      );
      await expect(tx).to.emit(htlc, "Locked").withArgs(lockId, alice.address, bob.address, amount, V_PUBLISHED.addr, timelock);
      const l = await htlc.getLock(lockId);
      expect(l.sender).to.equal(alice.address);
      expect(l.receiver).to.equal(bob.address);
      expect(l.amount).to.equal(amount);
      expect(l.lockAddr).to.equal(V_PUBLISHED.addr);
      expect(l.timelock).to.equal(timelock);
      expect(l.claimed).to.equal(false);
      expect(l.refunded).to.equal(false);
      expect(l.preimage).to.equal(ethers.ZeroHash);
      await expect(htlc.connect(alice).newLock(V_PUBLISHED.addr, timelock, bob.address, { value: amount })).to.be.revertedWithCustomError(htlc, "LockAlreadyExists");
      await expect(htlc.newLock(V_PUBLISHED.addr, timelock + 5, bob.address, { value: 0 })).to.be.revertedWithCustomError(htlc, "ZeroAmount");
      await expect(htlc.newLock(V_PUBLISHED.addr, timelock + 5, ethers.ZeroAddress, { value: 1 })).to.be.revertedWithCustomError(htlc, "ZeroReceiver");
      await expect(htlc.newLock(V_PUBLISHED.addr, 0, bob.address, { value: 1 })).to.be.revertedWithCustomError(htlc, "TimelockNotInFuture");
      await expect(htlc.newLock(V_PUBLISHED.addr, await now(), bob.address, { value: 1 })).to.be.revertedWithCustomError(htlc, "TimelockNotInFuture");
      await expect(htlc.getLock(ethers.ZeroHash)).to.be.revertedWithCustomError(htlc, "LockNotFound");
    });

    it("plain ETH sends to the contract revert (no receive or fallback)", async () => {
      await need(0);
      await expect(alice.sendTransaction({ to: await htlc.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("claim", () => {
    it("pays the fixed receiver when a third party submits the vendor-vector secret; stores and emits it", async () => {
      await need(1);
      const { lockId } = await newLock(V_PUBLISHED.addr);
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await htlc.connect(carol).claim(lockId, V_PUBLISHED.secret, { gasLimit: 650000 });
      const rc = await tx.wait();
      gas.claims.push(Number(rc.gasUsed));
      await expect(tx).to.emit(htlc, "Claimed").withArgs(lockId, V_PUBLISHED.secret);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(before + amount);
      const l = await htlc.getLock(lockId);
      expect(l.claimed).to.equal(true);
      expect(l.preimage).to.equal(V_PUBLISHED.secret);
    });

    it("wrong secret, SHA-256 digest as lock, unknown lock, double claim revert; a failed claim changes nothing", async () => {
      await need(4);
      const sha = "0x" + crypto.createHash("sha256").update(Buffer.from(V_OTHER.secret.slice(2), "hex")).digest("hex");
      const a = await newLock(V_OTHER.addr);
      const b = await newLock(sha);
      await expect(htlc.connect(bob).claim(a.lockId, V_ONES.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
      await expect(htlc.connect(bob).claim(b.lockId, V_OTHER.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
      await expect(htlc.claim(ethers.id("nope"), V_OTHER.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "LockNotFound");
      expect((await htlc.getLock(a.lockId)).claimed).to.equal(false);
      await htlc.connect(bob).claim(a.lockId, V_OTHER.secret, { gasLimit: 650000 });
      await expect(htlc.connect(bob).claim(a.lockId, V_OTHER.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
    });

    it("timelock: claim works at timelock-1 and reverts TimelockExpired at timelock, even with a wrong secret (checked before the permutation)", async () => {
      await need(2);
      const a = await newLock(V_ZERO.addr);
      await setNextTimestamp(a.timelock - 1);
      await htlc.connect(bob).claim(a.lockId, V_ZERO.secret, { gasLimit: 650000 });
      const b = await newLock(V_ONES.addr, undefined, { delta: HOUR });
      await setNextTimestamp(b.timelock);
      await expect(htlc.connect(bob).claim(b.lockId, V_ZERO.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "TimelockExpired");
      // the expired claim is cheap: it must also succeed in failing with a gas limit far below the permutation's cost
      const c = await newLock(V_ONES.addr, undefined, { delta: HOUR });
      await setNextTimestamp(c.timelock);
      const r = await tryClaim(c.lockId, V_ONES.secret, 80000);
      expect(r).to.deep.equal({ ok: false, err: "TimelockExpired" });
    });

    it("the secret is exactly 32 bytes: any trailing byte is rejected (BadCalldataLength), a short secret fails in the ABI decoder", async () => {
      await need(1);
      const a = await newLock(V_PUBLISHED.addr);
      const sel = htlc.interface.getFunction("claim").selector;
      const to = await htlc.getAddress();
      const send = async (data) => {
        try {
          const tx = await carol.sendTransaction({ to, data, gasLimit: 650000 });
          await tx.wait();
          return "ok";
        } catch (e) {
          return errOf(e);
        }
      };
      const good = sel + a.lockId.slice(2) + V_PUBLISHED.secret.slice(2);
      expect(await send(good + "00")).to.equal("BadCalldataLength");
      expect(await send(good + "00".repeat(32))).to.equal("BadCalldataLength");
      expect(await send(sel + a.lockId.slice(2) + "00" + V_PUBLISHED.secret.slice(2))).to.equal("BadCalldataLength");
      expect(await send(good.slice(0, -2))).to.equal("EMPTY"); // 31-byte secret
      expect(await send(sel + a.lockId.slice(2))).to.equal("EMPTY"); // no secret
      expect((await htlc.getLock(a.lockId)).claimed).to.equal(false);
      expect(await send(good)).to.equal("ok");
      expect((await htlc.getLock(a.lockId)).claimed).to.equal(true);
    });

    it("InsufficientGas: below the floor the claim reverts early and changes nothing; the lock stays claimable", async () => {
      await need(1);
      const floor = Number(await htlc.MIN_CLAIM_GAS());
      const a = await newLock(V_PUBLISHED.addr);
      const r = await tryClaim(a.lockId, V_PUBLISHED.secret, floor - 60000);
      expect(r).to.deep.equal({ ok: false, err: "InsufficientGas" });
      expect((await htlc.getLock(a.lockId)).claimed).to.equal(false);
      expect((await tryClaim(a.lockId, V_PUBLISHED.secret, 650000)).ok).to.equal(true);
    });

    it("gas: the floor is exact (the lowest gas limit that passes the check is the lowest that succeeds), for a receiver account that does not exist yet", async () => {
      // worst case for the payout: the receiver is a fresh address (25,000 gas new-account surcharge)
      const floor = Number(await (await need(0)).MIN_CLAIM_GAS());
      const recommended = Number(await htlc.RECOMMENDED_CLAIM_GAS_LIMIT());
      let n = 0;
      const attempt = async (limit, secret = V_ONES) => {
        await need(1);
        const receiver = ethers.Wallet.createRandom().address; // never funded
        const a = await newLock(secret.addr, receiver, { value: 1000n + BigInt(n++) });
        return tryClaim(a.lockId, secret.secret, limit);
      };
      expect((await attempt(recommended)).ok, "recommended gas limit must succeed").to.equal(true);
      let lo = floor - 100000; // fails with InsufficientGas
      let hi = recommended; // succeeds
      expect((await attempt(lo)).err).to.equal("InsufficientGas");
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const r = await attempt(mid);
        if (r.ok) hi = mid;
        else {
          expect(r.err, `limit ${mid} fails: it must fail with InsufficientGas, never run out of gas after the check`).to.equal("InsufficientGas");
          lo = mid;
        }
      }
      gas.notes.minLimit = hi;
      // gas used by a successful claim to a fresh address with the dearest calldata = the worst honest case
      const worst = await attempt(recommended, V_ONES);
      gas.claims.push(worst.gasUsed);
      console.log(`        lowest gas limit that succeeds (fresh receiver, 0xff secret): ${hi}; floor ${floor}; recommended ${recommended}; claim gasUsed ${worst.gasUsed}`);
      expect(hi).to.be.lessThan(recommended - 20000);
      expect(worst.gasUsed).to.be.lessThan(floor + 40000);
    });

    it("gas report: cheapest and dearest honest claim (zero secret to a funded EOA, 0xff secret to a never-funded address)", async () => {
      await need(2);
      const cheap = await newLock(V_ZERO.addr, bob.address, { value: 7n });
      const rc1 = await (await htlc.connect(carol).claim(cheap.lockId, V_ZERO.secret, { gasLimit: 650000 })).wait();
      const fresh = ethers.Wallet.createRandom().address;
      const dear = await newLock(V_ONES.addr, fresh, { value: 7n });
      const rc2 = await (await htlc.connect(carol).claim(dear.lockId, V_ONES.secret, { gasLimit: 650000 })).wait();
      gas.min = Number(rc1.gasUsed);
      gas.max = Number(rc2.gasUsed);
      gas.claims.push(gas.min, gas.max);
      expect(gas.min).to.be.lessThan(gas.max);
      expect(gas.max).to.be.lessThan(Number(await htlc.RECOMMENDED_CLAIM_GAS_LIMIT()));
    });

    it("receiver that rejects ETH: claim reverts (with the secret in its calldata), funds stay, the sender refunds after the timelock", async () => {
      await need(1);
      const rejecter = await (await ethers.getContractFactory("RejectEther")).deploy();
      const rAddr = await rejecter.getAddress();
      const a = await newLock(V_PUBLISHED.addr, rAddr, { delta: HOUR });
      await expect(htlc.connect(bob).claim(a.lockId, V_PUBLISHED.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "TransferFailed");
      expect((await htlc.getLock(a.lockId)).claimed).to.equal(false);
      await increaseTime(HOUR + 1);
      await expect(htlc.connect(alice).refund(a.lockId)).to.changeEtherBalances([htlc, alice], [-amount, amount]);
    });
  });

  describe("refund", () => {
    it("only the sender, only at or after the timelock, never after a claim, never twice", async () => {
      await need(1);
      const a = await newLock(V_OTHER.addr);
      await expect(htlc.connect(alice).refund(a.lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
      await setNextTimestamp(a.timelock - 1);
      await expect(htlc.connect(alice).refund(a.lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
      await setNextTimestamp(a.timelock);
      await expect(htlc.connect(bob).refund(a.lockId)).to.be.revertedWithCustomError(htlc, "NotSender");
      const tx = htlc.connect(alice).refund(a.lockId);
      await expect(tx).to.emit(htlc, "Refunded").withArgs(a.lockId);
      await expect(tx).to.changeEtherBalances([htlc, alice], [-amount, amount]);
      await expect(htlc.connect(alice).refund(a.lockId)).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
      await expect(htlc.connect(bob).claim(a.lockId, V_OTHER.secret, { gasLimit: 650000 })).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
      await expect(htlc.connect(alice).refund(ethers.id("none"))).to.be.revertedWithCustomError(htlc, "LockNotFound");
    });

    it("refund after claim reverts AlreadyClaimed", async () => {
      await need(1);
      const a = await newLock(V_OTHER.addr);
      await htlc.connect(bob).claim(a.lockId, V_OTHER.secret, { gasLimit: 650000 });
      await increaseTime(2 * HOUR + 1);
      await expect(htlc.connect(alice).refund(a.lockId)).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
    });
  });

  after(async () => {
    await chain.recycle(); // release the runtime's retained traces for the files that run after this one
    const eth = 3000;
    const usd = (g, gwei) => (g * gwei * 1e-9 * eth).toFixed(2);
    if (gas.min !== undefined) {
      console.log("\n      HTLCPoseidonV2 claim gas (receipt gasUsed)");
      console.log(`        cheapest honest claim (0x00 secret, funded EOA):           ${gas.min}`);
      console.log(`        dearest honest claim (0xff secret, never-funded receiver): ${gas.max}`);
      console.log(`        lowest gas limit that succeeds (dearest case):             ${gas.notes.minLimit}`);
      for (const g of [1, 5, 10]) console.log(`        at ${String(g).padStart(2)} gwei, ETH = ${eth} USD: ${usd(gas.min, g)} - ${usd(gas.max, g)} USD`);
    }
    console.log(`        chain recycled ${chain.mem.recycles}x in chunks of ${chain.mem.chunk} (~${Math.round(chain.mem.perPerm)} MB retained per call)\n`);
  });
});
