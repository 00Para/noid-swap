"use strict";
/*
 * Tests for live.js `claim --replace` at nonce 0 on Alice's fresh per-swap Ethereum key
 * without a held intent and without identifying the old pending transaction.
 * Verifies:
 *   - accepted when ALL conditions hold (program mode --key-stdin, fresh swap key, latest 0,
 *     pending 1, swap file accounts for no other send, explicit fee cap);
 *   - bids at the fee cap with the asked tip, max(given tip, min(cap, 1 gwei)), raised by 12.5 % and never above the cap;
 *   - without a fee cap on a test network the node prices it, as for a claim without a cap;
 *   - late cutoff T_reveal - DE applies past M_A;
 *   - under-priced replacement refusal reports "under-priced ... tip";
 *   - refused whenever ANY condition is missing;
 *   - existing R5-2 rule stays unchanged in every other case (non-fresh key, refund --replace).
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("./helpers/isolated-home");
const { live } = require("./helpers/live-module");

const HOUR = 3600;
const GWEI = 10n ** 9n;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

describe("live.js claim --replace at nonce 0 on fresh per-swap key", function () {
  this.timeout(120000);

  let provider, funder, htlcAddr, codeHash, tmpRoot, nFile = 0;
  const amount = ethers.parseEther("0.15");

  before(async function () {
    provider = hre.ethers.provider;
    [funder] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("HTLC");
    const htlc = await Factory.deploy();
    await htlc.waitForDeployment();
    htlcAddr = await htlc.getAddress();
    codeHash = live.artifactCodeHash("sha256");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-claim-nonce0-"));
  });

  after(async function () {
    // Ensure automine is restored even if a test fails.
    try {
      await provider.send("evm_setAutomine", [true]);
    } catch {
      /* ignore */
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function setupLock({ ttl = HOUR } = {}) {
    const bobKey = rand32();
    const aliceKey = rand32();
    const bob = new ethers.Wallet(bobKey, provider);
    const alice = new ethers.Wallet(aliceKey, provider);
    const payout = new ethers.Wallet(rand32()).address;
    const secret = rand32();
    const hashlock = sha256Raw(secret);

    await (await funder.sendTransaction({ to: bob.address, value: amount + ethers.parseEther("0.2") })).wait();
    await (await funder.sendTransaction({ to: alice.address, value: ethers.parseEther("0.2") })).wait();

    const blk = await provider.getBlock("latest");
    const tReveal = blk.timestamp + ttl;
    const locked = await live.lock(provider, bob, {
      chainId: "31337",
      contract: htlcAddr,
      codeHash,
      hashlock,
      receiver: alice.address,
      amountWei: amount.toString(),
      tReveal: String(tReveal),
      gasPriceGwei: "20",
    });
    // Mine a block so finalized >= lockBlock on Hardhat.
    await provider.send("evm_mine", []);
    return { bobKey, aliceKey, bob, alice, payout, secret, hashlock, tReveal, lockId: locked.lockId };
  }

  function writeAliceSwapFile({
    bob,
    alice,
    payout,
    hashlock,
    lockId,
    tReveal,
    phase = "lock_final",
    ethKey = true,
    intent = null,
    pendingAction = null,
    history = [],
    profile = "rehearsal",
  }) {
    const file = path.join(tmpRoot, `alice-${nFile++}.swap.json`);
    const j = {
      version: 1,
      role: "alice",
      phase:
        phase === "lock_final" || phase === "lock_seen"
          ? { role: "alice", phase, lock: { lock_id: lockId, t_reveal: tReveal } }
          : { role: "alice", phase },
      public: {
        hashlock,
        claim_authority: "o1test",
        params: {
          profile,
          eth: {
            chain_id: 31337,
            contract: htlcAddr.toLowerCase(),
            code_hash: codeHash,
            lock_kind: "sha256",
            amount_wei: amount.toString(),
            alice_receiver: alice.address.toLowerCase(),
            bob_sender: bob.address.toLowerCase(),
          },
        },
      },
      secret: { ciphertext: "not-read-by-live.js" },
      history: history.map((event, i) => ({ at: 100 + i, event, from: "lock_final", to: "lock_final" })),
    };
    if (ethKey) {
      j.eth_key = {
        address: alice.address.toLowerCase(),
        payout: payout.toLowerCase(),
        secret: { ciphertext: "not-read-by-live.js" },
      };
    }
    if (intent) j.pending_intent = intent;
    if (pendingAction) j.pending_action = pendingAction;
    fs.writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 });
    return file;
  }

  /**
   * Wraps Hardhat's provider so `findPendingTx` cannot inspect the pending transaction
   * (returns empty pending block and rejects txpool_content), while allowing controlled
   * (latest, pending) nonces for `aliceAddr` when specified.
   */
  function makeHiddenPendingProvider(aliceAddr, { latestNonce, pendingNonce, overrideSend } = {}) {
    return new Proxy(provider, {
      get(target, prop) {
        if (prop === "getTransactionCount") {
          return async (addr, tag) => {
            if (addr.toLowerCase() === aliceAddr.toLowerCase()) {
              if (tag === "pending" && pendingNonce !== undefined) return pendingNonce;
              if (tag === "latest" && latestNonce !== undefined) return latestNonce;
            }
            return target.getTransactionCount(addr, tag);
          };
        }
        if (prop === "getBlock") {
          return async (tag, prefetch) => {
            if (tag === "pending") return { number: 0, transactions: [], prefetchedTransactions: [] };
            return target.getBlock(tag, prefetch);
          };
        }
        if (prop === "send") {
          return async (method, params) => {
            if (method === "txpool_content" || method === "txpool_contentFrom") {
              throw new Error("txpool_content unsupported");
            }
            if (method === "eth_getBlockByNumber" && params && params[0] === "pending") {
              return { number: "0x0", transactions: [] };
            }
            return target.send(method, params);
          };
        }
        if (prop === "broadcastTransaction" && overrideSend) {
          return overrideSend;
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it("accepts dry-run and real replacement at nonce 0 bidding at the fee cap without a held intent", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    const signerDry = new ethers.Wallet(s.aliceKey, hidden);

    // Dry run: accepted without held intent and without --replace-tx, bids at the 25 gwei fee cap with the asked tip (1 gwei) + 12.5 %.
    const dry = await live.claim(hidden, signerDry, {
      swap,
      keyStdin: true,
      replace: true,
      gasPriceGwei: "25",
      dryRun: true,
    });
    expect(dry.dryRun).to.equal(true);
    expect(dry.replace.nonce).to.equal(0);
    expect(dry.replace.replacesTx).to.equal(null);
    expect(dry.replace.nonceZeroFreshKey).to.equal(true);
    expect(dry.replace.newMaxFeeGwei).to.equal("25.0");
    expect(dry.replace.newTipGwei).to.equal("1.125");

    // Real replacement on Hardhat: place an actual low-fee tx at nonce 0 with automine off,
    // hide it from pending block inspection, and replace it at nonce 0 with live.claim --replace.
    await provider.send("evm_setAutomine", [false]);
    const htlcIface = new ethers.Interface(["function claim(bytes32,bytes32)"]);
    const lowFeeTx = await s.alice.sendTransaction({
      to: htlcAddr,
      data: htlcIface.encodeFunctionData("claim", [s.lockId, s.secret]),
      nonce: 0,
      gasLimit: 250000n,
      maxFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: GWEI, // the tip a first send gets from the same rule: the replacement must clear it
    });
    expect(await provider.getTransactionCount(s.alice.address, "latest")).to.equal(0);
    expect(await provider.getTransactionCount(s.alice.address, "pending")).to.equal(1);

    const secretFile = path.join(tmpRoot, "secret.hex");
    fs.writeFileSync(secretFile, s.secret + "\n", { mode: 0o600 });

    const realHidden = makeHiddenPendingProvider(s.alice.address);
    const signerReal = new ethers.Wallet(s.aliceKey, realHidden);

    const claimPromise = live.claim(realHidden, signerReal, {
      swap,
      keyStdin: true,
      replace: true,
      gasPriceGwei: "25",
      secretFile,
      unboundedSendInProcess: true,
    });
    // Wait briefly for the replacement tx to enter Hardhat's mempool, then mine it.
    await new Promise((r) => setTimeout(r, 250));
    await provider.send("evm_mine", []);
    await provider.send("evm_setAutomine", [true]);

    const res = await claimPromise;
    expect(res.txHash).to.match(/^0x[0-9a-f]{64}$/i);
    expect(res.txHash).to.not.equal(lowFeeTx.hash);
    expect(res.replace.nonce).to.equal(0);
    expect(res.replace.nonceZeroFreshKey).to.equal(true);
    expect(await provider.getTransactionCount(s.alice.address, "latest")).to.equal(1);
  });

  it("applies the late cutoff T_reveal - DE past the M_A cutoff", async function () {
    const s = await setupLock({ ttl: 7200 });
    const swap = writeAliceSwapFile(s);
    // Advance past M_A (default 1800 s before timelock) to 600 s before timelock (still well before T_reveal - 60 s).
    await provider.send("evm_setNextBlockTimestamp", [s.tReveal - 600]);
    await provider.send("evm_mine", []);

    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    const signer = new ethers.Wallet(s.aliceKey, hidden);
    const dry = await live.claim(hidden, signer, {
      swap,
      keyStdin: true,
      replace: true,
      gasPriceGwei: "25",
      dryRun: true,
    });
    expect(dry.dryRun).to.equal(true);
    expect(BigInt(dry.revealCutoff)).to.equal(BigInt(s.tReveal) - 60n);
  });

  it("reports under-priced with the tip words when the node refuses the replacement as under-priced", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    const secretFile = path.join(tmpRoot, "secret-underpriced.hex");
    fs.writeFileSync(secretFile, s.secret + "\n", { mode: 0o600 });

    const hidden = makeHiddenPendingProvider(s.alice.address, {
      latestNonce: 0,
      pendingNonce: 1,
      overrideSend: async () => {
        throw new Error("replacement transaction underpriced");
      },
    });
    const signer = new ethers.Wallet(s.aliceKey, hidden);

    let err = null;
    try {
      await live.claim(hidden, signer, {
        swap,
        keyStdin: true,
        replace: true,
        gasPriceGwei: "25",
        secretFile,
        unboundedSendInProcess: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/under-priced.*tip/i);
  });

  it("without a fee cap on a test network the replacement is accepted and the node prices it", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    const signer = new ethers.Wallet(s.aliceKey, hidden);
    const dry = await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, dryRun: true });
    expect(dry.dryRun).to.equal(true);
    expect(dry.replace.nonce).to.equal(0);
    expect(dry.replace.nonceZeroFreshKey).to.equal(true);
    expect(dry.replace.newMaxFeeGwei).to.equal(null);
  });

  it("refuses whenever any required condition is missing and keeps R5-2 unchanged elsewhere", async function () {
    const s = await setupLock();

    const cases = [
      {
        name: "latest nonce != 0 (latest 1, pending 2)",
        swap: writeAliceSwapFile(s),
        nonces: { latestNonce: 1, pendingNonce: 2 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /latest nonce 0 and pending nonce 1/i,
      },
      {
        name: "pending nonce != 1 (latest 0, pending 2)",
        swap: writeAliceSwapFile(s),
        nonces: { latestNonce: 0, pendingNonce: 2 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /latest nonce 0 and pending nonce 1/i,
      },
      {
        name: "no pending transaction (latest 0, pending 0)",
        swap: writeAliceSwapFile(s),
        nonces: { latestNonce: 0, pendingNonce: 0 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /no pending transaction/i,
      },
      {
        name: "not program mode (missing --key-stdin)",
        swap: writeAliceSwapFile(s),
        nonces: { latestNonce: 0, pendingNonce: 1 },
        args: { keyStdin: false, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /no pending intent/i,
      },
      {
        name: "not a fresh per-swap key (no eth_key in swap file)",
        swap: writeAliceSwapFile({ ...s, ethKey: false }),
        nonces: { latestNonce: 0, pendingNonce: 1 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /no pending intent/i,
      },
      {
        name: "swap file records another send (history has reveal_submitted)",
        swap: writeAliceSwapFile({ ...s, history: ["reveal_submitted"] }),
        nonces: { latestNonce: 0, pendingNonce: 1 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /no pending intent/i,
      },
      {
        name: "swap file is not in lock_seen or lock_final (phase reveal_submitted)",
        swap: writeAliceSwapFile({ ...s, phase: "reveal_submitted" }),
        nonces: { latestNonce: 0, pendingNonce: 1 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /no pending intent/i,
      },
      {
        name: "R5-2 unchanged: held intent on non-fresh key without --replace-tx is still refused",
        swap: writeAliceSwapFile({
          ...s,
          ethKey: false,
          intent: {
            action: "reveal_eth",
            decided_at: 1,
            params: { lock_id: s.lockId, t_reveal: s.tReveal, cutoff: s.tReveal - 1800, late_cutoff: s.tReveal - 60 },
          },
        }),
        nonces: { latestNonce: 0, pendingNonce: 1 },
        args: { keyStdin: true, replace: true, gasPriceGwei: "25", dryRun: true },
        match: /--replace-tx HASH/i,
      },
    ];

    for (const c of cases) {
      const hidden = makeHiddenPendingProvider(s.alice.address, c.nonces);
      const signer = new ethers.Wallet(s.aliceKey, hidden);
      let err = null;
      try {
        await live.claim(hidden, signer, { swap: c.swap, ...c.args });
      } catch (e) {
        err = e;
      }
      expect(err, `case "${c.name}" must refuse`).to.be.an("error");
      expect(err.message, `case "${c.name}"`).to.match(c.match);
    }
  });

  // A first re-send of the reveal at nonce 0, left pending (automine off). Its hash is what a later re-send is given.
  async function firstResend(s, { lockId = s.lockId, capGwei = 25n, tipWei = GWEI + GWEI / 8n } = {}) {
    await provider.send("evm_setAutomine", [false]);
    const htlcIface = new ethers.Interface(["function claim(bytes32,bytes32)"]);
    return s.alice.sendTransaction({
      to: htlcAddr,
      data: htlcIface.encodeFunctionData("claim", [lockId, s.secret]),
      nonce: 0,
      gasLimit: 250000n,
      maxFeePerGas: capGwei * GWEI,
      maxPriorityFeePerGas: tipWei,
    });
  }

  it("second nonce-0 re-send given the first re-send's hash raises cap and tip by 12.5 % over it", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    try {
      const first = await firstResend(s);
      const hidden = makeHiddenPendingProvider(s.alice.address);
      const signer = new ethers.Wallet(s.aliceKey, hidden);
      const dry = await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, replaceTx: first.hash, gasPriceGwei: "28.125", dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(dry.replace.nonceZeroFreshKey).to.not.equal(true);
      expect(dry.replace.replacesTx).to.equal(first.hash);
      expect(dry.replace.oldMaxFeeGwei).to.equal("25.0");
      expect(dry.replace.oldTipGwei).to.equal("1.125");
      expect(dry.replace.newMaxFeeGwei).to.equal("28.125");
      expect(dry.replace.newTipGwei).to.equal("1.265625");
      // The same cap again is not enough over the first re-send: refused with the minimum named.
      let err = null;
      try {
        await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, replaceTx: first.hash, gasPriceGwei: "25", dryRun: true });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an("error");
      expect(err.message).to.match(/below the minimum 28\.125/);
    } finally {
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [true]);
    }
  });

  it("--replace-tx with no intent on an eligible fresh key is accepted and checked", async function () {
    const s = await setupLock();
    const other = await setupLock();
    const swap = writeAliceSwapFile(s);
    try {
      // A pending send of this signer that is a claim of ANOTHER lock is refused (replacing it would cancel something else).
      const wrong = await firstResend(s, { lockId: other.lockId });
      const hidden = makeHiddenPendingProvider(s.alice.address);
      const signer = new ethers.Wallet(s.aliceKey, hidden);
      let err = null;
      try {
        await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, replaceTx: wrong.hash, gasPriceGwei: "30", dryRun: true });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an("error");
      expect(err.message).to.match(/is not a claim of lock/i);
      // Not eligible (no fresh key in the file): the hash is not accepted without an intent.
      const plain = writeAliceSwapFile({ ...s, ethKey: false });
      err = null;
      try {
        await live.claim(hidden, signer, { swap: plain, keyStdin: true, replace: true, replaceTx: wrong.hash, gasPriceGwei: "30", dryRun: true });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an("error");
      expect(err.message).to.match(/no pending intent/i);
    } finally {
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [true]);
    }
  });

  it("unknown --replace-tx on an eligible fresh key falls back to nonce 0", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    const signer = new ethers.Wallet(s.aliceKey, hidden);
    const dry = await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, replaceTx: rand32(), gasPriceGwei: "25", dryRun: true });
    expect(dry.dryRun).to.equal(true);
    expect(dry.replace.nonce).to.equal(0);
    expect(dry.replace.nonceZeroFreshKey).to.equal(true);
    // Not eligible: an unknown hash is still refused.
    const plain = writeAliceSwapFile({ ...s, ethKey: false });
    let err = null;
    try {
      await live.claim(hidden, signer, { swap: plain, keyStdin: true, replace: true, replaceTx: rand32(), gasPriceGwei: "25", dryRun: true });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
  });

  it("a delivered_rejected under-priced refusal of a nonce-0 re-send also says the tip words", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    const secretFile = path.join(tmpRoot, "secret-delivered.hex");
    fs.writeFileSync(secretFile, s.secret + "\n", { mode: 0o600 });
    const hidden = makeHiddenPendingProvider(s.alice.address, {
      latestNonce: 0,
      pendingNonce: 1,
      overrideSend: async () => {
        throw new live.SendOutcomeError({ outcome: "delivered_rejected", stage: "response", reason: "replacement transaction underpriced" });
      },
    });
    const signer = new ethers.Wallet(s.aliceKey, hidden);
    let err = null;
    try {
      await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, gasPriceGwei: "25", secretFile, unboundedSendInProcess: true });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/under-priced.*tip/i);
  });

  // A real claim whose send is refused by the node (nothing broadcast). The reveal fee record is written before the send, so it stays.
  async function refusedAttempt(s, swap, gasPriceGwei) {
    const secretFile = path.join(tmpRoot, "secret-rf.hex");
    fs.writeFileSync(secretFile, s.secret + "\n", { mode: 0o600 });
    const hidden = makeHiddenPendingProvider(s.alice.address, {
      latestNonce: 0,
      pendingNonce: 1,
      overrideSend: async () => {
        throw new live.SendOutcomeError({ outcome: "delivered_rejected", stage: "response", reason: "replacement transaction underpriced" });
      },
    });
    const signer = new ethers.Wallet(s.aliceKey, hidden);
    try {
      await live.claim(hidden, signer, { swap, keyStdin: true, replace: true, gasPriceGwei, secretFile, unboundedSendInProcess: true });
    } catch (e) {
      return e;
    }
    throw new Error("the refused attempt must throw");
  }
  const dryAt = async (s, swap, gasPriceGwei) => {
    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    return live.claim(hidden, new ethers.Wallet(s.aliceKey, hidden), { swap, keyStdin: true, replace: true, gasPriceGwei, dryRun: true });
  };

  it("a refused re-send does not erase the earlier hash: the fee record is written before the send, never truncated, and holds no secret", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    await refusedAttempt(s, swap, "25");
    const file = live.revealFeesPath(swap);
    const one = fs.readFileSync(file, "utf8");
    const r1 = JSON.parse(one.trim());
    expect(r1).to.include({ version: 1, nonce: 0, max_fee_per_gas: "25000000000", max_priority_fee_per_gas: "1125000000" });
    expect(r1.tx_hash).to.match(/^[0-9a-f]{64}$/);
    expect(one).to.not.include(s.secret.slice(2));
    expect(one).to.not.include(s.aliceKey.slice(2));
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).to.equal(0);
    // a second refused attempt (cap 30) appends; the first line is still there, byte for byte
    await refusedAttempt(s, swap, "30");
    const two = fs.readFileSync(file, "utf8");
    expect(two.startsWith(one)).to.equal(true);
    expect(two.trim().split("\n")).to.have.length(2);
    const rec = live.readRevealFees(swap, s.lockId);
    expect(rec.count).to.equal(2);
    expect(rec.maxFee).to.equal(30n * GWEI);
    expect(rec.newestHash).to.equal("0x" + JSON.parse(two.trim().split("\n")[1]).tx_hash);
  });

  it("a third re-send raises the tip above the second's, and a cap that cannot cover the rise is refused naming the cap needed", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    await refusedAttempt(s, swap, "25"); // R1: cap 25, tip 1.125
    const secondDry = await dryAt(s, swap, "30");
    expect(secondDry.replace.newTipGwei).to.equal("1.265625"); // over R1's 1.125 by 12.5 %
    await refusedAttempt(s, swap, "30"); // R2: cap 30, tip 1.265625
    const thirdDry = await dryAt(s, swap, "35");
    expect(thirdDry.replace.newTipGwei).to.equal("1.423828125"); // over R2's tip, not pinned at 1.125
    expect(thirdDry.replace.newMaxFeeGwei).to.equal("35.0");
    // the cap must clear the highest recorded cap + 12.5 % (33.75): 33 is refused with the figure, 34 is accepted
    let err = null;
    try {
      await dryAt(s, swap, "33");
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/at least 33.75 gwei/);
    expect(err.message).to.match(/--max-fee-gwei/);
    expect((await dryAt(s, swap, "34")).replace.newTipGwei).to.equal("1.423828125");
    // without a cap on a test network, with a record, the command asks for one instead of letting the node price a send it would refuse
    const hidden = makeHiddenPendingProvider(s.alice.address, { latestNonce: 0, pendingNonce: 1 });
    let err2 = null;
    try {
      await live.claim(hidden, new ethers.Wallet(s.aliceKey, hidden), { swap, keyStdin: true, replace: true, dryRun: true });
    } catch (e) {
      err2 = e;
    }
    expect(err2 && err2.message).to.match(/give --max-fee-gwei of at least 33.75/);
  });

  it("an unreadable fee record refuses the re-send, and an unknown hash plus the record still replaces at nonce 0 over the recorded fees", async function () {
    const s = await setupLock();
    const swap = writeAliceSwapFile(s);
    await refusedAttempt(s, swap, "25");
    // the node does not return the recorded hash (it was never broadcast here): the record's fees still bind
    const dry = await dryAt(s, swap, "28.125");
    expect(dry.replace.nonceZeroFreshKey).to.equal(true);
    expect(dry.replace.newTipGwei).to.equal("1.265625");
    // a record that is a directory cannot be read: refused, nothing signed
    const s2 = await setupLock();
    const swap2 = writeAliceSwapFile(s2);
    fs.mkdirSync(live.revealFeesPath(swap2));
    let err = null;
    try {
      await dryAt(s2, swap2, "25");
    } catch (e) {
      err = e;
    }
    expect(err && err.message).to.match(/reveal fee record .* could not be read/);
  });
});
