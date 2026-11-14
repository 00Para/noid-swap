const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn, spawnSync } = require("child_process");

const live = require("../scripts/live.js");
const { startProxy } = require("../scripts/rpc-proxy.js");

const HOUR = 3600;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

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
  function swapFile({ intent = null, eth = {}, hash, ethFromBlock, profile } = {}) {
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
      const real = await live.lock(provider, bob, { swap });
      expect(real.lockId).to.equal(want);
      expect(await nonce(bobAddr)).to.equal(n + 1);
      const s = await live.status(provider, null, { contract: htlcAddr, lockId: want });
      expect(s.lock.receiver).to.equal(aliceAddr);
      expect(s.lock.timelock).to.equal(String(tReveal));
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
        await expect(live.lock(provider, bob, { swap, ...over }), JSON.stringify(over)).to.be.rejectedWith(re);
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
      const real = await live.lock(net, bob, { swap: lockSwap(tReveal, { eth: { chain_id: 1 } }), ...FEE });
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
        return live.lock(node, alice, { ...tgtMain, ...t, ...sw, ...extra });
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
        await expect(live.lock(net, w, { ...tgtMain, ...t, swap, dryRun, ...m({ maxFeeGwei: "10" }) }), `dryRun ${dryRun}`).to.be.rejectedWith(/refusing: the sender 0x[0-9a-fA-F]{40} holds 1\.0 ETH but amount 0\.9999 ETH \+ worst-case fee/);
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
      const l = await live.lock(net, bob, { swap: lockFile(hashlock, tReveal), ...tgtMain, contract: d.contract, hashlock, tReveal: String(tReveal), receiver: aliceAddr, amountWei: amount.toString(), ...flags });
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
      const l2 = await live.lock(net, bob, { swap: lockFile(h2, t2), ...tgtMain, contract: d.contract, hashlock: h2, tReveal: String(t2), receiver: aliceAddr, amountWei: amount.toString(), ...flags });
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

  function swapFile({ intent = null, chain = 31337, history, hash = hashlock } = {}) {
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock: hash,
        claim_authority: "o1test",
        params: {
          eth: { chain_id: chain, contract: htlcAddr.toLowerCase(), code_hash: tgt.codeHash, amount_wei: amount.toString(), alice_receiver: aliceAddr.toLowerCase(), bob_sender: bobAddr.toLowerCase() },
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

  async function makeLock({ ttl = 2 * HOUR } = {}) {
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, bob, { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: aliceAddr, amountWei: amount.toString() });
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
      const lk = await live.lock(net, bob, { swap: swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) }), ...flags });
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
      const lk = await live.lock(net, bob, { swap: swapFile({ chain: 1, hash: h2, intent: lockIntent(t1, h2) }), ...MAIN, maxFeeGwei: "5" });
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
      const lk = await live.lock(net, bob, { swap: lockSwap, ...flags });
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
      const lk = await live.lock(net, bob, { swap: lockSwap, ...at });
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
      for (const ev of ["reveal_submitted", "eth_claim_mined", "eth_claim_reorged", "eth_reveal_dropped", "reveal_pending_seen", "reveal_reverted_seen"]) {
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
