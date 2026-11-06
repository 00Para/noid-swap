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

    it("--dry-run with a secret estimates gas, checks the hashlock, and prints neither the secret nor the calldata", async () => {
      const l = await newLock();
      const p = await live.claim(provider, bob, { ...base(l), secret: l.preimage, dryRun: true });
      expect(BigInt(p.gasEstimate)).to.be.gt(0n);
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
        estimateGas: async (req) => { throw new Error(`cannot estimate gas, data=${req.data}`); },
      };
      let err;
      try {
        await live.claim(provider, leaky, { ...base(l), secret: l.preimage, dryRun: true });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(live.UserError);
      expect(err.message).to.match(/cannot estimate gas/);
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
        expect(BigInt(JSON.parse(dry2.out).gasEstimate)).to.be.gt(0n);

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
  function swapFile({ intent = null, eth = {}, hash, ethFromBlock } = {}) {
    const j = {
      version: 1,
      role: "bob",
      public: {
        hashlock: hash || hashlock,
        claim_authority: "o1test",
        params: {
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
      const r = await live.claim(provider, carol, { swap, secret: preimage });
      expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(await bal(aliceAddr)).to.equal(before + amount);
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
