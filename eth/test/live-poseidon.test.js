"use strict";
/*
 * live.js with the poseidon lock kind (docs/poseidon-leg.md section 9.6, docs/poseidon-v2-review.md V2-6, V2-7, V2-8): the real
 * HTLCPoseidonV2 contract on Hardhat, driven through the same functions the command line uses.
 *
 * Memory: every claim that reaches the Poseidon permutation costs the Hardhat runtime ~30-45 MB until the provider is recreated, so this
 * file makes only a handful of real claims (each one is noted) and resets the chain when it is done. Refusals happen before the
 * permutation and cost nothing.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const live = require("../scripts/live.js");

const HOUR = 3600;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
/** Pinned runtime code hash of HTLCPoseidonV2 (docs/poseidon-leg.md 8.4; swap-cli's HTLC_POSEIDON_V2_CODE_HASH). */
const POSEIDON_HASH = "0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3";
const PUBLISHED_SECRET = "0x" + Buffer.from([...Array(32).keys()]).toString("hex");
const PUBLISHED_ADDR = "0xf8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf";

describe("live.js with the poseidon lock kind (HTLCPoseidonV2)", function () {
  this.timeout(600000);
  const amount = ethers.parseEther("0.2");
  let provider, alice, bob, carol, aliceAddr, bobAddr, carolAddr, addr, tgt, dir, nSwap, secret, lockAddr;

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const bal = (a) => provider.getBalance(a);
  const nonce = (a) => provider.getTransactionCount(a);

  /** A swap file with only the parts live.js reads. `lockKind` null = as swap-cli writes a sha256 file (the key is absent). */
  function swapFile({ intent = null, lockKind = "poseidon", codeHash, hash, contract } = {}) {
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock: hash || lockAddr,
        claim_authority: "o1test",
        params: {
          eth: {
            chain_id: 31337,
            contract: (contract || addr).toLowerCase(),
            code_hash: codeHash || tgt.codeHash,
            ...(lockKind === null ? {} : { lock_kind: lockKind }),
            amount_wei: amount.toString(),
            alice_receiver: aliceAddr.toLowerCase(),
            bob_sender: bobAddr.toLowerCase(),
          },
        },
      },
      secret: { ciphertext: "not-read-by-live.js" },
    };
    if (intent) j.pending_intent = intent;
    const file = path.join(dir, `swap-${nSwap++}.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }
  const wrapIntent = (action, params) => ({ action, params: { action, ...params }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 });
  const lockIntent = (tReveal) => wrapIntent("lock_eth", { hashlock: lockAddr, t_reveal: tReveal, receiver: aliceAddr.toLowerCase(), amount_wei: amount.toString() });
  const revealIntent = (lockId, tReveal) => wrapIntent("reveal_eth", { lock_id: lockId, t_reveal: tReveal, cutoff: tReveal - 1800 });
  const refundIntent = (lockId) => wrapIntent("refund_eth", { lock_id: lockId });

  async function makeLock({ signer = bob, receiver = aliceAddr, word = lockAddr, ttl = 2 * HOUR } = {}) {
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, signer, { ...tgt, lockKind: "poseidon", contract: addr, lockAddr: word, tReveal: String(tReveal), receiver, amountWei: amount.toString() });
    return { tReveal, ...l };
  }
  const claimArgs = (l, extra = {}) => ({ ...tgt, lockKind: "poseidon", contract: addr, lockId: l.lockId, secret, ...extra });

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    [aliceAddr, bobAddr, carolAddr] = await Promise.all([alice.getAddress(), bob.getAddress(), carol.getAddress()]);
    const d = await live.deploy(provider, carol, { contractKind: "poseidon" });
    addr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    secret = rand32();
    lockAddr = live.localAddr(secret);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-poseidon-"));
    nSwap = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  after(async () => {
    await hre.network.provider.send("hardhat_reset", []); // give the claims' retained trace memory back
  });

  describe("deploy, the local address and the flags", () => {
    it("deploys the V2 artifact (--contract-kind poseidon) and reports the pinned code hash", async () => {
      const d = await live.deploy(provider, carol, { contractKind: "poseidon" });
      expect(d.codeHash).to.equal(POSEIDON_HASH);
      expect(d.codeHash).to.equal(live.artifactCodeHash("poseidon"));
      expect(d.matchesArtifact).to.equal(true);
      // The default is still HTLC.sol.
      const h = await live.deploy(provider, carol, {});
      expect(h.codeHash).to.equal(live.artifactCodeHash("sha256"));
      expect(h.codeHash).to.not.equal(POSEIDON_HASH);
      expect(h.matchesArtifact).to.equal(true);
      // The dry run predicts the address of the V2 deployment.
      const dry = await live.deploy(provider, carol, { contractKind: "poseidon", dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(dry.dataLength).to.be.gt(15000);
    });

    it("computes Addr(secret) locally: the published vector, and the contract agrees on a public test vector", async () => {
      expect(live.localAddr(PUBLISHED_SECRET)).to.equal(PUBLISHED_ADDR);
      expect(live.localLockWord("poseidon", PUBLISHED_SECRET)).to.equal(PUBLISHED_ADDR);
      expect(live.localLockWord("sha256", PUBLISHED_SECRET)).to.equal(ethers.sha256(PUBLISHED_SECRET));
    });

    it("parses --lock-kind and --contract-kind as one setting and refuses another value", () => {
      expect(live.parseArgs(["deploy", "--contract-kind", "poseidon"]).args.lockKind).to.equal("poseidon");
      expect(live.parseArgs(["status", "--lock-kind", "poseidon", "--contract", addr, "--lock-id", rand32()]).args.lockKind).to.equal("poseidon");
      expect(() => live.parseArgs(["deploy", "--contract-kind", "keccak"])).to.throw(/sha256 or poseidon/);
      expect(() => live.parseArgs(["deploy", "--contract-kind", "poseidon", "--lock-kind", "sha256"])).to.throw(/disagree/);
      expect(live.parseArgs(["lock", "--lock-kind", "poseidon", "--lock-addr", lockAddr]).args.lockAddr).to.equal(lockAddr);
    });
  });

  describe("lock", () => {
    it("locks on --lock-addr, reports the kind, and the on-chain record carries the address", async () => {
      const l = await makeLock();
      expect(l.lockKind).to.equal("poseidon");
      expect(l.codeHash).to.equal(POSEIDON_HASH);
      const want = live.computeLockIdLocal(bobAddr, aliceAddr, amount, lockAddr, BigInt(l.tReveal));
      expect(l.lockId).to.equal(want);
      const s = await live.status(provider, null, { contract: addr, lockId: l.lockId });
      expect(s.lockKind).to.equal("poseidon"); // detected from the code hash, no flag
      expect(s.state).to.equal("open (claimable)");
      expect(s.lock.hashlock).to.equal(lockAddr); // the output key stays `hashlock`
      expect(s.events[0].hashlock).to.equal(lockAddr);
    });

    it("takes --lock-addr, not --hashlock, and the sha256 kind the other way round", async () => {
      const tReveal = String((await latestTs()) + 2 * HOUR);
      const base = { ...tgt, contract: addr, tReveal, receiver: aliceAddr, amountWei: amount.toString() };
      await expect(live.lock(provider, bob, { ...base, lockKind: "poseidon", hashlock: lockAddr })).to.be.rejectedWith(/give --lock-addr, not --hashlock/);
      await expect(live.lock(provider, bob, { ...base, lockKind: "poseidon" })).to.be.rejectedWith(/missing required --lock-addr/);
      await expect(live.lock(provider, bob, { ...base, lockAddr })).to.be.rejectedWith(/--lock-addr belongs to the poseidon lock kind/);
    });

    it("refuses a second lock of its own sender on the address; a lock of another sender neither blocks nor is read (T9, REVIEW-6 R6-2, REVIEW-7 R7-1)", async () => {
      await makeLock();
      // The same sender, a different timelock: a second lock of Bob's under the same address.
      await expect(makeLock({ ttl: 3 * HOUR })).to.be.rejectedWith(/from this sender .* already exists/);
      // The same sender to ANOTHER receiver is still an earlier lock of Bob's on the address.
      await expect(makeLock({ receiver: carolAddr })).to.be.rejectedWith(/from this sender .* already exists/);
      // Another sender's earlier lock on the address does NOT block (a 1-wei lock must not veto the swap). REVIEW-7 R7-1: the node is asked for
      // the signer's own locks only (indexed sender topic), so carol's query does not even see Bob's lock: nothing is reported either.
      const dry = await live.lock(provider, carol, {
        ...tgt, lockKind: "poseidon", contract: addr, lockAddr, tReveal: String((await latestTs()) + 3 * HOUR), receiver: aliceAddr, amountWei: amount.toString(), dryRun: true,
      });
      expect(dry.dryRun).to.equal(true);
      expect(dry.lockedEventsQuery).to.equal("sender");
      expect(dry.lockedEventsScanned).to.equal(0);
      expect(dry.foreignLocksSameHashlock).to.deep.equal([]);
      // ... and carol really can lock after bob (the other direction of the same fact).
      const second = await makeLock({ signer: carol });
      expect(second.foreignLocksSameHashlock).to.deep.equal([]);
      // An unrelated address is fine.
      const other = await makeLock({ word: live.localAddr(rand32()) });
      expect(other.lockKind).to.equal("poseidon");
    });

    it("asks only the indexed sender topic: no cap-size rule, every log re-checked locally, a node error fails it (REVIEW-7 R7-1)", async () => {
      const topic0 = live.htlcInterface("poseidon").getEvent("Locked").topicHash;
      const calls = [];
      // `mode`: "plain" = pass through; "pad" = answer with n copies of the first real log; "ignore" = ignore the topic filter (every Locked log);
      // "fail" = a node error.
      const spy = (mode, n = 0) =>
        new Proxy(provider, {
          get(t, prop) {
            if (prop === "getLogs") {
              return async (f) => {
                calls.push(f);
                if (mode === "fail") throw new Error("query returned more than 10000 results");
                if (mode === "ignore") return t.getLogs({ address: f.address, fromBlock: f.fromBlock, toBlock: f.toBlock, topics: [topic0] });
                const real = await t.getLogs(f);
                return mode === "pad" ? Array.from({ length: n }, () => real[0]) : real;
              };
            }
            const v = t[prop];
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      await makeLock({ word: live.localAddr(rand32()) }); // Bob's own lock on another address: one log for his sender
      await makeLock({ signer: carol, word: lockAddr }); // somebody else's lock on OUR address
      const tReveal = String((await latestTs()) + 2 * HOUR);
      const args = { ...tgt, lockKind: "poseidon", contract: addr, lockAddr, tReveal, receiver: aliceAddr, amountWei: amount.toString(), dryRun: true };
      // The query carries Bob's address as topic2 and nothing else restrictive.
      const ok = await live.lock(spy("plain"), bob, args);
      expect(ok.dryRun).to.equal(true);
      expect(calls.length).to.be.gt(0);
      for (const f of calls) expect(f.topics).to.deep.equal([topic0.toLowerCase(), null, ethers.zeroPadValue(bobAddr, 32).toLowerCase()]);
      expect(ok.lockedEventsScanned).to.equal(1);
      expect(ok.foreignLocksSameHashlock).to.deep.equal([]);
      // A result of exactly a usual provider cap size (copies of Bob's own unrelated lock) is NOT an error any more: the size does not depend
      // on other people's activity, and the logs are the ones of Bob's address.
      for (const n of [1000, 5000]) {
        const padded = await live.lock(spy("pad", n), bob, args);
        expect(padded.dryRun).to.equal(true);
        expect(padded.lockedEventsScanned).to.equal(n);
      }
      // A provider that ignores the topic filter answers with every Locked log, carol's lock on OUR address included: it is dropped here.
      const ignoring = await live.lock(spy("ignore"), bob, args);
      expect(ignoring.dryRun).to.equal(true);
      expect(ignoring.lockedEventsScanned).to.equal(1);
      expect(ignoring.foreignLocksSameHashlock).to.deep.equal([]);
      // ... but Bob's own earlier lock on the address, delivered the same way, still blocks.
      await makeLock({ word: lockAddr });
      await expect(live.lock(spy("ignore"), bob, args)).to.be.rejectedWith(/from this sender .* already exists/);
      // A node error is an error (never "no earlier lock" by silence).
      await expect(live.lock(spy("fail"), bob, args)).to.be.rejectedWith(/10000 results/);
    });
  });

  describe("claim", () => {
    it("sends exactly 68 bytes of calldata with a gas limit of 1,000,000, pays Alice, and status shows the preimage (REAL CLAIM 1)", async () => {
      const l = await makeLock();
      const before = await bal(aliceAddr);
      const r = await live.claim(provider, alice, claimArgs(l));
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      const tx = await provider.getTransaction(r.txHash);
      expect(tx.gasLimit).to.equal(live.POSEIDON_CLAIM_GAS_LIMIT);
      expect(tx.gasLimit).to.equal(1_000_000n);
      expect((tx.data.length - 2) / 2).to.equal(68);
      expect(tx.data).to.equal(live.htlcInterface("poseidon").encodeFunctionData("claim", [l.lockId, secret]));
      const receipt = await provider.getTransactionReceipt(r.txHash);
      expect(receipt.status).to.equal(1);
      expect(receipt.gasUsed).to.be.lt(600000n).and.gt(450000n);
      expect(await bal(aliceAddr)).to.be.gt(before + amount - ethers.parseEther("0.01"));
      const s = await live.status(provider, null, { contract: addr, lockId: l.lockId });
      expect(s.state).to.equal("claimed");
      expect(s.preimage).to.equal(secret);
      expect(s.preimageMatchesHashlock).to.equal(true); // Addr(preimage), computed locally
      expect(s.lockKind).to.equal("poseidon");
    });

    it("never sends the secret to the node except in the signed raw transaction: no estimateGas, no eth_call (REAL CLAIM 2)", async () => {
      // A wallet signs locally (eth_sendRawTransaction); every JSON-RPC request is recorded.
      const log = [];
      const wire = {
        request: async ({ method, params }) => {
          log.push({ method, params });
          return hre.network.provider.request({ method, params });
        },
      };
      const rec = new ethers.BrowserProvider(wire, undefined, { cacheTimeout: -1 });
      const wallet = ethers.Wallet.createRandom().connect(rec);
      await alice.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
      // The lock pays the wallet: Bob locks for it on its own address (a second secret).
      const secret2 = rand32();
      const word2 = live.localAddr(secret2);
      const l3 = await makeLock({ receiver: wallet.address, word: word2, signer: bob });
      log.length = 0;
      // Dry run first, WITH the secret: a poseidon dry run never estimates.
      const dry = await live.claim(rec, wallet, { ...tgt, lockKind: "poseidon", contract: addr, lockId: l3.lockId, secret: secret2, dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(dry.gasLimit).to.equal("1000000");
      expect(dry.gasEstimate).to.equal(null);
      expect(dry.dataLength).to.equal(68);
      const dryText = JSON.stringify(log);
      expect(dryText.toLowerCase()).to.not.include(secret2.slice(2).toLowerCase());
      // The real claim.
      log.length = 0;
      const r = await live.claim(rec, wallet, { ...tgt, lockKind: "poseidon", contract: addr, lockId: l3.lockId, secret: secret2 });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      const needle = secret2.slice(2).toLowerCase();
      const carrying = log.filter((q) => JSON.stringify(q.params).toLowerCase().includes(needle));
      expect(carrying.map((q) => q.method)).to.deep.equal(["eth_sendRawTransaction"]);
      expect(log.some((q) => q.method === "eth_estimateGas")).to.equal(false);
      expect(log.some((q) => q.method === "eth_call" && JSON.stringify(q.params).toLowerCase().includes(needle))).to.equal(false);
      // The recorded calls include the fee/nonce/balance reads that are allowed (they carry no calldata).
      expect(log.some((q) => q.method === "eth_sendRawTransaction")).to.equal(true);
    });

    it("a claim that is mined and reverts is reported as reverted with the secret public, and carries the hash (REVIEW-6 R6-3)", async () => {
      const l = await makeLock({ ttl: 2 * HOUR });
      await provider.send("evm_setAutomine", [false]);
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const p = live.claim(provider, alice, claimArgs(l, { onSent: sent }));
      await Promise.race([sentP, p.catch(() => {})]);
      // Every gate passed on the latest block; the block that mines the claim is stamped after the timelock (TimelockExpired, before the permutation).
      await provider.send("evm_setNextBlockTimestamp", [l.tReveal + 10]);
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [true]);
      const r = await p;
      expect(r.reverted).to.equal(true);
      expect(r.secretPublic).to.equal(true);
      expect(r.lockKind).to.equal("poseidon");
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(r.swapCliFlag).to.equal(`--reveal-tx ${r.txHash}`);
      const receipt = await provider.getTransactionReceipt(r.txHash);
      expect(receipt.status).to.equal(0);
      const tx = await provider.getTransaction(r.txHash);
      expect((tx.data.length - 2) / 2).to.equal(68);
      expect(tx.data.toLowerCase()).to.include(secret.slice(2).toLowerCase());
      expect((await live.status(provider, null, { contract: addr, lockId: l.lockId })).state).to.match(/^expired-unclaimed/);
    });

    it("refuses a wrong secret, a 31- or 33-byte secret, before anything is sent", async () => {
      const l = await makeLock();
      const n = await nonce(aliceAddr);
      await expect(live.claim(provider, alice, claimArgs(l, { secret: rand32() }))).to.be.rejectedWith(/Addr\(secret\) = 0x[0-9a-f]{64} but the lock's lockAddr is/);
      await expect(live.claim(provider, alice, claimArgs(l, { secret: "0x" + "ab".repeat(31) }))).to.be.rejectedWith(/exactly 64 hex chars/);
      await expect(live.claim(provider, alice, claimArgs(l, { secret: "0x" + "ab".repeat(33) }))).to.be.rejectedWith(/exactly 64 hex chars/);
      // The sha256 of the secret is not what this lock is keyed on.
      await expect(live.claim(provider, alice, claimArgs(l, { secret: ethers.sha256(secret) }))).to.be.rejectedWith(/but the lock's lockAddr is/);
      expect(await nonce(aliceAddr)).to.equal(n);
    });

    it("refuses on the wrong chain, the wrong code hash, and a contract of the other kind (code hash mismatch)", async () => {
      const l = await makeLock();
      await expect(live.claim(provider, alice, claimArgs(l, { chainId: "11155111" }))).to.be.rejectedWith(/chain id mismatch/);
      await expect(live.claim(provider, alice, claimArgs(l, { codeHash: rand32() }))).to.be.rejectedWith(/not the code hash of this repo's compiled artifact/);
      // The kind says poseidon; the contract at this address is HTLC.sol.
      const h = await live.deploy(provider, carol, {});
      await expect(live.claim(provider, alice, claimArgs(l, { contract: h.contract }))).to.be.rejectedWith(/code hash mismatch/);
      // And the other way round: sha256 flags against the V2 contract.
      await expect(live.claim(provider, alice, claimArgs(l, { lockKind: "sha256", codeHash: undefined }))).to.be.rejectedWith(/code hash mismatch/);
    });

    it("refuses an expired lock and a claim past the reveal cutoff, and never claims a closed lock", async () => {
      const l = await makeLock({ ttl: 1000 });
      // 1000 s to the timelock is inside the default 1800 s margin.
      await expect(live.claim(provider, alice, claimArgs(l))).to.be.rejectedWith(/past the reveal cutoff/);
      await provider.send("evm_increaseTime", [1100]);
      await provider.send("evm_mine", []);
      await expect(live.claim(provider, alice, claimArgs(l))).to.be.rejectedWith(/already passed/);
    });

    it("signs nothing but exactly selector + lock id + secret (a suffix is refused, and the message never shows the secret)", () => {
      const iface = live.htlcInterface("poseidon");
      const lockId = rand32();
      const data = iface.encodeFunctionData("claim", [lockId, secret]);
      expect(() => live.assertPoseidonClaimCalldata(iface, data, lockId, secret)).to.not.throw();
      for (const bad of [data + "00", data + "abcdef", data.slice(0, -2)]) {
        let msg = "";
        try {
          live.assertPoseidonClaimCalldata(iface, bad, lockId, secret);
        } catch (e) {
          msg = e.message;
        }
        expect(msg).to.match(/refusing to sign/);
        expect(msg.toLowerCase()).to.not.include(secret.slice(2).toLowerCase());
      }
      // Right length, other content: refused.
      expect(() => live.assertPoseidonClaimCalldata(iface, data, lockId, rand32())).to.throw(/not selector \+ lock id \+ secret/);
    });

    it("a poseidon claim --dry-run with the secret is refused against a node that is not on this machine, before any network call", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      const out = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [SCRIPT, "claim", "--lock-kind", "poseidon", "--contract", addr, "--lock-id", rand32(), "--chain-id", "31337", "--key-file", keyFile, "--dry-run", "--secret-stdin"],
          { env: { ...process.env, ETH_RPC_URL: "http://203.0.113.9:8545" } }
        );
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, err }));
        child.stdin.end(secret + "\n");
      });
      expect(out.code).to.equal(1);
      expect(out.err).to.match(/not on this machine/);
      expect(out.err).to.not.include(secret.slice(2));
    });
  });

  describe("--swap FILE with lock_kind poseidon", () => {
    it("lock, reveal and refund all follow the file: the lock word, the V2 artifact, the pinned code hash (REAL CLAIM 3)", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const lockFile = swapFile({ intent: lockIntent(tReveal) });
      const dry = await live.lock(provider, bob, { swap: lockFile, dryRun: true });
      expect(dry.lockKind).to.equal("poseidon");
      const l = await live.lock(provider, bob, { swap: lockFile });
      expect(l.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, lockAddr, BigInt(tReveal)));
      // Alice's reveal from the file: the secret is only the secret; every term comes from the file's intent.
      const revealFile = swapFile({ intent: revealIntent(l.lockId, tReveal) });
      const plan = await live.claim(provider, alice, { swap: revealFile, dryRun: true });
      expect(plan.lockKind).to.equal("poseidon");
      expect(plan.hashlock).to.equal(lockAddr);
      expect(plan.gasLimit).to.equal("1000000");
      const r = await live.claim(provider, alice, { swap: revealFile, secret });
      const tx = await provider.getTransaction(r.txHash);
      expect(tx.gasLimit).to.equal(1_000_000n);
      expect((tx.data.length - 2) / 2).to.equal(68);
      // A second lock for the refund path (another address).
      const secret2 = rand32();
      lockAddr = live.localAddr(secret2);
      const t2 = (await latestTs()) + HOUR;
      const l2 = await live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(t2) }) });
      await provider.send("evm_increaseTime", [HOUR + 10]);
      await provider.send("evm_mine", []);
      const nb = await nonce(bobAddr);
      const rf = await live.refund(provider, bob, { swap: swapFile({ intent: refundIntent(l2.lockId) }) });
      expect(rf.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await nonce(bobAddr)).to.equal(nb + 1);
      const s = await live.status(provider, null, { contract: addr, lockId: l2.lockId, lockKind: "poseidon" });
      expect(s.state).to.equal("refunded");
    });

    it("refuses a file whose kind, pin or flags disagree", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      // --lock-kind sha256 against a poseidon file.
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal) }), lockKind: "sha256", dryRun: true })).to.be.rejectedWith(/disagrees with the swap file/);
      // The file pins HTLC.sol's hash while saying poseidon.
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal), codeHash: live.artifactCodeHash("sha256") }), dryRun: true })).to.be.rejectedWith(/not the local HTLCPoseidonV2 artifact's/);
      // A sha256 file (no lock_kind key) pinning the V2 hash.
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal), lockKind: null }), dryRun: true })).to.be.rejectedWith(/not the local artifact's/);
      // --hashlock against a poseidon file, --lock-addr that differs from the file's.
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal) }), hashlock: lockAddr, dryRun: true })).to.be.rejectedWith(/give --lock-addr/);
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal) }), lockAddr: rand32(), dryRun: true })).to.be.rejectedWith(/--lock-addr disagrees with the swap file/);
      // An unknown kind in the file.
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal), lockKind: "keccak" }), dryRun: true })).to.be.rejectedWith(/unknown lock_kind/);
    });

    it("a lock on chain whose lock word is not the file's is refused by the reveal", async () => {
      const l = await makeLock({ word: live.localAddr(rand32()) }); // another address than the file's
      const file = swapFile({ intent: revealIntent(l.lockId, l.tReveal) });
      await expect(live.claim(provider, alice, { swap: file, secret })).to.be.rejectedWith(/hashlock/);
    });
  });
});
