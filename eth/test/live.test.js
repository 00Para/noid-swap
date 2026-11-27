const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn, spawnSync } = require("child_process");

const isolated = require("./helpers/isolated-home"); // before anything else: the per-user lock record must never touch the real home
const live = require("../scripts/live.js");
const { startProxy } = require("../scripts/rpc-proxy.js");

const HOUR = 3600;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

/**
 * The approval that a fresh read-only tick would hand over for the lock of swap file `file` (the real one is built by lock_precheck in scripts/live/env.sh from
 * the tick's output; this stands in for it in the tests, from the file). `over` changes one of the terms, to test a refusal.
 */
function approvalOf(file, over = {}, at = Math.floor(Date.now() / 1000)) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const eth = j.public.params.eth;
  const it = j.pending_intent;
  const p = it.params;
  const terms = {
    chainId: eth.chain_id, contract: eth.contract, lockKind: eth.lock_kind === undefined ? "sha256" : eth.lock_kind, codeHash: eth.code_hash,
    bobSender: eth.bob_sender, receiver: p.receiver, amountWei: p.amount_wei, lockWord: p.hashlock, tReveal: p.t_reveal, decidedAt: it.decided_at, ...over,
  };
  return { approvedIntent: String(it.decided_at), approvedTerms: live.approvalTermsHash(terms), approvedAt: String(at) };
}
/** args with the approval of their swap file added for a real send (a dry run and a lock without a swap file need none); explicit approval flags win. */
function withApproval(args) {
  if (args.dryRun || !args.swap) return args;
  let ap = {};
  try {
    ap = approvalOf(args.swap);
  } catch {
    /* a file the helper cannot read gets no approval, and the lock refuses */
  }
  return { ...ap, ...args };
}
const lockApproved = (provider, signer, args) => live.lock(provider, signer, withApproval(args));

describe("live.js (over Hardhat's in-process network)", function () {
  let provider, alice, bob, carol, htlcAddr, tgt;
  const amount = ethers.parseEther("0.5");

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const bal = (a) => provider.getBalance(a);

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 }); // no 250 ms response cache
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    const d = await live.deploy(provider, alice, {});
    htlcAddr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
  });

  describe("deploy / balance / send", () => {
    it("deploys the artifact and reports chainId, codeHash and deployer", async () => {
      const d = await live.deploy(provider, alice, {});
      const code = await provider.getCode(d.contract);
      expect(d.deployer).to.equal(await alice.getAddress());
      expect(d.chainId).to.equal("31337");
      expect(d.codeHash).to.equal(ethers.keccak256(code));
      expect(d.matchesArtifact).to.equal(true);
      expect(d.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(d.blockNumber).to.be.a("number");
    });

    it("deploy --dry-run predicts the address and sends nothing", async () => {
      const nonceBefore = await provider.getTransactionCount(await alice.getAddress());
      const r = await live.deploy(provider, alice, { dryRun: true });
      expect(r.dryRun).to.equal(true);
      expect(r.sent).to.equal(false);
      expect(BigInt(r.gasEstimate)).to.be.gt(0n);
      expect(r.dataLength).to.be.gt(100);
      expect(await provider.getTransactionCount(await alice.getAddress())).to.equal(nonceBefore);
      const real = await live.deploy(provider, alice, {});
      expect(real.contract).to.equal(r.expectedContract);
    });

    it("balance and send", async () => {
      const to = await carol.getAddress();
      const before = await bal(to);
      const r = await live.send(provider, alice, { to, amountWei: "123456789" });
      expect(r.valueWei).to.equal("123456789");
      expect(await bal(to)).to.equal(before + 123456789n);
      const b = await live.balance(provider, null, { address: to.toLowerCase() });
      expect(b.address).to.equal(to);
      expect(b.balanceWei).to.equal((before + 123456789n).toString());
      expect(b.chainId).to.equal("31337");
    });

    it("send --dry-run does not move funds", async () => {
      const to = await carol.getAddress();
      const before = await bal(to);
      const r = await live.send(provider, alice, { to, amountWei: "1000", dryRun: true });
      expect(r.dryRun).to.equal(true);
      expect(r.valueWei).to.equal("1000");
      expect(await bal(to)).to.equal(before);
    });

    it("rejects bad input", async () => {
      await expect(live.send(provider, alice, { to: "0x1234", amountWei: "1" })).to.be.rejectedWith(/not a valid Ethereum address/);
      await expect(live.send(provider, alice, { to: await bob.getAddress(), amountWei: "0" })).to.be.rejectedWith(/> 0/);
      await expect(live.send(provider, alice, { to: await bob.getAddress(), amountWei: "1.5" })).to.be.rejectedWith(/decimal integer/);
      await expect(live.send(provider, null, { to: await bob.getAddress(), amountWei: "1" })).to.be.rejectedWith(/signer/);
    });
  });

  describe("local lockId recomputation", () => {
    it("matches HTLC.computeLockId", async () => {
      const htlc = new ethers.Contract(htlcAddr, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/HTLC.sol/HTLC.json"))).abi, provider);
      const args = [await alice.getAddress(), await bob.getAddress(), amount, sha256Raw(rand32()), 1893456000n];
      expect(live.computeLockIdLocal(...args)).to.equal(await htlc.computeLockId(...args));
    });
  });

  describe("deploy -> lock -> status -> claim", () => {
    it("full happy path; status shows the preimage after the claim", async () => {
      const preimage = rand32();
      const hashlock = sha256Raw(preimage);
      const tReveal = (await latestTs()) + 2 * HOUR;
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const l = await live.lock(provider, alice, {
        ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: bobAddr, amountWei: amount.toString(),
      });
      expect(l.sender).to.equal(aliceAddr);
      expect(l.lockId).to.equal(live.computeLockIdLocal(aliceAddr, bobAddr, amount, hashlock, BigInt(tReveal)));
      expect(l.blockTimestamp).to.equal((await provider.getBlock(l.blockNumber)).timestamp);

      let s = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      expect(s.exists).to.equal(true);
      expect(s.state).to.match(/^open/);
      expect(s.lock.hashlock).to.equal(hashlock);
      expect(s.lock.receiver).to.equal(bobAddr);
      expect(s.lock.amountWei).to.equal(amount.toString());
      expect(s.events.map((e) => e.event)).to.deep.equal(["Locked"]);
      expect(s.preimage).to.equal(null);

      // wrong preimage is refused locally, nothing sent
      await expect(live.claim(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: rand32() })).to.be.rejectedWith(/sha256\(secret\)/);
      // keccak256 of the preimage is not the hashlock either
      await expect(live.claim(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: ethers.keccak256(preimage) })).to.be.rejectedWith(/sha256\(secret\)/);

      // dry run: no state change
      const dry = await live.claim(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(dry.receiver).to.equal(bobAddr);
      expect((await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);

      const before = await bal(bobAddr);
      const c = await live.claim(provider, carol, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage }); // anyone may claim; pays Bob
      expect(c.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(c.blockNumber).to.be.a("number");
      expect(await bal(bobAddr)).to.equal(before + amount);

      s = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      expect(s.state).to.equal("claimed");
      expect(s.events.map((e) => e.event)).to.deep.equal(["Locked", "Claimed"]);
      expect(s.preimage).to.equal(preimage);
      expect(s.preimageMatchesHashlock).to.equal(true);
      expect(s.lock.preimage).to.equal(preimage);

      // status with --from-block starting at the claim only sees the claim
      const s2 = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId, fromBlock: c.blockNumber });
      expect(s2.events.map((e) => e.event)).to.deep.equal(["Claimed"]);
      expect(s2.preimage).to.equal(preimage);

      await expect(live.claim(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage })).to.be.rejectedWith(/already claimed/);
    });

    it("lock --dry-run reports the expected lockId and creates nothing", async () => {
      const hashlock = sha256Raw(rand32());
      const tReveal = String((await latestTs()) + HOUR);
      const a = { ...tgt, contract: htlcAddr, hashlock, tReveal, receiver: await bob.getAddress(), amountWei: "1000" };
      const dry = await live.lock(provider, alice, { ...a, dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(dry.valueWei).to.equal("1000");
      const real = await live.lock(provider, alice, a);
      expect(real.lockId).to.equal(dry.expectedLockId);
    });

    // A provider whose getBlock(<number>) answers null the first `nulls` times (Infinity: always); "latest" and tags are untouched.
    const lagging = (nulls) => {
      const st = { numeric: 0 };
      const p = new Proxy(provider, {
        get(t, k) {
          if (k === "getBlock") {
            return async (tag, ...rest) => {
              if (typeof tag === "number" && st.numeric++ < nulls) return null;
              return t.getBlock(tag, ...rest);
            };
          }
          const v = t[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return { p, st };
    };
    const lockArgs = async () => ({
      ...tgt, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: await bob.getAddress(), amountWei: "1000", blockRetryMs: 1,
    });

    it("lock: a block the node does not serve at first is read again, and its timestamp is recorded", async () => {
      const { p, st } = lagging(1);
      const l = await live.lock(p, alice, await lockArgs());
      expect(st.numeric).to.equal(2);
      expect(l.blockTimestamp).to.equal((await provider.getBlock(l.blockNumber)).timestamp);
      expect(l).to.not.have.property("blockTimestampNote");
    });

    it("lock: a block that is never served gives a null timestamp with a note, the lock itself is not affected", async () => {
      const { p, st } = lagging(Infinity);
      const written = [];
      const orig = process.stderr.write;
      process.stderr.write = (c, ...r) => (written.push(String(c)), true);
      let l;
      try {
        l = await live.lock(p, alice, await lockArgs());
      } finally {
        process.stderr.write = orig;
      }
      expect(st.numeric).to.equal(5);
      expect(l.blockTimestamp).to.equal(null);
      expect(l.blockTimestampNote).to.match(/not served/);
      expect(l.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(written.filter((w) => /timestamp of block/.test(w))).to.have.length(1);
      expect((await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId })).exists).to.equal(true);
    });

    it("lock rejects bad inputs before sending", async () => {
      const ok = { ...tgt, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: await bob.getAddress(), amountWei: "1" };
      await expect(live.lock(provider, alice, { ...ok, hashlock: "0x1234" })).to.be.rejectedWith(/32 bytes/);
      await expect(live.lock(provider, alice, { ...ok, tReveal: String((await latestTs()) - 1) })).to.be.rejectedWith(/not after/);
      await expect(live.lock(provider, alice, { ...ok, tReveal: String(Date.now()) })).to.be.rejectedWith(/milliseconds/);
      await expect(live.lock(provider, alice, { ...ok, amountWei: "0" })).to.be.rejectedWith(/> 0/);
      await expect(live.lock(provider, alice, { ...ok, receiver: "nope" })).to.be.rejectedWith(/valid Ethereum address/);
    });

    it("claim after the timelock is refused", async () => {
      const preimage = rand32();
      const tReveal = (await latestTs()) + HOUR;
      const l = await live.lock(provider, alice, {
        ...tgt, contract: htlcAddr, hashlock: sha256Raw(preimage), tReveal: String(tReveal), receiver: await bob.getAddress(), amountWei: "1000",
      });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      await expect(live.claim(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage })).to.be.rejectedWith(/already passed/);
    });
  });

  describe("deploy -> lock -> refund", () => {
    it("refuses before the timelock, refunds after", async () => {
      const aliceAddr = await alice.getAddress();
      const hashlock = sha256Raw(rand32());
      const tReveal = (await latestTs()) + 2 * HOUR;
      const l = await live.lock(provider, alice, {
        ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: await bob.getAddress(), amountWei: amount.toString(),
      });
      const early = live.refund(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      await expect(early).to.be.rejectedWith(/too early/);
      await expect(live.refund(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, dryRun: true })).to.be.rejectedWith(/too early/);

      await provider.send("evm_increaseTime", [2 * HOUR + 1]);
      await provider.send("evm_mine", []);

      let s = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      expect(s.state).to.match(/^expired-unclaimed/);

      // only the sender may refund
      await expect(live.refund(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId })).to.be.rejectedWith(/only the lock's sender/);

      const dry = await live.refund(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect((await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId })).lock.refunded).to.equal(false);

      const before = await bal(aliceAddr);
      const r = await live.refund(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, gasPriceGwei: "5" });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(aliceAddr)).to.be.gt(before); // got ~0.5 ETH back, minus gas

      s = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      expect(s.state).to.equal("refunded");
      expect(s.events.map((e) => e.event)).to.deep.equal(["Locked", "Refunded"]);
      expect(s.preimage).to.equal(null);
      await expect(live.refund(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId })).to.be.rejectedWith(/already refunded/);
    });

    it("status of an unknown lock says so", async () => {
      const s = await live.status(provider, null, { ...tgt, contract: htlcAddr, lockId: rand32() });
      expect(s.exists).to.equal(false);
      expect(s.state).to.equal("not found");
      expect(s.events).to.deep.equal([]);
    });
  });

  describe("chain guard and arg parsing", () => {
    it("refuses mainnet and unknown chains", async () => {
      const fake = (id) => ({ getNetwork: async () => ({ chainId: BigInt(id) }) });
      const signer = { getAddress: async () => "0x" + "11".repeat(20) };
      const args = { to: "0x" + "22".repeat(20), amountWei: "1" };
      await expect(live.send(fake(1), signer, { ...args, allowChainId: "1" })).to.be.rejectedWith(/mainnet/);
      await expect(live.send(fake(10), signer, args)).to.be.rejectedWith(/not a known test network/);
    });

    it("parseArgs maps flags to camelCase and rejects typos", () => {
      const { command, args } = live.parseArgs(["lock", "--key-file", "k", "--t-reveal", "5", "--amount-wei", "7", "--dry-run"]);
      expect(command).to.equal("lock");
      expect(args).to.deep.equal({ keyFile: "k", tReveal: "5", amountWei: "7", dryRun: true });
      expect(live.parseArgs(["balance", "0xabc"]).args.address).to.equal("0xabc");
      expect(() => live.parseArgs(["lock", "--bogus", "1"])).to.throw(/unknown flag/);
      expect(() => live.parseArgs(["nothing"])).to.throw(/usage/);
      expect(() => live.parseArgs(["lock", "--contract"])).to.throw(/needs a value/);
    });
  });

  describe("keygen and key files", () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-test-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("keygen writes a key file, prints only the address, refuses to overwrite", async () => {
      const file = path.join(dir, "nested", "bob.key");
      const r = await live.keygen(null, null, { out: file });
      const key = fs.readFileSync(file, "utf8");
      expect(key).to.match(/^0x[0-9a-f]{64}\n$/);
      expect(new ethers.Wallet(key.trim()).address).to.equal(r.address);
      expect(JSON.stringify(r)).to.not.include(key.trim());
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
      await expect(live.keygen(null, null, { out: file })).to.be.rejectedWith(/refusing to overwrite/);
      expect(fs.readFileSync(file, "utf8")).to.equal(key);
    });

    it("keygen via the CLI prints a single JSON object without the key", () => {
      const file = path.join(dir, "cli.key");
      const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "live.js"), "keygen", "--out", file], { encoding: "utf8" });
      const j = JSON.parse(out);
      expect(j.address).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(out).to.not.include(fs.readFileSync(file, "utf8").trim());
      const again = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "live.js"), "keygen", "--out", file], { encoding: "utf8" });
      expect(again.status).to.not.equal(0);
      expect(again.stderr).to.match(/refusing to overwrite/);
      expect(again.stdout).to.equal("");
    });

    it("loadSigner: a key-file wallet can fund-receive, lock and be refused on bad files", async () => {
      const file = path.join(dir, "k.key");
      const { address } = await live.keygen(null, null, { out: file });
      await live.send(provider, alice, { to: address, amountWei: ethers.parseEther("1").toString() });
      const w = live.loadSigner(provider, file);
      expect(await w.getAddress()).to.equal(address);
      const tReveal = String((await latestTs()) + HOUR);
      const l = await live.lock(provider, w, { ...tgt, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal, receiver: await bob.getAddress(), amountWei: "1000" });
      expect(l.sender).to.equal(address);

      fs.writeFileSync(path.join(dir, "bad.key"), "not a key\n");
      expect(() => live.loadSigner(provider, path.join(dir, "bad.key"))).to.throw(/0x" \+ 64 hex/);
      expect(() => live.loadSigner(provider, path.join(dir, "missing.key"))).to.throw(/not found/);
    });
  });
});

// ===========================================================================
// REVIEW-2 F1 / F3 / F4 / F7: the gates live.js re-applies by itself
// ===========================================================================
describe("live.js gates (REVIEW-2 F1, F3, F4, F7)", function () {
  this.timeout(180000);
  const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
  const amount = ethers.parseEther("0.2");
  let provider, alice, bob, carol, htlcAddr, htlcBlock, tgt, aliceAddr, bobAddr;

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const bal = (a) => provider.getBalance(a);
  const mine = (n = 1) => provider.send("hardhat_mine", ["0x" + n.toString(16)]);

  /** A provider whose listed members are replaced; everything else is the real in-process node. */
  const wrap = (over) =>
    new Proxy(provider, {
      get(t, prop) {
        if (Object.prototype.hasOwnProperty.call(over, prop)) return over[prop];
        const v = t[prop];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });

  async function newLock({ ttl = 2 * HOUR, signer = alice, receiver = bobAddr, hashlock, preimage = rand32() } = {}) {
    const hl = hashlock || sha256Raw(preimage);
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, signer, {
      ...tgt, contract: htlcAddr, hashlock: hl, tReveal: String(tReveal), receiver, amountWei: amount.toString(),
    });
    return { preimage, hashlock: hl, tReveal, ...l };
  }
  const base = (l) => ({ ...tgt, contract: htlcAddr, lockId: l.lockId });

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    [aliceAddr, bobAddr] = await Promise.all([alice.getAddress(), bob.getAddress()]);
    const d = await live.deploy(provider, alice, {});
    htlcAddr = d.contract;
    htlcBlock = d.blockNumber;
    tgt = { chainId: "31337", codeHash: d.codeHash };
  });

  // ------------------------------------------------------------------ F1
  describe("F1: the chain id is mandatory and the code hash is the artifact's, both verified before sending", () => {
    it("lock, claim and refund refuse to run without --chain-id, or with a malformed --chain-id or --code-hash", async () => {
      const l = await newLock();
      const lockArgs = { contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1" };
      const nonce = await provider.getTransactionCount(aliceAddr);
      for (const [fn, signer, a] of [
        ["lock", alice, lockArgs],
        ["claim", bob, { contract: htlcAddr, lockId: l.lockId, secret: l.preimage }],
        ["refund", alice, { contract: htlcAddr, lockId: l.lockId }],
      ]) {
        await expect(live[fn](provider, signer, { ...a, codeHash: tgt.codeHash }), `${fn} without chain id`).to.be.rejectedWith(/missing required --chain-id/);
        await expect(live[fn](provider, signer, { ...a, ...tgt, codeHash: "0x1234" }), `${fn} short hash`).to.be.rejectedWith(/--code-hash must be 0x followed by exactly 64 hex/);
        await expect(live[fn](provider, signer, { ...a, ...tgt, chainId: "abc" }), `${fn} bad chain id`).to.be.rejectedWith(/--chain-id must be a non-negative decimal/);
        await expect(live[fn](provider, signer, { ...a, codeHash: tgt.codeHash, dryRun: true }), `${fn} dry-run without chain id`).to.be.rejectedWith(/missing required --chain-id/);
      }
      expect(await provider.getTransactionCount(aliceAddr)).to.equal(nonce);
    });

    it("REVIEW-3 F1: an omitted --code-hash is the local artifact's hash; a given one must equal it; nothing is sent otherwise", async () => {
      const l = await newLock();
      const artifactHash = ethers.keccak256(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "HTLC.sol", "HTLC.json"), "utf8")).deployedBytecode);
      expect(tgt.codeHash).to.equal(artifactHash);
      const lockArgs = { contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1", chainId: "31337", dryRun: true };
      // Omitted: accepted, and the hash that was checked is the artifact's.
      expect((await live.lock(provider, alice, lockArgs)).codeHash).to.equal(artifactHash);
      expect((await live.claim(provider, bob, { contract: htlcAddr, lockId: l.lockId, chainId: "31337", secret: l.preimage, dryRun: true })).codeHash).to.equal(artifactHash);
      // Given and equal (any letter case): accepted.
      expect((await live.lock(provider, alice, { ...lockArgs, codeHash: artifactHash.toUpperCase().replace("0X", "0x") })).codeHash).to.equal(artifactHash);
      // Given and different (a well-formed hash of some other contract): refused, nothing sent.
      const nonce = await provider.getTransactionCount(aliceAddr);
      const other = ethers.keccak256("0x6001600155");
      const re = /--code-hash 0x[0-9a-f]{64} is not the code hash of this repo's compiled artifact, 0x[0-9a-f]{64}: a different value means a different contract; refusing/;
      for (const dryRun of [false, true]) {
        await expect(live.lock(provider, alice, { ...lockArgs, codeHash: other, dryRun })).to.be.rejectedWith(re);
        await expect(live.claim(provider, bob, { contract: htlcAddr, lockId: l.lockId, chainId: "31337", secret: l.preimage, codeHash: other, dryRun })).to.be.rejectedWith(re);
        await expect(live.refund(provider, alice, { contract: htlcAddr, lockId: l.lockId, chainId: "31337", codeHash: other, dryRun })).to.be.rejectedWith(re);
      }
      expect(await provider.getTransactionCount(aliceAddr)).to.equal(nonce);
    });

    it("REVIEW-3 F1: without a compiled artifact the command line says to run hardhat compile (no hash is guessed)", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-noartifact-"));
      try {
        fs.mkdirSync(path.join(tmp, "scripts"));
        const copy = path.join(tmp, "scripts", "live.js");
        fs.copyFileSync(SCRIPT, copy);
        const keyFile = path.join(tmp, "k.key");
        await live.keygen(null, null, { out: keyFile });
        const r = await new Promise((resolve) => {
          const child = spawn(process.execPath, [copy, "refund", "--key-file", keyFile, "--contract", htlcAddr, "--lock-id", rand32(), "--chain-id", "31337", "--dry-run"], {
            env: { ...process.env, NODE_PATH: path.join(__dirname, "..", "node_modules"), ETH_RPC_URL: "http://127.0.0.1:9" },
          });
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ code, err }));
        });
        expect(r.code).to.equal(1);
        expect(r.err).to.match(/HTLC artifact not found at .*; run "npx hardhat compile" in eth\/ first/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("a chain id that differs from the node's is refused by lock, claim and refund, also with --dry-run, and nothing is sent", async () => {
      const l = await newLock();
      const wrong = { ...tgt, chainId: "11155111" };
      const contractBal = await bal(htlcAddr);
      const nonceA = await provider.getTransactionCount(aliceAddr);
      const nonceB = await provider.getTransactionCount(bobAddr);
      const lockArgs = { ...wrong, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1" };
      for (const dryRun of [false, true]) {
        await expect(live.lock(provider, alice, { ...lockArgs, dryRun })).to.be.rejectedWith(/chain id mismatch: --chain-id is 11155111 but the RPC endpoint reports 31337/);
        await expect(live.claim(provider, bob, { ...wrong, contract: htlcAddr, lockId: l.lockId, secret: l.preimage, dryRun })).to.be.rejectedWith(/chain id mismatch/);
        await expect(live.refund(provider, alice, { ...wrong, contract: htlcAddr, lockId: l.lockId, dryRun })).to.be.rejectedWith(/chain id mismatch/);
      }
      expect(await bal(htlcAddr)).to.equal(contractBal);
      expect(await provider.getTransactionCount(aliceAddr)).to.equal(nonceA);
      expect(await provider.getTransactionCount(bobAddr)).to.equal(nonceB);
    });

    it("a code hash other than the artifact's is refused by lock, claim and refund, also with --dry-run", async () => {
      const l = await newLock();
      const wrong = { ...tgt, codeHash: ethers.keccak256("0x6001600155") };
      const contractBal = await bal(htlcAddr);
      const lockArgs = { ...wrong, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1" };
      for (const dryRun of [false, true]) {
        await expect(live.lock(provider, alice, { ...lockArgs, dryRun })).to.be.rejectedWith(/--code-hash 0x[0-9a-f]{64} is not the code hash of this repo's compiled artifact, 0x[0-9a-f]{64}.*different contract; refusing/);
        await expect(live.claim(provider, bob, { ...wrong, contract: htlcAddr, lockId: l.lockId, secret: l.preimage, dryRun })).to.be.rejectedWith(/not the code hash of this repo's compiled artifact/);
        await expect(live.refund(provider, alice, { ...wrong, contract: htlcAddr, lockId: l.lockId, dryRun })).to.be.rejectedWith(/not the code hash of this repo's compiled artifact/);
      }
      expect(await bal(htlcAddr)).to.equal(contractBal);
    });

    it("a look-alike contract (different code behind the same address as seen by the node) is refused", async () => {
      const l = await newLock();
      const lookalike = wrap({ getCode: async () => "0x60806040523480156100105760006000fd" });
      await expect(live.claim(lookalike, bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/code hash mismatch/);
      await expect(live.lock(lookalike, alice, { ...tgt, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1" })).to.be.rejectedWith(/code hash mismatch/);
    });

    it("an address with no code is refused", async () => {
      const nobody = await carol.getAddress();
      await expect(live.lock(provider, alice, { ...tgt, contract: nobody, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1" })).to.be.rejectedWith(/no contract code at/);
    });

    it("mainnet is still refused, by --chain-id 1 and by a node that says it is chain 1", async () => {
      const l = await newLock();
      await expect(live.claim(provider, bob, { ...base(l), chainId: "1", secret: l.preimage, dryRun: true })).to.be.rejectedWith(/mainnet/);
      const mainnetNode = wrap({
        send: async (m, p) => (m === "eth_chainId" ? "0x1" : provider.send(m, p)),
        getNetwork: async () => ({ chainId: 1n }),
      });
      await expect(live.refund(mainnetNode, alice, { ...base(l), chainId: "1", dryRun: true })).to.be.rejectedWith(/mainnet/);
      await expect(live.refund(mainnetNode, alice, { ...base(l), chainId: "31337", dryRun: true })).to.be.rejectedWith(/mainnet/);
    });

    it("status prints the chain id and code hash to copy into the flags", async () => {
      const l = await newLock();
      const s = await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId });
      expect(s.chainId).to.equal(tgt.chainId);
      expect(s.codeHash).to.equal(tgt.codeHash);
      expect(s.scannedFromBlock).to.equal(htlcBlock);
    });
  });

  // ------------------------------------------------------------------ F3: claim
  describe("F3: claim re-applies the reveal cutoff and the finality gate", () => {
    it("refuses inside the margin (default 1800 s), also with --dry-run, and the lock stays open", async () => {
      const l = await newLock({ ttl: 1000 });
      const before = await bal(bobAddr);
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff.*margin 1800 s/);
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage })).to.be.rejectedWith(/past the reveal cutoff/);
      expect(await bal(bobAddr)).to.be.lte(before);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("--margin-s moves the cutoff: 900 s passes a 1000 s lock, 1100 s does not, 0 allows the last moment", async () => {
      const l = await newLock({ ttl: 1000 });
      const ok = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, marginS: "900" });
      expect(ok.marginS).to.equal("900");
      expect(ok.revealCutoff).to.equal((BigInt(l.tReveal) - 900n).toString());
      expect(BigInt(ok.secondsToCutoff)).to.be.gt(0n);
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, marginS: "1100" })).to.be.rejectedWith(/past the reveal cutoff/);
      const zero = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, marginS: "0" });
      expect(zero.revealCutoff).to.equal(String(l.tReveal));
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, marginS: "-5" })).to.be.rejectedWith(/--margin-s must be a non-negative decimal integer/);
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, marginS: "soon" })).to.be.rejectedWith(/--margin-s/);
    });

    it("the default plan shows margin 1800, the cutoff, and the lock and finalized blocks", async () => {
      const l = await newLock();
      const p = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true });
      expect(p.marginS).to.equal("1800");
      expect(p.revealCutoff).to.equal((BigInt(l.tReveal) - 1800n).toString());
      expect(p.lockedBlock).to.equal(l.blockNumber);
      expect(p.finalizedBlock).to.be.gte(l.blockNumber);
      expect(p.chainId).to.equal("31337");
      expect(p.codeHash).to.equal(tgt.codeHash);
      expect(p.receiver).to.equal(bobAddr);
    });

    it("refuses while the lock's block is above the finalized block, accepts once they meet", async () => {
      const l = await newLock();
      await mine(2);
      const at = (n) => wrap({ getBlock: async (tag, ...r) => (tag === "finalized" ? { number: n, timestamp: 0 } : provider.getBlock(tag, ...r)) });
      await expect(live.claim(at(l.blockNumber - 1), bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/lock is not final yet.*Locked in block \d+, finalized block is \d+/);
      await expect(live.claim(at(l.blockNumber - 1), bob, { ...base(l), secret: l.preimage })).to.be.rejectedWith(/not final yet/);
      const ok = await live.claim(at(l.blockNumber), bob, { ...base(l), secret: l.preimage, dryRun: true });
      expect(ok.finalizedBlock).to.equal(l.blockNumber);
      expect(ok.lockedBlock).to.equal(l.blockNumber);
    });

    // The reveal cutoff is checked again immediately before signing: the scans, the finality lookup and the fee planning in between can take
    // minutes on a slow endpoint. The passage of time is simulated by a provider whose `finalized` lookup (the step after the early check)
    // mines a block with a later timestamp, or moves the mocked wall clock.
    describe("the cutoff is re-checked just before sending", () => {
      const chainClock = (ts) =>
        wrap({
          getBlock: async (tag, ...r) => {
            if (tag === "finalized") {
              await provider.send("evm_setNextBlockTimestamp", ["0x" + ts.toString(16)]);
              await provider.send("evm_mine", []);
            }
            return provider.getBlock(tag, ...r);
          },
        });
      const wallClock = (ts) =>
        wrap({
          getBlock: async (tag, ...r) => {
            if (tag === "finalized") Date.now = () => ts * 1000;
            return provider.getBlock(tag, ...r);
          },
        });
      const realNow = Date.now;
      afterEach(() => {
        Date.now = realNow;
      });
      const nonceOf = (a) => provider.getTransactionCount(a, "latest");

      it("a chain clock past the cutoff at send time refuses, sends nothing, and the lock stays open", async () => {
        const l = await newLock();
        const cutoff = l.tReveal - 1800;
        const n0 = await nonceOf(bobAddr);
        await expect(live.claim(chainClock(cutoff + 10), bob, { ...base(l), secret: l.preimage })).to.be.rejectedWith(
          new RegExp(`past the reveal cutoff. now ${cutoff + 10} > cutoff ${cutoff} .*re-checked just before sending.*nothing was sent`)
        );
        expect(await nonceOf(bobAddr)).to.equal(n0);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      });

      it("a wall clock past the cutoff at send time refuses too", async () => {
        const l = await newLock();
        const cutoff = l.tReveal - 1800;
        const n0 = await nonceOf(bobAddr);
        try {
          await expect(live.claim(wallClock(cutoff + 10), bob, { ...base(l), secret: l.preimage })).to.be.rejectedWith(/past the reveal cutoff.*re-checked just before sending/);
        } finally {
          Date.now = realNow;
        }
        expect(await nonceOf(bobAddr)).to.equal(n0);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      });

      it("a latest block at the timelock at send time refuses even when the cutoff equals the timelock (--margin-s 0)", async () => {
        const l = await newLock();
        const n0 = await nonceOf(bobAddr);
        await expect(live.claim(chainClock(l.tReveal), bob, { ...base(l), marginS: "0", secret: l.preimage })).to.be.rejectedWith(
          /timelock \d+ has passed.*re-checked just before sending.*nothing was sent/
        );
        expect(await nonceOf(bobAddr)).to.equal(n0);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.not.equal("claimed");
      });

      it("a clock inside the cutoff at send time claims as before", async () => {
        const l = await newLock();
        const cutoff = l.tReveal - 1800;
        const r = await live.claim(chainClock(cutoff - 60), bob, { ...base(l), secret: l.preimage });
        expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
      });

      it("a latest block that cannot be read at send time refuses (fail closed) and sends nothing", async () => {
        const l = await newLock();
        let latestReads = 0;
        const p = wrap({
          getBlock: async (tag, ...r) => {
            if (tag === "latest" && ++latestReads > 1) throw new Error("socket hang up");
            return provider.getBlock(tag, ...r);
          },
        });
        const n0 = await nonceOf(bobAddr);
        await expect(live.claim(p, bob, { ...base(l), secret: l.preimage })).to.be.rejectedWith(/could not re-read the latest block just before sending.*nothing was sent/);
        expect(await nonceOf(bobAddr)).to.equal(n0);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      });

      it("--dry-run never runs the guard and reports the same fields", async () => {
        const l = await newLock();
        const cutoff = l.tReveal - 1800;
        const plain = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true });
        let latestReads = 0;
        const counting = wrap({
          getBlock: async (tag, ...r) => {
            if (tag === "latest") latestReads++;
            return provider.getBlock(tag, ...r);
          },
        });
        await live.claim(counting, bob, { ...base(l), secret: l.preimage, dryRun: true });
        const readsDry = latestReads;
        // a clock that jumps past the cutoff after the early check changes nothing in a dry run
        const jumped = await live.claim(chainClock(cutoff + 10), bob, { ...base(l), secret: l.preimage, dryRun: true });
        for (const o of [plain, jumped]) {
          expect(o.dryRun).to.equal(true);
          expect(o.sent).to.equal(false);
        }
        const strip = (o) => {
          const { secondsToCutoff, finalizedBlock, ...rest } = o;
          return rest;
        };
        expect(strip(jumped)).to.deep.equal(strip(plain));
        // the real claim reads the latest block exactly once more than the dry run (the guard)
        latestReads = 0;
        const l2 = await newLock();
        await live.claim(counting, bob, { ...base(l2), secret: l2.preimage });
        expect(latestReads).to.equal(readsDry + 1);
      });
    });

    it("refuses when the node cannot answer the `finalized` tag", async () => {
      const l = await newLock();
      const throws = wrap({ getBlock: async (tag, ...r) => { if (tag === "finalized") throw new Error("invalid block tag"); return provider.getBlock(tag, ...r); } });
      const nulls = wrap({ getBlock: async (tag, ...r) => (tag === "finalized" ? null : provider.getBlock(tag, ...r)) });
      await expect(live.claim(throws, bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/`finalized` block tag/);
      await expect(live.claim(nulls, bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/`finalized` block tag/);
    });

    it("refuses when no Locked event is found (for example --from-block above the lock)", async () => {
      const l = await newLock();
      await mine(1);
      await expect(live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, fromBlock: String(l.blockNumber + 1) })).to.be.rejectedWith(/no Locked event for 0x[0-9a-f]{64} found in blocks/);
      const ok = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true, fromBlock: String(l.blockNumber) });
      expect(ok.lockedBlock).to.equal(l.blockNumber);
    });

    it("refuses when the Locked event disagrees with getLock()", async () => {
      const l = await newLock();
      const iface = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/HTLC.sol/HTLC.json"))).abi);
      const liar = wrap({
        getLogs: async (f) => {
          const logs = await provider.getLogs(f);
          return logs.map((lg) => {
            const p = iface.parseLog(lg);
            // re-encode the event data with a different amount
            const enc = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "uint256"], [p.args.amount + 1n, p.args.hashlock, p.args.timelock]);
            return { ...lg, data: enc, address: lg.address, topics: lg.topics, blockNumber: lg.blockNumber, index: lg.index, transactionHash: lg.transactionHash };
          });
        },
      });
      await expect(live.claim(liar, bob, { ...base(l), secret: l.preimage, dryRun: true })).to.be.rejectedWith(/disagrees with getLock/);
    });

    it("still sends a real claim when every gate passes, and --confirmations keeps working", async () => {
      const l = await newLock();
      const before = await bal(bobAddr);
      // a second confirmation needs another block: Hardhat only mines on demand, so mine one shortly after the send
      const miner = new Promise((r) => setTimeout(r, 1500)).then(() => mine(1));
      const [c] = await Promise.all([live.claim(provider, carol, { ...base(l), secret: l.preimage, confirmations: 2 }), miner]);
      expect(c.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(bobAddr)).to.equal(before + amount);
    });
  });

  // ------------------------------------------------------------------ F3: lock
  describe("F3: lock refuses a second lock of its own sender under the same hashlock", () => {
    const lockArgs = async (hashlock, extra = {}) => ({
      ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: bobAddr, amountWei: "1000", ...extra,
    });

    it("a second lock from the same sender with the same hashlock but another timelock is refused, in dry-run too, and nothing is sent", async () => {
      const first = await newLock();
      const nonce = await provider.getTransactionCount(aliceAddr);
      const contractBal = await bal(htlcAddr);
      const second = await lockArgs(first.hashlock, { tReveal: String(first.tReveal + 60) });
      await expect(live.lock(provider, alice, second)).to.be.rejectedWith(new RegExp(`Locked event for hashlock ${first.hashlock} from this sender ${aliceAddr} already exists \\(lockId ${first.lockId}`));
      await expect(live.lock(provider, alice, { ...second, dryRun: true })).to.be.rejectedWith(/already exists/);
      expect(await provider.getTransactionCount(aliceAddr)).to.equal(nonce);
      expect(await bal(htlcAddr)).to.equal(contractBal);
    });

    it("another sender's lock under the same hashlock does not block it; it is reported in the result and on stderr", async () => {
      const first = await newLock({ signer: bob, receiver: aliceAddr });
      const notes = [];
      const orig = process.stderr.write;
      process.stderr.write = (chunk, ...rest) => { notes.push(String(chunk)); return true; };
      let dry, real;
      try {
        dry = await live.lock(provider, alice, { ...(await lockArgs(first.hashlock)), dryRun: true });
        real = await live.lock(provider, alice, await lockArgs(first.hashlock));
      } finally {
        process.stderr.write = orig;
      }
      const expected = [{ sender: bobAddr, lockId: first.lockId, blockNumber: first.blockNumber }];
      expect(dry.foreignLocksSameHashlock).to.deep.equal(expected);
      expect(real.foreignLocksSameHashlock).to.deep.equal(expected);
      expect(real.sender).to.equal(aliceAddr);
      expect(real.lockId).to.equal(dry.expectedLockId);
      expect(notes.length).to.equal(2);
      for (const n of notes) {
        expect(n).to.match(/^note: 1 Locked event\(s\) from other sender\(s\) already exist under hashlock /);
        expect(n).to.include(first.lockId);
      }
      // the foreign lock is not ours: a second lock of Alice's under that hashlock is now refused
      await expect(live.lock(provider, alice, await lockArgs(first.hashlock, { tReveal: String((await latestTs()) + 2 * HOUR) }))).to.be.rejectedWith(/from this sender .* already exists/);
    });

    it("a fresh hashlock reports no foreign locks and writes no note", async () => {
      const notes = [];
      const orig = process.stderr.write;
      process.stderr.write = (chunk, ...rest) => { notes.push(String(chunk)); return true; };
      let dry;
      try {
        dry = await live.lock(provider, alice, { ...(await lockArgs(sha256Raw(rand32()))), dryRun: true });
      } finally {
        process.stderr.write = orig;
      }
      expect(dry.foreignLocksSameHashlock).to.deep.equal([]);
      expect(notes).to.deep.equal([]);
    });

    it("a fresh hashlock is accepted; the result and the dry-run report what was scanned", async () => {
      await newLock();
      const hl = sha256Raw(rand32());
      const dry = await live.lock(provider, alice, { ...(await lockArgs(hl)), dryRun: true });
      expect(dry.lockedEventsScanned).to.equal(1);
      expect(dry.scannedFromBlock).to.equal(htlcBlock);
      expect(dry.codeHash).to.equal(tgt.codeHash);
      const real = await live.lock(provider, alice, await lockArgs(hl));
      expect(real.chainId).to.equal("31337");
      expect(real.lockId).to.equal(dry.expectedLockId);
    });

    it("the exact lockId is also refused by state when the log scan cannot see it", async () => {
      const first = await newLock();
      await mine(1);
      const same = await lockArgs(first.hashlock, { tReveal: String(first.tReveal), amountWei: amount.toString() });
      await expect(live.lock(provider, alice, { ...same, fromBlock: String(first.blockNumber + 1) })).to.be.rejectedWith(/lock 0x[0-9a-f]{64} already exists at /);
    });

    it("a --from-block beyond the latest block is refused", async () => {
      const latest = (await provider.getBlock("latest")).number;
      await expect(live.lock(provider, alice, { ...(await lockArgs(sha256Raw(rand32()))), fromBlock: String(latest + 5) })).to.be.rejectedWith(/beyond the latest block/);
    });

    it("scans in eth_getLogs ranges of at most 50,000 blocks and still finds a lock 100,000 blocks back", async () => {
      const snap = await provider.send("evm_snapshot", []);
      try {
        const first = await newLock();
        await mine(100010);
        const calls = [];
        const rec = wrap({ getLogs: async (f) => { calls.push(f); return provider.getLogs(f); } });
        await expect(live.lock(rec, alice, { ...(await lockArgs(first.hashlock, { tReveal: String((await latestTs()) + HOUR) })), fromBlock: "0" })).to.be.rejectedWith(/already exists/);
        expect(calls.length).to.be.gte(3);
        for (const f of calls) expect(f.toBlock - f.fromBlock + 1).to.be.lte(50000);
        expect(calls[0].fromBlock).to.equal(0);
        for (let i = 1; i < calls.length; i++) expect(calls[i].fromBlock).to.equal(calls[i - 1].toBlock + 1);
      } finally {
        await provider.send("evm_revert", [snap]);
      }
    });

    it("getLogsChunked covers [from, to] exactly in <= 50,000-block ranges", async () => {
      const calls = [];
      const fake = { getLogs: async (f) => { calls.push([f.fromBlock, f.toBlock]); return [{ b: f.fromBlock }]; } };
      const out = await live.getLogsChunked(fake, { address: "0x0" }, 0, 120000);
      expect(calls).to.deep.equal([[0, 49999], [50000, 99999], [100000, 120000]]);
      expect(out).to.have.length(3);
      calls.length = 0;
      await live.getLogsChunked(fake, {}, 7, 7);
      expect(calls).to.deep.equal([[7, 7]]);
      calls.length = 0;
      await live.getLogsChunked(fake, {}, 8, 7);
      expect(calls).to.deep.equal([]);
      calls.length = 0;
      await live.getLogsChunked(fake, {}, 0, 49999);
      expect(calls).to.deep.equal([[0, 49999]]);
      expect(live.LOG_RANGE_MAX).to.equal(50000);
    });

    it("findDeploymentBlock finds the deployment block; a node without history makes the scan start at 0", async () => {
      await mine(5);
      const latest = (await provider.getBlock("latest")).number;
      expect(await live.findDeploymentBlock(provider, htlcAddr, latest)).to.equal(htlcBlock);
      expect(await live.findDeploymentBlock(provider, await carol.getAddress(), latest)).to.equal(null);
      const noHistory = wrap({ getCode: async (a, tag) => { if (tag !== undefined && tag !== "latest") throw new Error("missing trie node"); return provider.getCode(a, tag); } });
      expect(await live.findDeploymentBlock(noHistory, htlcAddr, latest)).to.equal(null);
      const dry = await live.lock(noHistory, alice, { ...(await lockArgs(sha256Raw(rand32()))), dryRun: true });
      expect(dry.scannedFromBlock).to.equal(0);
    });
  });

  // ------------------------------------------------------------------ F7: refund
  describe("F7: refund needs a present, unclaimed, unrefunded lock whose timelock has passed", () => {
    it("refuses an unknown lock, a claimed lock, a refunded lock, and an early refund; accepts after the timelock", async () => {
      const unknown = { ...tgt, contract: htlcAddr, lockId: rand32() };
      await expect(live.refund(provider, alice, unknown)).to.be.rejectedWith(/no such lock/);
      await expect(live.refund(provider, alice, { ...unknown, dryRun: true })).to.be.rejectedWith(/no such lock/);

      const claimed = await newLock({ ttl: HOUR });
      await live.claim(provider, bob, { ...base(claimed), secret: claimed.preimage, marginS: "0" });
      const open = await newLock({ ttl: HOUR });
      await expect(live.refund(provider, alice, base(open))).to.be.rejectedWith(/too early/);
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      await expect(live.refund(provider, alice, base(claimed))).to.be.rejectedWith(/already claimed/);
      await expect(live.refund(provider, alice, { ...base(claimed), dryRun: true })).to.be.rejectedWith(/already claimed/);

      const dry = await live.refund(provider, alice, { ...base(open), dryRun: true });
      expect(dry.codeHash).to.equal(tgt.codeHash);
      expect(dry.lockId).to.equal(open.lockId);
      const r = await live.refund(provider, alice, base(open));
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      await expect(live.refund(provider, alice, base(open))).to.be.rejectedWith(/already refunded/);
    });
  });

  // ------------------------------------------------------------------ F4
  describe("F4: the secret never appears on argv, in output or in errors", () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-gates-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("--preimage and --secret are refused by the parser without echoing the value", () => {
      const secret = rand32();
      for (const flag of ["--preimage", "--secret"]) {
        let err;
        try {
          live.parseArgs(["claim", "--contract", "0x" + "11".repeat(20), flag, secret]);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(live.UserError);
        expect(err.message).to.match(/was removed.*--secret-stdin.*--secret-file/);
        expect(err.message).to.not.include(secret.slice(2));
      }
      // a stray positional that looks like a secret is not echoed either
      const secret2 = rand32();
      let err2;
      try {
        live.parseArgs(["claim", secret2]);
      } catch (e) {
        err2 = e;
      }
      expect(err2.message).to.not.include(secret2.slice(2));
      const { args } = live.parseArgs(["claim", "--secret-stdin", "--margin-s", "60", "--secret-file", "f", "--chain-id", "1", "--code-hash", "0x00", "--from-block", "3"]);
      expect(args).to.deep.equal({ secretStdin: true, marginS: "60", secretFile: "f", chainId: "1", codeHash: "0x00", fromBlock: "3" });
    });

    it("a real claim needs the secret, from stdin or a file", async () => {
      const l = await newLock();
      const before = await bal(bobAddr);
      await expect(live.claim(provider, bob, base(l))).to.be.rejectedWith(/claim needs the secret: pipe it to --secret-stdin or pass --secret-file/);
      expect(await bal(bobAddr)).to.be.lte(before);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("--dry-run works without any secret: it prints the plan, no gas estimate, no calldata", async () => {
      const l = await newLock();
      const p = await live.claim(provider, bob, { ...base(l), dryRun: true });
      expect(p.dryRun).to.equal(true);
      expect(p.sent).to.equal(false);
      expect(p.gasEstimate).to.equal(null);
      expect(p.gasEstimateNote).to.match(/^not estimated/);
      expect(p.secretProvided).to.equal(false);
      expect(p.data).to.equal(undefined);
      expect(p).to.include({ lockId: l.lockId, chainId: "31337", to: htlcAddr, receiver: bobAddr, hashlock: l.hashlock });
      expect(p.timelock).to.equal(String(l.tReveal));
      expect(p.revealCutoff).to.equal((BigInt(l.tReveal) - 1800n).toString());
      expect(p.lockedBlock).to.equal(l.blockNumber);
      expect(p.codeHash).to.equal(tgt.codeHash);
      expect(JSON.stringify(p)).to.not.include(l.preimage.slice(2));
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("--dry-run without a secret still applies every gate", async () => {
      const l = await newLock({ ttl: 1000 });
      await expect(live.claim(provider, bob, { ...base(l), dryRun: true })).to.be.rejectedWith(/past the reveal cutoff/);
      await expect(live.claim(provider, bob, { ...base(l), dryRun: true, codeHash: ethers.keccak256("0x00") })).to.be.rejectedWith(/not the code hash of this repo's compiled artifact/);
    });

    it("--dry-run with a secret uses the fixed gas limit (never an estimate: REVIEW-6 R6-8), checks the hashlock, and prints neither the secret nor the calldata", async () => {
      const l = await newLock();
      const p = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true });
      expect(p.gasEstimate).to.equal(null);
      expect(p.gasLimit).to.equal("200000");
      expect(p.gasEstimateNote).to.match(/fixed gas limit/);
      expect(p.secretProvided).to.equal(true);
      expect(p.data).to.equal(undefined);
      expect(p.dataLength).to.equal(4 + 32 + 32);
      expect(JSON.stringify(p)).to.not.include(l.preimage.slice(2));
      await expect(live.claim(provider, bob, { ...base(l), secret: rand32(), dryRun: true })).to.be.rejectedWith(/sha256\(secret\) = 0x[0-9a-f]{64} but the lock's hashlock is 0x[0-9a-f]{64}/);
    });

    it("a wrong secret is refused naming only digests, never the secret itself", async () => {
      const l = await newLock();
      const wrongSecret = rand32();
      let err;
      try {
        await live.claim(provider, bob, { ...base(l), secret: wrongSecret });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.match(/^refusing: sha256\(secret\) = 0x[0-9a-f]{64} but the lock's hashlock is 0x[0-9a-f]{64}$/);
      expect(err.message).to.include(sha256Raw(wrongSecret));
      expect(err.message).to.not.include(wrongSecret.slice(2));
      expect(err.message).to.not.include(l.preimage.slice(2));
    });

    it("--secret-file: claims, prints neither the secret nor the file contents, rejects bad files", async () => {
      const l = await newLock();
      const file = path.join(dir, "secret.txt");
      fs.writeFileSync(file, l.preimage + "\n");
      const before = await bal(bobAddr);
      const dry = await live.claim(provider, carol, { ...base(l), secretFile: file, dryRun: true });
      expect(dry.secretProvided).to.equal(true);
      const c = await live.claim(provider, carol, { ...base(l), secretFile: file });
      expect(await bal(bobAddr)).to.equal(before + amount);
      expect(JSON.stringify(dry)).to.not.include(l.preimage.slice(2));
      expect(JSON.stringify(c)).to.not.include(l.preimage.slice(2));

      const junk = "this is not a secret but it is a very particular line of text";
      fs.writeFileSync(path.join(dir, "junk.txt"), junk + "\n");
      let err;
      try {
        await live.claim(provider, carol, { ...base(l), secretFile: path.join(dir, "junk.txt") });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.match(/--secret-file must be 0x followed by exactly 64 hex/);
      expect(err.message).to.not.include(junk);
      await expect(live.claim(provider, carol, { ...base(l), secretFile: path.join(dir, "missing.txt") })).to.be.rejectedWith(/secret file not found/);
      await expect(live.claim(provider, carol, { ...base(l), secretFile: file, secret: l.preimage })).to.be.rejectedWith(/exactly one of/);
      await expect(live.claim(provider, carol, { ...base(l), secretFile: file, secretStdin: true })).to.be.rejectedWith(/exactly one of/);
    });

    it("an error from the node that carries the calldata is scrubbed", async () => {
      const l = await newLock();
      const leaky = {
        getAddress: async () => bobAddr,
        // REVIEW-6 R6-8: the claim is never estimated, so the node's complaint can only come from the send; and an estimate would be a bug.
        estimateGas: async () => { throw new Error("estimateGas must not be called for a claim"); },
        sendTransaction: async (req) => { throw new Error(`node refused the transaction, data=${req.data}`); },
      };
      let err;
      try {
        await live.claim(provider, leaky, { ...base(l), secret: l.preimage });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(live.UserError);
      expect(err.message).to.match(/node refused the transaction/);
      expect(err.message).to.not.match(/estimateGas must not be called/);
      expect(err.message).to.not.include(l.preimage.slice(2));
      expect(live.redact(`x ${l.preimage} y ${l.preimage.slice(2).toUpperCase()}`)).to.equal("x 0x[secret redacted] y [secret redacted]");
    });

    describe("the command line, end to end (a JSON-RPC bridge to the in-process node)", () => {
      let server, url;
      before(async () => {
        const handle = async (rq) => {
          try {
            return { jsonrpc: "2.0", id: rq.id, result: await hre.network.provider.send(rq.method, rq.params || []) };
          } catch (e) {
            return { jsonrpc: "2.0", id: rq.id, error: { code: e.code || -32603, message: e.message, data: typeof e.data === "string" ? e.data : e.data && e.data.data } };
          }
        };
        server = http.createServer((req, res) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const out = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(out));
          });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${server.address().port}`;
      });
      after(async () => {
        await new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
      });

      const cli = (args, input) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ETH_RPC_URL: url } });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ code, out, err }));
          child.stdin.end(input === undefined ? "" : input);
        });

      it("claim --secret-stdin sends the claim; nothing printed contains the secret; --dry-run needs no secret", async () => {
        const l = await newLock();
        const keyFile = path.join(dir, "claimer.key");
        const { address } = await live.keygen(null, null, { out: keyFile });
        await live.send(provider, alice, { to: address, amountWei: ethers.parseEther("1").toString() });
        const flags = ["--key-file", keyFile, "--contract", htlcAddr, "--lock-id", l.lockId, "--chain-id", "31337", "--code-hash", tgt.codeHash];

        const dry = await cli(["claim", ...flags, "--dry-run"]);
        expect(dry.code, dry.err).to.equal(0);
        const plan = JSON.parse(dry.out);
        expect(plan.gasEstimate).to.equal(null);
        expect(plan.secretProvided).to.equal(false);

        const dry2 = await cli(["claim", ...flags, "--dry-run", "--secret-stdin"], l.preimage + "\n");
        expect(dry2.code, dry2.err).to.equal(0);
        expect(JSON.parse(dry2.out).gasLimit).to.equal("200000"); // fixed, not estimated (REVIEW-6 R6-8)

        const none = await cli(["claim", ...flags]);
        expect(none.code).to.equal(1);
        expect(none.err).to.match(/claim needs the secret/);

        const bad = await cli(["claim", ...flags, "--secret-stdin"], "not-hex-at-all-but-private\n");
        expect(bad.code).to.equal(1);
        expect(bad.err).to.match(/--secret-stdin must be 0x followed by exactly 64 hex/);
        expect(bad.err).to.not.include("not-hex-at-all-but-private");

        const gone = await cli(["claim", ...flags, "--preimage", l.preimage]);
        expect(gone.code).to.equal(1);
        expect(gone.err).to.match(/was removed/);
        expect(gone.out).to.equal("");
        expect(gone.err).to.not.include(l.preimage.slice(2));

        const before = await bal(bobAddr);
        const real = await cli(["claim", ...flags, "--secret-stdin"], l.preimage + "\n");
        expect(real.code, real.err).to.equal(0);
        expect(JSON.parse(real.out).txHash).to.match(/^0x[0-9a-f]{64}$/);
        for (const text of [dry.out, dry.err, dry2.out, dry2.err, real.out, real.err]) expect(text).to.not.include(l.preimage.slice(2));
        expect(await bal(bobAddr)).to.equal(before + amount);
        const s = await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId });
        expect(s.state).to.equal("claimed");
      });

      it("lock and refund over the CLI need --chain-id; --code-hash is optional and must equal the artifact's", async () => {
        const keyFile = path.join(dir, "k.key");
        const { address } = await live.keygen(null, null, { out: keyFile });
        await live.send(provider, alice, { to: address, amountWei: ethers.parseEther("1").toString() });
        const lockFlags = ["--key-file", keyFile, "--contract", htlcAddr, "--hashlock", sha256Raw(rand32()), "--t-reveal", String((await latestTs()) + HOUR), "--receiver", bobAddr, "--amount-wei", "1000"];
        const missing = await cli(["lock", ...lockFlags, "--dry-run"]);
        expect(missing.code).to.equal(1);
        expect(missing.err).to.match(/missing required --chain-id/);
        const wrongChain = await cli(["lock", ...lockFlags, "--chain-id", "1", "--code-hash", tgt.codeHash, "--dry-run"]);
        expect(wrongChain.err).to.match(/mainnet/);
        const ok = await cli(["lock", ...lockFlags, "--chain-id", "31337", "--code-hash", tgt.codeHash, "--dry-run"]);
        expect(ok.code, ok.err).to.equal(0);
        expect(JSON.parse(ok.out).codeHash).to.equal(tgt.codeHash);
        const omitted = await cli(["lock", ...lockFlags, "--chain-id", "31337", "--dry-run"]);
        expect(omitted.code, omitted.err).to.equal(0);
        expect(JSON.parse(omitted.out).codeHash).to.equal(tgt.codeHash);
        const refundWrong = await cli(["refund", "--key-file", keyFile, "--contract", htlcAddr, "--lock-id", rand32(), "--chain-id", "31337", "--code-hash", ethers.keccak256("0x00")]);
        expect(refundWrong.code).to.equal(1);
        expect(refundWrong.err).to.match(/not the code hash of this repo's compiled artifact/);
      });
    });
  });
});

// ===========================================================================
// REVIEW-3 F3: lock / claim / refund tied to the swap file (--swap FILE)
// ===========================================================================
describe("live.js --swap FILE (REVIEW-3 F3)", function () {
  this.timeout(180000);
  const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
  const amount = ethers.parseEther("0.2");
  let provider, alice, bob, carol, htlcAddr, tgt, aliceAddr, bobAddr, carolAddr, dir, preimage, hashlock, nSwap;

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const bal = (a) => provider.getBalance(a);
  const nonce = (a) => provider.getTransactionCount(a);

  /** A swap file with only the parts live.js reads (plus a `secret` it must never touch). Returns its path. */
  function swapFile({ intent = null, eth = {}, hash, ethFromBlock, profile, history } = {}) {
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock: hash || hashlock,
        claim_authority: "o1test",
        params: {
          ...(profile !== undefined ? { profile } : {}), // as swap-cli stores it: absent for production
          eth: {
            chain_id: 31337,
            contract: htlcAddr.toLowerCase(),
            code_hash: tgt.codeHash,
            amount_wei: amount.toString(),
            alice_receiver: aliceAddr.toLowerCase(),
            bob_sender: bobAddr.toLowerCase(),
            ...eth,
          },
        },
      },
      secret: { ciphertext: "not-read-by-live.js" },
    };
    if (intent) j.pending_intent = intent;
    if (ethFromBlock !== undefined) j.eth_from_block = ethFromBlock;
    if (history !== undefined) j.history = history;
    const file = path.join(dir, `swap-${nSwap++}.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }
  const wrapIntent = (action, params) => ({ action, params: { action, ...params }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 });
  const lockIntent = (tReveal, over = {}) =>
    wrapIntent("lock_eth", { hashlock, t_reveal: tReveal, receiver: aliceAddr.toLowerCase(), amount_wei: amount.toString(), ...over });
  const revealIntent = (lockId, tReveal, cutoff) => wrapIntent("reveal_eth", { lock_id: lockId, t_reveal: tReveal, cutoff });
  const refundIntent = (lockId) => wrapIntent("refund_eth", { lock_id: lockId });

  /** A lock made directly (no --swap), by `signer` for `receiver`. */
  async function makeLock({ signer = bob, receiver = aliceAddr, hash = hashlock, ttl = 2 * HOUR, value = amount } = {}) {
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, signer, { ...tgt, contract: htlcAddr, hashlock: hash, tReveal: String(tReveal), receiver, amountWei: value.toString() });
    return { tReveal, ...l };
  }

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    [aliceAddr, bobAddr, carolAddr] = await Promise.all([alice.getAddress(), bob.getAddress(), carol.getAddress()]);
    const d = await live.deploy(provider, carol, {});
    htlcAddr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    preimage = rand32();
    hashlock = sha256Raw(preimage);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-swap-"));
    nSwap = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // ------------------------------------------------------------------ lock
  describe("lock", () => {
    it("takes every term from the file; --dry-run and the real send agree, and the lock id is the file's terms", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const swap = swapFile({ intent: lockIntent(tReveal) });
      const dry = await live.lock(provider, bob, { swap, dryRun: true });
      const want = live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal));
      expect(dry.expectedLockId).to.equal(want);
      expect(dry.valueWei).to.equal(amount.toString());
      const n = await nonce(bobAddr);
      const real = await lockApproved(provider, bob, { swap });
      expect(real.lockId).to.equal(want);
      expect(await nonce(bobAddr)).to.equal(n + 1);
      const s = await live.status(provider, null, { contract: htlcAddr, lockId: want });
      expect(s.lock.receiver).to.equal(aliceAddr);
      expect(s.lock.timelock).to.equal(String(tReveal));
    });

    describe("the approval of a fresh check (an outside read, 2026-11-10)", () => {
      const NO_APPROVAL = /needs the approval of a fresh read-only `swap-cli tick`.*(?:is|are) missing.*scripts\/live\/lock\.sh.*do not call live\.js lock directly.*Nothing was sent/s;
      const lockFileOf = (swap) => swap + live.LOCK_LOCK_SUFFIX;
      const recordOf = (swap) => swap + live.LOCK_SENT_SUFFIX;
      async function fresh(decidedAt = undefined) {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const intent = lockIntent(tReveal);
        if (decidedAt !== undefined) intent.decided_at = decidedAt;
        return { tReveal, swap: swapFile({ intent }) };
      }
      const nothingSent = async (swap, n) => {
        expect(await nonce(bobAddr)).to.equal(n);
        expect(fs.existsSync(recordOf(swap)), "no lock record").to.equal(false);
        expect(fs.existsSync(lockFileOf(swap)), "the lock lock is let go").to.equal(false);
      };

      it("a real lock needs all three values: with any missing it refuses and sends nothing; the message says to use lock.sh", async () => {
        const { swap } = await fresh();
        const n = await nonce(bobAddr);
        const ap = approvalOf(swap);
        await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(NO_APPROVAL);
        for (const drop of ["approvedIntent", "approvedTerms", "approvedAt"]) {
          const part = { ...ap };
          delete part[drop];
          await expect(live.lock(provider, bob, { swap, ...part }), drop).to.be.rejectedWith(NO_APPROVAL);
          await expect(live.lock(provider, bob, { swap, ...part, [drop]: "" }), drop).to.be.rejectedWith(NO_APPROVAL);
        }
        await nothingSent(swap, n);
      });

      it("another intent's decided_at refuses, and the message does not print the file's own value", async () => {
        const { swap } = await fresh(1762000000);
        const n = await nonce(bobAddr);
        const ap = approvalOf(swap);
        let err = null;
        await live.lock(provider, bob, { swap, ...ap, approvedIntent: "1762000001" }).catch((e) => (err = e));
        expect(err && err.message).to.match(/--approved-intent 1762000001 is not the decided_at of the lock_eth intent in the swap file/);
        expect(err.message, "a number that stays valid must not be copied from an error").to.not.include("1762000000");
        await expect(live.lock(provider, bob, { swap, ...ap, approvedIntent: "18446744073709551617" })).to.be.rejectedWith(/is not the decided_at/);
        for (const bad of ["abc", "-1", "+1", "01", " 1", "1 ", "1.0", "0x1", "1e0", "٣"]) {
          await expect(live.lock(provider, bob, { swap, ...ap, approvedIntent: bad }), bad).to.be.rejectedWith(/--approved-intent must be a whole number/);
        }
        await expect(live.lock(provider, bob, { swap, ...ap, approvedIntent: 1762000001 })).to.be.rejectedWith(/is not the decided_at/);
        await expect(live.lock(provider, bob, { swap, ...ap, approvedIntent: 1.5 })).to.be.rejectedWith(/whole number/);
        await nothingSent(swap, n);
      });

      it("a hash of other terms refuses: each one of the nine terms changed after the check, a malformed hash, an uppercase hash of the right terms is accepted", async () => {
        const { swap } = await fresh();
        const n = await nonce(bobAddr);
        const other = {
          chainId: "1", contract: "0x" + "ab".repeat(20), lockKind: "poseidon", codeHash: "0x" + "cd".repeat(32), bobSender: "0x" + "ef".repeat(20),
          receiver: "0x" + "12".repeat(20), amountWei: "1", lockWord: "0x" + "34".repeat(32), tReveal: "5", decidedAt: "2",
        };
        for (const [term, value] of Object.entries(other)) {
          if (term === "decidedAt") continue; // that one is the --approved-intent check, above
          const ap = approvalOf(swap, { [term]: value });
          await expect(live.lock(provider, bob, { swap, ...ap }), term).to.be.rejectedWith(/is not the hash [0-9a-f]{64} of the terms this lock would be sent with/);
        }
        const ap = approvalOf(swap);
        for (const bad of ["abc", "0x" + "1".repeat(64), "1".repeat(63), "g".repeat(64)]) {
          await expect(live.lock(provider, bob, { swap, ...ap, approvedTerms: bad }), bad).to.be.rejectedWith(/--approved-terms must be the 64 hex digits/);
        }
        await nothingSent(swap, n);
        const real = await live.lock(provider, bob, { swap, ...ap, approvedTerms: ap.approvedTerms.toUpperCase() });
        expect(real.lockId).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("a stale or future tick time refuses; the limit is the engine's observation age limit (read from engine.rs)", async () => {
        const { swap } = await fresh();
        const n = await nonce(bobAddr);
        const now = Math.floor(Date.now() / 1000);
        await expect(live.lock(provider, bob, { swap, ...approvalOf(swap, {}, now - 121) })).to.be.rejectedWith(/the fresh check is 12[1-9] s old .*limit is 120 s, the engine's own observation age limit \(MAX_OBSERVATION_AGE_S/s);
        await expect(live.lock(provider, bob, { swap, ...approvalOf(swap, {}, now - 3600) })).to.be.rejectedWith(/is 3[56]\d\d s old/);
        await expect(live.lock(provider, bob, { swap, ...approvalOf(swap, {}, now + 60) })).to.be.rejectedWith(/in the future of this machine's clock .*allowed: 5 s/);
        for (const bad of ["x", "-5", "05", "1.5", " 1"]) {
          await expect(live.lock(provider, bob, { swap, ...approvalOf(swap), approvedAt: bad }), bad).to.be.rejectedWith(/--approved-at must be a whole number/);
        }
        await nothingSent(swap, n);
        // in step: the constant here is the Rust one
        const src = path.join(__dirname, "..", "..", "swap-cli", "src", "engine.rs");
        if (fs.existsSync(src)) {
          const m = /pub const MAX_OBSERVATION_AGE_S: u64 = (\d+);/.exec(fs.readFileSync(src, "utf8"));
          expect(m, "the constant is in engine.rs").to.not.equal(null);
          expect(Number(m[1])).to.equal(live.MAX_OBSERVATION_AGE_S);
        }
        // a tick of 100 s ago still sends
        const ok = await live.lock(provider, bob, { swap, ...approvalOf(swap, {}, now - 100) });
        expect(ok.lockId).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("the encoding is fixed: a shared vector (the same terms and the same hash are in scripts/live/selftest.sh), and the right approval sends as before", async () => {
        const t = {
          chainId: "11155111", contract: "0x" + "11".repeat(20), lockKind: "sha256", codeHash: "0x" + "22".repeat(32), bobSender: "0x" + "33".repeat(20),
          receiver: "0x" + "44".repeat(20), amountWei: "1000000000000000", lockWord: "0x" + "55".repeat(32), tReveal: "1762007200", decidedAt: "1762000000",
        };
        expect(live.approvalText(t)).to.equal(
          "noid-swap lock approval v1\nchain_id=11155111\ncontract=0x" + "11".repeat(20) + "\nlock_kind=sha256\ncode_hash=0x" + "22".repeat(32) + "\nbob_sender=0x" + "33".repeat(20) +
            "\nreceiver=0x" + "44".repeat(20) + "\namount_wei=1000000000000000\nlock_word=0x" + "55".repeat(32) + "\nt_reveal=1762007200\ndecided_at=1762000000\n"
        );
        expect(live.approvalTermsHash(t)).to.equal("c49c5c1f57ed1e347403ffa1e4ea25167b0132aa7b6f705d5996acaf8cb09761");
        expect(live.approvalTermsHash({ ...t, contract: t.contract.toUpperCase().replace("0X", "0x") }), "case of the hex does not matter").to.equal(live.approvalTermsHash(t));
        expect(() => live.approvalTermsHash({ ...t, lockKind: "keccak" })).to.throw(/lock_kind/);
        expect(() => live.approvalTermsHash({ ...t, amountWei: "-1" })).to.throw(/whole number/);
        expect(() => live.approvalTermsHash({ ...t, lockWord: "0x12" })).to.throw(/hex digits/);
      });

      it("an intent whose decided_at cannot be read in the file refuses even with a value; the right approval sends; the lock lock is gone after", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        for (const bad of [undefined, "1", -1, 1.5, null]) {
          const intent = lockIntent(tReveal);
          if (bad === undefined) delete intent.decided_at;
          else intent.decided_at = bad;
          const swap = swapFile({ intent });
          await expect(live.lock(provider, bob, { swap, approvedIntent: "1", approvedTerms: "0".repeat(64), approvedAt: String(Math.floor(Date.now() / 1000)) }), String(bad)).to.be.rejectedWith(/no decided_at that can be read as a Unix time/);
        }
        const { swap, tReveal: tReveal2 } = await fresh();
        const real = await live.lock(provider, bob, { swap, ...approvalOf(swap) });
        expect(real.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal2)));
        expect(fs.existsSync(lockFileOf(swap)), "the lock lock is gone after the send").to.equal(false);
        expect(fs.existsSync(recordOf(swap)), "the record of the send stays").to.equal(true);
        expect(path.resolve(real.lockRecord)).to.equal(path.resolve(recordOf(swap)));
      });

      it("a dry run needs no approval (and a wrong one changes nothing); a lock without a swap file is not covered, and takes no lock file", async () => {
        const { tReveal, swap } = await fresh();
        expect((await live.lock(provider, bob, { swap, dryRun: true })).dryRun).to.equal(true);
        expect((await live.lock(provider, bob, { swap, dryRun: true, approvedIntent: "999", approvedTerms: "x", approvedAt: "y" })).dryRun).to.equal(true);
        expect(fs.existsSync(lockFileOf(swap)) || fs.existsSync(recordOf(swap))).to.equal(false);
        expect((await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String(tReveal), receiver: aliceAddr, amountWei: "1" })).lockId).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("the three flags are command-line flags of lock only", async () => {
        const a = live.parseArgs(["lock", "--approved-intent", "1762000000", "--approved-terms", "ab", "--approved-at", "1762000010"]).args;
        expect([a.approvedIntent, a.approvedTerms, a.approvedAt]).to.deep.equal(["1762000000", "ab", "1762000010"]);
        for (const f of ["--approved-intent", "--approved-terms", "--approved-at"]) expect(() => live.parseArgs(["lock", f])).to.throw(/needs a value/);
        for (const cmd of ["claim", "refund", "deploy", "send"]) expect(() => live.parseArgs([cmd, "--approved-intent", "1"]), cmd).to.throw(/unknown flag/);
      });

      it("a swap file with more than one hard link is refused for lock and claim (also in a dry run), with the fix; one name again is accepted", async function () {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal) });
        const revealSwap = swapFile({ intent: revealIntent(rand32(), tReveal, tReveal - 1800) });
        const alias = path.join(dir, "second-name.json");
        const aliasReveal = path.join(dir, "second-name-reveal.json");
        try {
          fs.linkSync(swap, alias);
          fs.linkSync(revealSwap, aliasReveal);
        } catch (e) {
          if (e.code === "ENOTSUP" || e.code === "EPERM" || e.code === "EACCES" || e.code === "EXDEV") return this.skip(); // a file system without hard links
          throw e;
        }
        if (fs.statSync(swap).nlink < 2) return this.skip(); // a file system that does not report a link count
        const LINKS = /has 2 hard links.*keep one name/s;
        const n = await nonce(bobAddr);
        await expect(live.lock(provider, bob, { swap, dryRun: true })).to.be.rejectedWith(LINKS);
        await expect(live.lock(provider, bob, { swap: alias, dryRun: true })).to.be.rejectedWith(LINKS);
        await expect(lockApproved(provider, bob, { swap })).to.be.rejectedWith(LINKS);
        await expect(live.claim(provider, alice, { swap: revealSwap, dryRun: true })).to.be.rejectedWith(LINKS);
        await expect(live.claim(provider, alice, { swap: aliasReveal, secret: rand32() })).to.be.rejectedWith(LINKS);
        expect(await nonce(bobAddr)).to.equal(n);
        expect(fs.existsSync(`${swap}.claim-lock`) || fs.existsSync(`${revealSwap}.claim-lock`), "no claim lock is taken for a refused file").to.equal(false);
        expect(fs.existsSync(lockFileOf(swap)), "no lock lock is taken for a refused file").to.equal(false);
        fs.unlinkSync(alias);
        fs.unlinkSync(aliasReveal);
        expect((await live.lock(provider, bob, { swap, dryRun: true })).dryRun).to.equal(true); // one name again: accepted
        const ec = await live.claim(provider, alice, { swap: revealSwap, dryRun: true }).then(() => null, (x) => x);
        expect(ec === null || !LINKS.test(ec.message), "the link check no longer fires").to.equal(true);
      });
    });

    // Bob's key is Hardhat's account 1: a local key (an ethers.Wallet), so the signed hash is known before the broadcast
    describe("the lock lock and the lock record: a second send is impossible while the first is unresolved (2026-11-10)", () => {
      const BOB_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
      let wallet;
      beforeEach(() => {
        wallet = new ethers.Wallet(BOB_KEY, provider);
      });
      afterEach(async () => {
        await provider.send("evm_setAutomine", [true]);
      });
      const lockFileOf = (swap) => swap + live.LOCK_LOCK_SUFFIX;
      const recordOf = (swap) => swap + live.LOCK_SENT_SUFFIX;
      async function fileWith(hash = hashlock) {
        const tReveal = (await latestTs()) + 2 * HOUR;
        return { tReveal, swap: swapFile({ hash, intent: lockIntent(tReveal, { hashlock: hash }) }) };
      }
      const until = async (cond, what) => {
        for (let i = 0; i < 200; i++) {
          if (await cond()) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`timed out waiting for ${what}`);
      };

      it("the key is Hardhat's account 1 (the premise of these tests)", async () => {
        expect(wallet.address).to.equal(bobAddr);
      });

      it("(a) an existing lock lock refuses a real lock before anything else, names the file, is never removed; a dry run takes no lock", async () => {
        const { swap } = await fileWith();
        fs.writeFileSync(lockFileOf(swap), '{"version":1,"pid":1,"at":1}\n');
        const n = await nonce(bobAddr);
        const e = await lockApproved(provider, bob, { swap }).then(() => null, (x) => x);
        expect(e && e.message).to.match(/another lock for this swap file is running, or an earlier one died: the lock file .*\.lock-lock exists/);
        expect(e.message).to.match(/this tool never removes a lock it did not make/);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(true);
        expect(await nonce(bobAddr)).to.equal(n);
        expect((await live.lock(provider, bob, { swap, dryRun: true })).dryRun).to.equal(true);
        fs.unlinkSync(lockFileOf(swap));
        expect((await lockApproved(provider, bob, { swap })).lockId).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("(a) the lock lock is let go after a refusal too (an approval that does not match), so the retry is not blocked", async () => {
        const { swap } = await fileWith();
        await expect(live.lock(provider, bob, { swap, ...approvalOf(swap), approvedIntent: "7" })).to.be.rejectedWith(/is not the decided_at/);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        expect((await lockApproved(provider, bob, { swap })).lockId).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("(c) the record is written before the broadcast: it holds the lock word, the lock id, the sender, the nonce and the signed hash of the transaction that was mined", async () => {
        const { swap, tReveal } = await fileWith();
        const nonceBefore = await nonce(bobAddr);
        const r = await lockApproved(provider, wallet, { swap });
        const rec = JSON.parse(fs.readFileSync(recordOf(swap), "utf8"));
        expect(rec).to.include({ version: 1, lock_word: hashlock, lock_id: r.lockId, sender: bobAddr, nonce: nonceBefore, tx_hash: r.txHash });
        expect(rec.at).to.be.a("number");
        expect(rec.lock_id).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
        expect(fs.statSync(recordOf(swap)).size).to.be.lessThan(4096);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
      });

      it("a first send that never mines, then a second attempt: the record refuses it (and another swap file of the same sender meets the pending-nonce check)", async () => {
        const { swap } = await fileWith();
        await provider.send("evm_setAutomine", [false]);
        const first = lockApproved(provider, wallet, { swap }); // broadcast, then waits for a receipt that does not come
        await until(() => fs.existsSync(recordOf(swap)) && !fs.existsSync(lockFileOf(swap)), "the record, and the lock lock let go after the broadcast");
        expect(await provider.getTransactionCount(bobAddr, "pending")).to.equal((await provider.getTransactionCount(bobAddr, "latest")) + 1);
        // the same swap file, a fresh approval: refused by the record (nothing mined, so the duplicate rule sees nothing)
        const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
        expect(e && e.message).to.match(/refusing: the lock record .*\.lock-sent exists \(it records sender 0x[0-9a-fA-F]{40}, nonce \d+, transaction hash 0x[0-9a-f]{64}, lock id 0x[0-9a-f]{64}, written at Unix second \d+\)/);
        expect(e.message).to.match(/Remove the record by hand ONLY if \(1\).*finalized block.*\(2\) the sender's nonce at a FINALIZED block is above the recorded nonce while the recorded hash has no receipt/s);
        expect(e.message).to.match(/This tool never removes the record itself.*section "Clearing a FILE\.lock-sent record" of scripts\/live\/README\.md and docs\/runbook-two-party\.md/s);
        expect(fs.existsSync(recordOf(swap))).to.equal(true);
        // another swap file (no record), the same sender: the pending-nonce check
        const other = await fileWith(sha256Raw(rand32()));
        const e2 = await lockApproved(provider, wallet, { swap: other.swap }).then(() => null, (x) => x);
        expect(e2 && e2.message).to.match(/the sender 0x[0-9a-fA-F]{40} has a transaction pending on this node \(pending nonce \d+, latest nonce \d+\).*the record is the check that counts/s);
        expect(fs.existsSync(recordOf(other.swap)), "no record for a lock that was refused before the send").to.equal(false);
        expect(fs.existsSync(lockFileOf(other.swap))).to.equal(false);
        // the first one is mined: it succeeds, the record stays, and a third attempt is refused by the duplicate rule (the lock is mined)
        await provider.send("evm_setAutomine", [true]);
        await provider.send("evm_mine", []);
        const r1 = await first;
        expect(r1.txHash).to.match(/^0x[0-9a-f]{64}$/);
        expect(fs.existsSync(recordOf(swap))).to.equal(true);
        await expect(lockApproved(provider, wallet, { swap })).to.be.rejectedWith(/a Locked event for hashlock .* from this sender .* already exists/);
      });

      it("the approval is judged again at the last step before the record is written: a stall in the slow steps that pushes it past 120 s refuses, with no record", async () => {
        const { swap } = await fileWith();
        const slow = new ethers.Wallet(BOB_KEY, provider);
        const realEstimate = slow.estimateGas.bind(slow);
        slow.estimateGas = async (tx) => {
          await new Promise((r) => setTimeout(r, 4000)); // a stalled endpoint, for four seconds
          return realEstimate(tx);
        };
        const n = await nonce(bobAddr);
        const now = Math.floor(Date.now() / 1000);
        // 117 s old at the first check (it passes), 121 s old after the stall
        const e = await live.lock(provider, slow, { swap, ...approvalOf(swap, {}, now - 117) }).then(() => null, (x) => x);
        expect(e && e.message).to.match(/the fresh check is 12[0-9] s old .*limit is 120 s/s);
        expect(fs.existsSync(recordOf(swap)), "no record: nothing was signed").to.equal(false);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        expect(await nonce(bobAddr)).to.equal(n);
      }).timeout(30000);

      it("a dry run says on stderr that a real lock would refuse on an existing lock record, and still returns its result", async () => {
        const { swap } = await fileWith();
        fs.writeFileSync(recordOf(swap), "not json");
        const written = [];
        const realWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk, ...rest) => {
          written.push(String(chunk));
          return true;
        };
        let dry;
        try {
          dry = await live.lock(provider, bob, { swap, dryRun: true });
        } finally {
          process.stderr.write = realWrite;
        }
        expect(dry.dryRun).to.equal(true);
        expect(written.join("")).to.match(/WARNING: the lock record .*\.lock-sent exists .*a real lock for this swap file would refuse.*Clearing a FILE\.lock-sent record/s);
      });

      it("a record that cannot be examined or read counts as present; a record of any content refuses; the tool never removes it", async () => {
        const { swap } = await fileWith();
        const n = await nonce(bobAddr);
        for (const content of ["", "not json", '{"version":2}', "x".repeat(5000)]) {
          fs.writeFileSync(recordOf(swap), content);
          const e = await lockApproved(provider, bob, { swap }).then(() => null, (x) => x);
          expect(e && e.message, JSON.stringify(content.slice(0, 20))).to.match(/refusing: the lock record .*\.lock-sent exists \((its content could not be read|it is not a record this tool wrote)/);
          expect(fs.readFileSync(recordOf(swap), "utf8")).to.equal(content);
        }
        fs.rmSync(recordOf(swap));
        fs.mkdirSync(recordOf(swap)); // a directory at the name: examined, not a regular file
        const e2 = await lockApproved(provider, bob, { swap }).then(() => null, (x) => x);
        expect(e2 && e2.message).to.match(/lock record .* exists \(it is not a record this tool wrote/);
        expect(fs.statSync(recordOf(swap)).isDirectory()).to.equal(true);
        expect(await nonce(bobAddr)).to.equal(n);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
      });

      it("a send refused before the broadcast takes back the record this call made; an error after the bytes may have left keeps it", async () => {
        // before the broadcast: the signer refuses to sign (after the record was written by preSend)
        const { swap } = await fileWith();
        const failing = new ethers.Wallet(BOB_KEY, provider);
        const realSign = failing.signTransaction.bind(failing);
        let calls = 0;
        failing.signTransaction = async (tx) => {
          calls++;
          if (calls >= 2) throw new Error("signing refused by the test"); // the 1st call is the pre-signature for the hash, the 2nd the real one
          return realSign(tx);
        };
        const n = await nonce(bobAddr);
        const e = await lockApproved(provider, failing, { swap }).then(() => null, (x) => x);
        expect(e && e.message).to.match(/signing refused by the test.*The lock record this call had written was removed again \(nothing was sent/s);
        expect(fs.existsSync(recordOf(swap)), "taken back").to.equal(false);
        expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        expect(await nonce(bobAddr)).to.equal(n);
        // after the broadcast was attempted: the node refuses the transaction, the record STAYS
        const { swap: swap2 } = await fileWith(sha256Raw(rand32()));
        const refusing = new ethers.Wallet(BOB_KEY, provider);
        const realBroadcast = provider.broadcastTransaction.bind(provider);
        provider.broadcastTransaction = async () => {
          throw new Error("the node did not answer (test)");
        };
        try {
          const e2 = await lockApproved(provider, refusing, { swap: swap2 }).then(() => null, (x) => x);
          expect(e2 && e2.message).to.match(/the node did not answer \(test\).*the lock record .*\.lock-sent was written before the send and STAYS.*Clearing a FILE\.lock-sent record/s);
        } finally {
          provider.broadcastTransaction = realBroadcast;
        }
        expect(fs.existsSync(recordOf(swap2)), "the record stays after the broadcast was attempted").to.equal(true);
        expect(fs.existsSync(lockFileOf(swap2)), "the lock lock is let go").to.equal(false);
        // and the next attempt refuses on the record, whatever the node says
        await expect(lockApproved(provider, bob, { swap: swap2 })).to.be.rejectedWith(/refusing: the lock record .*\.lock-sent exists/);
      });

      // ---- the per-user lock record (an outside read of the public copy 70be980): keyed by chain, sender and lock word, not by the name of the swap file
      describe("the per-user lock record", () => {
        const userRecordOf = (hash = hashlock) => live.userLockSentPath(31337, bobAddr, hash);
        /** A provider that sees no Locked logs (a stale log index): the duplicate rule is blind, as in the outside probe. */
        const blindProvider = () =>
          new Proxy(provider, {
            get(t, prop) {
              if (prop === "getLogs") return async () => [];
              const v = t[prop];
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        const PER_USER = /refusing: the per-user lock record .*\.json exists \(it records sender 0x[0-9a-fA-F]{40}, nonce \d+, transaction hash 0x[0-9a-f]{64}, lock id 0x[0-9a-f]{64}, written at Unix second \d+, swap file /;
        const captureStderr = async (fn) => {
          const written = [];
          const realWrite = process.stderr.write.bind(process.stderr);
          process.stderr.write = (chunk) => {
            written.push(String(chunk));
            return true;
          };
          try {
            return { result: await fn(), stderr: written.join("") };
          } finally {
            process.stderr.write = realWrite;
          }
        };
        beforeEach(() => isolated.clearRecords());
        afterEach(() => isolated.restoreSeam()); // a test that cleared the seam puts it back even when it fails

        it("the tests run on a temporary home, never the real one", () => {
          expect(path.resolve(live.userLockSentDir())).to.equal(path.resolve(isolated.recordsDir()));
          expect(path.resolve(live.userLockSentDir()).startsWith(path.resolve(os.tmpdir()))).to.equal(true);
        });

        it("it is named from chain id, sender and lock word (lower case), and a term that is not well formed cannot name one", () => {
          const p = live.userLockSentPath("31337", bobAddr.toUpperCase().replace("0X", "0x"), hashlock.toUpperCase().replace("0X", "0x"));
          expect(path.basename(p)).to.equal(`31337-${bobAddr.toLowerCase().slice(2)}-${hashlock.slice(2)}.json`);
          expect(path.dirname(p)).to.equal(live.userLockSentDir());
          expect(() => live.userLockSentPath("1.5", bobAddr, hashlock)).to.throw(/chain id/);
          expect(() => live.userLockSentPath(1, "0x12", hashlock)).to.throw(/sender is not an address/);
          expect(() => live.userLockSentPath(1, bobAddr, "0x12")).to.throw(/lock word/);
        });

        it("it is written before the broadcast, with the content of the record beside the swap file plus chain, contract, kind and the real path; both stay after the send", async () => {
          const { swap } = await fileWith();
          const seen = [];
          const realBroadcast = provider.broadcastTransaction.bind(provider);
          provider.broadcastTransaction = async (raw) => {
            seen.push({ file: fs.existsSync(recordOf(swap)) ? fs.readFileSync(recordOf(swap), "utf8") : null, user: fs.existsSync(userRecordOf()) ? fs.readFileSync(userRecordOf(), "utf8") : null });
            return realBroadcast(raw);
          };
          let r;
          try {
            r = await lockApproved(provider, wallet, { swap });
          } finally {
            provider.broadcastTransaction = realBroadcast;
          }
          expect(seen).to.have.length(1);
          expect(seen[0].file, "the record beside the file is there when the bytes go out").to.not.equal(null);
          expect(seen[0].user, "so is the per-user record").to.not.equal(null);
          const fileRec = JSON.parse(fs.readFileSync(recordOf(swap), "utf8"));
          const userRec = JSON.parse(fs.readFileSync(userRecordOf(), "utf8"));
          expect(JSON.parse(seen[0].user)).to.deep.equal(userRec);
          const { chain_id: chainId, contract, lock_kind: kind, swap_file: swapFileName, ...rest } = userRec;
          expect(rest, "the same fields, the same time").to.deep.equal(fileRec);
          expect(chainId).to.equal("31337");
          expect(contract.toLowerCase()).to.equal(htlcAddr.toLowerCase());
          expect(kind).to.equal("sha256");
          expect(swapFileName).to.equal(fs.realpathSync(swap));
          expect(r.userLockRecord).to.equal(userRecordOf());
          expect(fs.existsSync(userRecordOf()), "it stays after the send").to.equal(true);
          expect(fs.readdirSync(live.userLockSentDir())).to.deep.equal([path.basename(userRecordOf())]);
          if (process.platform !== "win32") expect(fs.statSync(userRecordOf()).mode & 0o777).to.equal(0o600);
        });

        it("a renamed swap file with a new T_reveal, a blind duplicate rule: the second lock is refused by the per-user record (and goes out without it)", async () => {
          const a = await fileWith();
          const first = await lockApproved(provider, wallet, { swap: a.swap });
          // the outside probe: the intent is cancelled and recorded again with a new T_reveal, the file is renamed, the node's log query returns nothing
          const renamed = path.join(dir, "renamed.json");
          fs.renameSync(a.swap, renamed);
          const j = JSON.parse(fs.readFileSync(renamed, "utf8"));
          j.pending_intent.params.t_reveal = a.tReveal + 60;
          fs.writeFileSync(renamed, JSON.stringify(j, null, 2));
          expect(fs.existsSync(recordOf(renamed)), "the record beside the old name is not found under the new one").to.equal(false);
          const n = await nonce(bobAddr);
          const e = await lockApproved(blindProvider(), wallet, { swap: renamed }).then(() => null, (x) => x);
          expect(e && e.message).to.match(PER_USER);
          expect(e.message).to.match(/Nothing was sent/);
          expect(e.message).to.match(/the contract itself shows no lock: read the record's lock id on two endpoints \(`live\.js status`\) and search the Locked events of this sender for this lock word up to the finalized block/);
          expect(e.message).to.match(/a replacement of the same call under another hash.*uses the same nonce/s);
          expect(e.message).to.match(/no transaction hash \(no local key\).*the two contract reads are mandatory/s);
          expect(e.message).to.match(/section "Clearing a FILE\.lock-sent record" of scripts\/live\/README\.md and docs\/runbook-two-party\.md/);
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(recordOf(renamed)), "no record is made for a lock that was refused").to.equal(false);
          expect(fs.existsSync(lockFileOf(renamed))).to.equal(false);
          expect(JSON.parse(fs.readFileSync(userRecordOf(), "utf8")).lock_id).to.equal(first.lockId); // the record is the first lock's, untouched
          // a copy of that file under yet another name: the same
          const copy = path.join(dir, "copy.json");
          fs.copyFileSync(renamed, copy);
          await expect(lockApproved(blindProvider(), wallet, { swap: copy })).to.be.rejectedWith(PER_USER);
          expect(await nonce(bobAddr)).to.equal(n);
          // the control: the record is what stopped it (without it the blind rule lets a second lock out)
          fs.unlinkSync(userRecordOf());
          const second = await lockApproved(blindProvider(), wallet, { swap: renamed });
          expect(second.lockId).to.not.equal(first.lockId);
          expect(await nonce(bobAddr)).to.equal(n + 1);
        });

        it("a lock without --swap is refused by the per-user record too (and the same lock goes out without it)", async () => {
          const { swap, tReveal } = await fileWith();
          await lockApproved(provider, wallet, { swap });
          const n = await nonce(bobAddr);
          const bare = { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal + 60), receiver: aliceAddr, amountWei: amount.toString() };
          const e = await live.lock(blindProvider(), wallet, bare).then(() => null, (x) => x);
          expect(e && e.message).to.match(PER_USER);
          expect(await nonce(bobAddr)).to.equal(n);
          // another lock word of the same sender is not in the way
          expect((await live.lock(provider, wallet, { ...bare, hashlock: sha256Raw(rand32()) })).lockId).to.match(/^0x[0-9a-f]{64}$/);
          // a lock without --swap writes the per-user record of its own lock word too (a second file now)
          expect(fs.readdirSync(live.userLockSentDir())).to.have.length(2);
          fs.unlinkSync(userRecordOf());
          expect((await live.lock(blindProvider(), wallet, bare)).lockId).to.match(/^0x[0-9a-f]{64}$/);
        });

        it("a record that cannot be read, is empty, is too large or is a directory refuses, and is never touched", async () => {
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          fs.mkdirSync(live.userLockSentDir(), { recursive: true });
          for (const content of ["", "not json", '{"version":2}', "x".repeat(5000)]) {
            fs.writeFileSync(userRecordOf(), content);
            const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
            expect(e && e.message, JSON.stringify(content.slice(0, 20))).to.match(/refusing: the per-user lock record .*\.json exists \((its content could not be read|it is not a record this tool wrote)/);
            expect(fs.readFileSync(userRecordOf(), "utf8")).to.equal(content);
            const bare = await live.lock(provider, wallet, { ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: aliceAddr, amountWei: "1" }).then(() => null, (x) => x);
            expect(bare && bare.message, "without --swap too").to.match(/refusing: the per-user lock record/);
          }
          fs.rmSync(userRecordOf());
          fs.mkdirSync(userRecordOf()); // a directory at the name
          const e2 = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
          expect(e2 && e2.message).to.match(/per-user lock record .* exists \(it is not a record this tool wrote/);
          expect(fs.statSync(userRecordOf()).isDirectory()).to.equal(true);
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(recordOf(swap)), "no record beside the file for a refused lock").to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        });

        it("a place that cannot be examined or made refuses: `.noid-swap` is a file; a home that is not an absolute path", async () => {
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          fs.writeFileSync(path.join(isolated.home, ".noid-swap"), "in the way");
          const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
          expect(e && e.message).to.match(/per-user lock record/);
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(recordOf(swap)), "no debris beside the swap file").to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
          fs.rmSync(path.join(isolated.home, ".noid-swap"));
          // an environment home that is not an absolute path cannot be the account's home: refused (the seam is cleared, so the real rules apply)
          const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
          live.setUserLockSentHomeForTests(null);
          process.env.HOME = "relative-home";
          process.env.USERPROFILE = "relative-home";
          try {
            const e2 = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
            expect(e2 && e2.message).to.match(/refusing: the home of the environment \(relative-home\) is not the home of this user account \(.*\).*nothing was sent/s);
            const bare = await live.lock(provider, wallet, { ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: aliceAddr, amountWei: "1" }).then(() => null, (x) => x);
            expect(bare && bare.message).to.match(/the home of the environment \(relative-home\) is not the home of this user account/);
            const { result, stderr } = await captureStderr(() => live.lock(provider, bob, { swap, dryRun: true }));
            expect(result.dryRun, "a dry run still answers").to.equal(true);
            expect(stderr).to.match(/WARNING: a real lock would refuse: the home of the environment \(relative-home\)/);
          } finally {
            process.env.HOME = saved.HOME;
            process.env.USERPROFILE = saved.USERPROFILE;
            isolated.restoreSeam();
          }
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
        });

        // ---- the place of the per-user records: the account's home, never the environment's
        it("the environment's home is not the account's home: a real lock (with and without --swap) is refused before any record is written, and the message names both homes", async () => {
          const accountHome = os.userInfo().homedir;
          // the set-up of this test: the environment's home is the helper's temporary one, so the account's home (the real one) cannot be the same directory
          expect(path.resolve(accountHome).toLowerCase()).to.not.equal(path.resolve(isolated.home).toLowerCase());
          expect(path.resolve(process.env.HOME)).to.equal(path.resolve(isolated.home));
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          live.setUserLockSentHomeForTests(null);
          try {
            // The refusal is asserted first and before any write: it is made while the place is looked up, ahead of every record.
            const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
            expect(e && e.message).to.match(/refusing: the home of the environment \(.*\) is not the home of this user account \(.*\)/s);
            expect(e.message).to.include(isolated.home);
            expect(e.message).to.include(accountHome);
            expect(e.message).to.match(/per-user lock records live under the account's home/);
            expect(e.message).to.match(/refuses rather than look in the wrong place/);
            expect(e.message).to.match(/Run it as the same user, with HOME and USERPROFILE unchanged/);
            expect(e.message).to.not.match(/sudo -H/);
            expect(e.message).to.match(/nothing was sent/);
            const bare = await live.lock(provider, wallet, { ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: aliceAddr, amountWei: "1" }).then(() => null, (x) => x);
            expect(bare && bare.message, "without --swap too").to.match(/refusing: the home of the environment .* is not the home of this user account/s);
            expect(() => live.userLockSentDir()).to.throw(/is not the home of this user account/);
          } finally {
            isolated.restoreSeam();
          }
          expect(await nonce(bobAddr), "nothing was sent").to.equal(n);
          expect(await provider.getLogs({ address: htlcAddr, fromBlock: 0 }), "no Locked event").to.have.length(0);
          expect(fs.existsSync(path.join(isolated.home, ".noid-swap")), "nothing was created under the temporary home").to.equal(false);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        });

        it("a run under sudo (SUDO_USER or SUDO_UID set) is refused, with and without --swap: nothing is sent and no record is written", async () => {
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          const names = ["SUDO_USER", "SUDO_UID"];
          const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
          live.setUserLockSentHomeForTests(null);
          try {
            for (const name of names) {
              for (const k of names) delete process.env[k];
              process.env[name] = name === "SUDO_UID" ? "1000" : "someone";
              const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
              expect(e && e.message, name).to.match(/refusing: this tool runs under sudo \(SUDO_UID or SUDO_USER is set\), which is another user account: the per-user lock records of the calling user are not visible to it\. Run it as the user that holds the records.*nothing was sent/s);
              const bare = await live.lock(provider, wallet, { ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: aliceAddr, amountWei: "1" }).then(() => null, (x) => x);
              expect(bare && bare.message, `${name} without --swap`).to.match(/this tool runs under sudo/);
              // a dry run still answers, and says so
              const { result, stderr } = await captureStderr(() => live.lock(provider, bob, { swap, dryRun: true }));
              expect(result.dryRun).to.equal(true);
              expect(stderr).to.match(/WARNING: a real lock would refuse: this tool runs under sudo/);
              expect(stderr).to.not.match(/record .* exists/);
            }
            // an empty value is not set
            for (const k of names) process.env[k] = "";
            const e2 = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
            expect(e2 && e2.message, "an empty SUDO variable is no sudo; the home rule refuses here (the seam is cleared)").to.match(/is not the home of this user account/);
          } finally {
            for (const k of names) {
              if (saved[k] === undefined) delete process.env[k];
              else process.env[k] = saved[k];
            }
            isolated.restoreSeam();
          }
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(path.join(isolated.home, ".noid-swap"))).to.equal(false);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        });

        it("an account home that cannot be determined (os.userInfo throws, or gives an empty home) refuses every real lock; nothing is sent or written", async () => {
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          const realUserInfo = os.userInfo;
          live.setUserLockSentHomeForTests(null);
          try {
            const stubs = [
              ["throws", () => { throw Object.assign(new Error("no account (test)"), { code: "ENOENT" }); }],
              ["an empty home", () => ({ homedir: "" })],
            ];
            for (const [name, stub] of stubs) {
              os.userInfo = stub;
              const e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
              expect(e && e.message, name).to.match(/refusing: the home directory of this user account cannot be determined.*nothing was sent/s);
              const bare = await live.lock(provider, wallet, { ...tgt, contract: htlcAddr, hashlock, tReveal: String((await latestTs()) + HOUR), receiver: aliceAddr, amountWei: "1" }).then(() => null, (x) => x);
              expect(bare && bare.message, `${name} without --swap`).to.match(/the home directory of this user account cannot be determined/);
            }
          } finally {
            os.userInfo = realUserInfo;
            isolated.restoreSeam();
          }
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(path.join(isolated.home, ".noid-swap"))).to.equal(false);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
        });

        it("the folder is `<account home>/.noid-swap/lock-sent`, from the operating system's account database (a path computation only: nothing is read or written there)", () => {
          const accountHome = os.userInfo().homedir;
          const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
          live.setUserLockSentHomeForTests(null);
          try {
            process.env.HOME = accountHome;
            process.env.USERPROFILE = accountHome;
            expect(live.userLockSentDir()).to.equal(path.join(accountHome, ".noid-swap", "lock-sent"));
            if (process.platform === "win32") {
              // the same folder in another letter case, and with a trailing separator
              process.env.USERPROFILE = accountHome.toUpperCase();
              expect(live.userLockSentDir()).to.equal(path.join(accountHome, ".noid-swap", "lock-sent"));
              process.env.USERPROFILE = accountHome + path.sep;
              expect(live.userLockSentDir()).to.equal(path.join(accountHome, ".noid-swap", "lock-sent"));
            }
            // a home that is empty is not the account's home
            process.env.USERPROFILE = "";
            process.env.HOME = "";
            expect(() => live.userLockSentDir()).to.throw(/is not the home of this user account/);
          } finally {
            process.env.HOME = saved.HOME;
            process.env.USERPROFILE = saved.USERPROFILE;
            isolated.restoreSeam();
          }
          expect(() => live.setUserLockSentHomeForTests("relative/dir")).to.throw(/absolute path/);
          expect(() => live.setUserLockSentHomeForTests("")).to.throw(/absolute path/);
        });

        it("the outside probe with the environment's home pointed elsewhere: the earlier record is in the old home, the second lock is refused by the mismatch rule, not by finding the earlier record (it never looks in the new home)", async () => {
          const a = await fileWith();
          const first = await lockApproved(provider, wallet, { swap: a.swap });
          const renamed = path.join(dir, "renamed.json");
          fs.renameSync(a.swap, renamed);
          const j = JSON.parse(fs.readFileSync(renamed, "utf8"));
          j.pending_intent.params.t_reveal = a.tReveal + 60;
          fs.writeFileSync(renamed, JSON.stringify(j, null, 2));
          const n = await nonce(bobAddr);
          const other = fs.mkdtempSync(path.join(os.tmpdir(), "live-other-home-"));
          const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
          live.setUserLockSentHomeForTests(null);
          try {
            process.env.HOME = other;
            process.env.USERPROFILE = other;
            const e = await lockApproved(blindProvider(), wallet, { swap: renamed }).then(() => null, (x) => x);
            expect(e && e.message).to.match(/refusing: the home of the environment \(.*\) is not the home of this user account/s);
            expect(e.message).to.include(other);
            const copy = path.join(dir, "copy.json");
            fs.copyFileSync(renamed, copy);
            await expect(lockApproved(blindProvider(), wallet, { swap: copy })).to.be.rejectedWith(/is not the home of this user account/);
            expect(fs.readdirSync(other), "nothing was made in the other home").to.have.length(0);
          } finally {
            process.env.HOME = saved.HOME;
            process.env.USERPROFILE = saved.USERPROFILE;
            isolated.restoreSeam();
            fs.rmSync(other, { recursive: true, force: true });
          }
          expect(await nonce(bobAddr)).to.equal(n);
          expect(JSON.parse(fs.readFileSync(userRecordOf(), "utf8")).lock_id, "the first lock's record is untouched").to.equal(first.lockId);
        });

        // ---- a real lock without --swap writes the per-user record too (and nothing else: no record beside a file, no approval, no lock lock, no pending-nonce check)
        const NO_SWAP_RECORD = /refusing: the per-user lock record .*\.json exists \(it records sender 0x[0-9a-fA-F]{40}, nonce \d+, transaction hash 0x[0-9a-f]{64}, lock id 0x[0-9a-f]{64}, written at Unix second \d+\)/;
        const bareArgs = (tReveal, over = {}) => ({ ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: aliceAddr, amountWei: amount.toString(), ...over });

        it("a real lock without --swap writes the per-user record before the broadcast: file name, mode, fields (swap_file null), and reports it", async () => {
          const tReveal = (await latestTs()) + 2 * HOUR;
          const nonceBefore = await nonce(bobAddr);
          const seen = [];
          const realBroadcast = provider.broadcastTransaction.bind(provider);
          provider.broadcastTransaction = async (raw) => {
            seen.push(fs.existsSync(userRecordOf()) ? fs.readFileSync(userRecordOf(), "utf8") : null);
            return realBroadcast(raw);
          };
          let r;
          try {
            r = await live.lock(provider, wallet, bareArgs(tReveal));
          } finally {
            provider.broadcastTransaction = realBroadcast;
          }
          expect(seen, "the record is there when the bytes go out").to.have.length(1);
          expect(seen[0]).to.not.equal(null);
          expect(r.userLockRecord).to.equal(userRecordOf());
          expect(r.lockRecord, "no record beside a swap file").to.equal(undefined);
          expect(path.basename(userRecordOf())).to.equal(`31337-${bobAddr.toLowerCase().slice(2)}-${hashlock.slice(2)}.json`);
          const rec = JSON.parse(fs.readFileSync(userRecordOf(), "utf8"));
          expect(JSON.parse(seen[0])).to.deep.equal(rec);
          expect(rec).to.include({ version: 1, lock_word: hashlock, lock_id: r.lockId, sender: bobAddr, nonce: nonceBefore, tx_hash: r.txHash, chain_id: "31337", lock_kind: "sha256" });
          expect(rec.contract.toLowerCase()).to.equal(htlcAddr.toLowerCase());
          expect(rec.swap_file).to.equal(null);
          expect(rec.at).to.be.a("number");
          expect(fs.readdirSync(live.userLockSentDir())).to.deep.equal([path.basename(userRecordOf())]);
          if (process.platform !== "win32") expect(fs.statSync(userRecordOf()).mode & 0o777).to.equal(0o600);
          expect(fs.readdirSync(dir).filter((f) => f.endsWith(live.LOCK_SENT_SUFFIX) || f.endsWith(live.LOCK_LOCK_SUFFIX)), "nothing beside any file").to.have.length(0);
        });

        it("the second probe: a lock without --swap, then one with --swap under the same lock word and another T_reveal, a blind log scan: refused by the per-user record, nothing sent", async () => {
          const { swap, tReveal } = await fileWith();
          const first = await live.lock(provider, wallet, bareArgs(tReveal + 60));
          const n = await nonce(bobAddr);
          const e = await lockApproved(blindProvider(), wallet, { swap }).then(() => null, (x) => x);
          expect(e && e.message).to.match(NO_SWAP_RECORD);
          expect(e.message).to.include(path.basename(userRecordOf()));
          expect(await nonce(bobAddr)).to.equal(n);
          expect(fs.existsSync(recordOf(swap)), "no record beside the file for a refused lock").to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
          expect(JSON.parse(fs.readFileSync(userRecordOf(), "utf8")).lock_id).to.equal(first.lockId);
        });

        it("two locks without --swap in a row under the same lock word, a blind log scan: the second is refused and nothing is sent", async () => {
          const tReveal = (await latestTs()) + 2 * HOUR;
          const first = await live.lock(blindProvider(), wallet, bareArgs(tReveal));
          const n = await nonce(bobAddr);
          const e = await live.lock(blindProvider(), wallet, bareArgs(tReveal + 60)).then(() => null, (x) => x);
          expect(e && e.message).to.match(NO_SWAP_RECORD);
          expect(await nonce(bobAddr)).to.equal(n);
          expect(JSON.parse(fs.readFileSync(userRecordOf(), "utf8")).lock_id).to.equal(first.lockId);
          // another lock word is not in the way
          expect((await live.lock(blindProvider(), wallet, bareArgs(tReveal, { hashlock: sha256Raw(rand32()) }))).lockId).to.match(/^0x[0-9a-f]{64}$/);
        });

        it("a lock without --swap that fails before the broadcast takes its record back; one that fails after the broadcast point keeps it", async () => {
          // before the broadcast: the signer refuses to sign (after the record was written by the pre-send step)
          const failing = new ethers.Wallet(BOB_KEY, provider);
          const realSign = failing.signTransaction.bind(failing);
          let calls = 0;
          failing.signTransaction = async (tx) => {
            calls++;
            if (calls >= 2) throw new Error("signing refused by the test"); // the 1st call is the pre-signature for the hash, the 2nd the real one
            return realSign(tx);
          };
          const n = await nonce(bobAddr);
          const e = await live.lock(provider, failing, bareArgs((await latestTs()) + 2 * HOUR)).then(() => null, (x) => x);
          expect(e && e.message).to.match(/signing refused by the test.*The per-user lock record this call had written was removed again \(nothing was sent/s);
          expect(fs.existsSync(userRecordOf()), "taken back").to.equal(false);
          expect(await nonce(bobAddr)).to.equal(n);
          // a record someone else wrote between the first look and the write is never overwritten, and refuses the call
          fs.mkdirSync(live.userLockSentDir(), { recursive: true });
          const racing = new ethers.Wallet(BOB_KEY, provider);
          const realEstimate = racing.estimateGas.bind(racing);
          racing.estimateGas = async (tx) => {
            fs.writeFileSync(userRecordOf(), "written by someone else, after the check");
            return realEstimate(tx);
          };
          const e1 = await live.lock(provider, racing, bareArgs((await latestTs()) + 2 * HOUR)).then(() => null, (x) => x);
          expect(e1 && e1.message).to.match(/refusing: the per-user lock record .*exists \(its content could not be read\)/);
          expect(fs.readFileSync(userRecordOf(), "utf8")).to.equal("written by someone else, after the check");
          expect(await nonce(bobAddr)).to.equal(n);
          fs.unlinkSync(userRecordOf());
          // after the broadcast was attempted: the node refuses the transaction, the record STAYS
          const refusing = new ethers.Wallet(BOB_KEY, provider);
          const realBroadcast = provider.broadcastTransaction.bind(provider);
          provider.broadcastTransaction = async () => {
            throw new Error("the node did not answer (test)");
          };
          try {
            const e2 = await live.lock(provider, refusing, bareArgs((await latestTs()) + 2 * HOUR)).then(() => null, (x) => x);
            expect(e2 && e2.message).to.match(/the node did not answer \(test\).*the per-user lock record .*\.json was written before the send and STAYS.*every later lock of this sender under this lock word refuses.*Clearing a FILE\.lock-sent record/s);
          } finally {
            provider.broadcastTransaction = realBroadcast;
          }
          expect(fs.existsSync(userRecordOf()), "the record stays after the broadcast was attempted").to.equal(true);
          // and the next lock refuses on it whatever the node says
          await expect(live.lock(provider, wallet, bareArgs((await latestTs()) + 2 * HOUR))).to.be.rejectedWith(/refusing: the per-user lock record .*\.json exists/);
          expect(await nonce(bobAddr)).to.equal(n);
        });

        it("two locks without --swap started at the same moment: one goes out, the other is refused by the record", async () => {
          const tReveal = (await latestTs()) + 2 * HOUR;
          const n = await nonce(bobAddr);
          const results = await Promise.allSettled([live.lock(blindProvider(), wallet, bareArgs(tReveal)), live.lock(blindProvider(), wallet, bareArgs(tReveal + 60))]);
          const sent = results.filter((x) => x.status === "fulfilled");
          const refused = results.filter((x) => x.status === "rejected");
          expect(sent, JSON.stringify(results.map((x) => (x.status === "rejected" ? String(x.reason && x.reason.message).slice(0, 200) : "ok")))).to.have.length(1);
          expect(refused).to.have.length(1);
          expect(refused[0].reason.message).to.match(/refusing: the per-user lock record .*\.json exists/);
          expect(await nonce(bobAddr)).to.equal(n + 1);
          expect(JSON.parse(fs.readFileSync(userRecordOf(), "utf8")).lock_id).to.equal(sent[0].value.lockId);
        });

        it("a write of the per-user record that fails sends nothing and leaves no debris: the half-written record and the one beside the file are taken back", async () => {
          const { swap } = await fileWith();
          const n = await nonce(bobAddr);
          const realOpen = fs.openSync;
          const realFsync = fs.fsyncSync;
          const realClose = fs.closeSync;
          const bad = new Set();
          fs.openSync = (p, ...rest) => {
            const fd = realOpen(p, ...rest);
            if (String(p).startsWith(live.userLockSentDir())) bad.add(fd);
            return fd;
          };
          fs.fsyncSync = (fd) => {
            if (bad.has(fd)) throw Object.assign(new Error("input/output error (test)"), { code: "EIO" });
            return realFsync(fd);
          };
          fs.closeSync = (fd) => {
            bad.delete(fd);
            return realClose(fd);
          };
          let e;
          try {
            e = await lockApproved(provider, wallet, { swap }).then(() => null, (x) => x);
          } finally {
            fs.openSync = realOpen;
            fs.fsyncSync = realFsync;
            fs.closeSync = realClose;
          }
          expect(e && e.message).to.match(/the per-user lock record .* could not be written durably \(EIO\); nothing was sent\. The per-user lock record this call had written was removed again/);
          expect(e.message).to.match(/The lock record this call had written was removed again/);
          expect(fs.existsSync(userRecordOf())).to.equal(false);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          expect(fs.existsSync(lockFileOf(swap))).to.equal(false);
          expect(await nonce(bobAddr)).to.equal(n);
          // and the retry on a healthy disk goes out
          expect((await lockApproved(provider, wallet, { swap })).lockId).to.match(/^0x[0-9a-f]{64}$/);
        });

        it("a dry run writes nothing (not even the directory) and warns when a per-user record exists", async () => {
          const { swap } = await fileWith();
          const quiet = await captureStderr(() => live.lock(provider, bob, { swap, dryRun: true }));
          expect(quiet.result.dryRun).to.equal(true);
          expect(quiet.stderr).to.not.match(/per-user lock record/);
          expect(fs.existsSync(path.join(isolated.home, ".noid-swap")), "no directory made").to.equal(false);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          fs.mkdirSync(live.userLockSentDir(), { recursive: true });
          fs.writeFileSync(userRecordOf(), "x");
          const loud = await captureStderr(() => live.lock(provider, bob, { swap, dryRun: true }));
          expect(loud.result.dryRun).to.equal(true);
          expect(loud.stderr).to.match(/WARNING: the per-user lock record .*\.json exists .*a real lock of this sender under this lock word would refuse, whatever the swap file is called.*Clearing a FILE\.lock-sent record/s);
          expect(fs.readFileSync(userRecordOf(), "utf8")).to.equal("x");
          // without --swap as well
          const tRev = String((await latestTs()) + HOUR);
          const bare = await captureStderr(() => live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock, tReveal: tRev, receiver: aliceAddr, amountWei: "1", dryRun: true }));
          expect(bare.result.dryRun).to.equal(true);
          expect(bare.stderr).to.match(/WARNING: the per-user lock record/);
        });

        it("the record stays after a broadcast that then fails (the node refuses, a timeout, a 429, a revert), and every later lock refuses on it", async () => {
          const reverted = () => ({
            hash: "0x" + "ab".repeat(32),
            nonce: 0,
            wait: async () => {
              throw Object.assign(new Error("transaction execution reverted (test)"), { code: "CALL_EXCEPTION", receipt: { status: 0, hash: "0x" + "ab".repeat(32) } });
            },
          });
          const cases = [
            ["the node refused", async () => { throw new Error("the node did not answer (test)"); }, /the node did not answer \(test\)/],
            ["a timeout", async () => { throw Object.assign(new Error("timeout (test)"), { code: "TIMEOUT" }); }, /timeout \(test\)/],
            ["a 429", async () => { throw Object.assign(new Error("server response 429 Too Many Requests (test)"), { code: "SERVER_ERROR", status: 429 }); }, /429/],
            ["a revert", async () => reverted(), /failed \(status 0\)/],
          ];
          for (const [name, stub, re] of cases) {
            const { swap } = await fileWith(sha256Raw(rand32()));
            const hash = JSON.parse(fs.readFileSync(swap, "utf8")).public.hashlock;
            const realBroadcast = provider.broadcastTransaction;
            provider.broadcastTransaction = stub;
            let e;
            try {
              e = await lockApproved(provider, new ethers.Wallet(BOB_KEY, provider), { swap }).then(() => null, (x) => x);
            } finally {
              provider.broadcastTransaction = realBroadcast;
            }
            expect(e && e.message, name).to.match(re);
            expect(e.message, name).to.match(/was written before the send and STAYS.*The per-user lock record .*\.json was written too and STAYS: every later lock of this sender under this lock word refuses/s);
            expect(fs.existsSync(recordOf(swap)), name).to.equal(true);
            expect(fs.existsSync(userRecordOf(hash)), name).to.equal(true);
            // a copy of the file under another name meets the per-user record
            const copy = path.join(dir, `copy-${nSwap}.json`);
            fs.copyFileSync(swap, copy);
            await expect(lockApproved(provider, wallet, { swap: copy }), name).to.be.rejectedWith(/refusing: the per-user lock record .*\.json exists/);
            expect(fs.existsSync(lockFileOf(swap)), name).to.equal(false);
          }
        });

        it("a send refused before the broadcast takes back both of this call's records (and a refusal before the records writes none)", async () => {
          const { swap } = await fileWith();
          const failing = new ethers.Wallet(BOB_KEY, provider);
          const realSign = failing.signTransaction.bind(failing);
          let calls = 0;
          failing.signTransaction = async (tx) => {
            calls++;
            if (calls >= 2) throw new Error("signing refused by the test");
            return realSign(tx);
          };
          const n = await nonce(bobAddr);
          const e = await lockApproved(provider, failing, { swap }).then(() => null, (x) => x);
          expect(e && e.message).to.match(/signing refused by the test.*The lock record this call had written was removed again.*The per-user lock record this call had written was removed again/s);
          expect(fs.existsSync(recordOf(swap))).to.equal(false);
          expect(fs.existsSync(userRecordOf())).to.equal(false);
          expect(await nonce(bobAddr)).to.equal(n);
          // an approval that does not match: refused before anything is written
          await expect(live.lock(provider, wallet, { swap, ...approvalOf(swap), approvedIntent: "7" })).to.be.rejectedWith(/is not the decided_at/);
          expect(fs.existsSync(userRecordOf())).to.equal(false);
          // a per-user record someone else wrote between the check and the write is never overwritten and refuses the call (exclusive create)
          fs.mkdirSync(live.userLockSentDir(), { recursive: true });
          const racing = new ethers.Wallet(BOB_KEY, provider);
          const realEstimate = racing.estimateGas.bind(racing);
          racing.estimateGas = async (tx) => {
            fs.writeFileSync(userRecordOf(), "written by someone else, after the check");
            return realEstimate(tx);
          };
          const e2 = await lockApproved(provider, racing, { swap }).then(() => null, (x) => x);
          expect(e2 && e2.message).to.match(/refusing: the per-user lock record .*exists \(its content could not be read\)/);
          expect(fs.readFileSync(userRecordOf(), "utf8")).to.equal("written by someone else, after the check");
          expect(fs.existsSync(recordOf(swap)), "the record beside the file is taken back").to.equal(false);
          expect(await nonce(bobAddr)).to.equal(n);
        });
      });
    });


    it("scans the logs from the file's eth_from_block when --from-block is omitted, and a given --from-block wins (REVIEW-3 F7)", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const intent = lockIntent(tReveal);
      const stored = await live.lock(provider, bob, { swap: swapFile({ intent, ethFromBlock: 1 }), dryRun: true });
      expect(stored.scannedFromBlock).to.equal(1);
      const given = await live.lock(provider, bob, { swap: swapFile({ intent, ethFromBlock: 1 }), dryRun: true, fromBlock: "2" });
      expect(given.scannedFromBlock).to.equal(2);
      // A file without the field still finds the deployment block (or 0) by itself.
      const none = await live.lock(provider, bob, { swap: swapFile({ intent }), dryRun: true });
      expect(none.scannedFromBlock).to.not.equal(1);
    });

    it("flags that equal the file's pass, in any letter case", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const swap = swapFile({ intent: lockIntent(tReveal) });
      const r = await live.lock(provider, bob, {
        swap, dryRun: true, chainId: "31337", contract: htlcAddr.toUpperCase().replace("0X", "0x"), codeHash: tgt.codeHash.toUpperCase().replace("0X", "0x"),
        hashlock: hashlock.toUpperCase().replace("0X", "0x"), receiver: aliceAddr, amountWei: amount.toString(), tReveal: String(tReveal),
      });
      expect(r.expectedLockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
    });

    it("refuses every flag that disagrees with the file, naming both values, and sends nothing", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const swap = swapFile({ intent: lockIntent(tReveal) });
      const other = sha256Raw(rand32());
      const cases = [
        [{ tReveal: String(tReveal + 1) }, new RegExp(`--t-reveal disagrees with the swap file: you gave ${tReveal + 1}, the file has ${tReveal}`)],
        [{ hashlock: other }, new RegExp(`--hashlock disagrees with the swap file: you gave ${other}, the file has ${hashlock}`)],
        [{ receiver: carolAddr }, /--receiver disagrees with the swap file: you gave 0x[0-9a-fA-F]{40}, the file has 0x[0-9a-fA-F]{40}/],
        [{ amountWei: "1" }, new RegExp(`--amount-wei disagrees with the swap file: you gave 1, the file has ${amount}`)],
        [{ chainId: "1337" }, /--chain-id disagrees with the swap file: you gave 1337, the file has 31337/],
        [{ contract: carolAddr }, /--contract disagrees with the swap file/],
        [{ codeHash: rand32() }, /--code-hash disagrees with the swap file/],
      ];
      const n = await nonce(bobAddr);
      for (const [over, re] of cases) {
        await expect(lockApproved(provider, bob, { swap, ...over }), JSON.stringify(over)).to.be.rejectedWith(re);
        await expect(live.lock(provider, bob, { swap, dryRun: true, ...over }), JSON.stringify(over)).to.be.rejectedWith(re);
      }
      expect(await nonce(bobAddr)).to.equal(n);
    });

    it("REVIEW-3 F1: a file that pins another code hash, or none, is refused (dry-run or not)", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const n = await nonce(bobAddr);
      for (const [eth, re] of [
        [{ code_hash: rand32() }, /the swap file pins code_hash 0x[0-9a-f]{64}, which is not the local artifact's 0x[0-9a-f]{64} \(a different value means a different contract\); refusing/],
        [{ code_hash: null }, /the file pins no code_hash; refusing/],
      ]) {
        const swap = swapFile({ intent: lockIntent(tReveal), eth });
        await expect(live.lock(provider, bob, { swap }), JSON.stringify(eth)).to.be.rejectedWith(re);
        await expect(live.lock(provider, bob, { swap, dryRun: true }), JSON.stringify(eth)).to.be.rejectedWith(re);
        // Even when the flag agrees with the file's other-contract hash.
        if (eth.code_hash) await expect(live.lock(provider, bob, { swap, dryRun: true, codeHash: eth.code_hash }), "flag agrees").to.be.rejectedWith(/not the local artifact's/);
      }
      expect(await nonce(bobAddr)).to.equal(n);
    });

    it("refuses without a pending intent, with another action's intent, with a doctored intent, and with the wrong key", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const n = await nonce(bobAddr);
      await expect(live.lock(provider, bob, { swap: swapFile({}) })).to.be.rejectedWith(/no pending intent; expected lock_eth/);
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: revealIntent(rand32(), tReveal, tReveal - 1800) }) })).to.be.rejectedWith(/pending intent is reveal_eth, but this command carries out lock_eth/);
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal, { amount_wei: "1" }) }) })).to.be.rejectedWith(/intent's amount_wei 1 differs from the file's amount_wei/);
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal, { hashlock: sha256Raw(rand32()) }) }) })).to.be.rejectedWith(/intent's hashlock .* differs/);
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal, { receiver: carolAddr.toLowerCase() }) }) })).to.be.rejectedWith(/intent's receiver .* differs/);
      // The signer must be the file's bob_sender.
      const swap = swapFile({ intent: lockIntent(tReveal) });
      await expect(live.lock(provider, alice, { swap })).to.be.rejectedWith(new RegExp(`this key is ${aliceAddr} but the swap file's bob_sender is ${bobAddr}`));
      await expect(live.lock(provider, alice, { swap, dryRun: true })).to.be.rejectedWith(/bob_sender/);
      expect(await nonce(bobAddr)).to.equal(n);
    });

    it("a missing or unreadable file is a refusal, not a fallback to the flags", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const flags = { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: aliceAddr, amountWei: amount.toString(), dryRun: true };
      await expect(live.lock(provider, bob, { ...flags, swap: path.join(dir, "nope.json") })).to.be.rejectedWith(/swap file not found/);
      const junk = path.join(dir, "junk.json");
      fs.writeFileSync(junk, "{ not json");
      await expect(live.lock(provider, bob, { ...flags, swap: junk })).to.be.rejectedWith(/not valid JSON/);
      const empty = path.join(dir, "empty.json");
      fs.writeFileSync(empty, "{}");
      await expect(live.lock(provider, bob, { ...flags, swap: empty })).to.be.rejectedWith(/is it a swap-cli swap file/);
      // Without --swap the in-process function behaves as before (the command line prints the warning).
      expect((await live.lock(provider, bob, flags)).dryRun).to.equal(true);
    });

    // T21: the producer screen of swap-cli remembers a detection (marker file or history entry); `lock` must refuse under production, also in a dry run.
    describe("the producer screen's remembered detection (T21)", () => {
      const MARKER = ".producer-differs";
      const SEEN = [{ at: 5, event: "producer_differs_seen", from: "x", to: "y" }];
      const OVERRIDDEN = [{ at: 6, event: "producer_concentration_overridden: largest 60 % of 720", from: "x", to: "y" }];
      const REFUSAL = /refusing: the producer screen of swap-cli remembers .*under the production profile that screen refuses the lock\. This is a screen, not a defence\. Do not send this lock\..*swap-cli intent FILE --cancel.*--accept-producer-concentration.*new swap file\. Once a `tick --apply` has run, removing the marker does not clear it\./s;
      const stderrOf = async (fn) => {
        const written = [];
        const orig = process.stderr.write;
        process.stderr.write = (c, ...r) => (written.push(String(c)), true);
        try {
          return { result: await fn(), written: written.join("") };
        } finally {
          process.stderr.write = orig;
        }
      };
      const logsOf = async () => (await provider.getLogs({ address: htlcAddr, fromBlock: 0 })).length;

      /** Nothing was sent: Bob's nonce and balance and the contract's logs are as before. */
      async function assertNothingSent(run) {
        const n = await nonce(bobAddr), b = await bal(bobAddr), l = await logsOf();
        await run();
        expect(await nonce(bobAddr)).to.equal(n);
        expect(await bal(bobAddr)).to.equal(b);
        expect(await logsOf()).to.equal(l);
      }

      it("(a) intent recorded, then the marker appears, then lock: refused with the full text, nothing sent", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal) }); // the earlier tick passed
        fs.writeFileSync(swap + MARKER, "{}"); // the later tick detected
        await assertNothingSent(async () => {
          const e = await live.lock(provider, bob, { swap }).then(() => null, (x) => x);
          expect(e, "lock must refuse").to.be.instanceOf(Error);
          expect(e.message).to.match(REFUSAL);
          expect(e.message).to.include(swap + MARKER);
          expect(e.message).to.not.match(/0x[0-9a-fA-F]{40}/);
        });
      });

      it("(b) the history entry alone (no marker) refuses too", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: SEEN });
        expect(fs.existsSync(swap + MARKER)).to.equal(false);
        await assertNothingSent(async () => {
          const e = await live.lock(provider, bob, { swap }).then(() => null, (x) => x);
          expect(e.message).to.match(REFUSAL);
          expect(e.message).to.include("the swap file's history holds \"producer_differs_seen\"");
          expect(e.message).to.not.include("marker file");
        });
      });

      it("(c) a marker that is a directory, an empty file or garbage refuses (presence is enough, nothing is parsed)", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        for (const make of [
          (m) => fs.mkdirSync(m),
          (m) => fs.writeFileSync(m, ""),
          (m) => fs.writeFileSync(m, "\u0000 not json at all {{{"),
          (m) => fs.writeFileSync(m, JSON.stringify({ version: 1, height: 1, at: 1 })),
        ]) {
          const swap = swapFile({ intent: lockIntent(tReveal) });
          make(swap + MARKER);
          await assertNothingSent(async () => {
            await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(REFUSAL);
          });
        }
      });

      it("(c) a marker that is a symlink (even a dangling one) refuses", async function () {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal) });
        try {
          fs.symlinkSync(path.join(dir, "no-such-target"), swap + MARKER);
        } catch (e) {
          if (e.code === "EPERM" || e.code === "EACCES") return this.skip(); // Windows without the symlink privilege
          throw e;
        }
        await assertNothingSent(async () => {
          await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(REFUSAL);
        });
      });

      it("(c) a marker that cannot be examined (lstat fails with EACCES, ENOTDIR or EIO) refuses and says so", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal) });
        for (const code of ["EACCES", "ENOTDIR", "EIO"]) {
          const orig = fs.lstatSync;
          fs.lstatSync = (f, ...r) => {
            if (String(f).endsWith(MARKER)) throw Object.assign(new Error(code), { code });
            return orig.call(fs, f, ...r);
          };
          try {
            await assertNothingSent(async () => {
              const e = await live.lock(provider, bob, { swap }).then(() => null, (x) => x);
              expect(e, code).to.be.instanceOf(Error);
              expect(e.message).to.match(REFUSAL);
              expect(e.message).to.include(`cannot be examined (${code}), which counts as present`);
            });
          } finally {
            fs.lstatSync = orig;
          }
        }
        // The stub is gone: no marker, so the dry run goes through.
        expect((await live.lock(provider, bob, { swap, dryRun: true })).dryRun).to.equal(true);
      });

      it("(d) under sepolia and rehearsal the same evidence only warns on stderr, and the lock goes through", async () => {
        for (const profile of ["sepolia", "rehearsal"]) {
          const tReveal = (await latestTs()) + 2 * HOUR;
          const swap = swapFile({ intent: lockIntent(tReveal), profile, history: SEEN });
          fs.writeFileSync(swap + MARKER, "{}");
          const n = await nonce(bobAddr);
          const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
          expect(result.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
          expect(await nonce(bobAddr)).to.equal(n + 1);
          expect(written).to.match(new RegExp(`^WARNING: the producer screen of swap-cli remembers .*under the ${profile} profile this only warns\\. A screen, not a defence\\.\\n`, "m"));
          expect(written).to.include("the marker file").and.to.include("producer_differs_seen");
          hashlock = sha256Raw(rand32()); // the next profile locks under a fresh hashlock (one own lock per hashlock)
        }
      });

      it("(e) production with the operator's override in the history: a warning, and the lock goes through", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: [...SEEN, ...OVERRIDDEN] });
        fs.writeFileSync(swap + MARKER, "{}");
        const n = await nonce(bobAddr);
        const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
        expect(result.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
        expect(await nonce(bobAddr)).to.equal(n + 1);
        expect(written).to.match(/^WARNING: the producer screen of swap-cli remembers .*only because the swap file records the operator's producer_concentration_overridden \(tick --accept-producer-concentration\)\. A screen, not a defence\.\n/m);
      });

      // The override counts only when its entry comes AFTER the last detection entry (an outside read, 2026-11-10): an older override, written for
      // a concentration, must not waive a later disagreement of the two nodes.
      const REFUSES = /refusing: the producer screen of swap-cli remembers .*under the production profile that screen refuses the lock/s;

      it("(e2) the override entry comes BEFORE the detection: the lock is refused under production, in a dry run too, nothing sent, the file untouched", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: [...OVERRIDDEN, ...SEEN] });
        const before = fs.readFileSync(swap, "utf8");
        await assertNothingSent(async () => {
          // "Several ticks": the same refusal each time, and the history is as it was.
          for (let i = 0; i < 3; i++) {
            const e = await live.lock(provider, bob, { swap }).then(() => null, (x) => x);
            expect(e, `attempt ${i}`).to.be.instanceOf(Error);
            expect(e.message).to.match(REFUSES);
            expect(e.message).to.include("the swap file's history holds \"producer_differs_seen\"");
            await expect(live.lock(provider, bob, { swap, dryRun: true }), `dry run ${i}`).to.be.rejectedWith(REFUSES);
          }
        });
        expect(fs.readFileSync(swap, "utf8"), "live.js never writes the swap file").to.equal(before);
        // With a marker file as well: the same.
        fs.writeFileSync(swap + MARKER, "{}");
        await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(REFUSES);
      });

      it("(e3) the override entry comes AFTER the last detection: a warning, and the lock goes through; a later detection takes the waiver away again", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        // detection, override: waived.
        const swap = swapFile({ intent: lockIntent(tReveal), history: [...SEEN, ...OVERRIDDEN] });
        const n = await nonce(bobAddr);
        const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
        expect(result.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
        expect(await nonce(bobAddr)).to.equal(n + 1);
        expect(written).to.match(/^WARNING: the producer screen of swap-cli remembers .*only because the swap file records the operator's producer_concentration_overridden/m);
        // override, detection, override, detection: the newest detection has no override after it.
        const late = swapFile({ intent: lockIntent(tReveal), history: [...OVERRIDDEN, ...SEEN, ...OVERRIDDEN, ...SEEN] });
        await assertNothingSent(async () => {
          await expect(live.lock(provider, bob, { swap: late })).to.be.rejectedWith(REFUSES);
        });
        // override, detection, override: waived (the latest override is newer than the latest detection).
        hashlock = sha256Raw(rand32()); // one own lock per hashlock
        const waived = swapFile({ intent: lockIntent((await latestTs()) + 2 * HOUR), history: [...OVERRIDDEN, ...SEEN, ...OVERRIDDEN] });
        const m = await nonce(bobAddr);
        const out = await stderrOf(() => lockApproved(provider, bob, { swap: waived }));
        expect(out.result.lockId).to.be.a("string");
        expect(await nonce(bobAddr)).to.equal(m + 1);
      });

      it("(f) no marker and no entry: no warning, behaviour unchanged (an override alone changes nothing either)", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: OVERRIDDEN });
        const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
        expect(result.lockId).to.be.a("string");
        expect(written).to.not.include("producer screen");
      });

      it("(g) a dry run under production with a marker (or the entry) refuses too", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const withMarker = swapFile({ intent: lockIntent(tReveal) });
        fs.writeFileSync(withMarker + MARKER, "");
        await expect(live.lock(provider, bob, { swap: withMarker, dryRun: true })).to.be.rejectedWith(REFUSAL);
        await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(tReveal), history: SEEN }), dryRun: true })).to.be.rejectedWith(REFUSAL);
      });

      // An outside read, 2026-11-10 (finding 1): with the marker file and NO detection entry in the history there is no entry for an override to come
      // after, so an override entry (e.g. one for a concentration, written earlier) must not waive anything: `tick --apply` has to write the detection first.
      it("(h) the marker alone with an override in the history and no detection entry: refused, in a dry run too, nothing sent, and the text says to run tick --apply", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: OVERRIDDEN });
        fs.writeFileSync(swap + MARKER, "{}");
        await assertNothingSent(async () => {
          for (const dryRun of [false, true]) {
            const e = await live.lock(provider, bob, { swap, dryRun }).then(() => null, (x) => x);
            expect(e, `dry run ${dryRun}`).to.be.instanceOf(Error);
            expect(e.message).to.match(REFUSAL);
            expect(e.message).to.include("history holds no \"producer_differs_seen\" entry yet, so no override can count");
            expect(e.message).to.include("swap-cli tick --apply").and.to.include("--accept-producer-concentration");
          }
        });
        // The marker as a link target of the real path counts too (the same file reached by two names): see the realpath tests below.
        // Once a tick --apply has written the detection and then the override, the same file goes through with the waiver warning.
        const waived = swapFile({ intent: lockIntent(tReveal), history: [...OVERRIDDEN, ...SEEN, ...OVERRIDDEN] });
        fs.writeFileSync(waived + MARKER, "{}");
        const out = await stderrOf(() => lockApproved(provider, bob, { swap: waived }));
        expect(out.result.lockId).to.be.a("string");
        expect(out.written).to.match(/^WARNING: the producer screen of swap-cli remembers .*only because the swap file records the operator's producer_concentration_overridden/m);
      });

      // Finding 2: the engine writes `producer_alert_lock_pending:<decided_at>[:kind]` when a tick finds its screen refusing a PENDING lock (every kind of
      // refusal); the lock must not go out on the strength of an intent that is older than that refusal. The test intents have decided_at 1.
      const LATCH = (suffix = "1:concentration", at = 7) => [{ at, event: `producer_alert_lock_pending:${suffix}`, from: "x", to: "y" }];
      const LATCH_REFUSAL = /refusing: the swap file's history holds a "producer_alert_lock_pending:\.\.\." entry for this pending lock_eth intent.*no producer_concentration_overridden entry comes after it\. This is a screen, not a defence\. Do not send this lock\./s;

      it("(i) the latch of this intent in the history, no override after it: refused (every form of the entry), in a dry run too, nothing sent, the file untouched", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        for (const suffix of ["1", "1:concentration", "1:remembered", "1:cannot-be-checked"]) {
          const swap = swapFile({ intent: lockIntent(tReveal), history: LATCH(suffix) });
          const before = fs.readFileSync(swap, "utf8");
          expect(fs.existsSync(swap + MARKER)).to.equal(false);
          await assertNothingSent(async () => {
            for (const dryRun of [false, true]) {
              const e = await live.lock(provider, bob, { swap, dryRun }).then(() => null, (x) => x);
              expect(e, `${suffix} dry run ${dryRun}`).to.be.instanceOf(Error);
              expect(e.message, suffix).to.match(LATCH_REFUSAL);
              expect(e.message, suffix).to.include("A latch stays on record even if the screen passes again").and.to.include("cancel the intent");
            }
          });
          expect(fs.readFileSync(swap, "utf8")).to.equal(before);
        }
        // The scenario of the finding: the tick recorded the intent, then a plain concentration refusal wrote the latch (no marker, no detection entry).
        const swap = swapFile({ intent: lockIntent(tReveal), history: [{ at: 1, event: "intent_decided:lock_eth" }, ...LATCH("1:concentration", 9)] });
        await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(LATCH_REFUSAL);
        // The refusal comes before any network read.
        const noNet = new Proxy({}, { get: () => { throw new Error("the provider must not be touched"); } });
        await expect(live.lock(noNet, bob, { swap })).to.be.rejectedWith(LATCH_REFUSAL);
      });

      it("(i2) a latch of ANOTHER intent (another decided_at, a longer number that starts with this one) or a different event name is not this intent's latch", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        for (const suffix of ["2:concentration", "12:concentration", "10", "11:x"]) {
          hashlock = sha256Raw(rand32());
          const swap = swapFile({ intent: lockIntent((await latestTs()) + 2 * HOUR), history: LATCH(suffix) });
          const n = await nonce(bobAddr);
          const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
          expect(result.lockId, suffix).to.be.a("string");
          expect(await nonce(bobAddr)).to.equal(n + 1);
          expect(written, suffix).to.not.include("producer screen");
        }
        void tReveal;
      });

      it("(i3) the override entry AFTER the latch waives it: a warning that says so, and the lock goes through; an override BEFORE the latch does not", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const before = swapFile({ intent: lockIntent(tReveal), history: [...OVERRIDDEN, ...LATCH("1:concentration", 9)] });
        await assertNothingSent(async () => {
          await expect(live.lock(provider, bob, { swap: before })).to.be.rejectedWith(LATCH_REFUSAL);
        });
        const after = swapFile({ intent: lockIntent(tReveal), history: [...LATCH("1:concentration", 7), ...OVERRIDDEN] });
        const n = await nonce(bobAddr);
        const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap: after }));
        expect(result.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
        expect(await nonce(bobAddr)).to.equal(n + 1);
        expect(written).to.match(/^WARNING: the swap file's history holds a "producer_alert_lock_pending:\.\.\." entry for this pending lock_eth intent.*only because the swap file records the operator's producer_concentration_overridden \(tick --accept-producer-concentration\)\. A screen, not a defence\.\n/m);
        // A later latch takes the waiver away again: latch, override, latch.
        hashlock = sha256Raw(rand32());
        const later = swapFile({ intent: lockIntent((await latestTs()) + 2 * HOUR), history: [...LATCH("1:concentration", 7), ...OVERRIDDEN, ...LATCH("1:remembered", 9)] });
        await assertNothingSent(async () => {
          await expect(live.lock(provider, bob, { swap: later })).to.be.rejectedWith(LATCH_REFUSAL);
        });
      });

      it("(i4) a detection waived and a latch not (or the other way round): the lock is refused for the one that stands, and both texts are given when both stand", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        // detection, override, latch: the detection is waived, the latch stands.
        const a = swapFile({ intent: lockIntent(tReveal), history: [...SEEN, ...OVERRIDDEN, ...LATCH("1:remembered", 9)] });
        const ea = await live.lock(provider, bob, { swap: a }).then(() => null, (x) => x);
        expect(ea.message).to.match(LATCH_REFUSAL);
        expect(ea.message).to.not.include("remembers that two Parano1d nodes");
        // latch, override, detection: the latch is waived, the detection stands.
        const b = swapFile({ intent: lockIntent(tReveal), history: [...LATCH("1:remembered", 5), ...OVERRIDDEN, ...SEEN] });
        const eb = await live.lock(provider, bob, { swap: b }).then(() => null, (x) => x);
        expect(eb.message).to.match(REFUSES);
        expect(eb.message).to.not.include("producer_alert_lock_pending");
        // latch and detection with no override at all: both are named.
        const c = swapFile({ intent: lockIntent(tReveal), history: [...LATCH("1:remembered", 5), ...SEEN] });
        const ec = await live.lock(provider, bob, { swap: c }).then(() => null, (x) => x);
        expect(ec.message).to.include("remembers that two Parano1d nodes").and.to.include("producer_alert_lock_pending");
      });

      it("(i5) under sepolia and rehearsal the latch only warns, and the lock goes through", async () => {
        for (const profile of ["sepolia", "rehearsal"]) {
          hashlock = sha256Raw(rand32());
          const tReveal = (await latestTs()) + 2 * HOUR;
          const swap = swapFile({ intent: lockIntent(tReveal), profile, history: LATCH("1:concentration") });
          const n = await nonce(bobAddr);
          const { result, written } = await stderrOf(() => lockApproved(provider, bob, { swap }));
          expect(result.lockId).to.be.a("string");
          expect(await nonce(bobAddr)).to.equal(n + 1);
          expect(written).to.match(new RegExp(`^WARNING: the swap file's history holds a "producer_alert_lock_pending:\\.\\.\\." entry.*under the ${profile} profile this only warns\\. A screen, not a defence\\.\\n`, "m"));
        }
      });

      it("(i6) a latch for an intent whose decided_at cannot be read counts for any intent (fail closed)", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        for (const bad of [undefined, null, {}, 1.5, "1", -1, 2 ** 60, [1]]) {
          const intent = lockIntent(tReveal);
          if (bad === undefined) delete intent.decided_at;
          else intent.decided_at = bad;
          const swap = swapFile({ intent, history: LATCH("77:concentration") });
          await assertNothingSent(async () => {
            await expect(live.lock(provider, bob, { swap }), JSON.stringify(bad)).to.be.rejectedWith(LATCH_REFUSAL);
          });
        }
      });

      it("the refusal comes before any network read (the provider is never touched); refund does not look at the marker", async () => {
        const tReveal = (await latestTs()) + 2 * HOUR;
        const swap = swapFile({ intent: lockIntent(tReveal), history: SEEN });
        const noNet = new Proxy({}, { get: () => { throw new Error("the provider must not be touched"); } });
        await expect(live.lock(noNet, bob, { swap })).to.be.rejectedWith(REFUSAL);
        const l = await makeLock();
        const refundSwap = swapFile({ intent: refundIntent(l.lockId), history: SEEN });
        fs.writeFileSync(refundSwap + MARKER, "{}");
        const e = await live.refund(provider, bob, { swap: refundSwap, dryRun: true }).then(() => null, (x) => x);
        if (e) expect(e.message).to.not.include("producer screen"); // it may refuse for its own reasons (the timelock), never for this one
      });
    });
  });

  // ------------------------------------------------------------------ claim (the reveal)
  describe("claim", () => {
    it("takes the lock id from the intent; the plan names the file and the cutoff is the earlier of flag and file", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const p = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
      expect(p.lockId).to.equal(l.lockId);
      expect(p.revealCutoff).to.equal(String(l.tReveal - 1800));
      expect(p.swapFile).to.equal(path.resolve(swap));
      // The file froze an EARLIER cutoff than the flag's default: the file's wins, and --margin-s 0 cannot loosen it.
      const early = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 3600) });
      expect((await live.claim(provider, alice, { swap: early, secret: preimage, dryRun: true })).revealCutoff).to.equal(String(l.tReveal - 3600));
      expect((await live.claim(provider, alice, { swap: early, secret: preimage, dryRun: true, marginS: "0" })).revealCutoff).to.equal(String(l.tReveal - 3600));
      // A LATER frozen cutoff does not loosen the flag's margin either.
      const late = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 10) });
      expect((await live.claim(provider, alice, { swap: late, secret: preimage, dryRun: true })).revealCutoff).to.equal(String(l.tReveal - 1800));
    });

    it("refuses past the cutoff the file froze, also with --margin-s 0 and --dry-run", async () => {
      const l = await makeLock();
      const past = (await latestTs()) - 5;
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, past) });
      const re = new RegExp(`past the reveal cutoff.*frozen cutoff ${past}`);
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true })).to.be.rejectedWith(re);
      await expect(live.claim(provider, alice, { swap, secret: preimage, marginS: "0" })).to.be.rejectedWith(re);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("refuses a lock id that is not the intent's, another action's intent, and an intent without t_reveal / cutoff", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const wrong = rand32();
      await expect(live.claim(provider, alice, { swap, lockId: wrong, secret: preimage, dryRun: true })).to.be.rejectedWith(new RegExp(`--lock-id disagrees with the swap file: you gave ${wrong}, the file has ${l.lockId}`));
      await expect(live.claim(provider, alice, { swap: swapFile({ intent: refundIntent(l.lockId) }), secret: preimage, dryRun: true })).to.be.rejectedWith(/pending intent is refund_eth, but this command carries out reveal_eth/);
      await expect(live.claim(provider, alice, { swap: swapFile({}), secret: preimage, dryRun: true })).to.be.rejectedWith(/no pending intent; expected reveal_eth/);
      await expect(live.claim(provider, alice, { swap: swapFile({ intent: wrapIntent("reveal_eth", { lock_id: l.lockId }) }), secret: preimage, dryRun: true })).to.be.rejectedWith(/carries no t_reveal \/ cutoff/);
      await expect(live.claim(provider, alice, { swap: swapFile({ intent: revealIntent(l.lockId, l.tReveal + 5, l.tReveal - 1800) }), secret: preimage, dryRun: true })).to.be.rejectedWith(/froze t_reveal/);
      await expect(live.claim(provider, alice, { swap, chainId: "1337", secret: preimage, dryRun: true })).to.be.rejectedWith(/--chain-id disagrees/);
    });

    it("refuses a lock whose receiver, sender, amount or hashlock is not the file's, whoever supplied its id", async () => {
      const cases = [
        ["receiver", { receiver: carolAddr }, /lock's receiver on chain is .* alice_receiver/],
        ["sender", { signer: carol }, /lock's sender on chain is .* bob_sender/],
        ["amount", { value: 1000n }, /lock's amount on chain is 1000 but the swap file's amount_wei is 200000000000000000/],
        ["hashlock", { hash: sha256Raw(rand32()) }, /lock's hashlock on chain is .* hashlock/],
      ];
      for (const [name, over, re] of cases) {
        // A fresh hashlock per lock: the lock gate refuses a second lock of the same sender under one hashlock.
        const l = await makeLock({ hash: sha256Raw(rand32()), ...over });
        const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
        await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true }), name).to.be.rejectedWith(re);
        await expect(live.claim(provider, alice, { swap, secret: preimage }), name).to.be.rejectedWith(re);
        expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state, name).to.match(/^open/);
      }
    });

    it("a real reveal with every term from the file pays the file's receiver", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const before = await bal(aliceAddr);
      const r = await live.claim(provider, alice, { swap, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(aliceAddr)).to.be.gt(before + amount - ethers.parseEther("0.01"));
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });
  });

  // ------------------------------------------------------------------ refund
  describe("refund", () => {
    it("takes the lock id from the intent and refunds once the timelock has passed", async () => {
      const l = await makeLock({ ttl: HOUR });
      const swap = swapFile({ intent: refundIntent(l.lockId) });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const dry = await live.refund(provider, bob, { swap, dryRun: true });
      expect(dry.lockId).to.equal(l.lockId);
      const before = await bal(bobAddr);
      const r = await live.refund(provider, bob, { swap });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(bobAddr)).to.be.gt(before + amount - ethers.parseEther("0.01"));
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("refunded");
    });

    it("refuses another lock id, another action's intent, no intent, and a lock that is not the file's", async () => {
      const l = await makeLock({ ttl: HOUR });
      const other = await makeLock({ ttl: HOUR, receiver: carolAddr, hash: sha256Raw(rand32()) });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const swap = swapFile({ intent: refundIntent(l.lockId) });
      const n = await nonce(bobAddr);
      await expect(live.refund(provider, bob, { swap, lockId: other.lockId })).to.be.rejectedWith(new RegExp(`--lock-id disagrees with the swap file: you gave ${other.lockId}, the file has ${l.lockId}`));
      await expect(live.refund(provider, bob, { swap: swapFile({ intent: refundIntent(other.lockId) }) })).to.be.rejectedWith(/lock's receiver on chain is/);
      await expect(live.refund(provider, bob, { swap: swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) }) })).to.be.rejectedWith(/pending intent is reveal_eth, but this command carries out refund_eth/);
      await expect(live.refund(provider, bob, { swap: swapFile({}) })).to.be.rejectedWith(/no pending intent; expected refund_eth/);
      expect(await nonce(bobAddr)).to.equal(n);
    });
  });

  // ------------------------------------------------------------------ --mainnet with --swap
  describe("mainnet: the file must be a chain-1 production swap", () => {
    const FEE = { mainnet: true, maxFeeGwei: "50" };
    /** The in-process node answering as chain 1; the signers stay bound to the real in-process node. */
    const asMainnet = () =>
      new Proxy(provider, {
        get(t, prop) {
          if (prop === "getNetwork") return async () => ({ chainId: 1n });
          if (prop === "send") return async (method, params) => (method === "eth_chainId" ? "0x1" : provider.send(method, params));
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    const lockSwap = (tReveal, opts = {}) => swapFile({ intent: lockIntent(tReveal), ...opts });

    it("a chain_id 1 file with no profile field (production) or with profile \"production\" is accepted: lock dry run and real, claim, refund", async () => {
      const net = asMainnet();
      const tReveal = (await latestTs()) + 2 * HOUR;
      for (const opts of [{ eth: { chain_id: 1 } }, { eth: { chain_id: 1 }, profile: "production" }, { eth: { chain_id: "1" } }]) {
        const dry = await live.lock(net, bob, { swap: lockSwap(tReveal, opts), dryRun: true, ...FEE });
        expect(dry.dryRun, JSON.stringify(opts)).to.equal(true);
        expect(dry.chainId).to.equal("1");
        expect(dry.maxFeeGwei).to.equal("50.0");
        expect(dry.expectedLockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));
      }
      const real = await lockApproved(net, bob, { swap: lockSwap(tReveal, { eth: { chain_id: 1 } }), ...FEE });
      expect(real.chainId).to.equal("1");
      expect(real.lockId).to.equal(live.computeLockIdLocal(bobAddr, aliceAddr, amount, hashlock, BigInt(tReveal)));

      const before = await bal(aliceAddr);
      const c = await live.claim(net, alice, { swap: swapFile({ intent: revealIntent(real.lockId, tReveal, tReveal - 1800), eth: { chain_id: 1 } }), secret: preimage, ...FEE });
      expect(c.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(aliceAddr)).to.be.gt(before + amount - ethers.parseEther("0.01"));

      const h2 = sha256Raw(rand32());
      const l = await makeLock({ ttl: HOUR, hash: h2 });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const r = await live.refund(net, bob, { swap: swapFile({ intent: refundIntent(l.lockId), eth: { chain_id: 1 }, hash: h2 }), ...FEE });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("a file whose chain_id is not 1 is refused by lock, claim and refund, dry run or not, even on a node that says chain 1; nothing is sent", async () => {
      const net = asMainnet();
      const tReveal = (await latestTs()) + 2 * HOUR;
      const n = await nonce(bobAddr);
      for (const chain_id of [31337, 11155111, 2, 0]) {
        const files = {
          lock: lockSwap(tReveal, { eth: { chain_id } }),
          claim: swapFile({ intent: revealIntent(rand32(), tReveal, tReveal - 1800), eth: { chain_id } }),
          refund: swapFile({ intent: refundIntent(rand32()), eth: { chain_id } }),
        };
        const re = new RegExp(`--mainnet: the swap file's chain_id is ${chain_id}, not 1; refusing`);
        for (const dryRun of [true, false]) {
          await expect(live.lock(net, bob, { swap: files.lock, dryRun, ...FEE }), `lock ${chain_id}`).to.be.rejectedWith(re);
          await expect(live.claim(net, carol, { swap: files.claim, secret: preimage, dryRun, ...FEE }), `claim ${chain_id}`).to.be.rejectedWith(re);
          await expect(live.refund(net, bob, { swap: files.refund, dryRun, ...FEE }), `refund ${chain_id}`).to.be.rejectedWith(re);
        }
      }
      expect(await nonce(bobAddr)).to.equal(n);
    });

    it("a file whose profile is not production (sepolia, rehearsal, any other string) is refused by lock, claim and refund", async () => {
      const net = asMainnet();
      const tReveal = (await latestTs()) + 2 * HOUR;
      const n = await nonce(bobAddr);
      for (const profile of ["sepolia", "rehearsal", "Production", "production ", "mainnet"]) {
        const files = {
          lock: lockSwap(tReveal, { eth: { chain_id: 1 }, profile }),
          claim: swapFile({ intent: revealIntent(rand32(), tReveal, tReveal - 1800), eth: { chain_id: 1 }, profile }),
          refund: swapFile({ intent: refundIntent(rand32()), eth: { chain_id: 1 }, profile }),
        };
        const re = new RegExp(`--mainnet: the swap file's profile is ${profile}, not production; refusing`);
        for (const dryRun of [true, false]) {
          await expect(live.lock(net, bob, { swap: files.lock, dryRun, ...FEE }), `lock ${profile}`).to.be.rejectedWith(re);
          await expect(live.claim(net, carol, { swap: files.claim, secret: preimage, dryRun, ...FEE }), `claim ${profile}`).to.be.rejectedWith(re);
          await expect(live.refund(net, bob, { swap: files.refund, dryRun, ...FEE }), `refund ${profile}`).to.be.rejectedWith(re);
        }
      }
      // a profile that is not a string at all is a malformed file, not a production file
      for (const profile of [null, 5, "", {}]) {
        await expect(live.lock(net, bob, { swap: lockSwap(tReveal, { eth: { chain_id: 1 }, profile }), dryRun: true, ...FEE }), JSON.stringify(profile)).to.be.rejectedWith(/swap file profile must be a non-empty string/);
      }
      expect(await nonce(bobAddr)).to.equal(n);
    });

    it("the profile is only read as the file stores it: a profile in the intent or at the top level does not make a sepolia file production", async () => {
      const net = asMainnet();
      const tReveal = (await latestTs()) + 2 * HOUR;
      const file = lockSwap(tReveal, { eth: { chain_id: 1 }, profile: "sepolia" });
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      j.profile = "production";
      j.pending_intent.params.profile = "production";
      fs.writeFileSync(file, JSON.stringify(j));
      await expect(live.lock(net, bob, { swap: file, dryRun: true, ...FEE })).to.be.rejectedWith(/profile is sepolia, not production/);
    });

    it("the file's chain 1 and profile are not enough on their own: --chain-id must still agree, and a test node is still refused", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const file = lockSwap(tReveal, { eth: { chain_id: 1 } });
      await expect(live.lock(asMainnet(), bob, { swap: file, dryRun: true, chainId: "31337", ...FEE })).to.be.rejectedWith(/--chain-id disagrees with the swap file: you gave 31337, the file has 1/);
      await expect(live.lock(provider, bob, { swap: file, dryRun: true, ...FEE })).to.be.rejectedWith(/--mainnet is given but the RPC endpoint reports chain 31337, not 1/);
    });

    it("without --mainnet, a chain_id 1 file is refused on any node (the swap file does not unlock mainnet), a test file is unchanged", async () => {
      const tReveal = (await latestTs()) + 2 * HOUR;
      const file = lockSwap(tReveal, { eth: { chain_id: 1 } });
      const n = await nonce(bobAddr);
      for (const node of [asMainnet(), provider]) {
        await expect(live.lock(node, bob, { swap: file, dryRun: true })).to.be.rejectedWith(/Ethereum mainnet \(chainId 1\) without --mainnet/);
        await expect(live.lock(node, bob, { swap: file })).to.be.rejectedWith(/Ethereum mainnet \(chainId 1\) without --mainnet/);
      }
      expect(await nonce(bobAddr)).to.equal(n);
      // a file of another profile on a test chain runs as before (profile is only a mainnet check)
      const ok = await live.lock(provider, bob, { swap: lockSwap(tReveal, { profile: "sepolia" }), dryRun: true });
      expect(ok.chainId).to.equal("31337");
    });
  });

  // ------------------------------------------------------------------ the command line
  describe("the command line", () => {
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ETH_RPC_URL: "http://127.0.0.1:9" } });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end("");
      });
    const WARNING = "warning: no --swap FILE, the swap file's intent is not checked (REVIEW-3 F3)";

    it("lock, claim and refund warn once on stderr without --swap, and stay quiet about it with --swap", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      const swap = swapFile({});
      for (const cmd of ["lock", "claim", "refund"]) {
        const without = await run([cmd, "--key-file", keyFile]);
        expect(without.err.split(WARNING).length - 1, `${cmd}: ${without.err}`).to.equal(1);
        expect(without.code).to.equal(1);
        const withSwap = await run([cmd, "--key-file", keyFile, "--swap", swap]);
        expect(withSwap.err, cmd).to.not.include("warning: no --swap");
        expect(withSwap.err, cmd).to.match(/no pending intent; expected (lock_eth|reveal_eth|refund_eth)/);
        expect(withSwap.code).to.equal(1);
      }
      // Other commands do not warn.
      const kg = await run(["keygen", "--out", path.join(dir, "k2.key")]);
      expect(kg.code, kg.err).to.equal(0);
      expect(kg.err).to.not.include("warning: no --swap");
    });

    it("lock without --swap says plainly that NO producer check was made; claim and refund do not say it, and --swap silences it", async () => {
      const keyFile = path.join(dir, "k3.key");
      await live.keygen(null, null, { out: keyFile });
      const without = await run(["lock", "--key-file", keyFile]);
      expect(without.err).to.include(live.NO_SWAP_LOCK_WARNING.trim());
      expect(without.err.split("NO producer check was made").length - 1).to.equal(1);
      for (const cmd of ["claim", "refund"]) expect((await run([cmd, "--key-file", keyFile])).err, cmd).to.not.include("NO producer check was made");
      const withSwap = await run(["lock", "--key-file", keyFile, "--swap", swapFile({})]);
      expect(withSwap.err).to.not.include("NO producer check was made");
    });

    it("--swap is a flag of exactly lock, claim and refund", () => {
      for (const cmd of ["lock", "claim", "refund"]) expect(live.parseArgs([cmd, "--swap", "f.json"]).args).to.deep.equal({ swap: "f.json" });
      for (const cmd of ["send", "status", "deploy"]) expect(() => live.parseArgs([cmd, "--swap", "f.json"])).to.throw(/unknown flag --swap/);
    });
  });
});

// ===========================================================================
// Ethereum mainnet: --mainnet and --max-fee-gwei (fail-closed). No mainnet node is needed: the in-process node
// answers as chain 1 (eth_chainId and getNetwork), while the signers stay bound to the real in-process node.
// ===========================================================================
describe("live.js --mainnet (chain id 1)", function () {
  this.timeout(180000);
  const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
  const GWEI = 10n ** 9n;
  const CAP = "50";
  const SIGNING = ["deploy", "send", "lock", "claim", "refund"];
  const amount = ethers.parseEther("0.2");
  let provider, alice, bob, carol, htlcAddr, tgt, tgtMain, aliceAddr, bobAddr, carolAddr, dir;

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const bal = (a) => provider.getBalance(a);
  const nonce = (a) => provider.getTransactionCount(a);
  const m = (over = {}) => ({ mainnet: true, maxFeeGwei: CAP, ...over });

  /** The in-process node answering as chain `id`. */
  const asChain = (id) =>
    new Proxy(provider, {
      get(t, prop) {
        if (prop === "getNetwork") return async () => ({ chainId: BigInt(id) });
        if (prop === "send") return async (method, params) => (method === "eth_chainId" ? "0x" + BigInt(id).toString(16) : provider.send(method, params));
        const v = t[prop];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const lockTerms = async (over = {}) => ({
    contract: htlcAddr, hashlock: sha256Raw(rand32()), tReveal: String((await latestTs()) + 2 * HOUR), receiver: bobAddr, amountWei: "1000", ...over,
  });
  /** A lock on the (test) node itself, made without --mainnet, for the claim and refund cases. */
  async function makeLock({ ttl = 2 * HOUR, signer = alice } = {}) {
    const preimage = rand32();
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, signer, { ...tgt, contract: htlcAddr, hashlock: sha256Raw(preimage), tReveal: String(tReveal), receiver: bobAddr, amountWei: amount.toString() });
    return { preimage, tReveal, ...l };
  }
  const passAge = async (s) => {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  };
  /**
   * A swap file with only the parts live.js reads, for the action (lock_eth, reveal_eth, refund_eth) and chain 1
   * (production profile: no `profile` field). Under --mainnet, lock, claim and refund need one.
   */
  let nSwap = 0;
  function swapFile({ action, hashlock = rand32(), contract = htlcAddr, receiver = bobAddr, sender = aliceAddr, amountWei = "1000", lockId, tReveal = 0, chain = 1 }) {
    const params =
      action === "lock_eth" ? { hashlock, t_reveal: tReveal, receiver, amount_wei: amountWei }
      : action === "reveal_eth" ? { lock_id: lockId, t_reveal: tReveal, cutoff: tReveal - 1800 }
      : { lock_id: lockId };
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock,
        claim_authority: "o1test",
        params: { eth: { chain_id: chain, contract, code_hash: tgt.codeHash, amount_wei: amountWei, alice_receiver: receiver, bob_sender: sender } },
      },
      pending_intent: { action, params: { action, ...params }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 },
      secret: { ciphertext: "not-read-by-live.js" },
    };
    const file = path.join(dir, `swap-${nSwap++}.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }
  /** The swap file of a lock made by makeLock (alice -> bob, `amount`), for claim (reveal_eth) or refund (refund_eth). */
  const fileOfLock = (action, l, hashlock = sha256Raw(l.preimage), contract = htlcAddr) =>
    swapFile({ action, hashlock, contract, receiver: bobAddr, sender: aliceAddr, amountWei: amount.toString(), lockId: l.lockId, tReveal: l.tReveal });
  /** A call of each signing command, with `extra` merged into its flags; on `node`, signed by the right key. Under --mainnet, lock/claim/refund get a matching swap file. */
  async function call(cmd, node, extra) {
    const t = await lockTerms();
    const needSwap = extra.mainnet === true && extra.swap === undefined;
    const lockId = rand32();
    switch (cmd) {
      case "deploy": return live.deploy(node, alice, { ...extra });
      case "send": return live.send(node, alice, { to: carolAddr, amountWei: "1000", ...extra });
      case "lock": {
        const sw = needSwap ? { swap: swapFile({ action: "lock_eth", hashlock: t.hashlock, tReveal: Number(t.tReveal), receiver: t.receiver, amountWei: t.amountWei, sender: aliceAddr }) } : {};
        return lockApproved(node, alice, { ...tgtMain, ...t, ...sw, ...extra });
      }
      case "claim": {
        const sw = needSwap ? { swap: swapFile({ action: "reveal_eth", lockId, tReveal: Number(t.tReveal), sender: aliceAddr }) } : {};
        return live.claim(node, bob, { ...tgtMain, contract: htlcAddr, lockId, secret: rand32(), ...sw, ...extra });
      }
      case "refund": {
        const sw = needSwap ? { swap: swapFile({ action: "refund_eth", lockId, sender: aliceAddr }) } : {};
        return live.refund(node, alice, { ...tgtMain, contract: htlcAddr, lockId, ...sw, ...extra });
      }
      default: throw new Error(cmd);
    }
  }

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    [aliceAddr, bobAddr, carolAddr] = await Promise.all([alice.getAddress(), bob.getAddress(), carol.getAddress()]);
    const d = await live.deploy(provider, carol, {});
    htlcAddr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    tgtMain = { chainId: "1", codeHash: d.codeHash };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-mainnet-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // ------------------------------------------------------------------ the flags
  describe("the flags", () => {
    it("--mainnet and --max-fee-gwei exist on exactly deploy, send, lock, claim and refund", () => {
      for (const cmd of SIGNING) {
        expect(live.parseArgs([cmd, "--mainnet", "--max-fee-gwei", "3.5"]).args, cmd).to.deep.equal({ mainnet: true, maxFeeGwei: "3.5" });
        expect(() => live.parseArgs([cmd, "--max-fee-gwei"]), cmd).to.throw(/needs a value/);
      }
      for (const cmd of ["balance", "status", "keygen"]) {
        expect(() => live.parseArgs([cmd, "--mainnet"]), cmd).to.throw(/unknown flag --mainnet/);
        expect(() => live.parseArgs([cmd, "--max-fee-gwei", "5"]), cmd).to.throw(/unknown flag --max-fee-gwei/);
      }
    });

    it("--max-fee-gwei without --mainnet is refused by all five commands, before the network is touched", async () => {
      for (const cmd of SIGNING) {
        const n = await nonce(aliceAddr);
        await expect(call(cmd, null, { maxFeeGwei: CAP }), cmd).to.be.rejectedWith(/--max-fee-gwei is only accepted together with --mainnet/);
        await expect(call(cmd, null, { maxFeeGwei: CAP, dryRun: true }), cmd).to.be.rejectedWith(/only accepted together with --mainnet/);
        expect(await nonce(aliceAddr)).to.equal(n);
      }
    });

    it("--mainnet needs --max-fee-gwei, a positive decimal number of gwei (all five commands)", async () => {
      for (const cmd of SIGNING) {
        await expect(call(cmd, null, { mainnet: true }), cmd).to.be.rejectedWith(/missing required --max-fee-gwei/);
        await expect(call(cmd, null, { mainnet: true, maxFeeGwei: "" }), cmd).to.be.rejectedWith(/missing required --max-fee-gwei/);
        await expect(call(cmd, null, { mainnet: true, maxFeeGwei: "0" }), cmd).to.be.rejectedWith(/--max-fee-gwei must be > 0/);
        for (const bad of ["abc", "-1", "1e3", "0x10", ".5", "1.0000000001", "5 gwei"]) {
          await expect(call(cmd, null, { mainnet: true, maxFeeGwei: bad }), `${cmd} ${bad}`).to.be.rejectedWith(/--max-fee-gwei must be a positive decimal number/);
        }
      }
    });

    it("--mainnet is not combined with --allow-chain-id or --gas-price-gwei (all five commands)", async () => {
      for (const cmd of SIGNING) {
        await expect(call(cmd, null, m({ allowChainId: "31337" })), cmd).to.be.rejectedWith(/--mainnet cannot be combined with --allow-chain-id/);
        await expect(call(cmd, null, m({ allowChainId: "1" })), cmd).to.be.rejectedWith(/--mainnet cannot be combined with --allow-chain-id/);
        await expect(call(cmd, null, m({ gasPriceGwei: "5" })), cmd).to.be.rejectedWith(/--mainnet cannot be combined with --gas-price-gwei/);
      }
    });
  });

  // ------------------------------------------------------------------ the chain
  describe("the chain", () => {
    it("without --mainnet, a node that says chain 1 is refused by all five commands, also with --allow-chain-id 1 and --dry-run; nothing is sent", async () => {
      const net = asChain(1);
      for (const cmd of SIGNING) {
        for (const extra of [{}, { dryRun: true }, { allowChainId: "1" }, { allowChainId: "1", dryRun: true }]) {
          const n = await nonce(aliceAddr);
          await expect(call(cmd, net, extra), `${cmd} ${JSON.stringify(extra)}`).to.be.rejectedWith(/Ethereum mainnet \(chainId 1\) without --mainnet/);
          expect(await nonce(aliceAddr)).to.equal(n);
        }
      }
      // --chain-id 1 against a test node is refused the same way (lock, claim, refund)
      for (const cmd of ["lock", "claim", "refund"]) await expect(call(cmd, provider, { dryRun: true }), cmd).to.be.rejectedWith(/Ethereum mainnet \(chainId 1\) without --mainnet/);
    });

    it("with --mainnet, a test network is refused by all five commands (the node's chain id), also with --dry-run; nothing is sent", async () => {
      // the real node is chain 31337
      for (const cmd of SIGNING) {
        for (const extra of [m(), m({ dryRun: true })]) {
          const n = await nonce(aliceAddr);
          const re = cmd === "lock" || cmd === "claim" || cmd === "refund" ? /--mainnet is given but the RPC endpoint reports chain 31337, not 1/ : /--mainnet is given but the node is chain 31337/;
          await expect(call(cmd, provider, extra), `${cmd} ${JSON.stringify(extra)}`).to.be.rejectedWith(re);
          expect(await nonce(aliceAddr)).to.equal(n);
        }
      }
      // other well-known test chains behind the proxy, and an unknown one
      for (const id of [11155111, 17000, 1337, 10]) {
        await expect(call("send", asChain(id), m()), String(id)).to.be.rejectedWith(new RegExp(`--mainnet is given but the node is chain ${id}, not Ethereum mainnet`));
        await expect(call("deploy", asChain(id), m({ dryRun: true })), String(id)).to.be.rejectedWith(/mainnet and test networks are never mixed/);
      }
    });

    it("with --mainnet, --chain-id must be 1 (lock, claim, refund), whatever the node says; the swap file (chain 1) disagrees with any other value", async () => {
      const net = asChain(1);
      for (const cmd of ["lock", "claim", "refund"]) {
        const n = await nonce(aliceAddr);
        await expect(call(cmd, net, m({ chainId: "31337", dryRun: true })), cmd).to.be.rejectedWith(/--chain-id disagrees with the swap file: you gave 31337, the file has 1/);
        await expect(call(cmd, provider, m({ chainId: "31337", dryRun: true })), cmd).to.be.rejectedWith(/--chain-id disagrees with the swap file: you gave 31337, the file has 1/);
        expect(await nonce(aliceAddr)).to.equal(n);
      }
    });

    it("lock under --mainnet refuses without --swap FILE (also with --dry-run and an empty value); nothing is sent", async () => {
      const net = asChain(1);
      const n = await nonce(aliceAddr);
      const t = await lockTerms();
      for (const extra of [{}, { dryRun: true }, { swap: "" }]) {
        await expect(live.lock(net, alice, { ...tgtMain, ...t, ...m(), ...extra }), JSON.stringify(extra)).to.be.rejectedWith(/--mainnet requires --swap FILE for lock, claim and refund/);
      }
      expect(await nonce(aliceAddr)).to.equal(n);
    });

    it("claim under --mainnet refuses without --swap FILE (also with --dry-run and an empty value); nothing is sent", async () => {
      const net = asChain(1);
      const l = await makeLock({ ttl: HOUR });
      const n = await nonce(bobAddr);
      for (const extra of [{}, { dryRun: true }, { swap: "" }]) {
        await expect(live.claim(net, bob, { ...tgtMain, contract: htlcAddr, lockId: l.lockId, secret: l.preimage, ...m(), ...extra }), JSON.stringify(extra)).to.be.rejectedWith(/--mainnet requires --swap FILE for lock, claim and refund/);
      }
      expect(await nonce(bobAddr)).to.equal(n);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("refund under --mainnet refuses without --swap FILE (also with --dry-run and an empty value); nothing is sent", async () => {
      const net = asChain(1);
      const l = await makeLock({ ttl: HOUR });
      await passAge(HOUR + 5);
      const n = await nonce(aliceAddr);
      for (const extra of [{}, { dryRun: true }, { swap: "" }]) {
        await expect(live.refund(net, alice, { ...tgtMain, contract: htlcAddr, lockId: l.lockId, ...m(), ...extra }), JSON.stringify(extra)).to.be.rejectedWith(/--mainnet requires --swap FILE for lock, claim and refund/);
      }
      expect(await nonce(aliceAddr)).to.equal(n);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^expired-unclaimed/);
    });
  });

  // ------------------------------------------------------------------ the fee cap and the balance
  describe("fee safety on chain 1", () => {
    const worstOf = (r, cap = CAP) => BigInt(r.gasEstimate) * ethers.parseUnits(cap, "gwei");

    it("send --dry-run prints the cap, the worst-case cost (gas estimate x cap), the amount and the sender's balance", async () => {
      const net = asChain(1);
      const before = await bal(aliceAddr);
      const r = await live.send(net, alice, { to: carolAddr, amountWei: "1000", dryRun: true, ...m() });
      expect(r.dryRun).to.equal(true);
      expect(r.sent).to.equal(false);
      expect(r.chainId).to.equal("1");
      expect(r.maxFeeGwei).to.equal("50.0");
      expect(BigInt(r.gasEstimate)).to.be.gt(0n);
      expect(r.worstCaseFeeWei).to.equal(worstOf(r).toString());
      expect(r.worstCaseFeeEth).to.equal(ethers.formatEther(worstOf(r)));
      expect(r.requiredWei).to.equal((worstOf(r) + 1000n).toString());
      expect(r.senderBalanceWei).to.equal(before.toString());
      expect(r.senderBalanceEth).to.equal(ethers.formatEther(before));
      expect(await bal(aliceAddr)).to.equal(before);
      // a decimal cap
      const half = await live.send(net, alice, { to: carolAddr, amountWei: "1000", dryRun: true, ...m({ maxFeeGwei: "2.5" }) });
      expect(half.maxFeeGwei).to.equal("2.5");
      expect(half.worstCaseFeeWei).to.equal(worstOf(half, "2.5").toString());
    });

    it("deploy, lock and refund dry runs print the same fee block; claim does with the secret, and without it states what is missing", async () => {
      const net = asChain(1);
      const d = await live.deploy(net, alice, { dryRun: true, ...m() });
      expect(d.worstCaseFeeWei).to.equal(worstOf(d).toString());
      expect(d.requiredWei).to.equal(worstOf(d).toString()); // no value
      expect(d.expectedContract).to.match(/^0x[0-9a-fA-F]{40}$/);

      const t = await lockTerms({ amountWei: amount.toString() });
      const lk = await live.lock(net, alice, { ...tgtMain, ...t, swap: swapFile({ action: "lock_eth", hashlock: t.hashlock, tReveal: Number(t.tReveal), receiver: t.receiver, amountWei: t.amountWei, sender: aliceAddr }), dryRun: true, ...m() });
      expect(lk.worstCaseFeeWei).to.equal(worstOf(lk).toString());
      expect(lk.requiredWei).to.equal((worstOf(lk) + amount).toString());
      expect(lk.senderBalanceWei).to.equal((await bal(aliceAddr)).toString());
      expect(lk.expectedLockId).to.match(/^0x[0-9a-f]{64}$/);

      const l = await makeLock({ ttl: HOUR });
      const clSwap = fileOfLock("reveal_eth", l);
      const cl = await live.claim(net, bob, { ...tgtMain, contract: htlcAddr, lockId: l.lockId, secret: l.preimage, swap: clSwap, dryRun: true, ...m() });
      // The claim's gas is the fixed limit (REVIEW-6 R6-8), so the worst case is limit x cap.
      expect(cl.gasEstimate).to.equal(null);
      expect(cl.worstCaseFeeWei).to.equal((BigInt(cl.gasLimit) * ethers.parseUnits(CAP, "gwei")).toString());
      expect(cl.senderBalanceWei).to.equal((await bal(bobAddr)).toString());
      const clNoSecret = await live.claim(net, bob, { ...tgtMain, contract: htlcAddr, lockId: l.lockId, swap: clSwap, dryRun: true, ...m() });
      expect(clNoSecret.gasEstimate).to.equal(null);
      expect(clNoSecret.maxFeeGwei).to.equal("50.0");
      expect(clNoSecret.worstCaseFeeWei).to.equal(null);
      expect(clNoSecret.worstCaseFeeNote).to.match(/real secret/);
      expect(clNoSecret.senderBalanceWei).to.equal((await bal(bobAddr)).toString());

      await passAge(HOUR + 5);
      const rf = await live.refund(net, alice, { ...tgtMain, contract: htlcAddr, lockId: l.lockId, swap: fileOfLock("refund_eth", l), dryRun: true, ...m() });
      expect(rf.worstCaseFeeWei).to.equal(worstOf(rf).toString());
      expect(rf.senderBalanceWei).to.equal((await bal(aliceAddr)).toString());
    });

    it("a test-network dry run is unchanged: no fee block", async () => {
      const r = await live.send(provider, alice, { to: carolAddr, amountWei: "1000", dryRun: true });
      for (const k of ["maxFeeGwei", "worstCaseFeeWei", "worstCaseFeeEth", "requiredWei", "senderBalanceWei"]) expect(r, k).to.not.have.property(k);
    });

    it("refuses when the balance cannot cover amount + worst-case fee: dry run and real send, nothing is sent", async () => {
      const net = asChain(1);
      const w = ethers.Wallet.createRandom().connect(provider);
      await live.send(provider, alice, { to: w.address, amountWei: ethers.parseEther("1").toString() });
      const cap = "10";
      // The balance covers the amount but not amount + worst-case fee.
      const tooMuch = ethers.parseEther("0.9999").toString();
      const re = new RegExp(`refusing: the sender ${w.address} holds 1\\.0 ETH but amount 0\\.9999 ETH \\+ worst-case fee 0\\.\\d+ ETH \\(gas estimate \\d+ x 10\\.0 gwei\\) = 1\\.\\d+ ETH is needed`);
      const before = await bal(w.address);
      await expect(live.send(net, w, { to: carolAddr, amountWei: tooMuch, dryRun: true, ...m({ maxFeeGwei: cap }) })).to.be.rejectedWith(re);
      await expect(live.send(net, w, { to: carolAddr, amountWei: tooMuch, ...m({ maxFeeGwei: cap }) })).to.be.rejectedWith(re);
      expect(await bal(w.address)).to.equal(before);
      expect(await nonce(w.address)).to.equal(0);
      // The same wallet, with an amount that leaves room for the worst case, is accepted (dry run, then real).
      const ok = await live.send(net, w, { to: carolAddr, amountWei: ethers.parseEther("0.5").toString(), dryRun: true, ...m({ maxFeeGwei: cap }) });
      expect(BigInt(ok.requiredWei)).to.be.lt(before);
      const sent = await live.send(net, w, { to: carolAddr, amountWei: ethers.parseEther("0.5").toString(), ...m({ maxFeeGwei: cap }) });
      expect(sent.txHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("the boundary is exact: a balance of amount + worst-case fee passes, one wei less is refused", async () => {
      const net = asChain(1);
      const w = ethers.Wallet.createRandom().connect(provider);
      await live.send(provider, alice, { to: w.address, amountWei: ethers.parseEther("1").toString() });
      const flags = { to: carolAddr, amountWei: ethers.parseEther("0.25").toString(), dryRun: true, ...m({ maxFeeGwei: "10" }) };
      const probe = await live.send(net, w, flags);
      const exact = BigInt(probe.requiredWei);
      await provider.send("hardhat_setBalance", [w.address, "0x" + exact.toString(16)]);
      const pass = await live.send(net, w, flags);
      expect(pass.requiredWei).to.equal(exact.toString());
      expect(pass.senderBalanceWei).to.equal(exact.toString());
      await provider.send("hardhat_setBalance", [w.address, "0x" + (exact - 1n).toString(16)]);
      await expect(live.send(net, w, flags)).to.be.rejectedWith(/refusing: the sender 0x[0-9a-fA-F]{40} holds .* ETH but amount 0\.25 ETH \+ worst-case fee/);
    });

    it("lock refuses on balance too (value + worst case), before anything is sent", async () => {
      const net = asChain(1);
      const w = ethers.Wallet.createRandom().connect(provider);
      await live.send(provider, alice, { to: w.address, amountWei: ethers.parseEther("1").toString() });
      const t = await lockTerms({ amountWei: ethers.parseEther("0.9999").toString() });
      const n = await nonce(w.address);
      for (const dryRun of [true, false]) {
        const swap = swapFile({ action: "lock_eth", hashlock: t.hashlock, tReveal: Number(t.tReveal), receiver: t.receiver, amountWei: t.amountWei, sender: w.address });
        await expect(lockApproved(net, w, { ...tgtMain, ...t, swap, dryRun, ...m({ maxFeeGwei: "10" }) }), `dryRun ${dryRun}`).to.be.rejectedWith(/refusing: the sender 0x[0-9a-fA-F]{40} holds 1\.0 ETH but amount 0\.9999 ETH \+ worst-case fee/);
      }
      expect(await nonce(w.address)).to.equal(n);
    });
  });

  // ------------------------------------------------------------------ accepted on chain 1
  describe("accepted with --mainnet on chain 1", () => {
    it("deploy, lock, claim, refund and send run for real; the transactions carry the cap as maxFeePerGas", async () => {
      const net = asChain(1);
      const flags = m({ maxFeeGwei: "20" });
      const cap = 20n * GWEI;
      const feeOf = async (hash) => {
        const tx = await provider.getTransaction(hash);
        expect(tx.maxFeePerGas, hash).to.equal(cap);
        expect(tx.maxPriorityFeePerGas, hash).to.equal(GWEI);
      };

      const d = await live.deploy(net, alice, flags);
      expect(d.chainId).to.equal("1");
      expect(d.matchesArtifact).to.equal(true);
      expect(d.codeHash).to.equal(tgt.codeHash);
      await feeOf(d.txHash);

      const s = await live.send(net, alice, { to: carolAddr, amountWei: "12345", ...flags });
      await feeOf(s.txHash);

      const preimage = rand32();
      const hashlock = sha256Raw(preimage);
      const tReveal = (await latestTs()) + 2 * HOUR;
      const lockFile = (hl, tr) =>
        swapFile({ action: "lock_eth", hashlock: hl, contract: d.contract, tReveal: tr, receiver: aliceAddr, sender: bobAddr, amountWei: amount.toString() });
      const l = await lockApproved(net, bob, { swap: lockFile(hashlock, tReveal), ...tgtMain, contract: d.contract, hashlock, tReveal: String(tReveal), receiver: aliceAddr, amountWei: amount.toString(), ...flags });
      expect(l.chainId).to.equal("1");
      const ofLock = (action, lockId, hl, tr) =>
        swapFile({ action, hashlock: hl, contract: d.contract, tReveal: tr, receiver: aliceAddr, sender: bobAddr, amountWei: amount.toString(), lockId });
      await feeOf(l.txHash);

      const before = await bal(aliceAddr);
      const c = await live.claim(net, alice, { swap: ofLock("reveal_eth", l.lockId, hashlock, tReveal), ...tgtMain, contract: d.contract, lockId: l.lockId, secret: preimage, ...flags });
      await feeOf(c.txHash);
      expect(await bal(aliceAddr)).to.be.gt(before + amount - ethers.parseEther("0.01"));

      const t2 = (await latestTs()) + HOUR;
      const h2 = sha256Raw(rand32());
      const l2 = await lockApproved(net, bob, { swap: lockFile(h2, t2), ...tgtMain, contract: d.contract, hashlock: h2, tReveal: String(t2), receiver: aliceAddr, amountWei: amount.toString(), ...flags });
      await passAge(HOUR + 5);
      const r = await live.refund(net, bob, { swap: ofLock("refund_eth", l2.lockId, h2, t2), ...tgtMain, contract: d.contract, lockId: l2.lockId, ...flags });
      await feeOf(r.txHash);
      expect((await live.status(provider, null, { contract: d.contract, lockId: l2.lockId })).state).to.equal("refunded");
    });
  });

  // ------------------------------------------------------------------ the command line
  describe("the command line", () => {
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ETH_RPC_URL: "http://127.0.0.1:9" } });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end("");
      });
    const count = (text, needle) => text.split(needle).length - 1;
    const WARNING = "warning: --mainnet is in effect";

    it("the warning is exactly one line", () => {
      expect(live.MAINNET_WARNING.startsWith(WARNING)).to.equal(true);
      expect(live.MAINNET_WARNING.endsWith("\n")).to.equal(true);
      expect(count(live.MAINNET_WARNING, "\n")).to.equal(1);
    });

    it("--mainnet prints one warning line on stderr for each signing command, then refuses a missing cap; without --mainnet there is none", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      const swap = path.join(dir, "none.json");
      const extra = { deploy: [], send: ["--to", carolAddr, "--amount-wei", "1"], lock: ["--swap", swap], claim: ["--swap", swap], refund: ["--swap", swap] };
      for (const cmd of SIGNING) {
        const mainnet = await run([cmd, "--key-file", keyFile, ...extra[cmd], "--mainnet"]);
        expect(mainnet.code, `${cmd}: ${mainnet.err}`).to.equal(1);
        expect(count(mainnet.err, WARNING), `${cmd}: ${mainnet.err}`).to.equal(1);
        expect(mainnet.err, cmd).to.match(/error: missing required --max-fee-gwei/);
        if (cmd === "deploy" || cmd === "send") continue; // without --mainnet these would reach the (dead) RPC endpoint
        const plain = await run([cmd, "--key-file", keyFile, ...extra[cmd]]);
        expect(plain.err, cmd).to.not.include(WARNING);
        expect(plain.err, cmd).to.not.include("--max-fee-gwei");
      }
    });

    it("--mainnet without --swap is refused by lock, claim and refund on the command line, with no \"no --swap\" warning", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      for (const cmd of ["lock", "claim", "refund"]) {
        const r = await run([cmd, "--key-file", keyFile, "--mainnet", "--max-fee-gwei", "5"]);
        expect(r.code, `${cmd}: ${r.err}`).to.equal(1);
        expect(r.err, cmd).to.match(/error: --mainnet requires --swap FILE for lock, claim and refund/);
        expect(r.err, cmd).to.not.include("warning: no --swap");
        expect(count(r.err, WARNING), cmd).to.equal(1);
      }
    });

    it("--max-fee-gwei without --mainnet is refused on the command line, with no mainnet warning; --mainnet with --allow-chain-id likewise", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      const send = ["send", "--key-file", keyFile, "--to", carolAddr, "--amount-wei", "1"];
      const cap = await run([...send, "--max-fee-gwei", "5"]);
      expect(cap.code).to.equal(1);
      expect(cap.err).to.match(/error: --max-fee-gwei is only accepted together with --mainnet/);
      expect(cap.err).to.not.include(WARNING);
      const mixed = await run([...send, "--mainnet", "--max-fee-gwei", "5", "--allow-chain-id", "31337"]);
      expect(mixed.code).to.equal(1);
      expect(mixed.err).to.match(/error: --mainnet cannot be combined with --allow-chain-id/);
      expect(count(mixed.err, WARNING)).to.equal(1);
    });
  });
});

// ===========================================================================
// REVIEW-4 R4-1 (base fee check, --replace), R4-3 (late re-send cutoff), R4-5 (signer tied to the file)
// ===========================================================================
describe("live.js REVIEW-4 and REVIEW-5 (R4-1, R4-3, R4-5, R5-1, R5-2)", function () {
  this.timeout(180000);
  const GWEI = 10n ** 9n;
  const amount = ethers.parseEther("0.2");
  const ABI = () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "HTLC.sol", "HTLC.json"), "utf8")).abi;
  let provider, alice, bob, carol, htlcAddr, tgt, aliceAddr, bobAddr, carolAddr, dir, preimage, hashlock, nSwap;

  const latestBlk = () => provider.getBlock("latest");
  const latestTs = async () => (await latestBlk()).timestamp;
  const nonce = (a, tag = "latest") => provider.getTransactionCount(a, tag);
  const setBase = async (gwei) => {
    await provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + (BigInt(gwei) * GWEI).toString(16)]);
    await provider.send("evm_mine", []);
  };
  const asChain1 = () =>
    new Proxy(provider, {
      get(t, prop) {
        if (prop === "getNetwork") return async () => ({ chainId: 1n });
        if (prop === "send") return async (method, params) => (method === "eth_chainId" ? "0x1" : provider.send(method, params));
        const v = t[prop];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });

  function swapFile({ intent = null, chain = 31337, history, hash = hashlock, alice: aliceAddress = aliceAddr } = {}) {
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock: hash,
        claim_authority: "o1test",
        params: {
          eth: { chain_id: chain, contract: htlcAddr.toLowerCase(), code_hash: tgt.codeHash, amount_wei: amount.toString(), alice_receiver: String(aliceAddress).toLowerCase(), bob_sender: bobAddr.toLowerCase() },
        },
      },
      secret: { ciphertext: "not-read-by-live.js" },
    };
    if (intent) j.pending_intent = intent;
    if (history) j.history = history.map((event, i) => ({ at: 100 + i, event, from: "x", to: "y" }));
    const file = path.join(dir, `swap-${nSwap++}.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }
  const wrapIntent = (action, params) => ({ action, params: { action, ...params }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 });
  const revealIntent = (lockId, tReveal, cutoff, lateCutoff) =>
    wrapIntent("reveal_eth", { lock_id: lockId, t_reveal: tReveal, cutoff, ...(lateCutoff === undefined ? {} : { late_cutoff: lateCutoff }) });
  const refundIntent = (lockId) => wrapIntent("refund_eth", { lock_id: lockId });
  const lockIntent = (tReveal, hash = hashlock) => wrapIntent("lock_eth", { hashlock: hash, t_reveal: tReveal, receiver: aliceAddr.toLowerCase(), amount_wei: amount.toString() });

  async function makeLock({ ttl = 2 * HOUR, receiver = aliceAddr } = {}) {
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver, amountWei: amount.toString() });
    return { tReveal, ...l };
  }

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
    [aliceAddr, bobAddr, carolAddr] = await Promise.all([alice.getAddress(), bob.getAddress(), carol.getAddress()]);
    const d = await live.deploy(provider, carol, {});
    htlcAddr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    preimage = rand32();
    hashlock = sha256Raw(preimage);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-r4-"));
    nSwap = 0;
  });
  afterEach(async () => {
    await provider.send("evm_setAutomine", [true]);
    await setBase(1); // later tests assume a low base fee
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ R4-1: the base fee check
  describe("R4-1: the fee cap is checked against the latest base fee, also in --dry-run", () => {
    const MAIN = { mainnet: true };
    it("claim: a cap below 2 x the base fee is refused (dry run and real), 2 x passes and the report shows base fee, cap and ratio", async () => {
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBase(20);
      expect((await latestBlk()).baseFeePerGas).to.equal(20n * GWEI);
      const net = asChain1();
      const n = await nonce(aliceAddr);
      const re = /refusing: the fee cap 30\.0 gwei is below 2 x the latest base fee \(base fee 20\.0 gwei in block \d+; cap \/ base fee = 1\.50, the minimum is 2\)/;
      for (const dryRun of [true, false]) {
        await expect(live.claim(net, alice, { swap, secret: preimage, dryRun, ...MAIN, maxFeeGwei: "30" }), `dryRun ${dryRun}`).to.be.rejectedWith(re);
      }
      // without the secret the dry run refuses too
      await expect(live.claim(net, alice, { swap, dryRun: true, ...MAIN, maxFeeGwei: "30" })).to.be.rejectedWith(re);
      expect(await nonce(aliceAddr)).to.equal(n);
      const ok = await live.claim(net, alice, { swap, secret: preimage, dryRun: true, ...MAIN, maxFeeGwei: "40" });
      expect(ok.feeCheck).to.include({ baseFeeGwei: "20.0", maxFeeGwei: "40.0", ratio: "2.00", minRatio: "2" });
      const noSecret = await live.claim(net, alice, { swap, dryRun: true, ...MAIN, maxFeeGwei: "45" });
      expect(noSecret.feeCheck).to.include({ ratio: "2.25", minRatio: "2" });
      const real = await live.claim(net, alice, { swap, secret: preimage, ...MAIN, maxFeeGwei: "40" });
      expect(real.feeCheck.baseFeeGwei).to.equal("20.0");
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("lock and refund: a cap below the base fee is refused, one between 1 x and 2 x passes", async () => {
      const t1 = (await latestTs()) + 2 * HOUR;
      const h2 = sha256Raw(rand32()); // a second lock of this sender under the first lock's hashlock is refused by the F3 gate
      const lockSwap = swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) });
      const l = await makeLock({ ttl: HOUR });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      await setBase(20);
      const net = asChain1();
      const refundSwap = () => swapFile({ chain: 1, intent: refundIntent(l.lockId) });
      const n = await nonce(bobAddr);
      const re = /refusing: the fee cap 15\.0 gwei is below 1 x the latest base fee \(base fee 20\.0 gwei.*cap \/ base fee = 0\.75, the minimum is 1\)/;
      for (const dryRun of [true, false]) {
        await expect(live.lock(net, bob, { swap: lockSwap, dryRun, ...MAIN, maxFeeGwei: "15" })).to.be.rejectedWith(re);
        await expect(live.refund(net, bob, { swap: refundSwap(), dryRun, ...MAIN, maxFeeGwei: "15" })).to.be.rejectedWith(re);
      }
      expect(await nonce(bobAddr)).to.equal(n);
      const lk = await live.lock(net, bob, { swap: lockSwap, dryRun: true, ...MAIN, maxFeeGwei: "25" });
      expect(lk.feeCheck).to.include({ ratio: "1.25", minRatio: "1" });
      const rf = await live.refund(net, bob, { swap: refundSwap(), ...MAIN, maxFeeGwei: "25" });
      expect(rf.feeCheck).to.include({ ratio: "1.25", minRatio: "1" });
    });

    it("the --gas-price-gwei cap on a test chain is checked the same way; with no cap chosen there is no check", async () => {
      const l = await makeLock();
      await setBase(20);
      await expect(live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true, gasPriceGwei: "30" })).to.be.rejectedWith(/fee cap 30\.0 gwei is below 2 x the latest base fee/);
      const none = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true });
      expect(none).to.not.have.property("feeCheck");
    });
  });

  // ------------------------------------------------------------------ R4-1: --replace
  describe("R4-1: --replace re-sends the same call at the pending nonce with a raised fee", () => {
    const claimData = (lockId) => new ethers.Interface(ABI()).encodeFunctionData("claim", [lockId, preimage]);
    /** A stuck claim: sent with automine off, so it stays in the node's pool. Returns its hash. */
    async function stuckClaim(l, { maxFee = 3n * GWEI, tip = GWEI } = {}) {
      await provider.send("evm_setAutomine", [false]);
      const resp = await alice.sendTransaction({ to: htlcAddr, data: claimData(l.lockId), maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
      return resp.hash;
    }
    /** Run a real send while automine is off: wait until it has been sent (onSent), mine one block, return its result. */
    async function sendAndMine(run) {
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const p = run({ onSent: sent });
      await Promise.race([sentP, p.catch(() => {})]);
      await provider.send("evm_mine", []);
      return p;
    }

    it("replaces the stuck claim: same nonce, both fee fields up by 12.5 % or more, the old hash never mines, never a second nonce", async () => {
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const n0 = await nonce(aliceAddr);
      const oldHash = await stuckClaim(l);
      expect(await nonce(aliceAddr, "pending")).to.equal(n0 + 1);
      const net = asChain1();
      // a dry run shows the plan and sends nothing
      const dry = await live.claim(net, alice, { swap, secret: preimage, dryRun: true, replace: true, replaceTx: oldHash, mainnet: true, maxFeeGwei: "4" });
      expect(dry.replace).to.include({ nonce: n0, replacesTx: oldHash, oldFeeKnown: true, oldMaxFeeGwei: "3.0", oldTipGwei: "1.0", newMaxFeeGwei: "4.0", newTipGwei: "1.125" });
      expect(await nonce(aliceAddr, "pending")).to.equal(n0 + 1);
      // a cap that is not 12.5 % above the old one is refused
      await expect(live.claim(net, alice, { swap, secret: preimage, replace: true, replaceTx: oldHash, mainnet: true, maxFeeGwei: "3.2" })).to.be.rejectedWith(/--replace: the new fee cap 3\.2 gwei is below the minimum 3\.375 gwei/);
      const r = await sendAndMine((o) => live.claim(net, alice, { swap, secret: preimage, replace: true, replaceTx: oldHash, mainnet: true, maxFeeGwei: "4", ...o }));
      const nw = await provider.getTransaction(r.txHash);
      expect(nw.nonce).to.equal(n0);
      expect(nw.maxFeePerGas).to.equal(4n * GWEI);
      expect(nw.maxPriorityFeePerGas).to.be.gte((GWEI * 1125n) / 1000n);
      expect(await provider.getTransactionReceipt(oldHash)).to.equal(null);
      expect(await nonce(aliceAddr)).to.equal(n0 + 1); // exactly one transaction consumed the nonce
      expect(await nonce(aliceAddr, "pending")).to.equal(n0 + 1);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("without --max-fee-gwei (test chain) the fees are chosen: at least old + 12.5 % and 2 x the base fee", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const n0 = await nonce(aliceAddr);
      const oldHash = await stuckClaim(l, { maxFee: 5n * GWEI });
      const dry = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true, replaceTx: oldHash });
      expect(dry.replace.nonce).to.equal(n0);
      expect(ethers.parseUnits(dry.replace.newMaxFeeGwei, "gwei")).to.be.gte((5n * GWEI * 1125n) / 1000n);
      expect(ethers.parseUnits(dry.replace.newTipGwei, "gwei")).to.be.gte((GWEI * 1125n) / 1000n);
      const r = await sendAndMine((o) => live.claim(provider, alice, { swap, secret: preimage, replace: true, replaceTx: oldHash, ...o }));
      expect((await provider.getTransaction(r.txHash)).nonce).to.equal(n0);
      expect(await nonce(aliceAddr)).to.equal(n0 + 1);
    });

    it("without --replace-tx the old transaction is looked for in the node's pending block and pool, and identified (R5-2)", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const n0 = await nonce(aliceAddr);
      const oldHash = await stuckClaim(l);
      // (Hardhat's node shows its pool in the pending block; a node that does not is the R5-2 describe below.)
      const dry = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true });
      expect(dry.replace).to.include({ nonce: n0, replacesTx: oldHash, oldFeeKnown: true });
      const r = await sendAndMine((o) => live.claim(provider, alice, { swap, secret: preimage, replace: true, ...o }));
      expect((await provider.getTransaction(r.txHash)).nonce).to.equal(n0);
    });

    it("refuses when nothing is pending, dry run or not; never sends a second nonce", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const n = await nonce(aliceAddr, "pending");
      for (const dryRun of [true, false]) {
        await expect(live.claim(provider, alice, { swap, secret: preimage, replace: true, dryRun })).to.be.rejectedWith(/--replace: 0x[0-9a-fA-F]{40} has no pending transaction \(latest nonce \d+ = pending nonce \d+\); nothing to replace; refusing/);
      }
      expect(await nonce(aliceAddr, "pending")).to.equal(n);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    });

    it("refuses a pending transaction that is not this claim, a mined hash, and a lock that is already claimed", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      // an unrelated pending transaction at the nonce: replacing it would cancel something else
      await provider.send("evm_setAutomine", [false]);
      const other = await alice.sendTransaction({ to: carolAddr, value: 1n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      await expect(live.claim(provider, alice, { swap, secret: preimage, replace: true, replaceTx: other.hash })).to.be.rejectedWith(/is not a claim of lock/);
      await provider.send("evm_mine", []);
      // the hash of a mined transaction, while another transaction of the signer is pending
      await alice.sendTransaction({ to: carolAddr, value: 2n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      await expect(live.claim(provider, alice, { swap, secret: preimage, replace: true, replaceTx: other.hash })).to.be.rejectedWith(/already mined/);
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [true]);
      // the lock gets claimed: a later replace refuses on the lock, not on a nonce
      await live.claim(provider, alice, { swap, secret: preimage });
      const n = await nonce(aliceAddr, "pending");
      await expect(live.claim(provider, alice, { swap, secret: preimage, replace: true })).to.be.rejectedWith(/lock is already claimed/);
      expect(await nonce(aliceAddr, "pending")).to.equal(n);
    });

    it("--replace exists for claim and refund only, and --replace-tx needs --replace", async () => {
      for (const cmd of ["claim", "refund"]) expect(live.parseArgs([cmd, "--replace", "--replace-tx", rand32()]).args.replace).to.equal(true);
      for (const cmd of ["lock", "send", "deploy", "status"]) expect(() => live.parseArgs([cmd, "--replace"])).to.throw(/unknown flag --replace/);
      const t = (await latestTs()) + 2 * HOUR;
      await expect(live.lock(provider, bob, { swap: swapFile({ intent: lockIntent(t) }), replace: true, dryRun: true })).to.be.rejectedWith(/--replace exists for claim and refund only/);
      const l = await makeLock();
      await expect(live.claim(provider, alice, { swap: swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) }), secret: preimage, replaceTx: rand32(), dryRun: true })).to.be.rejectedWith(/--replace-tx needs --replace/);
    });

    it("refund --replace works on a stuck refund the same way", async () => {
      const l = await makeLock({ ttl: HOUR });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const n0 = await nonce(bobAddr);
      await provider.send("evm_setAutomine", [false]);
      const old = await bob.sendTransaction({ to: htlcAddr, data: new ethers.Interface(ABI()).encodeFunctionData("refund", [l.lockId]), maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      const swap = swapFile({ intent: refundIntent(l.lockId) });
      const r = await sendAndMine((o) => live.refund(provider, bob, { swap, replace: true, replaceTx: old.hash, ...o }));
      expect((await provider.getTransaction(r.txHash)).nonce).to.equal(n0);
      expect(await provider.getTransactionReceipt(old.hash)).to.equal(null);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("refunded");
    });

    it("a sent transaction is reported (hash, nonce) through onSent before the wait; the command line prints it for --replace-tx", async () => {
      const l = await makeLock();
      const seen = [];
      await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, onSent: (s) => seen.push(s) });
      expect(seen).to.have.length(1);
      expect(seen[0].hash).to.match(/^0x[0-9a-f]{64}$/);
      expect(seen[0].nonce).to.be.a("number");
    });
  });

  // ------------------------------------------------------------------ the tip: --priority-fee-gwei
  describe("--priority-fee-gwei: the tip is chosen by the operator, the cap stays the cap", () => {
    const MAIN = { mainnet: true };
    const TIP = "0.01";
    const tipWei = ethers.parseUnits(TIP, "gwei");
    const BASE = 60_000_000n; // 0.06 gwei: the base fee of the first mainnet run
    const gwei = (s) => ethers.parseUnits(s, "gwei");
    const setBaseWei = async (wei) => {
      await provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + BigInt(wei).toString(16)]);
      await provider.send("evm_mine", []);
    };
    /** [maxFeePerGas, maxPriorityFeePerGas] of a mined transaction. */
    const feesOf = async (hash) => {
      const tx = await provider.getTransaction(hash);
      return [tx.maxFeePerGas, tx.maxPriorityFeePerGas];
    };
    const sendTo = (node, extra) => live.send(node, alice, { to: carolAddr, amountWei: "1", ...extra });
    beforeEach(async () => {
      await setBaseWei(BASE); // a cap below 1 gwei must clear the base fee for the node to take the transaction
    });

    it("is applied by lock, claim, refund and send on chain 1: maxPriorityFeePerGas is the flag, maxFeePerGas the cap", async () => {
      const net = asChain1();
      const flags = { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: TIP };
      const cap = gwei("0.2");
      // lock
      const t1 = (await latestTs()) + 2 * HOUR;
      const h2 = sha256Raw(rand32());
      const lk = await lockApproved(net, bob, { swap: swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) }), ...flags });
      expect(await feesOf(lk.txHash)).to.deep.equal([cap, tipWei]);
      expect(lk.feeCheck).to.include({ priorityFeeGwei: TIP, maxFeeGwei: "0.2" });
      // claim
      const l = await makeLock();
      await setBaseWei(BASE);
      const c = await live.claim(net, alice, { swap: swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) }), secret: preimage, ...flags });
      expect(await feesOf(c.txHash)).to.deep.equal([cap, tipWei]);
      expect(c.feeCheck.priorityFeeGwei).to.equal(TIP);
      // refund (a plain test-chain lock made by bob, aged past its timelock)
      const h3 = sha256Raw(rand32());
      const t3 = (await latestTs()) + HOUR;
      const l3 = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: h3, tReveal: String(t3), receiver: aliceAddr, amountWei: amount.toString() });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await setBaseWei(BASE);
      const rf = await live.refund(net, bob, { swap: swapFile({ chain: 1, hash: h3, intent: refundIntent(l3.lockId) }), ...flags });
      expect(await feesOf(rf.txHash)).to.deep.equal([cap, tipWei]);
      expect(rf.feeCheck.priorityFeeGwei).to.equal(TIP);
      // send (no base-fee check, same fee fields)
      expect(await feesOf((await sendTo(net, flags)).txHash)).to.deep.equal([cap, tipWei]);
      // a tip equal to the cap is allowed
      expect(await feesOf((await sendTo(net, { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.2" })).txHash)).to.deep.equal([cap, cap]);
    });

    it("is applied with --gas-price-gwei on a test chain, and the flag is on exactly deploy, send, lock, claim and refund", async () => {
      expect(await feesOf((await sendTo(provider, { gasPriceGwei: "2", priorityFeeGwei: TIP })).txHash)).to.deep.equal([gwei("2"), tipWei]);
      const l = await makeLock();
      await setBaseWei(BASE);
      const c = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, gasPriceGwei: "2", priorityFeeGwei: TIP });
      expect(await feesOf(c.txHash)).to.deep.equal([gwei("2"), tipWei]);
      for (const cmd of ["deploy", "send", "lock", "claim", "refund"]) {
        expect(live.parseArgs([cmd, "--priority-fee-gwei", "0.5"]).args, cmd).to.deep.equal({ priorityFeeGwei: "0.5" });
        expect(() => live.parseArgs([cmd, "--priority-fee-gwei"]), cmd).to.throw(/needs a value/);
      }
      for (const cmd of ["balance", "status", "keygen"]) expect(() => live.parseArgs([cmd, "--priority-fee-gwei", "0.5"]), cmd).to.throw(/unknown flag --priority-fee-gwei/);
    });

    it("a tip above the cap is refused (every signing command, dry run or not), nothing is sent", async () => {
      const net = asChain1();
      const re = /--priority-fee-gwei 0\.3 gwei is above the fee cap 0\.2 gwei; the tip cannot exceed the cap; refusing/;
      const n = await nonce(aliceAddr, "pending");
      const bad = { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.3" };
      await expect(sendTo(net, bad)).to.be.rejectedWith(re);
      await expect(live.deploy(net, alice, { ...bad, dryRun: true })).to.be.rejectedWith(re);
      const l = await makeLock();
      const nb = await nonce(bobAddr, "pending"); // after Bob's own lock
      for (const dryRun of [true, false]) {
        await expect(live.claim(net, alice, { swap: swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) }), secret: preimage, dryRun, ...bad }), `claim ${dryRun}`).to.be.rejectedWith(re);
        await expect(live.refund(net, bob, { swap: swapFile({ chain: 1, intent: refundIntent(l.lockId) }), dryRun, ...bad }), `refund ${dryRun}`).to.be.rejectedWith(re);
        const h2 = sha256Raw(rand32());
        await expect(live.lock(net, bob, { swap: swapFile({ chain: 1, hash: h2, intent: lockIntent((await latestTs()) + 2 * HOUR, h2) }), dryRun, ...bad }), `lock ${dryRun}`).to.be.rejectedWith(re);
      }
      // on a test chain the cap is --gas-price-gwei
      await expect(sendTo(provider, { gasPriceGwei: "2", priorityFeeGwei: "3" })).to.be.rejectedWith(/--priority-fee-gwei 3\.0 gwei is above the fee cap 2\.0 gwei/);
      await expect(live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true, gasPriceGwei: "2", priorityFeeGwei: "3" })).to.be.rejectedWith(/is above the fee cap 2\.0 gwei/);
      expect(await nonce(aliceAddr, "pending")).to.equal(n);
      expect(await nonce(bobAddr, "pending")).to.equal(nb); // the lock and refund refusals sent nothing from Bob either
    });

    it("a malformed tip is refused like a malformed cap: 0, negative, 10 decimals, text, empty", async () => {
      const net = asChain1();
      const n = await nonce(aliceAddr, "pending");
      for (const zero of ["0", "0.0", "0.000000000"]) {
        await expect(sendTo(net, { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: zero }), zero).to.be.rejectedWith(/--priority-fee-gwei must be > 0/);
      }
      for (const bad of ["-1", "-0.01", "0.0000000001", "abc", "1e3", "0x10", ".5", "1.", "5 gwei", ""]) {
        for (const flags of [{ ...MAIN, maxFeeGwei: "0.2" }, { gasPriceGwei: "2" }]) {
          await expect(sendTo(flags.mainnet ? net : provider, { ...flags, priorityFeeGwei: bad }), `${JSON.stringify(bad)} ${JSON.stringify(flags)}`).to.be.rejectedWith(/--priority-fee-gwei must be a positive decimal number of gwei \(at most 9 decimals\)/);
        }
      }
      // nine decimals are fine
      await sendTo(net, { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.000000001" });
      expect(await nonce(aliceAddr, "pending")).to.equal(n + 1);
    });

    it("is refused without a cap flag: on a test chain without --gas-price-gwei, and under --mainnet without --max-fee-gwei", async () => {
      const n = await nonce(aliceAddr, "pending");
      const re = /--priority-fee-gwei needs a fee cap to sit under \(--max-fee-gwei with --mainnet, or --gas-price-gwei on a test network\); refusing/;
      await expect(sendTo(provider, { priorityFeeGwei: TIP })).to.be.rejectedWith(re);
      await expect(live.deploy(provider, alice, { priorityFeeGwei: TIP, dryRun: true })).to.be.rejectedWith(re);
      const l = await makeLock();
      await expect(live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true, priorityFeeGwei: TIP })).to.be.rejectedWith(re);
      await expect(live.refund(provider, bob, { ...tgt, contract: htlcAddr, lockId: l.lockId, dryRun: true, priorityFeeGwei: TIP })).to.be.rejectedWith(re);
      await expect(sendTo(asChain1(), { ...MAIN, priorityFeeGwei: TIP })).to.be.rejectedWith(/missing required --max-fee-gwei/);
      // --max-fee-gwei without --mainnet keeps its own refusal
      await expect(sendTo(provider, { maxFeeGwei: "1", priorityFeeGwei: TIP })).to.be.rejectedWith(/--max-fee-gwei is only accepted together with --mainnet/);
      expect(await nonce(aliceAddr, "pending")).to.equal(n);
    });

    it("without the flag the tip is exactly min(cap, 1 gwei): a cap below 1 gwei is the tip, a cap above it gets 1 gwei", async () => {
      const net = asChain1();
      for (const [cap, tip] of [["0.5", "0.5"], ["0.2", "0.2"], ["1", "1"], ["1.5", "1"], ["5", "1"]]) {
        expect(await feesOf((await sendTo(net, { ...MAIN, maxFeeGwei: cap })).txHash), `mainnet cap ${cap}`).to.deep.equal([gwei(cap), gwei(tip)]);
      }
      for (const [cap, tip] of [["0.5", "0.5"], ["5", "1"]]) {
        expect(await feesOf((await sendTo(provider, { gasPriceGwei: cap })).txHash), `test chain cap ${cap}`).to.deep.equal([gwei(cap), gwei(tip)]);
      }
      // lock and claim go through feePlan: the same tip, and the report names it
      const t1 = (await latestTs()) + 2 * HOUR;
      const h2 = sha256Raw(rand32());
      const lk = await lockApproved(net, bob, { swap: swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) }), ...MAIN, maxFeeGwei: "5" });
      expect(await feesOf(lk.txHash)).to.deep.equal([gwei("5"), gwei("1")]);
      expect(lk.feeCheck.priorityFeeGwei).to.equal("1.0");
      const l = await makeLock();
      await setBaseWei(BASE);
      const dry = await live.claim(net, alice, { swap: swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) }), secret: preimage, dryRun: true, ...MAIN, maxFeeGwei: "0.2" });
      expect(dry.feeCheck.priorityFeeGwei).to.equal("0.2");
      expect(dry.priorityFeeGwei).to.equal("0.2");
    });

    it("the dry run reports the tip and what one gas will cost: min(cap, base fee + tip); the worst case stays cap x gas", async () => {
      const net = asChain1();
      const l = await makeLock();
      const h2 = sha256Raw(rand32());
      const t1 = (await latestTs()) + 2 * HOUR;
      const lockSwap = swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) });
      const claimSwap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      // the first mainnet run: cap 0.2, base fee 0.06, tip 0.01 -> 0.07 per gas
      await setBaseWei(BASE);
      const flags = { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: TIP, dryRun: true };
      const cl = await live.claim(net, alice, { swap: claimSwap, secret: preimage, ...flags });
      expect(cl.feeCheck).to.include({ baseFeeGwei: "0.06", maxFeeGwei: "0.2", priorityFeeGwei: "0.01", expectedGasPriceGwei: "0.07", minRatio: "2" });
      expect(cl.priorityFeeGwei).to.equal("0.01");
      expect(cl.maxFeeGwei).to.equal("0.2");
      expect(cl.worstCaseFeeWei).to.equal((BigInt(cl.gasLimit) * gwei("0.2")).toString());
      const lk = await lockApproved(net, bob, { swap: lockSwap, ...flags });
      expect(lk.feeCheck).to.include({ priorityFeeGwei: "0.01", expectedGasPriceGwei: "0.07" });
      expect(lk.priorityFeeGwei).to.equal("0.01");
      expect(lk.worstCaseFeeWei).to.equal((BigInt(lk.gasEstimate) * gwei("0.2")).toString());
      // the claim dry run without the secret carries the tip too
      const noSecret = await live.claim(net, alice, { swap: claimSwap, ...flags });
      expect(noSecret.priorityFeeGwei).to.equal("0.01");
      expect(noSecret.feeCheck.expectedGasPriceGwei).to.equal("0.07");
      // the same call without the flag pays the whole cap (the tip is min(cap, 1 gwei) = 0.2): the old behaviour, now visible
      const old = await live.claim(net, alice, { swap: claimSwap, secret: preimage, ...MAIN, maxFeeGwei: "0.2", dryRun: true });
      expect(old.feeCheck).to.include({ priorityFeeGwei: "0.2", expectedGasPriceGwei: "0.2" });
      // when base fee + tip is above the cap, one gas costs the cap
      await setBaseWei(190_000_000n); // 0.19 gwei
      const capped = await live.lock(net, bob, { swap: lockSwap, ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.05", dryRun: true });
      expect(capped.feeCheck).to.include({ baseFeeGwei: "0.19", priorityFeeGwei: "0.05", expectedGasPriceGwei: "0.2" });
      // a test chain with a cap reports it too; with no cap there is no fee report
      await setBaseWei(BASE);
      const tc = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true, gasPriceGwei: "2", priorityFeeGwei: TIP });
      expect(tc.feeCheck).to.include({ priorityFeeGwei: "0.01", expectedGasPriceGwei: "0.07" });
    });

    // ---- --replace: a replacement is a rescue. Its tip is max(max(flag, min(cap, 1 gwei)), old tip x 1.125), never above the cap.
    const claimData = (lockId) => new ethers.Interface(ABI()).encodeFunctionData("claim", [lockId, preimage]);
    const refundData = (lockId) => new ethers.Interface(ABI()).encodeFunctionData("refund", [lockId]);
    /** Leave a transaction in the node's pool: automine off, then send. */
    const stuck = async (signer, data, maxFee, tip) => {
      await provider.send("evm_setAutomine", [false]);
      return signer.sendTransaction({ to: htlcAddr, data, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
    };
    /** Run a real send while automine is off: wait until it has been sent (onSent), mine one block, return its result. */
    const sendAndMine = async (run) => {
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const p = run({ onSent: sent });
      await Promise.race([sentP, p.catch(() => {})]);
      await provider.send("evm_mine", []);
      return p;
    };

    /** A second lock of Bob (own hashlock) with a one-hour timelock: it is made refundable by moving the clock past it. */
    const refundableLock = async () => {
      const hash = sha256Raw(rand32());
      const t = (await latestTs()) + HOUR;
      const lk = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: hash, tReveal: String(t), receiver: aliceAddr, amountWei: amount.toString() });
      return { hash, ...lk };
    };

    it("--replace, cap below 1 gwei, small flag: the replacement tips min(cap, 1 gwei) = the whole cap, not the flag (claim)", async () => {
      const net = asChain1();
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBaseWei(BASE);
      const n0 = await nonce(aliceAddr);
      // the first claim: cap 0.3, tip 0.01 (an operator's tip too small to be taken)
      const old = await stuck(alice, claimData(l.lockId), gwei("0.3"), tipWei);
      const rep = { swap, secret: preimage, replace: true, replaceTx: old.hash, ...MAIN, maxFeeGwei: "0.5", priorityFeeGwei: "0.001" };
      // dry run: the report shows the same tip everywhere
      const dry = await live.claim(net, alice, { ...rep, dryRun: true });
      expect(dry.replace).to.include({ nonce: n0, oldTipGwei: "0.01", newMaxFeeGwei: "0.5", newTipGwei: "0.5" });
      expect(dry.feeCheck).to.include({ priorityFeeGwei: "0.5", expectedGasPriceGwei: "0.5", maxFeeGwei: "0.5" });
      expect(dry.feeCheck).to.not.have.property("minPriorityFeeGwei"); // the floor is not applied to a replacement (0.001 is below it)
      expect(dry.priorityFeeGwei).to.equal("0.5");
      // the real replacement, read back from the chain
      const r = await sendAndMine((o) => live.claim(net, alice, { ...rep, ...o }));
      const mined = await provider.getTransaction(r.txHash);
      expect([mined.maxFeePerGas, mined.maxPriorityFeePerGas]).to.deep.equal([gwei("0.5"), gwei("0.5")]);
      expect(mined.nonce).to.equal(n0);
      expect(await provider.getTransactionReceipt(old.hash)).to.equal(null);
      expect(r.replace).to.include({ newTipGwei: "0.5" });
      expect(await nonce(aliceAddr)).to.equal(n0 + 1);
    });

    it("--replace, cap below 1 gwei, small flag: the same for a refund", async () => {
      const net = asChain1();
      const l = await makeLock({ ttl: HOUR });
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      await setBaseWei(BASE);
      const n0 = await nonce(bobAddr);
      const old = await stuck(bob, refundData(l.lockId), gwei("0.3"), tipWei);
      const swap = swapFile({ chain: 1, intent: refundIntent(l.lockId) });
      const rep = { swap, replace: true, replaceTx: old.hash, ...MAIN, maxFeeGwei: "0.5", priorityFeeGwei: "0.001" };
      const dry = await live.refund(net, bob, { ...rep, dryRun: true });
      expect(dry.replace).to.include({ nonce: n0, newMaxFeeGwei: "0.5", newTipGwei: "0.5" });
      expect(dry.feeCheck).to.include({ priorityFeeGwei: "0.5", expectedGasPriceGwei: "0.5" });
      const r = await sendAndMine((o) => live.refund(net, bob, { ...rep, ...o }));
      const mined = await provider.getTransaction(r.txHash);
      expect([mined.maxFeePerGas, mined.maxPriorityFeePerGas]).to.deep.equal([gwei("0.5"), gwei("0.5")]);
      expect(mined.nonce).to.equal(n0);
      expect(await provider.getTransactionReceipt(old.hash)).to.equal(null);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("refunded");
    });

    it("--replace, cap above 1 gwei: the tip is max(flag, 1 gwei, old tip + 12.5 %); a flag above 1 gwei is used, a smaller one is not", async () => {
      const net = asChain1();
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBaseWei(BASE);
      const n0 = await nonce(aliceAddr);
      const old = await stuck(alice, claimData(l.lockId), 3n * GWEI, gwei("0.1"));
      const rep = { swap, secret: preimage, replace: true, replaceTx: old.hash, ...MAIN, maxFeeGwei: "4" };
      // a flag below the rule min(4, 1) = 1 gwei (and below old tip + 12.5 % = 0.1125 for the first two): the rule rules
      for (const f of ["0.001", "0.05", "0.5"]) {
        const dry = await live.claim(net, alice, { ...rep, dryRun: true, priorityFeeGwei: f });
        expect(dry.replace, f).to.include({ nonce: n0, oldTipGwei: "0.1", newMaxFeeGwei: "4.0", newTipGwei: "1.0" });
        expect(dry.feeCheck, f).to.include({ priorityFeeGwei: "1.0", expectedGasPriceGwei: "1.06" });
      }
      // no flag: the same rule
      expect((await live.claim(net, alice, { ...rep, dryRun: true })).replace).to.include({ newTipGwei: "1.0" });
      // a flag above 1 gwei: the flag
      const dry = await live.claim(net, alice, { ...rep, dryRun: true, priorityFeeGwei: "2" });
      expect(dry.replace).to.include({ newMaxFeeGwei: "4.0", newTipGwei: "2.0" });
      expect(dry.feeCheck).to.include({ priorityFeeGwei: "2.0", expectedGasPriceGwei: "2.06" });
      // a flag above the cap is refused, dry run or not, and nothing is sent
      for (const dryRun of [true, false]) {
        await expect(live.claim(net, alice, { ...rep, dryRun, priorityFeeGwei: "4.5" })).to.be.rejectedWith(/--priority-fee-gwei 4\.5 gwei is above the fee cap 4\.0 gwei/);
      }
      expect(await nonce(aliceAddr, "pending")).to.equal(n0 + 1);
      // the real replacement carries the flag's tip and the new cap
      const r = await sendAndMine((o) => live.claim(net, alice, { ...rep, priorityFeeGwei: "2", ...o }));
      const mined = await provider.getTransaction(r.txHash);
      expect([mined.maxFeePerGas, mined.maxPriorityFeePerGas]).to.deep.equal([4n * GWEI, 2n * GWEI]);
      expect(mined.nonce).to.equal(n0);
      expect(await provider.getTransactionReceipt(old.hash)).to.equal(null);
      expect(await nonce(aliceAddr)).to.equal(n0 + 1);
    });

    it("--replace: old tip + 12.5 % still rules when it is the largest", async () => {
      const net = asChain1();
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBaseWei(BASE);
      // old tip 2 gwei under cap 3: the bump 2.25 beats the rule (1) and a small flag
      const old = await stuck(alice, claimData(l.lockId), 3n * GWEI, 2n * GWEI);
      const rep = { swap, secret: preimage, replace: true, replaceTx: old.hash, ...MAIN, maxFeeGwei: "4", dryRun: true };
      const dry = await live.claim(net, alice, { ...rep, priorityFeeGwei: "0.001" });
      expect(dry.replace).to.include({ oldTipGwei: "2.0", newMaxFeeGwei: "4.0", newTipGwei: "2.25" });
      expect(dry.feeCheck).to.include({ priorityFeeGwei: "2.25" });
      // a flag above the bump beats it
      expect((await live.claim(net, alice, { ...rep, priorityFeeGwei: "3" })).replace).to.include({ newTipGwei: "3.0" });
    });

    it("--replace: the replacement tip may equal the cap (old tip = old cap, new cap = old cap + 12.5 %); the 'tip above the cap' refusal is not reachable from a valid pending transaction", async () => {
      // The flag and min(cap, 1 gwei) are at most the cap by construction, and old tip <= old cap, so old tip + 12.5 % <= old cap + 12.5 %,
      // which the cap check enforces first. The boundary is the nearest case: it is accepted, and one wei less is refused on the cap.
      const net = asChain1();
      const l = await makeLock();
      const swap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBaseWei(BASE);
      const old = await stuck(alice, claimData(l.lockId), gwei("0.4"), gwei("0.4"));
      const rep = { swap, secret: preimage, replace: true, replaceTx: old.hash, ...MAIN, maxFeeGwei: "0.45", dryRun: true };
      const dry = await live.claim(net, alice, rep);
      expect(dry.replace).to.include({ oldMaxFeeGwei: "0.4", oldTipGwei: "0.4", newMaxFeeGwei: "0.45", newTipGwei: "0.45" });
      expect(dry.feeCheck).to.include({ priorityFeeGwei: "0.45", expectedGasPriceGwei: "0.45" });
      await expect(live.claim(net, alice, { ...rep, maxFeeGwei: "0.449999999" })).to.be.rejectedWith(/--replace: the new fee cap 0\.449999999 gwei is below the minimum 0\.45 gwei/);
    });

    // ---- the floor: a typed tip below a tenth of the latest base fee is refused (lock, claim, refund)
    it("floor: a tip below base fee / 10 (rounded up to a wei) is refused on lock, claim and refund, dry run or real; nothing is sent", async () => {
      const net = asChain1();
      const l = await makeLock(); // for the claims (two hours)
      const rl = await refundableLock(); // for the refunds (one hour)
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const h2 = sha256Raw(rand32());
      const lockSwap = swapFile({ chain: 1, hash: h2, intent: lockIntent((await latestTs()) + 2 * HOUR, h2) });
      const claimSwap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const refundSwap = swapFile({ chain: 1, hash: rl.hash, intent: refundIntent(rl.lockId) });
      await setBaseWei(BASE); // floor 0.006 gwei
      const [na, nb] = [await nonce(aliceAddr, "pending"), await nonce(bobAddr, "pending")];
      const re = /refusing: --priority-fee-gwei 0\.005999999 gwei is below a tenth of the latest base fee \(0\.06 gwei in block \d+\): such a tip can leave the transaction pending; give at least 0\.006 gwei or drop the flag; refusing/;
      const bad = { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.005999999" };
      for (const dryRun of [true, false]) {
        await expect(live.lock(net, bob, { swap: lockSwap, dryRun, ...bad }), `lock ${dryRun}`).to.be.rejectedWith(re);
        await expect(live.claim(net, alice, { swap: claimSwap, secret: preimage, dryRun, ...bad }), `claim ${dryRun}`).to.be.rejectedWith(re);
        if (dryRun) await expect(live.claim(net, alice, { swap: claimSwap, dryRun, ...bad }), "claim without secret").to.be.rejectedWith(re); // a real claim needs the secret first
        await expect(live.refund(net, bob, { swap: refundSwap, dryRun, ...bad }), `refund ${dryRun}`).to.be.rejectedWith(re);
      }
      // the same on a test chain with --gas-price-gwei
      await expect(live.refund(provider, bob, { ...tgt, contract: htlcAddr, lockId: rl.lockId, gasPriceGwei: "2", priorityFeeGwei: "0.005999999" })).to.be.rejectedWith(re);
      expect([await nonce(aliceAddr, "pending"), await nonce(bobAddr, "pending")]).to.deep.equal([na, nb]);
    });

    it("floor: a tip exactly at base fee / 10 is accepted and reported as feeCheck.minPriorityFeeGwei; the floor rounds up; the real transactions carry the tip", async () => {
      const net = asChain1();
      const l = await makeLock(); // for the claims (two hours)
      const rl = await refundableLock(); // for the refunds (one hour)
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      const h2 = sha256Raw(rand32());
      const lockSwap = swapFile({ chain: 1, hash: h2, intent: lockIntent((await latestTs()) + 2 * HOUR, h2) });
      const claimSwap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const refundSwap = swapFile({ chain: 1, hash: rl.hash, intent: refundIntent(rl.lockId) });
      const at = { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.006" };
      // rounding: base fee 60,000,005 wei -> floor 6,000,001 wei, so 6,000,000 wei is refused and the message names the rounded-up floor
      await setBaseWei(60_000_005n);
      await expect(live.lock(net, bob, { swap: lockSwap, dryRun: true, ...at })).to.be.rejectedWith(/is below a tenth of the latest base fee \(0\.060000005 gwei in block \d+\).*give at least 0\.006000001 gwei/);
      expect((await live.lock(net, bob, { swap: lockSwap, dryRun: true, ...at, priorityFeeGwei: "0.006000001" })).feeCheck.minPriorityFeeGwei).to.equal("0.006000001");
      // exactly at the floor: dry runs of all three
      await setBaseWei(BASE);
      for (const [cmd, run] of [
        ["lock", () => live.lock(net, bob, { swap: lockSwap, dryRun: true, ...at })],
        ["claim", () => live.claim(net, alice, { swap: claimSwap, secret: preimage, dryRun: true, ...at })],
        ["claim without secret", () => live.claim(net, alice, { swap: claimSwap, dryRun: true, ...at })],
        ["refund", () => live.refund(net, bob, { swap: refundSwap, dryRun: true, ...at })],
      ]) {
        const r = await run();
        expect(r.feeCheck, cmd).to.include({ baseFeeGwei: "0.06", priorityFeeGwei: "0.006", minPriorityFeeGwei: "0.006", expectedGasPriceGwei: "0.066" });
      }
      // real ones, read back from the chain (the lock first, the base fee set again before each)
      const lk = await lockApproved(net, bob, { swap: lockSwap, ...at });
      expect(await feesOf(lk.txHash)).to.deep.equal([gwei("0.2"), gwei("0.006")]);
      expect(lk.feeCheck.minPriorityFeeGwei).to.equal("0.006");
      await setBaseWei(BASE);
      const rf = await live.refund(net, bob, { swap: refundSwap, ...at });
      expect(await feesOf(rf.txHash)).to.deep.equal([gwei("0.2"), gwei("0.006")]);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: rl.lockId })).state).to.equal("refunded");
    });

    it("floor: never above the tip used without the flag, min(cap, 1 gwei): at a base fee above 10 gwei a typed 1 gwei is taken, less is refused", async () => {
      const net = asChain1();
      const h2 = sha256Raw(rand32());
      const lockSwap = swapFile({ chain: 1, hash: h2, intent: lockIntent((await latestTs()) + 2 * HOUR, h2) });
      const at = { ...MAIN, maxFeeGwei: "60" };
      await setBaseWei(gwei("20"));
      const ok = await live.lock(net, bob, { swap: lockSwap, dryRun: true, ...at, priorityFeeGwei: "1" });
      expect(ok.feeCheck).to.include({ baseFeeGwei: "20.0", priorityFeeGwei: "1.0", minPriorityFeeGwei: "1.0", expectedGasPriceGwei: "21.0" });
      await setBaseWei(gwei("20"));
      await expect(live.lock(net, bob, { swap: lockSwap, dryRun: true, ...at, priorityFeeGwei: "0.999999999" })).to.be.rejectedWith(
        /is below a tenth of the latest base fee \(20\.0 gwei in block \d+\).*give at least 1\.0 gwei/
      );
      await setBaseWei(BASE);
    });

    it("floor: a claim at the floor is mined with that tip; there is no floor without the flag, and none on a chain without a base fee or for send", async () => {
      const net = asChain1();
      const l = await makeLock();
      const claimSwap = swapFile({ chain: 1, intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await setBaseWei(BASE);
      // without the flag: tip min(cap, 1 gwei) = 0.2, no minPriorityFeeGwei in the report
      const noFlag = await live.claim(net, alice, { swap: claimSwap, secret: preimage, dryRun: true, ...MAIN, maxFeeGwei: "0.2" });
      expect(noFlag.feeCheck).to.include({ priorityFeeGwei: "0.2" });
      expect(noFlag.feeCheck).to.not.have.property("minPriorityFeeGwei");
      // a chain whose latest block has no base fee: no floor, no feeCheck (a one-wei tip passes); the cap is --gas-price-gwei
      const noBase = new Proxy(provider, {
        get(t, prop) {
          if (prop === "getBlock") {
            return async (tag, ...rest) => {
              const b = await t.getBlock(tag, ...rest);
              return tag === "latest" && b ? Object.create(b, { baseFeePerGas: { value: null } }) : b;
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const r = await live.claim(noBase, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true, gasPriceGwei: "2", priorityFeeGwei: "0.000000001" });
      expect(r).to.not.have.property("feeCheck");
      // send reads no base fee: a tiny tip is not refused there
      const n = await nonce(aliceAddr);
      expect(await feesOf((await sendTo(net, { ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.000000001" })).txHash)).to.deep.equal([gwei("0.2"), 1n]);
      expect(await nonce(aliceAddr)).to.equal(n + 1);
      // the real claim at the floor
      await setBaseWei(BASE);
      const c = await live.claim(net, alice, { swap: claimSwap, secret: preimage, ...MAIN, maxFeeGwei: "0.2", priorityFeeGwei: "0.006" });
      expect(await feesOf(c.txHash)).to.deep.equal([gwei("0.2"), gwei("0.006")]);
      expect(c.feeCheck.minPriorityFeeGwei).to.equal("0.006");
    });

    it("lock with --gas-price-gwei and the flag on a test chain: the mined transaction carries cap and tip, and the report shows both", async () => {
      const hl = sha256Raw(rand32());
      const tr = (await latestTs()) + 2 * HOUR;
      const dry = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: hl, tReveal: String(tr), receiver: aliceAddr, amountWei: amount.toString(), gasPriceGwei: "2", priorityFeeGwei: TIP, dryRun: true });
      expect(dry.feeCheck).to.include({ maxFeeGwei: "2.0", priorityFeeGwei: "0.01", minPriorityFeeGwei: "0.006", expectedGasPriceGwei: "0.07" });
      const nb = await nonce(bobAddr);
      const lk = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: hl, tReveal: String(tr), receiver: aliceAddr, amountWei: amount.toString(), gasPriceGwei: "2", priorityFeeGwei: TIP });
      expect(await feesOf(lk.txHash)).to.deep.equal([gwei("2"), tipWei]);
      expect((await provider.getTransaction(lk.txHash)).nonce).to.equal(nb);
      expect(lk.feeCheck.priorityFeeGwei).to.equal("0.01");
    });

    it("the command line prints one warning line on stderr when the flag is given, and none without it", async () => {
      const keyFile = path.join(dir, "k.key");
      await live.keygen(null, null, { out: keyFile });
      const run = (args) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "live.js"), ...args], { env: { ...process.env, ETH_RPC_URL: "http://127.0.0.1:9" } });
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ code, err }));
          child.stdin.end("");
        });
      const send = ["send", "--key-file", keyFile, "--to", carolAddr, "--amount-wei", "1"];
      const withFlag = await run([...send, "--priority-fee-gwei", "0.01"]); // refused (no cap) before the dead endpoint is touched
      expect(withFlag.code).to.equal(1);
      expect(withFlag.err.split("warning: --priority-fee-gwei is in effect: a tip below what block builders take can leave the transaction pending; --replace then re-sends it with a higher cap and pays up to the whole cap (the small tip is not used for a replacement)\n")).to.have.length(2);
      expect(withFlag.err).to.match(/error: --priority-fee-gwei needs a fee cap to sit under/);
      const bad = await run([...send, "--mainnet", "--max-fee-gwei", "0.2", "--priority-fee-gwei", "0.3"]);
      expect(bad.err).to.match(/error: --priority-fee-gwei 0\.3 gwei is above the fee cap 0\.2 gwei/);
      const without = await run([...send, "--max-fee-gwei", "5"]);
      expect(without.err).to.not.include("--priority-fee-gwei is in effect");
    });
  });

  // ------------------------------------------------------------------ R4-3
  describe("R4-3: the late re-send uses the cutoff the intent froze, when the file shows the secret may be public", () => {
    it("with history showing a public secret, a cutoff later than timelock - 1800 s rules; without it the earlier of the two stays the rule", async () => {
      const l = await makeLock({ ttl: 1000 }); // inside the default 1800 s margin
      const late = l.tReveal - 100;
      const intent = revealIntent(l.lockId, l.tReveal, late);
      // no marker: the default margin refuses
      const noHist = swapFile({ intent });
      await expect(live.claim(provider, alice, { swap: noHist, secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff.*whichever is earlier/);
      // events that are not evidence do not count
      const weak = swapFile({ intent, history: ["intent_decided:reveal_eth", "lock_final"] });
      await expect(live.claim(provider, alice, { swap: weak, secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff/);
      // each of swap-cli's own public-secret events does
      for (const ev of ["reveal_submitted", "eth_claim_mined", "eth_claim_reorged", "eth_reveal_dropped", "reveal_pending_seen", "reveal_reverted_seen", "reveal_sidecar_seen"]) {
        const swap = swapFile({ intent, history: ["lock_final", ev] });
        const p = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
        expect(p.revealCutoff, ev).to.equal(String(late));
        expect(p.revealCutoffRule, ev).to.match(/may already be public/);
      }
      // the dry run without the secret agrees, and an explicit --margin-s still tightens
      const pub = swapFile({ intent, history: ["eth_claim_reorged"] });
      expect((await live.claim(provider, alice, { swap: pub, dryRun: true })).revealCutoff).to.equal(String(late));
      await expect(live.claim(provider, alice, { swap: pub, secret: preimage, dryRun: true, marginS: "1800" })).to.be.rejectedWith(/past the reveal cutoff/);
      expect((await live.claim(provider, alice, { swap: pub, secret: preimage, dryRun: true, marginS: "900" })).revealCutoff).to.equal(String(l.tReveal - 900));
    });

    it("the frozen cutoff still binds in the late case: past it the claim is refused; inside it the claim is a real, mined one", async () => {
      const l = await makeLock({ ttl: 1000 });
      const past = (await latestTs()) - 5;
      const swapPast = swapFile({ intent: revealIntent(l.lockId, l.tReveal, past), history: ["eth_claim_mined"] });
      await expect(live.claim(provider, alice, { swap: swapPast, secret: preimage })).to.be.rejectedWith(new RegExp(`past the reveal cutoff.*frozen cutoff ${past}.*the secret may already be public`));
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 100), history: ["eth_claim_mined"] });
      const r = await live.claim(provider, alice, { swap, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });
  });

  describe("R4-3: the re-check just before sending uses the same (late) cutoff as the early check", () => {
    // The `finalized` lookup runs after the early check; here it mines a block with the given timestamp (time passing during the slow steps).
    const advancing = (ts) =>
      new Proxy(provider, {
        get(t, prop) {
          if (prop === "getBlock") {
            return async (tag, ...r) => {
              if (tag === "finalized") {
                await provider.send("evm_setNextBlockTimestamp", ["0x" + ts.toString(16)]);
                await provider.send("evm_mine", []);
              }
              return provider.getBlock(tag, ...r);
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });

    it("past the frozen late cutoff at send time: refused, nothing sent, the lock stays open", async () => {
      const l = await makeLock({ ttl: 1000 }); // already inside the default 1800 s margin
      const late = l.tReveal - 100;
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, late), history: ["eth_claim_mined"] });
      const n0 = await nonce(aliceAddr);
      await expect(live.claim(advancing(late + 10), alice, { swap, secret: preimage })).to.be.rejectedWith(
        new RegExp(`past the reveal cutoff. now ${late + 10} > cutoff ${late} \\(the swap file's frozen cutoff.*may already be public.*re-checked just before sending`)
      );
      expect(await nonce(aliceAddr)).to.equal(n0);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      // T21-11: refused at the send-time re-check, so the sidecar (written after it) does not exist
      expect(fs.existsSync(swap + live.REVEAL_SIDECAR_SUFFIX)).to.equal(false);
    });

    it("between the default and the late cutoff at send time: sent (the late cutoff rules at send time as in the early check)", async () => {
      const lm = await makeLock({ ttl: 1000 }); // the default cutoff (timelock - 1800) is long past
      const swap2 = swapFile({ intent: revealIntent(lm.lockId, lm.tReveal, lm.tReveal - 100), history: ["eth_claim_mined"] });
      const r = await live.claim(advancing(lm.tReveal - 200), alice, { swap: swap2, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  // ------------------------------------------------------------------ R5-1 and R5-2
  describe("R5-1: a stuck first reveal is replaceable past the M_A cutoff once its pending claim is identified", () => {
    const claimData = (lockId) => new ethers.Interface(ABI()).encodeFunctionData("claim", [lockId, preimage]);
    async function stuckClaim(l) {
      await provider.send("evm_setAutomine", [false]);
      return (await alice.sendTransaction({ to: htlcAddr, data: claimData(l.lockId), maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI })).hash;
    }
    async function sendAndMine(run) {
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const p = run({ onSent: sent });
      await Promise.race([sentP, p.catch(() => {})]);
      await provider.send("evm_mine", []);
      return p;
    }

    it("the plan: the late cutoff T_reveal - DE rules without any history marker; a first claim keeps T_reveal - M_A", async () => {
      const l = await makeLock({ ttl: 1000 }); // already inside the 1800 s margin: a FIRST reveal is refused
      const late = l.tReveal - 120;
      const intent = revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, late); // what swap-cli records for a first reveal
      const swap = swapFile({ intent });
      // a first claim (nothing pending, no --replace): refused, as before
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff.*whichever is earlier/);
      const oldHash = await stuckClaim(l);
      // the claim sits in the pool: --replace finds it, identifies it as this claim, and the late cutoff rules
      for (const replaceTx of [oldHash, undefined]) {
        const dry = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true, ...(replaceTx ? { replaceTx } : {}) });
        expect(dry.revealCutoff).to.equal(String(late));
        expect(dry.revealCutoffRule).to.match(/pending claim of this lock.*already public.*R5-1/);
        expect(dry.replace.replacesTx).to.equal(oldHash);
      }
      // an explicit --margin-s still tightens it
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true, replaceTx: oldHash, marginS: "900" })).to.be.rejectedWith(/past the reveal cutoff/);
      // an intent from before REVIEW-5 (no late_cutoff) gets the profile's DE: the same number
      const old = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      expect((await live.claim(provider, alice, { swap: old, secret: preimage, dryRun: true, replace: true, replaceTx: oldHash })).revealCutoff).to.equal(String(late));
      await provider.send("evm_mine", []);
    });

    it("past the late cutoff the replacement is refused too, and an unrelated pending transaction does not relax anything", async () => {
      const l = await makeLock({ ttl: 100 }); // T_reveal - 120 s is already behind us
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, l.tReveal - 120) });
      // an unrelated pending transaction of the signer sits at the nonce: never replaced, and it relaxes no cutoff
      await provider.send("evm_setAutomine", [false]);
      const other = await alice.sendTransaction({ to: carolAddr, value: 1n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true, replaceTx: other.hash })).to.be.rejectedWith(/is not a claim of lock/);
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true })).to.be.rejectedWith(/is not a claim of lock|could not be shown/);
      await provider.send("evm_mine", []);
      // the stuck claim itself, but past T_reveal - DE: refused
      const oldHash = await stuckClaim(l);
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true, replace: true, replaceTx: oldHash })).to.be.rejectedWith(/past the reveal cutoff/);
      await provider.send("evm_mine", []);
    });

    it("the replacement sent past M_A is a real, mined one: same nonce, higher fee, one transaction consumed", async () => {
      const l = await makeLock({ ttl: 1000 });
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, l.tReveal - 120) });
      const n0 = await nonce(aliceAddr);
      const oldHash = await stuckClaim(l);
      const r = await sendAndMine((o) => live.claim(provider, alice, { swap, secret: preimage, replace: true, replaceTx: oldHash, ...o }));
      expect((await provider.getTransaction(r.txHash)).nonce).to.equal(n0);
      expect(await provider.getTransactionReceipt(oldHash)).to.equal(null);
      expect(await nonce(aliceAddr)).to.equal(n0 + 1);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("the history marker reveal_pending_seen with a late_cutoff in the intent allows the plain re-send of a dropped claim; without late_cutoff the frozen cutoff stays", async () => {
      const l = await makeLock({ ttl: 1000 });
      const late = l.tReveal - 120;
      const withLate = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, late), history: ["lock_final", "reveal_pending_seen"] });
      const p = await live.claim(provider, alice, { swap: withLate, secret: preimage, dryRun: true });
      expect(p.revealCutoff).to.equal(String(late));
      expect(p.revealCutoffRule).to.match(/late cutoff T_reveal - DE/);
      const without = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), history: ["reveal_pending_seen"] });
      await expect(live.claim(provider, alice, { swap: without, secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff/);
    });
  });

  describe("R5-2: --replace never replaces what it has not identified", () => {
    /** A provider whose node cannot show a pending transaction by itself: no pending block, no txpool. */
    const blind = () =>
      new Proxy(provider, {
        get(t, prop) {
          if (prop === "send") {
            return async (method, params) => {
              if (method === "eth_getBlockByNumber" && params[0] === "pending") return { transactions: [] };
              if (method === "txpool_contentFrom") throw new Error("no txpool namespace");
              return provider.send(method, params);
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    it("a node that cannot show the old transaction: refused and asked for --replace-tx; with the hash it works (claim and refund)", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await provider.send("evm_setAutomine", [false]);
      const n0 = await nonce(aliceAddr);
      const old = await alice.sendTransaction({ to: htlcAddr, data: new ethers.Interface(ABI()).encodeFunctionData("claim", [l.lockId, preimage]), maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      for (const dryRun of [true, false]) {
        await expect(live.claim(blind(), alice, { swap, secret: preimage, replace: true, dryRun })).to.be.rejectedWith(/could not be shown by this node.*give --replace-tx HASH.*refusing/);
      }
      expect(await nonce(aliceAddr, "pending")).to.equal(n0 + 1); // nothing was sent
      const dry = await live.claim(blind(), alice, { swap, secret: preimage, replace: true, replaceTx: old.hash, dryRun: true });
      expect(dry.replace).to.include({ nonce: n0, replacesTx: old.hash, oldFeeKnown: true });
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [true]);
      // refund
      const h2 = sha256Raw(rand32());
      const tReveal2 = (await latestTs()) + HOUR;
      await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock: h2, tReveal: String(tReveal2), receiver: aliceAddr, amountWei: amount.toString() });
      const lockId2 = live.computeLockIdLocal(bobAddr, aliceAddr, amount, h2, BigInt(tReveal2));
      await provider.send("evm_increaseTime", [HOUR + 5]);
      await provider.send("evm_mine", []);
      await provider.send("evm_setAutomine", [false]);
      const old2 = await bob.sendTransaction({ to: htlcAddr, data: new ethers.Interface(ABI()).encodeFunctionData("refund", [lockId2]), maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      const rswap = swapFile({ intent: refundIntent(lockId2), hash: h2 });
      await expect(live.refund(blind(), bob, { swap: rswap, replace: true, dryRun: true })).to.be.rejectedWith(/could not be shown by this node.*refusing/);
      expect((await live.refund(blind(), bob, { swap: rswap, replace: true, replaceTx: old2.hash, dryRun: true })).replace.replacesTx).to.equal(old2.hash);
      await provider.send("evm_mine", []);
    });

    it("the txpool of a geth-style node identifies the old transaction when the pending block does not", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      await provider.send("evm_setAutomine", [false]);
      const n0 = await nonce(aliceAddr);
      const old = await alice.sendTransaction({ to: htlcAddr, data: new ethers.Interface(ABI()).encodeFunctionData("claim", [l.lockId, preimage]), maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      const raw = await provider.send("eth_getTransactionByHash", [old.hash]);
      const geth = new Proxy(provider, {
        get(t, prop) {
          if (prop === "send") {
            return async (method, params) => {
              if (method === "eth_getBlockByNumber" && params[0] === "pending") return { transactions: [] };
              if (method === "txpool_contentFrom") return { pending: { [String(n0)]: raw }, queued: {} };
              return provider.send(method, params);
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const dry = await live.claim(geth, alice, { swap, secret: preimage, replace: true, dryRun: true });
      expect(dry.replace).to.include({ nonce: n0, replacesTx: old.hash, oldFeeKnown: true });
      await provider.send("evm_mine", []);
    });
  });

  // ------------------------------------------------------------------ REVIEW-6 R6-3 and R6-8 (sha256 kind)
  describe("R6-8: the sha256 claim never sends the secret except in the signed raw transaction", () => {
    const claimData = (lockId) => new ethers.Interface(ABI()).encodeFunctionData("claim", [lockId, preimage]);
    function recorder() {
      const log = [];
      const wire = {
        request: async ({ method, params }) => {
          log.push({ method, params });
          return hre.network.provider.request({ method, params });
        },
      };
      return { log, rec: new ethers.BrowserProvider(wire, undefined, { cacheTimeout: -1 }) };
    }
    async function fundedWalletLock(rec) {
      const wallet = ethers.Wallet.createRandom().connect(rec);
      await alice.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
      const tReveal = (await latestTs()) + 2 * HOUR;
      const l = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: wallet.address, amountWei: amount.toString() });
      return { wallet, l: { tReveal, ...l } };
    }
    const carrying = (log) => log.filter((q) => JSON.stringify(q.params).toLowerCase().includes(preimage.slice(2).toLowerCase())).map((q) => q.method);

    it("a dry run and a real claim: no eth_estimateGas, no eth_call with the secret; only eth_sendRawTransaction carries it", async () => {
      const { log, rec } = recorder();
      const { wallet, l } = await fundedWalletLock(rec);
      log.length = 0;
      const dry = await live.claim(rec, wallet, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true });
      expect(dry.gasEstimate).to.equal(null);
      expect(dry.gasLimit).to.equal(live.SHA256_CLAIM_GAS_LIMIT.toString());
      expect(dry.gasLimit).to.equal("200000");
      expect(carrying(log)).to.deep.equal([]);
      log.length = 0;
      const r = await live.claim(rec, wallet, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(carrying(log)).to.deep.equal(["eth_sendRawTransaction"]);
      expect(log.some((q) => q.method === "eth_estimateGas")).to.equal(false);
      const tx = await provider.getTransaction(r.txHash);
      expect(tx.gasLimit).to.equal(200000n);
      expect((await provider.getTransactionReceipt(r.txHash)).status).to.equal(1);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("a --replace of a stuck claim also sends the secret only in the signed raw transaction", async () => {
      const { log, rec } = recorder();
      const { wallet, l } = await fundedWalletLock(rec);
      await provider.send("evm_setAutomine", [false]);
      const old = await wallet.sendTransaction({ to: htlcAddr, data: claimData(l.lockId), gasLimit: 200000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI });
      log.length = 0;
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const p = live.claim(rec, wallet, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, replace: true, replaceTx: old.hash, onSent: sent });
      await Promise.race([sentP, p.catch(() => {})]);
      await provider.send("evm_mine", []);
      const r = await p;
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(carrying(log)).to.deep.equal(["eth_sendRawTransaction"]);
      expect(log.some((q) => q.method === "eth_estimateGas")).to.equal(false);
      expect((await provider.getTransaction(r.txHash)).gasLimit).to.equal(200000n);
    });

    it("a dry run WITH the secret is refused against a node that is not on this machine, for this kind too", async () => {
      const l = await makeLock();
      const was = process.env.ETH_RPC_URL;
      process.env.ETH_RPC_URL = "https://sepolia.example.invalid/KEY";
      try {
        await expect(live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage, dryRun: true })).to.be.rejectedWith(/--dry-run with the secret against a node that is not on this machine/);
        // without the secret, every gate runs
        const p = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, dryRun: true });
        expect(p.dryRun).to.equal(true);
        expect(p.gasEstimateNote).to.match(/fixed gas limit \(200000\)/);
      } finally {
        if (was === undefined) delete process.env.ETH_RPC_URL;
        else process.env.ETH_RPC_URL = was;
      }
    });
  });

  describe("R6-3: a claim that is mined and reverts has published the secret, and live.js says so", () => {
    it("returns reverted: true and secretPublic: true with the transaction hash; the lock stays open and unclaimed", async () => {
      const l = await makeLock({ ttl: 2 * HOUR });
      await provider.send("evm_setAutomine", [false]);
      let sent;
      const sentP = new Promise((r) => (sent = r));
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const p = live.claim(provider, alice, { swap, secret: preimage, onSent: sent });
      await Promise.race([sentP, p.catch(() => {})]);
      // The claim passed every gate on the latest block (before the timelock); the block it is mined in is stamped after the timelock.
      await provider.send("evm_setNextBlockTimestamp", [l.tReveal + 10]);
      await provider.send("evm_mine", []);
      const r = await p;
      expect(r.reverted).to.equal(true);
      expect(r.secretPublic).to.equal(true);
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(r.swapCliFlag).to.equal(`--reveal-tx ${r.txHash}`);
      expect(r.note).to.match(/SECRET IS PUBLIC/);
      expect(r.lockId).to.equal(l.lockId);
      const receipt = await provider.getTransactionReceipt(r.txHash);
      expect(receipt.status).to.equal(0);
      expect(r.blockNumber).to.equal(receipt.blockNumber);
      // The calldata really is on chain with the secret, as swap-cli's --reveal-tx expects to find it.
      const tx = await provider.getTransaction(r.txHash);
      expect(tx.data.toLowerCase()).to.include(preimage.slice(2).toLowerCase());
      expect(tx.from).to.equal(aliceAddr);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^expired-unclaimed/);
      await provider.send("evm_setAutomine", [true]);
    });

    it("swap-cli's public-secret events include reveal_reverted_seen (the file shows the late cutoff after a reverted claim)", async () => {
      const l = await makeLock({ ttl: 1000 });
      const late = l.tReveal - 100;
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, late - 500, late), history: ["lock_final", "reveal_reverted_seen"] });
      const p = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
      expect(p.revealCutoff).to.equal(String(late));
      expect(p.revealCutoffRule).to.match(/may already be public/);
    });
  });

  // ------------------------------------------------------------------ R4-5
  // ------------------------------------------------------------------ T21-11: the reveal sidecar
  describe("T21-11: claim --swap writes FILE.reveal-sent before it broadcasts, and reads it as evidence that the secret may be public", () => {
    const sideOf = (swap) => swap + live.REVEAL_SIDECAR_SUFFIX;
    const leftovers = (swap) => fs.readdirSync(path.dirname(swap)).filter((n) => n.startsWith(path.basename(swap) + ".") && n !== path.basename(sideOf(swap)));
    const sidecarBody = (lockId, txHash = null, at = 1700000000) => JSON.stringify({ version: 1, lock_id: lockId.slice(2).toLowerCase(), tx_hash: txHash, at }) + "\n";
    async function walletLock(opts = {}) {
      const wallet = ethers.Wallet.createRandom().connect(provider);
      await alice.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
      const l = await makeLock({ ...opts, receiver: wallet.address });
      return { wallet, l };
    }
    /**
     * A wallet that shows the moment of the broadcast. With a local key the claim signs locally and hands the bytes to `signer.provider.broadcastTransaction`,
     * so `before(raw)` runs there (and in `sendTransaction`, which a non-wallet path would use); it may throw instead of letting the send happen.
     * afterSign(n) runs after the n-th local signature (the claim signs once for the sidecar's hash, when there is a swap file, and once to broadcast).
     */
    const spying = (wallet, before, { afterSign } = {}) => {
      const seen = new Proxy(wallet.provider, {
        get(t, prop) {
          if (prop === "broadcastTransaction") {
            return async (raw) => {
              await before(raw);
              return t.broadcastTransaction(raw);
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      let signs = 0;
      return new Proxy(wallet, {
        get(t, prop) {
          if (prop === "provider") return seen;
          if (prop === "sendTransaction") {
            return async (tx) => {
              await before(tx);
              return t.sendTransaction(tx);
            };
          }
          if (prop === "signTransaction") {
            return async (tx) => {
              const raw = await t.signTransaction(tx);
              signs += 1;
              if (afterSign) afterSign(signs);
              return raw;
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    };
    const EIO = () => Object.assign(new Error("simulated I/O failure"), { code: "EIO" });
    /**
     * Narrow, restorable stubs on `fs` (it is process-global and Hardhat and mocha use it too). Every handler acts only on the sidecar's files (a path
     * containing ".reveal-sent": the final name, its .tmp files and its .stale-* names) and on the directory's own handle, found by wrapping openSync.
     * t.opens lists every open; t.fds maps an open handle to { path, kind: "file" | "dir" }; t.real holds the real functions.
     */
    function patchFs() {
      const real = {};
      const names = ["openSync", "closeSync", "writeSync", "fsyncSync", "linkSync", "renameSync", "readFileSync", "lstatSync"];
      for (const k of names) real[k] = fs[k];
      const isSide = (p) => String(p).includes(".reveal-sent");
      const t = {
        fds: new Map(),
        opens: [],
        real,
        onWrite: null, // (f, fd, [buf, off, len]) -> bytes written
        onFsync: null, // (f, fd)
        onLink: null, // (from, to)
        onRename: null, // (from, to)
        onRead: null, // (path, restOfArgs)
        onLstat: null, // (path, restOfArgs)
        restore() {
          for (const k of names) fs[k] = real[k];
        },
      };
      fs.openSync = (p, ...rest) => {
        const fd = real.openSync(p, ...rest);
        const s = String(p);
        t.opens.push({ path: s, flags: rest[0] });
        if (isSide(s)) t.fds.set(fd, { path: s, kind: "file" });
        else if (path.resolve(s) === path.resolve(dir)) t.fds.set(fd, { path: s, kind: "dir" });
        return fd;
      };
      fs.closeSync = (fd) => {
        t.fds.delete(fd);
        return real.closeSync(fd);
      };
      fs.writeSync = (fd, ...a) => {
        const f = t.fds.get(fd);
        return f && f.kind === "file" && t.onWrite ? t.onWrite(f, fd, a) : real.writeSync(fd, ...a);
      };
      fs.fsyncSync = (fd) => {
        const f = t.fds.get(fd);
        return f && t.onFsync ? t.onFsync(f, fd) : real.fsyncSync(fd);
      };
      fs.linkSync = (a, b) => (isSide(b) && t.onLink ? t.onLink(a, b) : real.linkSync(a, b));
      fs.renameSync = (a, b) => ((isSide(a) || isSide(b)) && t.onRename ? t.onRename(a, b) : real.renameSync(a, b));
      fs.readFileSync = (p, ...rest) => (isSide(p) && t.onRead ? t.onRead(String(p), rest) : real.readFileSync(p, ...rest));
      fs.lstatSync = (p, ...rest) => (isSide(p) && t.onLstat ? t.onLstat(String(p), rest) : real.lstatSync(p, ...rest));
      return t;
    }
    /** Nothing was sent: the signer's nonce is unchanged and the lock is still open. */
    async function expectUnsent(wallet, l, n0) {
      expect(await nonce(wallet.address)).to.equal(n0);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
    }
    async function freshClaim() {
      preimage = rand32(); // a new secret each time: a hashlock can be locked once per sender
      hashlock = sha256Raw(preimage);
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), alice: wallet.address });
      return { wallet, l, swap, n0: await nonce(wallet.address) };
    }

    it("the sidecar exists, with exactly the lock id, the signed transaction's hash and a time, when the broadcast begins; mode 600; no secret; no leftovers", async () => {
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), alice: wallet.address });
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      let atSend = null;
      const t0 = Math.floor(Date.now() / 1000);
      const r = await live.claim(provider, spying(wallet, () => (atSend = fs.readFileSync(sideOf(swap), "utf8"))), { swap, secret: preimage });
      expect(atSend, "the sidecar was there when the broadcast was attempted").to.be.a("string");
      const j = JSON.parse(atSend);
      expect(Object.keys(j).sort()).to.deep.equal(["at", "lock_id", "tx_hash", "version"]);
      expect(j.version).to.equal(1);
      expect(j.lock_id).to.equal(l.lockId.slice(2).toLowerCase());
      expect(j.tx_hash, "a local key shows the hash before the broadcast").to.equal(r.txHash.slice(2).toLowerCase());
      expect(j.at).to.be.within(t0 - 2, t0 + 600);
      expect(atSend.toLowerCase()).to.not.include(preimage.slice(2).toLowerCase());
      if (process.platform !== "win32") expect(fs.statSync(sideOf(swap)).mode & 0o777).to.equal(0o600);
      expect(leftovers(swap)).to.deep.equal([]);
      expect(r.revealSidecar).to.equal("written");
      expect(r.revealSidecarFile).to.equal(sideOf(swap));
      expect(live.readRevealSidecar(swap, l.lockId).state).to.equal("matching");
      expect(live.readRevealSidecar(swap, "0x" + "11".repeat(32)).state).to.equal("foreign");
    });

    it("a dry run, a refused claim and a claim without --swap write nothing", async () => {
      const l = await makeLock();
      const past = (await latestTs()) - 5; // the frozen cutoff has passed: the claim is refused
      const refused = swapFile({ intent: revealIntent(l.lockId, l.tReveal, past) });
      await expect(live.claim(provider, alice, { swap: refused, secret: preimage })).to.be.rejectedWith(/past the reveal cutoff/);
      expect(fs.existsSync(sideOf(refused))).to.equal(false);
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const dry = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
      expect(dry.revealSidecar).to.equal("absent");
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      const r = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage });
      expect(r.revealSidecar).to.equal(undefined);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".reveal-sent"))).to.deep.equal([]);
    });

    it("if the sidecar cannot be written and made durable, nothing is broadcast and no half file is left", async () => {
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), alice: wallet.address });
      const n0 = await nonce(wallet.address);
      let sent = false;
      const real = fs.fsyncSync;
      fs.fsyncSync = () => {
        throw Object.assign(new Error("simulated I/O failure"), { code: "EIO" });
      };
      try {
        await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EIO\); nothing was sent/);
      } finally {
        fs.fsyncSync = real;
      }
      expect(sent).to.equal(false);
      expect(await nonce(wallet.address)).to.equal(n0);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
      // with the directory working again, the same claim goes through
      const ok = await live.claim(provider, wallet, { swap, secret: preimage });
      expect(ok.revealSidecar).to.equal("written");
    });

    it("if the directory cannot be synced, nothing is broadcast and the file this call made is removed (the non-Windows branch of fsyncDir, run everywhere by reporting the platform as linux)", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const original = Object.getOwnPropertyDescriptor(process, "platform");
      const t = patchFs();
      // fsyncDir ignores every error on win32 (a directory cannot be flushed there), so the platform is switched for this test only. The directory
      // handle is found by wrapping openSync; only that handle fails, so the file's own sync works.
      t.onFsync = (f, fd) => {
        if (f.kind === "dir") throw EIO();
        return t.real.fsyncSync(fd);
      };
      try {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true }); // inside the try: a throw here cannot leak the override
        await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EIO\); nothing was sent/);
      } finally {
        Object.defineProperty(process, "platform", original);
        t.restore();
      }
      await expectUnsent(wallet, l, n0);
      expect(fs.existsSync(sideOf(swap)), "a sidecar that is not known good must not stay as evidence").to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
      expect((await live.claim(provider, wallet, { swap, secret: preimage })).revealSidecar).to.equal("written");
    });

    it("on a file system without hard links the finished temporary file is renamed onto the sidecar's name (never written in place)", async () => {
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), alice: wallet.address });
      const t = patchFs();
      t.onLink = () => {
        throw Object.assign(new Error("no links here"), { code: "UNKNOWN" });
      };
      let r;
      try {
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        t.restore();
      }
      expect(r.revealSidecar).to.equal("written");
      expect(live.readRevealSidecar(swap, l.lockId).state).to.equal("matching");
      expect(leftovers(swap)).to.deep.equal([]);
      const writeOpens = t.opens.filter((o) => o.path.includes(".reveal-sent") && o.flags !== "r");
      expect(writeOpens.length).to.be.greaterThan(0);
      expect(writeOpens.every((o) => o.path.endsWith(".tmp")), "the final name is never opened for writing (the old in-place code did)").to.equal(true);
    });

    it("a write that makes no progress is an error: nothing is broadcast, no sidecar, no leftover", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const t = patchFs();
      t.onWrite = () => 0;
      let sent = false;
      try {
        await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(
          /reveal sidecar .* could not be written \(ESHORTWRITE\); nothing was sent/
        );
      } finally {
        t.restore();
      }
      expect(sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("a write that takes only a few bytes at a time is looped until every byte is out: the sidecar is byte-exact", async () => {
      const { wallet, l, swap } = await freshClaim();
      const t = patchFs();
      let calls = 0;
      t.onWrite = (f, fd, [buf, off, len]) => {
        calls += 1;
        return t.real.writeSync(fd, buf, off, Math.min(7, len));
      };
      let r;
      try {
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        t.restore();
      }
      expect(calls, "the body is longer than 7 bytes").to.be.greaterThan(5);
      const raw = fs.readFileSync(sideOf(swap), "utf8");
      const j = JSON.parse(raw);
      expect(raw.endsWith("\n")).to.equal(true);
      expect(raw).to.equal(JSON.stringify({ version: 1, lock_id: l.lockId.slice(2).toLowerCase(), tx_hash: r.txHash.slice(2).toLowerCase(), at: j.at }) + "\n");
      expect(r.revealSidecar).to.equal("written");
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("a write that reports the full length but stores half is caught by the read-back: refused, nothing broadcast, the file this call made is removed", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const t = patchFs();
      t.onWrite = (f, fd, [buf, off, len]) => {
        t.real.writeSync(fd, buf, off, Math.floor(len / 2));
        return len;
      };
      let sent = false;
      try {
        await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(
          /reveal sidecar .* could not be written \(EREADBACK\); nothing was sent/
        );
      } finally {
        t.restore();
      }
      expect(sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("without hard links a failed file sync leaves nothing at the final name (the final name is never opened for writing); the retry is 'written', not 'kept'", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const t = patchFs();
      t.onLink = () => {
        throw Object.assign(new Error("no links here"), { code: "ENOTSUP" });
      };
      let failedOnce = false;
      t.onFsync = (f, fd) => {
        if (f.kind === "file" && !failedOnce) {
          failedOnce = true;
          throw EIO();
        }
        return t.real.fsyncSync(fd);
      };
      let sent = false;
      let r;
      try {
        await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(
          /reveal sidecar .* could not be written \(EIO\); nothing was sent/
        );
        expect(sent).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(fs.existsSync(sideOf(swap)), "no file at the target name").to.equal(false);
        expect(leftovers(swap)).to.deep.equal([]);
        // the retry, with the sync working and hard links still refused
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        t.restore();
      }
      expect(r.revealSidecar).to.equal("written");
      expect(live.readRevealSidecar(swap, l.lockId).state).to.equal("matching");
      expect(leftovers(swap)).to.deep.equal([]);
      const writeOpens = t.opens.filter((o) => o.path.includes(".reveal-sent") && o.flags !== "r");
      expect(writeOpens.length).to.be.greaterThan(0);
      expect(writeOpens.every((o) => o.path.endsWith(".tmp")), "only .tmp names are opened for writing").to.equal(true);
    });

    it("the read-back must match: a new sidecar that does not read back as written is refused and removed; a kept one is refused and left as it was", async () => {
      // new sidecar
      {
        const { wallet, l, swap, n0 } = await freshClaim();
        const t = patchFs();
        let published = false;
        t.onLink = (a, b) => {
          t.real.linkSync(a, b);
          published = true;
        };
        t.onRead = (p, rest) => (published && !p.endsWith(".tmp") ? Buffer.from("not what was written\n") : t.real.readFileSync(p, ...rest));
        try {
          await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EREADBACK\); nothing was sent/);
        } finally {
          t.restore();
        }
        await expectUnsent(wallet, l, n0);
        expect(fs.existsSync(sideOf(swap))).to.equal(false);
        expect(leftovers(swap)).to.deep.equal([]);
      }
      // kept sidecar
      {
        const { wallet, l, swap, n0 } = await freshClaim();
        const original = sidecarBody(l.lockId, "ab".repeat(32));
        fs.writeFileSync(sideOf(swap), original);
        const t = patchFs();
        let published = false;
        t.onRename = (a, b) => {
          t.real.renameSync(a, b);
          if (String(b).endsWith(live.REVEAL_SIDECAR_SUFFIX)) published = true;
        };
        t.onRead = (p, rest) => (published && !p.endsWith(".tmp") ? Buffer.from("not what was written\n") : t.real.readFileSync(p, ...rest));
        try {
          await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/existing reveal sidecar .* could not be made durable again \(EREADBACK\).*kept.*nothing was sent/);
        } finally {
          t.restore();
        }
        await expectUnsent(wallet, l, n0);
        expect(fs.readFileSync(sideOf(swap), "utf8")).to.equal(original);
        expect(leftovers(swap)).to.deep.equal([]);
      }
    });

    it("a sidecar of this lock that is already there is written again, byte for byte (its time is kept), through a temporary file that is synced and renamed over it", async () => {
      const { wallet, l, swap } = await freshClaim();
      const original = sidecarBody(l.lockId, "ab".repeat(32), 1700000000);
      fs.writeFileSync(sideOf(swap), original);
      const inoBefore = fs.statSync(sideOf(swap)).ino;
      const t = patchFs();
      const tmpSynced = [];
      const renames = [];
      t.onFsync = (f, fd) => {
        if (f.kind === "file") tmpSynced.push(f.path);
        return t.real.fsyncSync(fd);
      };
      t.onRename = (a, b) => {
        renames.push([String(a), String(b)]);
        return t.real.renameSync(a, b);
      };
      let r;
      try {
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        t.restore();
      }
      expect(r.revealSidecar).to.equal("kept");
      expect(fs.readFileSync(sideOf(swap), "utf8")).to.equal(original);
      expect(tmpSynced.some((p) => p.endsWith(".tmp"))).to.equal(true);
      expect(renames.some(([a, b]) => a.endsWith(".tmp") && path.resolve(b) === path.resolve(sideOf(swap)))).to.equal(true);
      if (process.platform !== "win32") expect(fs.statSync(sideOf(swap)).ino, "a new inode: the entry was replaced by the durable copy").to.not.equal(inoBefore);
      expect(leftovers(swap)).to.deep.equal([]);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("a sidecar that was already there survives a failed re-publish untouched: a failed sync of the new copy, or a failed rename", async () => {
      for (const [what, arm] of [
        [
          "sync",
          (t) => {
            t.onFsync = (f, fd) => {
              if (f.kind === "file") throw EIO();
              return t.real.fsyncSync(fd);
            };
          },
        ],
        [
          "rename",
          (t) => {
            t.onRename = (a, b) => {
              if (String(b).endsWith(live.REVEAL_SIDECAR_SUFFIX)) throw EIO();
              return t.real.renameSync(a, b);
            };
          },
        ],
      ]) {
        const { wallet, l, swap, n0 } = await freshClaim();
        const original = sidecarBody(l.lockId, "cd".repeat(32), 1700000000);
        fs.writeFileSync(sideOf(swap), original);
        const t = patchFs();
        arm(t);
        let sent = false;
        try {
          await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage }), what).to.be.rejectedWith(
            /existing reveal sidecar .* could not be made durable again \(EIO\).*kept.*nothing was sent/
          );
        } finally {
          t.restore();
        }
        expect(sent, what).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(fs.readFileSync(sideOf(swap), "utf8"), what).to.equal(original);
        expect(leftovers(swap), what).to.deep.equal([]);
      }
    });

    it("the cutoff is re-checked against the wall clock after the sidecar is written: if the time ran out, nothing is sent; a sidecar made by this call is removed, an older one stays", async () => {
      for (const preExisting of [false, true]) {
        const { wallet, l, swap, n0 } = await freshClaim();
        const original = sidecarBody(l.lockId, "ab".repeat(32), 1700000000);
        if (preExisting) fs.writeFileSync(sideOf(swap), original);
        const realNow = Date.now;
        const jump = l.tReveal - 1800 - Math.floor(realNow() / 1000) + 60; // the wall clock ends 60 s past the cutoff, still before the timelock
        let offset = 0; // milliseconds
        const t = patchFs();
        // the offset stays 0 until the sidecar's temporary file is synced, so every earlier check passes
        t.onFsync = (f, fd) => {
          if (f.kind === "file") offset = jump * 1000;
          return t.real.fsyncSync(fd);
        };
        let sent = false;
        let err;
        try {
          Date.now = () => realNow() + offset; // inside the try: a throw before it cannot leak the stub
          err = await live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage }).then(
            () => null,
            (e) => e
          );
        } finally {
          Date.now = realNow;
          t.restore();
        }
        const tag = preExisting ? "a sidecar was there" : "no sidecar before";
        expect(err, tag).to.be.an.instanceOf(Error);
        expect(err.message, tag).to.match(/past the reveal cutoff.*re-checked against the wall clock immediately before the broadcast, after the reveal sidecar was written/);
        expect(err.message, tag).to.match(/nothing was sent/);
        expect(err.message, tag).to.not.match(/may have reached the network/);
        expect(sent, tag).to.equal(false);
        await expectUnsent(wallet, l, n0);
        if (preExisting) {
          expect(err.message).to.match(/that was there before is kept/);
          expect(fs.readFileSync(sideOf(swap), "utf8")).to.equal(original);
        } else {
          expect(err.message).to.match(/was removed again/);
          expect(fs.existsSync(sideOf(swap))).to.equal(false);
        }
        expect(leftovers(swap), tag).to.deep.equal([]);
      }
    });

    it("with a local key nothing is requested from the node between the sidecar and the broadcast: the signed bytes are the first thing sent", async () => {
      const { wallet, l, swap } = await freshClaim();
      const log = [];
      const realSend = provider.send;
      const realBroadcast = provider.broadcastTransaction;
      const t = patchFs();
      // the last read of the sidecar is the read-back that ends the sidecar write
      t.onRead = (p, rest) => {
        const got = t.real.readFileSync(p, ...rest);
        if (p.endsWith(live.REVEAL_SIDECAR_SUFFIX)) log.push("sidecar-readback");
        return got;
      };
      let r;
      try {
        provider.send = function (method, params) {
          log.push("req:" + method);
          return realSend.call(this, method, params);
        };
        provider.broadcastTransaction = function (raw) {
          log.push("broadcast");
          return realBroadcast.call(this, raw);
        };
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        delete provider.send;
        delete provider.broadcastTransaction;
        t.restore();
      }
      const lastRead = log.lastIndexOf("sidecar-readback");
      const at = log.indexOf("broadcast", lastRead);
      expect(lastRead, JSON.stringify(log)).to.be.greaterThan(-1);
      expect(at, JSON.stringify(log)).to.be.greaterThan(lastRead);
      // (the old path, signer.sendTransaction, populated the transaction again here, which asks the node for the network first)
      expect(log.slice(lastRead + 1, at), "no request between the sidecar and the broadcast").to.deep.equal([]);
      expect(log.slice(at), "the raw transaction is sent").to.include("req:eth_sendRawTransaction");
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("the clock jumps past the cutoff while the claim is signed (after preSend): the last check refuses, nothing is broadcast, the sidecar this call made is removed", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const realNow = Date.now;
      const jump = l.tReveal - 1800 - Math.floor(realNow() / 1000) + 60; // 60 s past the cutoff, before the timelock
      let offset = 0; // milliseconds
      let sent = false;
      let err;
      try {
        Date.now = () => realNow() + offset;
        // the claim signs once for the sidecar's hash (inside preSend) and once to broadcast: jump after the second
        const spy = spying(wallet, () => (sent = true), { afterSign: (n) => (n === 2 ? (offset = jump * 1000) : 0) });
        err = await live.claim(provider, spy, { swap, secret: preimage }).then(
          () => null,
          (e) => e
        );
      } finally {
        Date.now = realNow;
      }
      expect(err).to.be.an.instanceOf(Error);
      expect(err.message).to.match(/past the reveal cutoff.*re-checked against the wall clock immediately before the broadcast, after the reveal sidecar was written.*was removed again.*nothing was sent/);
      expect(err.message).to.not.match(/may have reached the network/);
      expect(sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("a claim without --swap is refused by the last check too when the clock jumps after preSend", async () => {
      const { wallet, l } = await walletLock();
      const n0 = await nonce(wallet.address);
      const realNow = Date.now;
      const jump = l.tReveal - 1800 - Math.floor(realNow() / 1000) + 60;
      let offset = 0;
      let sent = false;
      let err;
      try {
        Date.now = () => realNow() + offset;
        // no swap file: the only signature is the one that is broadcast
        const spy = spying(wallet, () => (sent = true), { afterSign: (n) => (n === 1 ? (offset = jump * 1000) : 0) });
        err = await live.claim(provider, spy, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage }).then(
          () => null,
          (e) => e
        );
      } finally {
        Date.now = realNow;
      }
      expect(err).to.be.an.instanceOf(Error);
      expect(err.message).to.match(/past the reveal cutoff.*re-checked against the wall clock immediately before the broadcast.*no reveal sidecar was involved.*nothing was sent/);
      expect(sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
    });

    it("a signer that is not a local key still claims, through sendTransaction", async () => {
      const l = await makeLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      let viaSend = 0;
      const counting = new Proxy(alice, {
        get(t, prop) {
          if (prop === "sendTransaction") {
            return async (tx) => {
              viaSend += 1;
              return t.sendTransaction(tx);
            };
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const r = await live.claim(provider, counting, { swap, secret: preimage });
      expect(viaSend).to.equal(1);
      expect(r.revealSidecar).to.equal("written");
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("two claims racing for one swap file: the one whose read-back finds the other's record refuses and leaves that record in place", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const other = sidecarBody(l.lockId, "ef".repeat(32), 1700000001);
      const t = patchFs();
      t.onLink = () => {
        throw Object.assign(new Error("no links here"), { code: "ENOTSUP" });
      };
      // right after this call's rename, the other claim's record lands on the same name (its own rename over ours)
      t.onRename = (a, b) => {
        t.real.renameSync(a, b);
        if (String(b).endsWith(live.REVEAL_SIDECAR_SUFFIX)) fs.writeFileSync(b, other);
      };
      let sent = false;
      try {
        await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(
          /another claim for this swap seems to be running.*left in place.*nothing was sent.*never run at the same time/
        );
      } finally {
        t.restore();
      }
      expect(sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(fs.readFileSync(sideOf(swap), "utf8"), "the other record is still there, byte for byte").to.equal(other);
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("without hard links, a failure AFTER the rename removes the file this call made: a failed directory sync, or a read-back that does not match", async () => {
      // (i) the directory sync fails (the platform is reported as linux for this case, as in the directory test above)
      {
        const { wallet, l, swap, n0 } = await freshClaim();
        const original = Object.getOwnPropertyDescriptor(process, "platform");
        const t = patchFs();
        t.onLink = () => {
          throw Object.assign(new Error("no links here"), { code: "ENOTSUP" });
        };
        t.onFsync = (f, fd) => {
          if (f.kind === "dir") throw EIO();
          return t.real.fsyncSync(fd);
        };
        let sent = false;
        try {
          Object.defineProperty(process, "platform", { value: "linux", configurable: true });
          await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EIO\); nothing was sent/);
        } finally {
          Object.defineProperty(process, "platform", original);
          t.restore();
        }
        expect(sent).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(fs.existsSync(sideOf(swap)), "(i) nothing at the final name").to.equal(false);
        expect(leftovers(swap)).to.deep.equal([]);
      }
      // (ii) the read-back does not match
      {
        const { wallet, l, swap, n0 } = await freshClaim();
        const t = patchFs();
        let published = false;
        t.onLink = () => {
          throw Object.assign(new Error("no links here"), { code: "ENOTSUP" });
        };
        t.onRename = (a, b) => {
          t.real.renameSync(a, b);
          if (String(b).endsWith(live.REVEAL_SIDECAR_SUFFIX)) published = true;
        };
        t.onRead = (p, rest) => (published && !p.endsWith(".tmp") ? Buffer.from("not what was written\n") : t.real.readFileSync(p, ...rest));
        let sent = false;
        try {
          await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EREADBACK\); nothing was sent/);
        } finally {
          t.restore();
        }
        expect(sent).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(fs.existsSync(sideOf(swap)), "(ii) nothing at the final name").to.equal(false);
        expect(leftovers(swap)).to.deep.equal([]);
      }
    });

    it("a sidecar that cannot be examined or read is an I/O problem, not bad content: the claim is refused and the file is neither moved nor deleted; the plan only reports it", async () => {
      for (const [what, arm] of [
        [
          "lstat",
          (t) => {
            t.onLstat = () => {
              throw EIO();
            };
          },
        ],
        [
          "read",
          (t) => {
            t.onRead = () => {
              throw EIO();
            };
          },
        ],
      ]) {
        const { wallet, l, swap, n0 } = await freshClaim();
        const original = sidecarBody(l.lockId, "ab".repeat(32), 1700000000);
        fs.writeFileSync(sideOf(swap), original);
        const t = patchFs();
        arm(t);
        let sent = false;
        let plan;
        try {
          plan = await live.claim(provider, wallet, { swap, secret: preimage, dryRun: true });
          await expect(live.claim(provider, spying(wallet, () => (sent = true)), { swap, secret: preimage }), what).to.be.rejectedWith(
            /existing reveal sidecar .* could not be examined or read \(EIO\).*neither moved nor deleted.*nothing was sent/
          );
        } finally {
          t.restore();
        }
        expect(plan.revealSidecar, what).to.equal("unreadable");
        expect(plan.revealSidecarNote, what).to.match(/EIO/);
        expect(sent, what).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(fs.readFileSync(sideOf(swap), "utf8"), what).to.equal(original);
        expect(fs.readdirSync(dir).filter((n) => n.includes(".stale-")), what).to.deep.equal([]);
        expect(leftovers(swap), what).to.deep.equal([]);
      }
    });

    it("execute: opts.preSend without opts.fixedGas is refused outright and sends nothing (a gas estimate would run between the guard and the broadcast)", async () => {
      const n0 = await nonce(aliceAddr);
      let called = false;
      await expect(
        live.execute(provider, alice, {}, { to: aliceAddr, data: "0x" }, {}, {
          preSend: async () => {
            called = true;
          },
        })
      ).to.be.rejectedWith(/preSend requires opts\.fixedGas/);
      expect(called).to.equal(false);
      expect(await nonce(aliceAddr)).to.equal(n0);
    });

    // ---- the library's own retry on HTTP 429 must not repeat the claim's send
    /**
     * A local HTTP JSON-RPC bridge to the in-process node. bridge.seen lists the methods of every request that arrived (a request is a batch).
     * bridge.throttle(methods) -> true makes it answer HTTP 429 with retry-after 1 (the request is then NOT forwarded).
     * bridge.redirect(methods) -> { status, location } makes it answer that redirect instead (the request is then NOT forwarded).
     * bridge.gate(methods) -> a promise holds the answer back until it settles (the request is forwarded after that).
     */
    async function startBridge() {
      const bridge = { seen: [], throttle: () => false, redirect: () => null, gate: () => null, throttled: 0, url: null, close: null };
      const handle = async (rq) => {
        try {
          return { jsonrpc: "2.0", id: rq.id, result: await hre.network.provider.send(rq.method, rq.params || []) };
        } catch (e) {
          return { jsonrpc: "2.0", id: rq.id, error: { code: e.code || -32603, message: e.message, data: typeof e.data === "string" ? e.data : e.data && e.data.data } };
        }
      };
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const methods = (Array.isArray(body) ? body : [body]).map((rq) => rq.method);
          bridge.seen.push(methods);
          if (bridge.throttle(methods)) {
            bridge.throttled += 1;
            res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
            res.end("slow down");
            return;
          }
          const moved = bridge.redirect(methods);
          if (moved) {
            res.writeHead(moved.status, { location: moved.location });
            res.end();
            return;
          }
          const held = bridge.gate(methods);
          if (held) await held;
          const out = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      bridge.url = `http://127.0.0.1:${server.address().port}`;
      bridge.close = () =>
        new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
      bridge.count = (method) => bridge.seen.filter((m) => m.includes(method)).length;
      return bridge;
    }
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));

    it("HTTP 429 to the request that carries the claim: the library does not repeat it; the claim fails, says the sidecar stays and that the send was throttled; the raw transaction was offered once", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const bridge = await startBridge();
      const p = live.makeProvider(bridge.url);
      let err;
      try {
        bridge.throttle = (methods) => methods.includes("eth_sendRawTransaction") && bridge.throttled === 0;
        err = await live.claim(p, wallet.connect(p), { swap, secret: preimage }).then(
          () => null,
          (e) => e
        );
        await pause(3500); // well past the retry-after: a library retry would have landed by now
        expect(bridge.count("eth_sendRawTransaction"), "the raw transaction reached the endpoint exactly once").to.equal(1);
        expect(bridge.throttled).to.equal(1);
      } finally {
        p.destroy();
        await bridge.close();
      }
      expect(err, "the claim is rejected").to.be.an.instanceOf(Error);
      expect(err.message).to.match(/refused the send as throttled \(HTTP 429\), so it most likely did NOT accept the claim; this tool does not repeat a reveal by itself\. To send it again as a first reveal, run the claim again now with --margin-s 1800 \(the strict cutoff, whatever the sidecar says\)/);
      expect(err.message, "no advice that would make a throttled first reveal count as sent").to.match(/run tick --apply before the claim only if you think it did reach the network\)$/);
      expect(err.message).to.match(/reveal sidecar .* was written before the send and stays: the claim may have reached the network/);
      expect(live.sendGuard.noRetry, "the switch is back to normal").to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(live.readRevealSidecar(swap, l.lockId).state).to.equal("matching");
    });

    it("control: HTTP 429 to an earlier request (a read) is retried by the library and the claim succeeds; only the send lost its retry", async () => {
      const { wallet, l, swap } = await freshClaim();
      const bridge = await startBridge();
      const p = live.makeProvider(bridge.url);
      let r;
      try {
        bridge.throttle = (methods) => methods.includes("eth_call") && bridge.throttled === 0;
        r = await live.claim(p, wallet.connect(p), { swap, secret: preimage });
      } finally {
        p.destroy();
        await bridge.close();
      }
      expect(bridge.throttled).to.equal(1);
      expect(bridge.count("eth_call"), "the throttled read was sent again by the library").to.be.greaterThan(1);
      expect(r.revealSidecar).to.equal("written");
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("after a claim through the command line's provider the switch is back to normal: a later throttled read is retried", async () => {
      const { wallet, l, swap } = await freshClaim();
      const bridge = await startBridge();
      const p = live.makeProvider(bridge.url);
      try {
        await live.claim(p, wallet.connect(p), { swap, secret: preimage });
        expect(live.sendGuard.noRetry).to.equal(false);
        const before = bridge.count("eth_getBlockByNumber");
        bridge.throttle = (methods) => methods.includes("eth_getBlockByNumber") && bridge.throttled === 0;
        const b = await p.getBlock("latest");
        expect(b, "the read succeeded after the library's retry").to.not.equal(null);
        expect(bridge.throttled).to.equal(1);
        expect(bridge.count("eth_getBlockByNumber") - before).to.be.greaterThan(1);
      } finally {
        p.destroy();
        await bridge.close();
      }
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    // ---- no redirect for a request made through makeProvider (an outside read, 2026-11-10)
    const REDIRECT_RE = /the endpoint answered with a redirect \(HTTP 307, to an http:\/\/ address\); this tool never follows redirects: put the endpoint's final URL in ETH_RPC_URL\./;

    it("HTTP 307 to the request that carries the claim is not followed: the other endpoint sees nothing at all, the claim fails, the sidecar stays, nothing is repeated", async () => {
      for (const [what, arm] of [
        ["the other endpoint would accept", () => {}],
        ["the other endpoint would answer 429 with retry-after and then 200 (the original bug)", (other) => (other.throttle = () => other.throttled === 0)],
      ]) {
        const { wallet, l, swap, n0 } = await freshClaim();
        const other = await startBridge();
        const bridge = await startBridge();
        arm(other);
        bridge.redirect = (methods) => (methods.includes("eth_sendRawTransaction") ? { status: 307, location: `${other.url}/final/path?apikey=LOCATIONKEY` } : null);
        const p = live.makeProvider(`${bridge.url}/v2/CONFIGKEY`);
        let err;
        try {
          err = await live.claim(p, wallet.connect(p), { swap, secret: preimage }).then(
            () => null,
            (e) => e
          );
          await pause(2500); // well past the retry-after: a library retry on the second endpoint would have landed by now
          expect(bridge.count("eth_sendRawTransaction"), `${what}: the first endpoint saw the send exactly once`).to.equal(1);
          expect(other.seen, `${what}: the second endpoint saw no request of any kind`).to.deep.equal([]);
          expect(other.throttled, what).to.equal(0);
        } finally {
          p.destroy();
          await bridge.close();
          await other.close();
        }
        expect(err, what).to.be.an.instanceOf(Error);
        expect(err.message, what).to.match(REDIRECT_RE);
        expect(err.message, what).to.match(
          /The endpoint answered the send with a redirect \(HTTP 307\), which this tool never follows, so it most likely did NOT accept the claim; this tool does not repeat a reveal by itself\. To send it again as a first reveal, put the endpoint's final URL in ETH_RPC_URL and run the claim again now with --margin-s 1800 \(the strict cutoff, whatever the sidecar says\)/
        );
        expect(err.message, what).to.match(/reveal sidecar .* was written before the send and stays: the claim may have reached the network/);
        expect(err.message, what).to.match(/run tick --apply before the claim only if you think it did reach the network\)$/);
        for (const secretPart of ["CONFIGKEY", "LOCATIONKEY", "final/path", "127.0.0.1"]) expect(err.message, `${what}: ${secretPart} is not printed`).to.not.include(secretPart);
        expect(live.sendGuard.noRetry, what).to.equal(false);
        expect(fs.existsSync(swap + live.CLAIM_LOCK_SUFFIX), `${what}: the claim lock is gone`).to.equal(false);
        await expectUnsent(wallet, l, n0);
        expect(live.readRevealSidecar(swap, l.lockId).state, what).to.equal("matching");
      }
    });

    it("a read through makeProvider still works against an endpoint that redirects nothing", async () => {
      const bridge = await startBridge();
      const p = live.makeProvider(bridge.url);
      try {
        expect(await p.getBlockNumber()).to.be.a("number");
        expect(await p.send("eth_chainId", [])).to.equal("0x7a69");
        expect(bridge.seen.length).to.be.greaterThan(0);
      } finally {
        p.destroy();
        await bridge.close();
      }
    });

    it("a read answered with a redirect (301, 302, 303, 307, 308) fails with the same clear error, promptly, and the target sees nothing; so does the network detection", async () => {
      const other = await startBridge();
      const bridge = await startBridge();
      const p = live.makeProvider(`${bridge.url}/v2/CONFIGKEY`);
      const realLog = console.log;
      console.log = () => {}; // the library's start-up loop says "failed to detect network" once a second
      try {
        for (const status of [301, 302, 303, 307, 308]) {
          bridge.redirect = () => ({ status, location: `${other.url}/x?apikey=LOCATIONKEY` });
          const e = await p.send("eth_blockNumber", []).then(
            () => null,
            (x) => x
          );
          expect(e, String(status)).to.be.an.instanceOf(Error);
          expect(e.code, String(status)).to.equal("REDIRECT_REFUSED");
          expect(e.statusCode, String(status)).to.equal(status);
          expect(e.message, String(status)).to.include(`(HTTP ${status}, to an http:// address); this tool never follows redirects`);
          for (const secretPart of ["CONFIGKEY", "LOCATIONKEY", "127.0.0.1"]) expect(e.message).to.not.include(secretPart);
          expect(live.explain(e)).to.equal(e.message);
        }
        // a provider method that starts with the network detection does not hang either
        const started = Date.now();
        const e2 = await p.getBlockNumber().then(
          () => null,
          (x) => x
        );
        expect(e2 && e2.code).to.equal("REDIRECT_REFUSED");
        expect(Date.now() - started, "fails promptly").to.be.below(3000);
        // an answer with no Location header: same refusal, nothing said about a target
        bridge.redirect = () => ({ status: 302, location: "" });
        const e3 = await p.send("eth_blockNumber", []).then(
          () => null,
          (x) => x
        );
        expect(e3.message).to.match(/^the endpoint answered with a redirect \(HTTP 302\); this tool never follows redirects/);
        await pause(300);
        expect(other.seen, "the address the answers named was never asked").to.deep.equal([]);
      } finally {
        console.log = realLog;
        p.destroy();
        await bridge.close();
        await other.close();
      }
    });

    // ---- the claim lock (FILE.claim-lock)
    const lockOf = (swap) => swap + live.CLAIM_LOCK_SUFFIX;
    /** Every file beside the swap file that begins with its name and a dot (the sidecar, its temporary and stale files, the lock), with its bytes in hex. */
    const snapshotOf = (swap) => {
      const base = path.basename(swap) + ".";
      const out = {};
      for (const n of fs.readdirSync(path.dirname(swap)).filter((x) => x.startsWith(base))) {
        const f = path.join(path.dirname(swap), n);
        out[n] = fs.statSync(f).isFile() ? fs.readFileSync(f).toString("hex") : "(not a file)";
      }
      return out;
    };
    /** A claim whose clock jumps past the cutoff after the second local signature (the last check refuses). Resolves to the error. */
    async function claimWithClockJump(wallet, l, swap, sentFlag) {
      const realNow = Date.now;
      const jump = l.tReveal - 1800 - Math.floor(realNow() / 1000) + 60;
      let offset = 0;
      try {
        Date.now = () => realNow() + offset;
        const spy = spying(wallet, () => (sentFlag.sent = true), { afterSign: (n) => (n === 2 ? (offset = jump * 1000) : 0) });
        return await live.claim(provider, spy, { swap, secret: preimage }).then(
          () => null,
          (e) => e
        );
      } finally {
        Date.now = realNow;
      }
    }

    it("the claim lock: one small line (pid, time), there while the claim is signed and sent, gone before the receipt wait and after the claim", async () => {
      const { wallet, swap } = await freshClaim();
      expect(fs.existsSync(lockOf(swap))).to.equal(false);
      let atSend = null;
      let atSent = "not called";
      const t0 = Math.floor(Date.now() / 1000);
      const r = await live.claim(provider, spying(wallet, () => (atSend = fs.readFileSync(lockOf(swap), "utf8"))), {
        swap,
        secret: preimage,
        onSent: () => (atSent = fs.existsSync(lockOf(swap))),
      });
      expect(atSend, "the lock was there when the broadcast was attempted").to.be.a("string");
      const j = JSON.parse(atSend);
      expect(Object.keys(j).sort()).to.deep.equal(["at", "pid", "version"]);
      expect(j.version).to.equal(1);
      expect(j.pid).to.equal(process.pid);
      expect(j.at).to.be.within(t0 - 2, t0 + 600);
      expect(atSend.toLowerCase()).to.not.include(preimage.slice(2).toLowerCase());
      expect(atSent, "the lock is released as soon as the broadcast has settled, before the wait for the receipt (a --replace-tx from another terminal is possible then)").to.equal(false);
      expect(fs.existsSync(lockOf(swap))).to.equal(false);
      expect(r.revealSidecar).to.equal("written");
      expect(leftovers(swap)).to.deep.equal([]);
    });

    it("a lock file that is already there (a dead claim, or one running) refuses the claim before anything beside the swap file is touched: no request, no sidecar, no .tmp, no .stale-*; the lock stays byte for byte", async () => {
      for (const [what, content, expected] of [
        ["a readable lock", JSON.stringify({ version: 1, pid: 4242, at: 1700000000 }) + "\n", /pid 4242, taken at Unix second 1700000000/],
        ["garbage", "not json at all", /its content could not be read/],
        ["empty", "", /its content could not be read/],
      ]) {
        for (const withSidecar of [false, true]) {
          const { wallet, l, swap, n0 } = await freshClaim();
          fs.writeFileSync(lockOf(swap), content);
          if (withSidecar) fs.writeFileSync(sideOf(swap), sidecarBody(l.lockId, "ab".repeat(32), 1700000000));
          const before = snapshotOf(swap);
          const bridge = await startBridge();
          const p = live.makeProvider(bridge.url);
          let err;
          try {
            err = await live.claim(p, wallet.connect(p), { swap, secret: preimage }).then(
              () => null,
              (e) => e
            );
            expect(bridge.seen, `${what}: no request of any kind`).to.deep.equal([]);
          } finally {
            p.destroy();
            await bridge.close();
          }
          const tag = `${what}, sidecar ${withSidecar}`;
          expect(err, tag).to.be.an.instanceOf(Error);
          expect(err.message, tag).to.match(/refusing: another claim for this swap file is running, or an earlier one died/);
          expect(err.message, tag).to.include(lockOf(swap));
          expect(err.message, tag).to.match(expected);
          expect(err.message, tag).to.match(/Nothing was read or written beside the swap file and nothing was sent\. If you are sure that no other claim for this swap file is running, delete .* by hand/);
          expect(snapshotOf(swap), `${tag}: every file beside the swap file is byte for byte as before`).to.deep.equal(before);
          await expectUnsent(wallet, l, n0);
        }
      }
      // something that is not a file at the name (a directory) is also "exists": fail closed, left alone
      const { wallet, l, swap, n0 } = await freshClaim();
      fs.mkdirSync(lockOf(swap));
      await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/another claim for this swap file is running, or an earlier one died/);
      expect(fs.statSync(lockOf(swap)).isDirectory()).to.equal(true);
      expect(fs.existsSync(sideOf(swap))).to.equal(false);
      await expectUnsent(wallet, l, n0);
      fs.rmdirSync(lockOf(swap));
    });

    it("the stale-lock refusal says whether the recorded pid is alive on this machine, and never takes the lock over", async () => {
      // pidLiveness on its own: signal 0 with a stub, every outcome.
      const kill = (code) => () => { throw Object.assign(new Error(code), { code }); };
      expect(live.pidLiveness(4242, () => true)).to.match(/a process with that pid is alive on this machine, so another claim may well be running/);
      expect(live.pidLiveness(4242, kill("EPERM"))).to.match(/is alive on this machine/);
      expect(live.pidLiveness(4242, kill("ESRCH"))).to.match(/no process with that pid is alive on this machine, so the claim that took it probably died/);
      expect(live.pidLiveness(4242, kill("EIO"))).to.match(/could not be determined/);
      // In the refusal: the lock of THIS process (alive) and a pid that cannot exist (not alive); the lock stays byte for byte, nothing is sent.
      for (const [pid, re] of [[process.pid, /a process with that pid is alive on this machine/], [2147483646, /no process with that pid is alive on this machine/]]) {
        const { wallet, l, swap, n0 } = await freshClaim();
        const body = JSON.stringify({ version: 1, pid, at: 1700000000 }) + "\n";
        fs.writeFileSync(lockOf(swap), body);
        const e = await live.claim(provider, wallet, { swap, secret: preimage }).then(() => null, (x) => x);
        expect(e, String(pid)).to.be.an.instanceOf(Error);
        expect(e.message).to.match(new RegExp(`pid ${pid}, taken at Unix second 1700000000; `));
        expect(e.message).to.match(re);
        expect(e.message).to.include("delete");
        expect(fs.readFileSync(lockOf(swap), "utf8"), "never taken over or removed").to.equal(body);
        expect(fs.existsSync(sideOf(swap))).to.equal(false);
        await expectUnsent(wallet, l, n0);
      }
    });

    it("the claim lock and the sidecar are named from the REAL path: the same swap file through a link meets the same lock; a real path that cannot be determined refuses", async function () {
      const { wallet, l, swap: first, n0 } = await freshClaim();
      // The same file by two names: the folder is reached through a link (a junction on Windows, which needs no privilege; a plain symlink elsewhere).
      const sub = path.join(dir, "real-sub");
      fs.mkdirSync(sub);
      const swap = path.join(sub, "swap.json");
      fs.copyFileSync(first, swap);
      const via = path.join(dir, "via");
      try {
        fs.symlinkSync(sub, via, "junction");
      } catch (e) {
        if (e.code === "EPERM" || e.code === "EACCES") return this.skip();
        throw e;
      }
      const link = path.join(via, "swap.json");
      const real = fs.realpathSync(link);
      expect(real).to.equal(fs.realpathSync(swap));
      expect(real).to.not.equal(path.resolve(link));
      // The lock sits beside the real file (another claim, started through the real name): a claim through the link meets it and refuses.
      fs.writeFileSync(lockOf(real), JSON.stringify({ version: 1, pid: 2147483646, at: 1700000000 }) + "\n");
      const e = await live.claim(provider, wallet, { swap: link, secret: preimage }).then(() => null, (x) => x);
      expect(e).to.be.an.instanceOf(Error);
      expect(e.message).to.match(/another claim for this swap file is running, or an earlier one died/);
      expect(e.message).to.include(lockOf(real));
      await expectUnsent(wallet, l, n0);
      fs.unlinkSync(lockOf(real));
      // Without a lock: the claim through the link writes its sidecar beside the REAL file, and the plan names the real path.
      const plan = await live.claim(provider, wallet, { swap: link, secret: preimage, dryRun: true });
      expect(plan.swapFile).to.equal(real);
      const done = await live.claim(provider, wallet, { swap: link, secret: preimage });
      expect(done.revealSidecar).to.equal("written");
      expect(fs.existsSync(sideOf(real))).to.equal(true);
      expect(fs.existsSync(lockOf(real)), "released").to.equal(false);
    });

    it("a swap FILE that is a symlink: the lock and the sidecar sit beside the real file, never beside the link's own name (skipped where symlinks are not allowed)", async function () {
      const { wallet, l, swap, n0 } = await freshClaim();
      const real = fs.realpathSync(swap);
      const link = path.join(dir, "link-to-swap.json");
      try {
        fs.symlinkSync(real, link);
      } catch (e) {
        if (e.code === "EPERM" || e.code === "EACCES") return this.skip(); // Windows without the symlink privilege
        throw e;
      }
      fs.writeFileSync(lockOf(real), JSON.stringify({ version: 1, pid: 2147483646, at: 1700000000 }) + "\n");
      await expect(live.claim(provider, wallet, { swap: link, secret: preimage })).to.be.rejectedWith(/another claim for this swap file is running/);
      expect(fs.existsSync(lockOf(link))).to.equal(false);
      fs.unlinkSync(lockOf(real));
      const done = await live.claim(provider, wallet, { swap: link, secret: preimage });
      expect(done.revealSidecar).to.equal("written");
      expect(fs.existsSync(sideOf(real)) && !fs.existsSync(sideOf(link))).to.equal(true);
      void l; void n0;
    });

    it("a swap file whose real path cannot be determined is refused before anything is read or sent (claim and lock)", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const realRP = fs.realpathSync;
      fs.realpathSync = Object.assign(
        (p, ...r) => {
          if (path.resolve(String(p)) === path.resolve(swap)) throw Object.assign(new Error("simulated"), { code: "EIO" });
          return realRP(p, ...r);
        },
        realRP
      );
      try {
        await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/the real path of .* cannot be determined \(EIO\); the claim lock and the reveal sidecar are named from it, so refusing/);
        await expect(live.claim(provider, wallet, { swap, secret: preimage, dryRun: true })).to.be.rejectedWith(/cannot be determined \(EIO\)/);
        await expect(live.lock(provider, bob, { swap })).to.be.rejectedWith(/cannot be determined \(EIO\)/);
      } finally {
        fs.realpathSync = realRP;
      }
      expect(fs.existsSync(lockOf(swap)) || fs.existsSync(sideOf(swap))).to.equal(false);
      await expectUnsent(wallet, l, n0);
    });

    it("a lock that cannot be created for another reason also refuses (fail closed): nothing is read, written or sent", async () => {
      const { wallet, l, swap, n0 } = await freshClaim();
      const realOpen = fs.openSync;
      fs.openSync = (p, ...rest) => {
        if (String(p).endsWith(live.CLAIM_LOCK_SUFFIX)) throw Object.assign(new Error("simulated"), { code: "EACCES" });
        return realOpen(p, ...rest);
      };
      try {
        await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(
          /the lock file .* could not be created \(EACCES\), so it is not known whether another claim for this swap file is running.*Nothing was read or written beside the swap file and nothing was sent/
        );
      } finally {
        fs.openSync = realOpen;
      }
      expect(snapshotOf(swap)).to.deep.equal({});
      await expectUnsent(wallet, l, n0);
      expect((await live.claim(provider, wallet, { swap, secret: preimage })).revealSidecar).to.equal("written");
    });

    it("a second claim while the first is between its lock and the answer to its send is refused and changes nothing; the first goes through and the lock is gone", async () => {
      const { wallet, l, swap } = await freshClaim();
      const bridge = await startBridge();
      const p = live.makeProvider(bridge.url);
      let open;
      const hold = new Promise((r) => (open = r));
      bridge.gate = (methods) => (methods.includes("eth_sendRawTransaction") ? hold : null);
      const wp = wallet.connect(p);
      const first = live.claim(p, wp, { swap, secret: preimage });
      let r;
      try {
        for (let i = 0; i < 400 && bridge.count("eth_sendRawTransaction") === 0; i++) await pause(25);
        expect(bridge.count("eth_sendRawTransaction"), "the first claim's send is at the endpoint").to.equal(1);
        expect(fs.existsSync(lockOf(swap)), "the first claim holds the lock").to.equal(true);
        const before = snapshotOf(swap);
        expect(before[path.basename(sideOf(swap))], "the first claim's sidecar is there").to.be.a("string");
        const requests = bridge.seen.length;
        const err = await live.claim(p, wp, { swap, secret: preimage }).then(
          () => null,
          (e) => e
        );
        expect(err).to.be.an.instanceOf(Error);
        expect(err.message).to.match(/another claim for this swap file is running, or an earlier one died/);
        expect(err.message).to.include(lockOf(swap));
        expect(err.message).to.include(`pid ${process.pid}`);
        expect(snapshotOf(swap), "the first claim's lock and sidecar are untouched").to.deep.equal(before);
        expect(bridge.seen.length, "the second claim sent no request").to.equal(requests);
      } finally {
        open();
        r = await first;
        p.destroy();
        await bridge.close();
      }
      expect(r.revealSidecar).to.equal("written");
      expect(fs.existsSync(lockOf(swap))).to.equal(false);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("the lock is gone after every way a claim can end: sent, refused at the last check, refused before the send, the sidecar cannot be written, the send throttled", async () => {
      // (1) sent
      {
        const { wallet, swap } = await freshClaim();
        await live.claim(provider, wallet, { swap, secret: preimage });
        expect(fs.existsSync(lockOf(swap)), "sent").to.equal(false);
      }
      // (2) refused at the last check, after the sidecar was written
      {
        const { wallet, l, swap, n0 } = await freshClaim();
        const flag = { sent: false };
        const err = await claimWithClockJump(wallet, l, swap, flag);
        expect(err.message).to.match(/past the reveal cutoff.*after the reveal sidecar was written.*was removed again.*nothing was sent/);
        expect(flag.sent).to.equal(false);
        expect(fs.existsSync(lockOf(swap)), "last check").to.equal(false);
        expect(fs.existsSync(sideOf(swap))).to.equal(false);
        await expectUnsent(wallet, l, n0);
      }
      // (3) refused before the send: the frozen cutoff has passed
      {
        preimage = rand32(); // a new secret: a hashlock can be locked once per sender
        hashlock = sha256Raw(preimage);
        const l = await makeLock();
        const past = (await latestTs()) - 5;
        const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, past) });
        await expect(live.claim(provider, alice, { swap, secret: preimage })).to.be.rejectedWith(/past the reveal cutoff/);
        expect(fs.existsSync(lockOf(swap)), "refused before the send").to.equal(false);
      }
      // (4) the sidecar cannot be written
      {
        const { wallet, swap } = await freshClaim();
        const real = fs.fsyncSync;
        fs.fsyncSync = () => {
          throw EIO();
        };
        try {
          await expect(live.claim(provider, wallet, { swap, secret: preimage })).to.be.rejectedWith(/reveal sidecar .* could not be written \(EIO\); nothing was sent/);
        } finally {
          fs.fsyncSync = real;
        }
        expect(fs.existsSync(lockOf(swap)), "sidecar cannot be written").to.equal(false);
        expect(fs.existsSync(sideOf(swap))).to.equal(false);
      }
      // (5) the send is answered with HTTP 429
      {
        const { wallet, l, swap } = await freshClaim();
        const bridge = await startBridge();
        const p = live.makeProvider(bridge.url);
        try {
          bridge.throttle = (methods) => methods.includes("eth_sendRawTransaction") && bridge.throttled === 0;
          await expect(live.claim(p, wallet.connect(p), { swap, secret: preimage })).to.be.rejectedWith(/throttled \(HTTP 429\)/);
        } finally {
          p.destroy();
          await bridge.close();
        }
        expect(fs.existsSync(lockOf(swap)), "throttled send").to.equal(false);
        expect(live.readRevealSidecar(swap, l.lockId).state, "the sidecar of the throttled send stays").to.equal("matching");
      }
    });

    it("a dry run takes no lock, does not look at one, and leaves one that is there byte for byte", async () => {
      const { wallet, swap } = await freshClaim();
      const dry = await live.claim(provider, wallet, { swap, secret: preimage, dryRun: true });
      expect(dry.dryRun).to.equal(true);
      expect(fs.existsSync(lockOf(swap))).to.equal(false);
      const held = JSON.stringify({ version: 1, pid: 4242, at: 1700000000 }) + "\n";
      fs.writeFileSync(lockOf(swap), held);
      const planOnly = await live.claim(provider, wallet, { swap, dryRun: true });
      expect(planOnly.dryRun).to.equal(true);
      const dry2 = await live.claim(provider, wallet, { swap, secret: preimage, dryRun: true });
      expect(dry2.dryRun).to.equal(true);
      expect(fs.readFileSync(lockOf(swap), "utf8")).to.equal(held);
      expect(snapshotOf(swap)).to.deep.equal({ [path.basename(lockOf(swap))]: Buffer.from(held).toString("hex") });
    });

    it("a claim without --swap needs no lock and makes none", async () => {
      const l = await makeLock();
      const before = fs.readdirSync(dir).filter((n) => n.includes(".claim-lock"));
      const r = await live.claim(provider, alice, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".claim-lock"))).to.deep.equal(before);
    });

    it("a lock that cannot be removed is reported on stderr and changes nothing else: the claim still succeeds, the lock stays for the operator", async () => {
      const { wallet, l, swap } = await freshClaim();
      const realUnlink = fs.unlinkSync;
      const realWrite = process.stderr.write;
      const said = [];
      fs.unlinkSync = (p, ...rest) => {
        if (String(p).endsWith(live.CLAIM_LOCK_SUFFIX)) throw Object.assign(new Error("simulated"), { code: "EPERM" });
        return realUnlink(p, ...rest);
      };
      process.stderr.write = (chunk) => {
        said.push(String(chunk));
        return true;
      };
      let r;
      try {
        r = await live.claim(provider, wallet, { swap, secret: preimage });
      } finally {
        fs.unlinkSync = realUnlink;
        process.stderr.write = realWrite;
      }
      expect(r.revealSidecar).to.equal("written");
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
      expect(said.join("")).to.match(/warning: the claim lock .* could not be removed \(EPERM\); delete it by hand before the next claim for this swap file/);
      expect(fs.existsSync(lockOf(swap))).to.equal(true);
      fs.unlinkSync(lockOf(swap));
    });

    // ---- a link that was made but reported an error
    it("a hard link that was really made but reported an error is this call's file: written, created, not raced; a later refusal takes it back", async () => {
      // directly: both ways of recognising the file (same inode; and, where the file system reports inode 0, the exact bytes)
      for (const [what, zeroInodes] of [
        ["same inode", false],
        ["inode 0 on this file system: the bytes decide", true],
      ]) {
        const { l, swap } = await freshClaim();
        const t = patchFs();
        t.onLink = (a, b) => {
          t.real.linkSync(a, b);
          throw EIO();
        };
        const realStat = fs.statSync;
        if (zeroInodes) {
          fs.statSync = (p, o) => {
            const st = realStat(p, o);
            return String(p).includes(".reveal-sent") && st && typeof st.ino === "bigint" ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0n }) : st;
          };
        }
        let res;
        try {
          res = live.writeRevealSidecar(swap, l.lockId, "0x" + "ab".repeat(32));
        } finally {
          fs.statSync = realStat;
          t.restore();
        }
        expect(res.state, what).to.equal("written");
        expect(res.created, what).to.equal(true);
        expect(fs.readFileSync(sideOf(swap)).equals(res.bytes), what).to.equal(true);
        expect(leftovers(swap), what).to.deep.equal([]);
      }
      // through the claim: the last check refuses after that, and the file is removed (it was never evidence of a send)
      const { wallet, l, swap, n0 } = await freshClaim();
      const t = patchFs();
      t.onLink = (a, b) => {
        t.real.linkSync(a, b);
        throw EIO();
      };
      const flag = { sent: false };
      let err;
      try {
        err = await claimWithClockJump(wallet, l, swap, flag);
      } finally {
        t.restore();
      }
      expect(err.message).to.match(/past the reveal cutoff.*after the reveal sidecar was written.*was removed again.*nothing was sent/);
      expect(err.message).to.not.match(/evidence of an earlier attempt/);
      expect(flag.sent).to.equal(false);
      await expectUnsent(wallet, l, n0);
      expect(fs.existsSync(sideOf(swap)), "no sidecar stays for a send that was never made").to.equal(false);
      expect(leftovers(swap)).to.deep.equal([]);
      expect(fs.existsSync(lockOf(swap))).to.equal(false);
    });

    it("a matching sidecar of another writer that appears at the moment of the link (a different record, EEXIST) is still kept and never removed", async () => {
      const { l, swap } = await freshClaim();
      const other = sidecarBody(l.lockId, "ef".repeat(32), 1700000001);
      const t = patchFs();
      t.onLink = (_a, b) => {
        fs.writeFileSync(b, other);
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      };
      let res;
      try {
        res = live.writeRevealSidecar(swap, l.lockId, "0x" + "ab".repeat(32));
      } finally {
        t.restore();
      }
      expect(res.state).to.equal("kept");
      expect(res.created).to.equal(false);
      expect(fs.readFileSync(sideOf(swap), "utf8"), "the other record, byte for byte").to.equal(other);
      expect(leftovers(swap)).to.deep.equal([]);
      // through the claim: the last check refuses and the other writer's record stays
      const again = await freshClaim();
      const otherAgain = sidecarBody(again.l.lockId, "ef".repeat(32), 1700000001);
      const t2 = patchFs();
      t2.onLink = (_a, b) => {
        fs.writeFileSync(b, otherAgain);
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      };
      const flag = { sent: false };
      let err;
      try {
        err = await claimWithClockJump(again.wallet, again.l, again.swap, flag);
      } finally {
        t2.restore();
      }
      expect(err.message).to.match(/past the reveal cutoff.*that was there before is kept \(it is evidence of an earlier attempt\).*nothing was sent/);
      expect(flag.sent).to.equal(false);
      expect(fs.readFileSync(sideOf(again.swap), "utf8")).to.equal(otherAgain);
    });

    it("a crash after the write but before the send leaves the sidecar; the next claim keeps it (the earliest time) and sends", async () => {
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, l.tReveal - 100), alice: wallet.address });
      const n0 = await nonce(wallet.address);
      await expect(
        live.claim(
          provider,
          spying(wallet, () => {
            throw new Error("process died");
          }),
          { swap, secret: preimage }
        )
      ).to.be.rejectedWith(/process died.*reveal sidecar .* was written before the send and stays/);
      expect(await nonce(wallet.address)).to.equal(n0);
      const first = fs.readFileSync(sideOf(swap), "utf8");
      expect(JSON.parse(first).lock_id).to.equal(l.lockId.slice(2).toLowerCase());
      // a second reveal attempt: the sidecar is kept as it is, the claim is sent
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const plan = await live.claim(provider, wallet, { swap, secret: preimage, dryRun: true });
      expect(plan.revealSidecar).to.equal("matching");
      const r = await live.claim(provider, wallet, { swap, secret: preimage });
      expect(r.revealSidecar).to.equal("kept");
      expect(fs.readFileSync(sideOf(swap), "utf8")).to.equal(first);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
    });

    it("a dropped transaction: the sidecar of an earlier, vanished claim makes the re-send use T_reveal - DE; without it the strict cutoff refuses", async () => {
      const l = await makeLock({ ttl: 1000 }); // inside the default 1800 s margin
      const late = l.tReveal - 100;
      const intent = revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, late);
      await expect(live.claim(provider, alice, { swap: swapFile({ intent }), secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff/);
      const swap = swapFile({ intent });
      fs.writeFileSync(sideOf(swap), sidecarBody(l.lockId, "ab".repeat(32)));
      const p = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
      expect(p.revealCutoff).to.equal(String(late));
      expect(p.revealCutoffRule).to.match(/late cutoff T_reveal - DE \(the reveal sidecar beside the file shows the secret may already be public\)/);
      expect(p.revealSidecar).to.equal("matching");
      // an explicit --margin-s still tightens it
      await expect(live.claim(provider, alice, { swap, secret: preimage, dryRun: true, marginS: "1800" })).to.be.rejectedWith(/past the reveal cutoff/);
      // an intent with no late cutoff keeps its frozen one, as for the history marker
      const noLate = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      fs.writeFileSync(sideOf(noLate), sidecarBody(l.lockId));
      await expect(live.claim(provider, alice, { swap: noLate, secret: preimage, dryRun: true })).to.be.rejectedWith(/past the reveal cutoff/);
      // inside the late cutoff the re-send is a real, mined claim
      const real = await live.claim(provider, alice, { swap, secret: preimage });
      expect(real.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(real.revealSidecar).to.equal("kept");
    });

    it("the late cutoff still binds: past T_reveal - DE a sidecar relaxes nothing, and nothing is sent", async () => {
      const l = await makeLock({ ttl: 1000 });
      const past = (await latestTs()) - 5;
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, past, past) });
      fs.writeFileSync(sideOf(swap), sidecarBody(l.lockId));
      const n0 = await nonce(aliceAddr);
      await expect(live.claim(provider, alice, { swap, secret: preimage })).to.be.rejectedWith(/past the reveal cutoff/);
      expect(await nonce(aliceAddr)).to.equal(n0);
    });

    it("a sidecar of another lock or not in the format is not evidence and is said so", async () => {
      const { wallet, l } = await walletLock({ ttl: 1000 }); // inside the margin: only evidence could relax the cutoff
      const intent = revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, l.tReveal - 100);
      for (const [what, body] of [
        ["foreign", sidecarBody("0x" + "11".repeat(32))],
        ["garbage", "not json at all"],
        ["wrong fields", JSON.stringify({ version: 1, lock_id: l.lockId.slice(2).toUpperCase(), tx_hash: null, at: 1 })],
        ["too large", " ".repeat(5000)],
      ]) {
        const swap = swapFile({ intent, alice: wallet.address });
        fs.writeFileSync(sideOf(swap), body);
        await expect(live.claim(provider, wallet, { swap, secret: preimage, dryRun: true }), what).to.be.rejectedWith(/past the reveal cutoff/);
      }
    });

    it("a foreign sidecar is reported in the plan; a real claim moves it aside (never deletes it) and writes its own", async () => {
      const { wallet, l } = await walletLock();
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800), alice: wallet.address });
      fs.writeFileSync(sideOf(swap), sidecarBody("0x" + "11".repeat(32)));
      const plan = await live.claim(provider, wallet, { swap, secret: preimage, dryRun: true });
      expect(plan.revealSidecar).to.equal("foreign");
      expect(plan.revealSidecarNote).to.match(/belongs to another lock.*ignored/);
      const r = await live.claim(provider, wallet, { swap, secret: preimage });
      expect(r.revealSidecar).to.equal("written");
      expect(live.readRevealSidecar(swap, l.lockId).state).to.equal("matching");
      const stale = fs.readdirSync(dir).filter((n) => n.includes(".reveal-sent.stale-"));
      expect(stale.length).to.equal(1);
      expect(JSON.parse(fs.readFileSync(path.join(dir, stale[0]), "utf8")).lock_id).to.equal("11".repeat(32));
    });

    it("the history marker swap-cli writes from the sidecar (reveal_sidecar_seen) selects the late cutoff like the other markers", async () => {
      const l = await makeLock({ ttl: 1000 });
      const late = l.tReveal - 100;
      const swap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800, late), history: ["lock_final", "reveal_sidecar_seen"] });
      const p = await live.claim(provider, alice, { swap, secret: preimage, dryRun: true });
      expect(p.revealCutoff).to.equal(String(late));
    });
  });

  describe("R4-5: the signing key is the swap file's party", () => {
    it("claim needs alice_receiver's key (dry run or not); refund needs bob_sender's; nothing is sent", async () => {
      const l = await makeLock();
      const claimSwap = swapFile({ intent: revealIntent(l.lockId, l.tReveal, l.tReveal - 1800) });
      const nc = await nonce(carolAddr);
      const nb = await nonce(bobAddr);
      for (const wrong of [carol, bob]) {
        const who = await wrong.getAddress();
        const re = new RegExp(`this key is ${who} but the swap file's alice_receiver is ${aliceAddr}; refusing`);
        await expect(live.claim(provider, wrong, { swap: claimSwap, secret: preimage, dryRun: true })).to.be.rejectedWith(re);
        await expect(live.claim(provider, wrong, { swap: claimSwap, secret: preimage })).to.be.rejectedWith(re);
      }
      expect((await live.claim(provider, alice, { swap: claimSwap, secret: preimage, dryRun: true })).dryRun).to.equal(true);
      await provider.send("evm_increaseTime", [2 * HOUR + 5]);
      await provider.send("evm_mine", []);
      const refundSwap = swapFile({ intent: refundIntent(l.lockId) });
      for (const wrong of [carol, alice]) {
        const who = await wrong.getAddress();
        const re = new RegExp(`this key is ${who} but the swap file's bob_sender is ${bobAddr}; refusing`);
        await expect(live.refund(provider, wrong, { swap: refundSwap, dryRun: true })).to.be.rejectedWith(re);
        await expect(live.refund(provider, wrong, { swap: refundSwap })).to.be.rejectedWith(re);
      }
      expect(await nonce(carolAddr)).to.equal(nc);
      expect(await nonce(bobAddr)).to.equal(nb);
      const rf = await live.refund(provider, bob, { swap: refundSwap });
      expect(rf.txHash).to.match(/^0x[0-9a-f]{64}$/);
    });
  });
});

describe("rpc-proxy.js", function () {
  const servers = [];
  const listen = (handler) =>
    new Promise((resolve) => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      await new Promise((r) => {
        s.close(r);
        s.closeAllConnections(); // drop keep-alive sockets so the process exits cleanly
      });
    }
  });

  const post = (port, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("forwards the body unchanged and returns the upstream body and status", async () => {
    const seen = [];
    const canned = '{"jsonrpc":"2.0","id":7,"result":"0x2a"}';
    const upstream = await listen((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(canned);
      });
    });
    const logs = [];
    const proxy = await startProxy({ listen: "127.0.0.1:0", upstream: `http://127.0.0.1:${upstream.address().port}/v2/SECRETKEY`, log: (l) => logs.push(l) });
    servers.push(proxy);

    const body = '{ "jsonrpc":"2.0",  "id":7,"method":"eth_blockNumber","params":[] }'; // odd spacing must survive
    const r = await post(proxy.address().port, body);
    expect(r.status).to.equal(200);
    expect(await r.text()).to.equal(canned);
    expect(seen).to.have.length(1);
    expect(seen[0].method).to.equal("POST");
    expect(seen[0].url).to.equal("/v2/SECRETKEY");
    expect(seen[0].body).to.equal(body);
    expect(logs).to.have.length(1);
    expect(logs[0]).to.match(/^eth_blockNumber 200 \d+ms$/);
    expect(logs[0]).to.not.include("SECRETKEY");
  });

  it("passes through non-200 statuses and bodies (e.g. 429)", async () => {
    const upstream = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":"rate limited"}');
      });
    });
    const proxy = await startProxy({ listen: "127.0.0.1:0", upstream: `http://127.0.0.1:${upstream.address().port}`, log: () => {} });
    servers.push(proxy);
    const r = await post(proxy.address().port, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
    expect(r.status).to.equal(429);
    expect(await r.text()).to.equal('{"error":"rate limited"}');
  });

  it("never follows a redirect: every 3xx of the upstream is answered with 502 and the redirect target is never asked", async () => {
    for (const status of [301, 302, 303, 307, 308, 304, 399]) {
      let targetAsked = 0;
      const target = await listen((req, res) => {
        req.resume();
        targetAsked++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"jsonrpc":"2.0","id":1,"result":"elsewhere"}');
      });
      const upstream = await listen((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/other`, "content-type": "application/json" });
          res.end("{}");
        });
      });
      const logs = [];
      const proxy = await startProxy({ listen: "127.0.0.1:0", upstream: `http://127.0.0.1:${upstream.address().port}/v2/SECRETKEY`, log: (l) => logs.push(l) });
      servers.push(proxy);
      const r = await post(proxy.address().port, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
      expect(r.status, String(status)).to.equal(502);
      const j = await r.json();
      expect(j.error.code).to.equal(-32603);
      expect(j.error.message).to.match(/upstream answered a redirect \(status \d+\); redirects are never followed/);
      expect(JSON.stringify(j)).to.not.include("elsewhere").and.to.not.include("SECRETKEY");
      expect(targetAsked, `${status}: the target was never asked`).to.equal(0);
      expect(logs).to.have.length(1);
      expect(logs[0]).to.match(/^eth_chainId 502 \d+ms$/);
    }
  });

  it("answers 502 with a JSON-RPC error when the upstream is down, and 405 for GET", async () => {
    const dead = await listen(() => {});
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    servers.pop();
    const proxy = await startProxy({ listen: "127.0.0.1:0", upstream: `http://127.0.0.1:${port}`, log: () => {} });
    servers.push(proxy);
    const r = await post(proxy.address().port, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
    expect(r.status).to.equal(502);
    expect((await r.json()).error.code).to.equal(-32603);
    const g = await fetch(`http://127.0.0.1:${proxy.address().port}/`);
    expect(g.status).to.equal(405);
  });

  it("refuses to bind anywhere but 127.0.0.1 and rejects bad upstreams", async () => {
    await expect(startProxy({ listen: "0.0.0.0:8546", upstream: "http://127.0.0.1:1" })).to.be.rejectedWith(/only 127\.0\.0\.1/);
    await expect(startProxy({ listen: "localhost:8546", upstream: "http://127.0.0.1:1" })).to.be.rejectedWith(/only 127\.0\.0\.1/);
    await expect(startProxy({ listen: "127.0.0.1:0", upstream: "ftp://127.0.0.1:1" })).to.be.rejectedWith(/http/);
    await expect(startProxy({ listen: "127.0.0.1:0", upstream: "not a url" })).to.be.rejectedWith(/not a valid URL/);
  });
});
