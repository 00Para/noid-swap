"use strict";
/*
 * The swap's own Ethereum key (swap wallet, piece 2b): live.js --key-stdin, `keygen --stdout`, `address`, `balance --address`, `reserve` and `sweep`, on Hardhat's in-process chain
 * (and, for the command line, over a JSON-RPC bridge to it). Nothing here touches a public network.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const isolated = require("./helpers/isolated-home"); // before anything else: the per-user lock record must never touch the real home
const { live } = require("./helpers/live-module");

const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
const HOUR = 3600;
const GWEI = 10n ** 9n;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");
const newKey = () => rand32();

describe("the swap's own Ethereum key (live.js, piece 2b)", function () {
  this.timeout(240000);

  let provider, funder, carol, htlcAddr, otherContract, tgt, dir, nFile;
  const amount = ethers.parseEther("0.3");
  const CAP = "10"; // gwei, via --gas-price-gwei
  const CAP_WEI = 10n * GWEI;

  const latestTs = async () => (await provider.getBlock("latest")).timestamp;
  const nonce = (a, tag = "latest") => provider.getTransactionCount(a, tag);
  const bal = (a) => provider.getBalance(a);
  const fund = async (to, wei) => (await funder.sendTransaction({ to, value: wei })).wait();
  const wallet = (key) => new ethers.Wallet(key, provider);
  const setBase = async (gwei) => {
    await provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x" + (BigInt(gwei) * GWEI).toString(16)]);
    await provider.send("evm_mine", []);
  };

  /** A party: a fresh key and its wallet. */
  const party = () => {
    const key = newKey();
    const w = wallet(key);
    return { key, w, address: w.address };
  };

  /** A swap-cli-shaped swap file with the parts live.js reads. */
  function swapFile({ role, hashlock, alice, bob, payout, ethKey = "own", phase = "created", intent = null, pendingAction = null, chain = 31337, contract = htlcAddr, lockKind, codeHash = tgt.codeHash, history }) {
    const own = role === "alice" ? alice : bob;
    const j = {
      version: 1,
      role,
      public: {
        hashlock,
        claim_authority: "o1test",
        params: { eth: { chain_id: chain, contract: contract.toLowerCase(), code_hash: codeHash, amount_wei: amount.toString(), alice_receiver: alice.toLowerCase(), bob_sender: bob.toLowerCase() } },
      },
      phase: { role, phase },
      secret: { ciphertext: "not-read-by-live.js" },
    };
    if (lockKind) j.public.params.eth.lock_kind = lockKind;
    if (ethKey === "own") j.eth_key = { address: own.toLowerCase(), secret: { ciphertext: "not-read" }, payout: payout.toLowerCase() };
    else if (ethKey !== null) j.eth_key = ethKey;
    if (intent) j.pending_intent = { action: intent, params: { action: intent, lock_id: rand32() }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 };
    if (pendingAction) j.pending_action = { kind: pendingAction, created_at: 1, attempt: 1, maybe_sent: true, detail: null };
    if (history) j.history = history.map((event, i) => ({ at: 100 + i, event, from: "x", to: "y" }));
    const file = path.join(dir, `swap-${nFile++}.swap.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }

  async function bobLocks({ bob, alice, hashlock, ttl = HOUR }) {
    const tReveal = (await latestTs()) + ttl;
    const l = await live.lock(provider, bob.w, { ...tgt, contract: htlcAddr, hashlock, tReveal: String(tReveal), receiver: alice.address, amountWei: amount.toString() });
    return { tReveal, ...l };
  }

  const passTime = async (s) => {
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
  };

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    [funder, carol] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
    const d = await live.deploy(provider, carol, {});
    htlcAddr = d.contract;
    otherContract = (await live.deploy(provider, carol, {})).contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-swapkey-"));
    nFile = 0;
    isolated.clearRecords();
    await setBase(1);
  });
  afterEach(async () => {
    await provider.send("evm_setAutomine", [true]);
    fs.rmSync(dir, { recursive: true, force: true });
    isolated.clearRecords();
  });

  // ---------------------------------------------------------------- the command line harness
  describe("the command line", () => {
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
    const noKey = (key, ...texts) => texts.forEach((t) => expect(t, "the key never shows").to.not.include(key.slice(2)));

    it("keygen --stdout writes the address then the key, two lines, to a pipe, and nothing else; --out and a terminal are refused", async () => {
      const r = await cli(["keygen", "--stdout"]);
      expect(r.code, r.err).to.equal(0);
      expect(r.err).to.equal("");
      const lines = r.out.split("\n");
      expect(lines.length).to.equal(3);
      expect(lines[2]).to.equal("");
      expect(lines[0]).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(lines[1]).to.match(/^0x[0-9a-f]{64}$/);
      expect(new ethers.Wallet(lines[1]).address).to.equal(lines[0]);
      const r2 = await cli(["keygen", "--stdout"]);
      expect(r2.out.split("\n")[1], "a second key is another key").to.not.equal(lines[1]);
      // both flags: refused, nothing written
      const both = await cli(["keygen", "--stdout", "--out", path.join(dir, "k.key")]);
      expect(both.code).to.equal(1);
      expect(both.err).to.match(/exactly one of --out FILE or --stdout/);
      expect(fs.existsSync(path.join(dir, "k.key"))).to.equal(false);
      // a terminal: refused, and the key is never written
      const written = [];
      expect(() => live.keygenStdout({}, { isTTY: true, write: (t) => written.push(t) })).to.throw(/stdout is a terminal/);
      expect(written).to.deep.equal([]);
      // the old form is unchanged
      const f = path.join(dir, "old.key");
      const old = await cli(["keygen", "--out", f]);
      expect(old.code, old.err).to.equal(0);
      expect(JSON.parse(old.out).address).to.match(/^0x/);
      expect((await cli(["keygen"])).err).to.match(/missing required --out/);
    });

    it("address --key-stdin prints the key's address and refuses a wrong --expect; a bad key is refused without showing it", async () => {
      const p = party();
      const ok = await cli(["address", "--key-stdin"], p.key + "\n");
      expect(ok.code, ok.err).to.equal(0);
      expect(JSON.parse(ok.out)).to.deep.equal({ address: p.address, matchesExpected: null });
      const exp = await cli(["address", "--key-stdin", "--expect", p.address.toLowerCase()], p.key + "\n");
      expect(JSON.parse(exp.out).matchesExpected).to.equal(true);
      const wrong = await cli(["address", "--key-stdin", "--expect", party().address], p.key + "\n");
      expect(wrong.code).to.equal(1);
      expect(wrong.err).to.match(/not the expected/);
      const f = path.join(dir, "p.key");
      fs.writeFileSync(f, p.key + "\n", { mode: 0o600 });
      expect(JSON.parse((await cli(["address", "--key-file", f])).out).address).to.equal(p.address);
      for (const bad of ["not-a-key-but-private", "0x" + "00".repeat(32), "0x" + "ff".repeat(32), "0x" + "ab".repeat(31)]) {
        const r = await cli(["address", "--key-stdin"], bad + "\n");
        expect(r.code, bad).to.equal(1);
        expect(r.out).to.equal("");
        expect(r.err).to.not.include(bad);
      }
      expect((await cli(["address", "--key-stdin", "--key-file", f], p.key + "\n")).err).to.match(/exactly one of --key-file or --key-stdin/);
    });

    it("--key-stdin takes exactly one line (the key); two lines, none, a blank line and a longer input are refused, and nothing is echoed", async () => {
      const p = party();
      const q = party();
      for (const [name, input] of [
        ["empty", ""],
        ["two lines", `${p.key}\n${q.key}\n`],
        ["blank first", `\n${p.key}\n`],
        ["blank after", `${p.key}\n\n`],
        ["same line", `${p.key} ${q.key}\n`],
        ["huge", "0x" + "ab".repeat(4000) + "\n"],
      ]) {
        const r = await cli(["address", "--key-stdin"], input);
        expect(r.code, name).to.equal(1);
        expect(r.out, name).to.equal("");
        noKey(p.key, r.err);
        noKey(q.key, r.err);
        expect(r.err, name).to.match(/--key-stdin/);
      }
      // CRLF line endings are fine
      expect(JSON.parse((await cli(["address", "--key-stdin"], p.key + "\r\n")).out).address).to.equal(p.address);
      // no trailing newline is fine
      expect(JSON.parse((await cli(["address", "--key-stdin"], p.key)).out).address).to.equal(p.address);
    });

    it("claim --key-stdin --secret-stdin: exactly two lines, the key then the secret; the claim is sent, nothing shows either", async () => {
      const alice = party();
      const bob = party();
      await fund(alice.address, ethers.parseEther("1"));
      await fund(bob.address, ethers.parseEther("1"));
      const preimage = rand32();
      const hashlock = sha256Raw(preimage);
      const l = await bobLocks({ bob, alice, hashlock });
      const flags = ["--contract", htlcAddr, "--lock-id", l.lockId, "--chain-id", "31337", "--code-hash", tgt.codeHash];
      const all = (r) => [r.out, r.err];
      // every wrong framing is refused before anything is read or signed
      for (const [name, input] of [
        ["key only", `${alice.key}\n`],
        ["secret only", `${preimage}\n`],
        ["secret first", `${preimage}\n${alice.key}\n`],
        ["three lines", `${alice.key}\n${preimage}\n${preimage}\n`],
        ["blank between", `${alice.key}\n\n${preimage}\n`],
        ["junk secret", `${alice.key}\nnot-hex-at-all-but-private\n`],
        ["empty", ""],
      ]) {
        const r = await cli(["claim", ...flags, "--key-stdin", "--secret-stdin"], input);
        expect(r.code, name).to.equal(1);
        expect(r.out, name).to.equal("");
        for (const t of all(r)) {
          noKey(alice.key, t);
          expect(t, name).to.not.include(preimage.slice(2));
          expect(t, name).to.not.include("not-hex-at-all-but-private");
        }
      }
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.match(/^open/);
      // a dry run with both
      const dry = await cli(["claim", ...flags, "--key-stdin", "--secret-stdin", "--dry-run"], `${alice.key}\n${preimage}\n`);
      expect(dry.code, dry.err).to.equal(0);
      expect(JSON.parse(dry.out).gasLimit).to.equal("200000");
      // --secret-file with --key-stdin: stdin holds the key only
      const sf = path.join(dir, "s.txt");
      fs.writeFileSync(sf, preimage + "\n");
      const mixed = await cli(["claim", ...flags, "--key-stdin", "--secret-file", sf, "--dry-run"], `${alice.key}\n`);
      expect(mixed.code, mixed.err).to.equal(0);
      // the real claim
      const before = await bal(alice.address);
      const real = await cli(["claim", ...flags, "--key-stdin", "--secret-stdin"], `${alice.key}\n${preimage}\n`);
      expect(real.code, real.err).to.equal(0);
      expect(JSON.parse(real.out).txHash).to.match(/^0x[0-9a-f]{64}$/);
      for (const t of [...all(dry), ...all(mixed), ...all(real)]) {
        noKey(alice.key, t);
        expect(t).to.not.include(preimage.slice(2));
      }
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("claimed");
      expect(await bal(alice.address)).to.be.gt(before); // + amount - gas
    });

    it("the existing key rules hold for --key-stdin: with --swap, claim needs alice_receiver's key, lock and refund bob_sender's", async () => {
      const alice = party();
      const bob = party();
      const stranger = party();
      const hashlock = sha256Raw(rand32());
      const flags = ["--contract", htlcAddr, "--lock-id", rand32(), "--chain-id", "31337"];
      const claimSwap = swapFile({ role: "alice", hashlock, alice: alice.address, bob: bob.address, payout: stranger.address });
      const r = await cli(["claim", ...flags, "--swap", claimSwap, "--key-stdin", "--dry-run"], stranger.key + "\n");
      expect(r.code).to.equal(1);
      // the file has no pending intent, so the bind refuses first; with an intent the key rule is what answers
      const withIntent = swapFile({ role: "alice", hashlock, alice: alice.address, bob: bob.address, payout: stranger.address });
      const j = JSON.parse(fs.readFileSync(withIntent, "utf8"));
      j.pending_intent = { action: "reveal_eth", params: { action: "reveal_eth", lock_id: flags[3], t_reveal: 4000000000, cutoff: 3999990000 }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 };
      fs.writeFileSync(withIntent, JSON.stringify(j));
      const wrongKey = await cli(["claim", "--swap", withIntent, "--key-stdin", "--dry-run"], stranger.key + "\n");
      expect(wrongKey.code).to.equal(1);
      expect(wrongKey.err).to.include(`this key is ${stranger.address} but the swap file's alice_receiver is ${alice.address}`);
      noKey(stranger.key, wrongKey.err);
      // lock and refund: bob_sender's key
      for (const cmd of ["lock", "refund"]) {
        const sw = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: stranger.address });
        const jj = JSON.parse(fs.readFileSync(sw, "utf8"));
        jj.pending_intent =
          cmd === "lock"
            ? { action: "lock_eth", params: { action: "lock_eth", hashlock, receiver: alice.address.toLowerCase(), amount_wei: amount.toString(), t_reveal: 4000000000 }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 }
            : { action: "refund_eth", params: { action: "refund_eth", lock_id: rand32() }, decided_at: 1, phase_at_decision: "x", noid_tip: 1, eth_block: 1 };
        fs.writeFileSync(sw, JSON.stringify(jj));
        const bad = await cli([cmd, "--swap", sw, "--key-stdin", "--dry-run"], stranger.key + "\n");
        expect(bad.code, cmd).to.equal(1);
        expect(bad.err, cmd).to.include(`this key is ${stranger.address} but the swap file's bob_sender is`);
        noKey(stranger.key, bad.err);
      }
    });

    it("lock --key-stdin (a dry run) and refund --key-stdin (real) work from the pipe, as --key-file does", async () => {
      const alice = party();
      const bob = party();
      await fund(bob.address, ethers.parseEther("1"));
      const hashlock = sha256Raw(rand32());
      const tReveal = (await latestTs()) + HOUR;
      const lockFlags = ["--contract", htlcAddr, "--chain-id", "31337", "--hashlock", hashlock, "--t-reveal", String(tReveal), "--receiver", alice.address, "--amount-wei", amount.toString()];
      const dry = await cli(["lock", ...lockFlags, "--key-stdin", "--dry-run"], bob.key + "\n");
      expect(dry.code, dry.err).to.equal(0);
      expect(JSON.parse(dry.out).from).to.equal(bob.address);
      noKey(bob.key, dry.out, dry.err);
      // the real lock in-process (the command line's per-user record needs the account home, which the test home is not), then refund over the pipe
      const l = await bobLocks({ bob, alice, hashlock: sha256Raw(rand32()) });
      await passTime(HOUR + 5);
      const refundFlags = ["--contract", htlcAddr, "--lock-id", l.lockId, "--chain-id", "31337", "--code-hash", tgt.codeHash];
      const r = await cli(["refund", ...refundFlags, "--key-stdin"], bob.key + "\n");
      expect(r.code, r.err).to.equal(0);
      noKey(bob.key, r.out, r.err);
      expect((await live.status(provider, null, { contract: htlcAddr, lockId: l.lockId })).state).to.equal("refunded");
      // the same with a wrong number of lines
      const bad = await cli(["refund", ...refundFlags, "--key-stdin"], `${bob.key}\n${bob.key}\n`);
      expect(bad.code).to.equal(1);
      noKey(bob.key, bad.err);
    });

    it("--key-stdin is a flag of lock, claim, refund, sweep, address and reserve only", () => {
      for (const cmd of ["lock", "claim", "refund", "sweep", "address", "reserve"]) expect(live.parseArgs([cmd, "--key-stdin"]).args, cmd).to.deep.equal({ keyStdin: true });
      for (const cmd of ["deploy", "send", "status", "balance", "keygen"]) expect(() => live.parseArgs([cmd, "--key-stdin"]), cmd).to.throw(/unknown flag --key-stdin/);
      expect(live.parseArgs(["balance", "--address", "0xabc"]).args).to.deep.equal({ address: "0xabc" });
      expect(live.parseArgs(["balance", "0xabc"]).args).to.deep.equal({ address: "0xabc" });
    });

    it("sweep over the command line: the key from the pipe, a dry run first, then the real one, and the JSON never carries the key", async () => {
      const bob = party();
      const alice = party();
      const payout = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, ethers.parseEther("1"));
      const l = await bobLocks({ bob, alice, hashlock });
      await passTime(HOUR + 5);
      await live.refund(provider, bob.w, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      const swap = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address });
      const flags = ["--swap", swap, "--to", payout.address, "--gas-price-gwei", CAP];
      const before = await bal(bob.address);
      const dry = await cli(["sweep", ...flags, "--key-stdin", "--dry-run"], bob.key + "\n");
      if (dry.code !== 0) {
        // On Linux and macOS the child's account home (from the account database) is not the test's isolated HOME, and live.js refuses a lock record it cannot look up (by
        // design: see userLockSentDir). That refusal is the behaviour under test here, and nothing was sent. (On Windows the account home follows USERPROFILE, so the run below happens.)
        expect(dry.err).to.match(/is not the home of this user account/);
        expect(dry.out).to.equal("");
        noKey(bob.key, dry.err);
        expect(await bal(bob.address)).to.equal(before);
        return;
      }
      expect(dry.code, dry.err).to.equal(0);
      const d = JSON.parse(dry.out);
      expect(d.dryRun).to.equal(true);
      expect(d.sweep.valueWei).to.equal((before - 21000n * CAP_WEI).toString());
      expect(await bal(bob.address)).to.equal(before);
      const real = await cli(["sweep", ...flags, "--key-stdin"], bob.key + "\n");
      expect(real.code, real.err).to.equal(0);
      expect(JSON.parse(real.out).valueWei).to.equal((before - 21000n * CAP_WEI).toString());
      noKey(bob.key, dry.out, dry.err, real.out, real.err);
      // a second sweep: only dust is left
      const again = await cli(["sweep", ...flags, "--key-stdin"], bob.key + "\n");
      expect(again.code).to.equal(1);
      expect(again.err).to.match(/nothing to sweep|does not exceed/);
    });

    it("reserve over the command line needs the key; exits 0 when the balance covers the reserve and 3 when it does not (numbers in JSON either way); a key of another address exits 1 with no amount", async () => {
      const alice = party();
      const bob = party();
      const hashlock = sha256Raw(rand32());
      const swap = swapFile({ role: "alice", hashlock, alice: alice.address, bob: bob.address, payout: party().address });
      const need = 200000n * CAP_WEI * 125n / 100n;
      const flags = ["reserve", "--role", "alice", "--swap", swap, "--gas-price-gwei", CAP];
      // no key: refused, nothing printed on stdout
      const none = await cli(flags);
      expect(none.code).to.equal(1);
      expect(none.out).to.equal("");
      // a key of another address: refused, no amount, the key never shown
      const stranger = party();
      const wrong = await cli([...flags, "--key-stdin"], stranger.key + "\n");
      expect(wrong.code).to.equal(1);
      expect(wrong.out).to.equal("");
      expect(wrong.err).to.match(/does not belong to the swap file's alice_receiver/);
      expect(wrong.err).to.match(/nothing must be deposited/);
      noKey(stranger.key, wrong.out, wrong.err);
      // both sources: refused
      const keyFile = path.join(dir, "alice.key");
      fs.writeFileSync(keyFile, alice.key + "\n", { mode: 0o600 });
      const both = await cli([...flags, "--key-stdin", "--key-file", keyFile], alice.key + "\n");
      expect(both.code).to.equal(1);
      expect(both.out).to.equal("");
      noKey(alice.key, both.out, both.err);
      // the right key
      const short = await cli([...flags, "--key-stdin"], alice.key + "\n");
      expect(short.code, short.err).to.equal(3);
      expect(short.err).to.match(/holds less than the reserve/);
      const v = JSON.parse(short.out);
      expect(v.covered).to.equal(false);
      expect(v.keyChecked).to.equal(true);
      expect(v.reserveWei).to.equal(need.toString());
      noKey(alice.key, short.out, short.err);
      await fund(alice.address, need);
      const okRun = await cli([...flags, "--key-file", keyFile]);
      expect(okRun.code, okRun.err).to.equal(0);
      expect(JSON.parse(okRun.out).covered).to.equal(true);
      noKey(alice.key, okRun.out, okRun.err);
    });
  });

  // ---------------------------------------------------------------- in-process: stdin refusal of a terminal
  describe("a terminal on stdin", () => {
    it("--key-stdin refuses a terminal before reading anything", async () => {
      const was = process.stdin.isTTY;
      process.stdin.isTTY = true;
      try {
        await expect(live.readKeyStdin({ keyStdin: true })).to.be.rejectedWith(/--key-stdin: stdin is a terminal, so the key would be typed in the clear/);
      } finally {
        process.stdin.isTTY = was;
      }
    });
  });

  // ---------------------------------------------------------------- balance
  describe("balance --address", () => {
    it("prints the balance in wei and the latest and the pending nonce", async () => {
      const p = party();
      await fund(p.address, 12345n);
      let b = await live.balance(provider, null, { address: p.address.toLowerCase() });
      expect(b).to.include({ address: p.address, balanceWei: "12345", nonceLatest: 0, noncePending: 0, chainId: "31337" });
      // one transaction out is one nonce; a second one held back by automine off shows as pending
      await fund(p.address, ethers.parseEther("1"));
      await (await p.w.sendTransaction({ to: carol.address ?? (await carol.getAddress()), value: 1n })).wait();
      await provider.send("evm_setAutomine", [false]);
      const held = await p.w.sendTransaction({ to: await carol.getAddress(), value: 1n });
      b = await live.balance(provider, null, { address: p.address });
      expect([b.nonceLatest, b.noncePending]).to.deep.equal([1, 2]);
      await provider.send("evm_setAutomine", [true]);
      await provider.send("evm_mine", []);
      await held.wait();
    });
  });

  // ---------------------------------------------------------------- reserve
  describe("reserve", () => {
    const mk = (role, over = {}) => {
      const alice = party();
      const bob = party();
      const hashlock = sha256Raw(rand32());
      const file = swapFile({ role, hashlock, alice: alice.address, bob: bob.address, payout: party().address, ...over });
      return { alice, bob, file, hashlock };
    };

    it("Alice, sha256: the claim's fixed 200,000 gas x the fee ceiling x 1.25, exactly, and whether the key covers it", async () => {
      const { alice, file } = mk("alice");
      const exact = (200000n * CAP_WEI * 125n) / 100n;
      let r = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: CAP });
      expect(r).to.include({ role: "alice", address: alice.address, claimGasLimit: "200000", gasTotal: "200000", feeCeilingWei: CAP_WEI.toString(), feeCeilingGwei: "10.0", feeCeilingSource: "--gas-price-gwei", margin: "1.25", lockKind: "sha256" });
      expect(r.keyChecked).to.equal(true);
      expect(r.reserveWei).to.equal(exact.toString());
      expect(r.requiredWei).to.equal(exact.toString());
      expect(r).to.not.have.property("amountWei");
      expect(r.covered).to.equal(false);
      expect(r.balanceWei).to.equal("0");
      expect(r.shortfallWei).to.equal(exact.toString());
      await fund(alice.address, exact - 1n);
      r = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: CAP });
      expect([r.covered, r.shortfallWei]).to.deep.equal([false, "1"]);
      await fund(alice.address, 1n);
      r = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: CAP });
      expect([r.covered, r.shortfallWei, r.balanceWei]).to.deep.equal([true, "0", exact.toString()]);
    });

    it("Alice, poseidon: the claim's fixed 1,000,000 gas", async () => {
      const { alice, file } = mk("alice", { lockKind: "poseidon" });
      const r = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: "3" });
      expect(r.claimGasLimit).to.equal("1000000");
      expect(r.reserveWei).to.equal(((1000000n * 3n * GWEI * 125n) / 100n).toString());
      expect(r.lockKind).to.equal("poseidon");
    });

    it("Bob: amount + (lock + refund gas ceilings) x the fee ceiling x 1.25; the numbers follow the lock kind", async () => {
      for (const [kind, lockGas, refundGas] of [["sha256", 250000n, 100000n], ["poseidon", 700000n, 200000n]]) {
        const { bob, file } = mk("bob", kind === "poseidon" ? { lockKind: "poseidon" } : {});
        const gas = lockGas + refundGas;
        const reserve = (gas * CAP_WEI * 125n) / 100n;
        expect(live.LOCK_GAS_RESERVE[kind]).to.equal(lockGas);
        expect(live.REFUND_GAS_RESERVE[kind]).to.equal(refundGas);
        let r = await live.reserve(provider, bob.w, { role: "bob", swap: file, gasPriceGwei: CAP });
        expect(r).to.include({ role: "bob", address: bob.address, amountWei: amount.toString(), lockGasCeiling: lockGas.toString(), refundGasCeiling: refundGas.toString(), gasTotal: gas.toString() });
        expect(r.reserveWei).to.equal(reserve.toString());
        expect(r.requiredWei).to.equal((amount + reserve).toString());
        expect(r.covered).to.equal(false);
        await fund(bob.address, amount + reserve);
        r = await live.reserve(provider, bob.w, { role: "bob", swap: file, gasPriceGwei: CAP });
        expect([r.covered, r.shortfallWei]).to.deep.equal([true, "0"]);
      }
    });

    it("the 1.25 is integer arithmetic that rounds up (tiny fee ceilings stay exact, and the helper rounds a fraction up)", async () => {
      const { alice, file } = mk("alice");
      // 200,000 x 1 wei x 1.25 = 250,000 exactly; at 3 wei: 600,000 x 1.25 = 750,000
      const r = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: "0.000000001" });
      expect(r.reserveWei).to.equal("250000");
      const three = await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: "0.000000003" });
      expect(three.reserveWei).to.equal("750000");
      const mb = mk("bob");
      const bobFile = mb.file;
      const rb = await live.reserve(provider, mb.bob.w, { role: "bob", swap: bobFile, gasPriceGwei: "0.000000001" });
      expect(rb.reserveWei).to.equal("437500");
      // every gas figure is a multiple of 4, so the product is whole; the helper still rounds a fraction up
      expect([live.withMargin(1n), live.withMargin(3n), live.withMargin(4n), live.withMargin(0n)]).to.deep.equal([2n, 4n, 5n, 0n]);
    });

    it("without a cap flag the node's own fee suggestion is the ceiling, and the output says so", async () => {
      const { alice, file } = mk("alice");
      const r = await live.reserve(provider, alice.w, { role: "alice", swap: file });
      expect(r.feeCeilingSource).to.equal("the node's fee suggestion");
      const fd = await provider.getFeeData();
      expect(r.feeCeilingWei).to.equal(fd.maxFeePerGas.toString());
    });

    it("refuses a wrong role, a wrong chain, a missing file, mainnet without its flags, and a cap flag without --mainnet", async () => {
      const a = mk("alice");
      await expect(live.reserve(provider, a.alice.w, { role: "bob", swap: a.file, gasPriceGwei: CAP })).to.be.rejectedWith(/--role bob but the swap file is alice's/);
      await expect(live.reserve(provider, a.alice.w, { role: "carol", swap: a.file })).to.be.rejectedWith(/--role must be alice or bob/);
      await expect(live.reserve(provider, a.alice.w, { swap: a.file })).to.be.rejectedWith(/missing required --role/);
      await expect(live.reserve(provider, a.alice.w, { role: "alice" })).to.be.rejectedWith(/missing required --swap/);
      await expect(live.reserve(provider, a.alice.w, { role: "alice", swap: path.join(dir, "none.json") })).to.be.rejectedWith(/swap file not found/);
      const other = mk("alice", { chain: 11155111 });
      await expect(live.reserve(provider, other.alice.w, { role: "alice", swap: other.file, gasPriceGwei: CAP })).to.be.rejectedWith(/chain id mismatch: the swap file is for chain 11155111 but the node reports 31337/);
      await expect(live.reserve(provider, a.alice.w, { role: "alice", swap: a.file, mainnet: true, maxFeeGwei: "20" })).to.be.rejectedWith(/--mainnet: the swap file's chain_id is 31337, not 1/);
      await expect(live.reserve(provider, a.alice.w, { role: "alice", swap: a.file, maxFeeGwei: "20" })).to.be.rejectedWith(/only accepted together with --mainnet/);
      await expect(live.reserve(provider, a.alice.w, { role: "alice", swap: a.file, mainnet: true })).to.be.rejectedWith(/missing required --max-fee-gwei/);
    });

    it("requires the key, and refuses a key whose address is not the file's account (both fields), before any amount is shown", async () => {
      const { alice, bob, file } = mk("alice");
      const args = { role: "alice", swap: file, gasPriceGwei: CAP };
      await expect(live.reserve(provider, null, args)).to.be.rejectedWith(/reserve needs the swap's key/);
      const stranger = party();
      let err;
      try {
        await live.reserve(provider, stranger.w, args);
      } catch (e) {
        err = e;
      }
      expect(err, "a stranger's key is refused").to.be.an("error");
      expect(err.message).to.match(/does not belong to the swap file's alice_receiver/);
      expect(err.message).to.match(/nothing must be deposited to/);
      expect(err.message).to.not.include(stranger.key.slice(2));
      // Bob's key is not Alice's account either
      await expect(live.reserve(provider, bob.w, args)).to.be.rejectedWith(/does not belong to the swap file's alice_receiver/);
      // the account matches but the file's eth_key address is another one: refused too
      const other = party();
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      j.eth_key.address = other.address.toLowerCase();
      fs.writeFileSync(file, JSON.stringify(j));
      await expect(live.reserve(provider, alice.w, args)).to.be.rejectedWith(/does not belong to the swap file's eth_key address/);
      // Bob's side: the key is bob_sender
      const b = mk("bob");
      await expect(live.reserve(provider, b.alice.w, { role: "bob", swap: b.file, gasPriceGwei: CAP })).to.be.rejectedWith(/does not belong to the swap file's bob_sender/);
      // a file without an eth_key record: the account alone is checked
      const plain = mk("alice", { ethKey: null });
      const r = await live.reserve(provider, plain.alice.w, { role: "alice", swap: plain.file, gasPriceGwei: CAP });
      expect(r.keyChecked).to.equal(true);
    });

    it("is read-only: no transaction, no file written", async () => {
      const { alice, file } = mk("alice");
      const n = await nonce(alice.address);
      const before = fs.readdirSync(dir).sort();
      await live.reserve(provider, alice.w, { role: "alice", swap: file, gasPriceGwei: CAP });
      expect(await nonce(alice.address)).to.equal(n);
      expect(fs.readdirSync(dir).sort()).to.deep.equal(before);
    });
  });

  // ---------------------------------------------------------------- sweep
  describe("sweep", () => {
    const sweepArgs = (file, to, extra = {}) => ({ swap: file, to, gasPriceGwei: CAP, ...extra });

    /** Bob's swap: a lock that is refunded (the swap failed) or still open. Returns what the tests need. */
    async function bobSwap({ state = "refunded", phase = "refunded", payoutOf, ...over } = {}) {
      const alice = party();
      const bob = party();
      const payout = payoutOf ? payoutOf() : party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, amount + ethers.parseEther("0.5"));
      const l = await bobLocks({ bob, alice, hashlock });
      if (state === "refunded") {
        await passTime(HOUR + 5);
        await live.refund(provider, bob.w, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      }
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase, ...over });
      return { alice, bob, payout, hashlock, l, file };
    }

    it("Bob after a refund: the whole balance minus 21,000 gas at the capped fee reaches the payout address, exactly", async () => {
      const { bob, payout, file } = await bobSwap();
      const before = await bal(bob.address);
      const to0 = await bal(payout.address);
      const expected = before - 21000n * CAP_WEI;
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
      expect(r.valueWei).to.equal(expected.toString());
      expect(r).to.include({ to: payout.address, from: bob.address, role: "bob", balanceBeforeWei: before.toString(), feeCapWei: CAP_WEI.toString() });
      expect(await bal(payout.address)).to.equal(to0 + expected);
      const left = await bal(bob.address);
      expect(left).to.be.gte(0n);
      expect(left).to.be.lt(21000n * CAP_WEI); // only the part of the fee cap the chain did not charge
      expect(await nonce(bob.address, "pending")).to.equal(await nonce(bob.address));
    });

    it("--dry-run prints what it would send, sends nothing, and writes nothing", async () => {
      const { bob, payout, file } = await bobSwap();
      const n = await nonce(bob.address);
      const before = await bal(bob.address);
      const files = fs.readdirSync(dir).sort();
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun: true }));
      expect(r).to.include({ dryRun: true, sent: false, to: payout.address, from: bob.address });
      expect(r.valueWei).to.equal((before - 21000n * CAP_WEI).toString());
      expect(r.gasLimit).to.equal("21000");
      expect(r.sweep).to.include({ role: "bob", key: bob.address, payout: payout.address, balanceWei: before.toString(), feeWei: (21000n * CAP_WEI).toString(), valueWei: r.valueWei });
      expect(r.sweep.locksSeen).to.have.length(1);
      expect(r.sweep.locksSeen[0].state).to.equal("refunded");
      expect(await nonce(bob.address)).to.equal(n);
      expect(await bal(bob.address)).to.equal(before);
      expect(fs.readdirSync(dir).sort()).to.deep.equal(files);
    });

    it("without a cap flag the node's own fee suggestion is pinned and the amount is still the balance minus 21,000 gas x that cap", async () => {
      const { bob, payout, file } = await bobSwap();
      const before = await bal(bob.address);
      const dry = await live.sweep(provider, bob.w, { swap: file, to: payout.address, dryRun: true });
      const fee = BigInt(dry.sweep.feeWei);
      expect(fee % 21000n).to.equal(0n);
      expect(dry.sweep.valueWei).to.equal((before - fee).toString());
      const r = await live.sweep(provider, bob.w, { swap: file, to: payout.address });
      expect(BigInt(r.valueWei) + BigInt(r.feeCapWei) * 21000n).to.equal(before);
    });

    it("refuses while Bob's lock is open, naming the lock, and sends nothing; then allows it once the lock is refunded", async () => {
      const { bob, payout, file, l } = await bobSwap({ state: "open", phase: "locked" });
      const n = await nonce(bob.address);
      for (const dryRun of [true, false]) {
        await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun }))).to.be.rejectedWith(new RegExp(`lock ${l.lockId} of this swap is still open on chain`));
      }
      expect(await nonce(bob.address)).to.equal(n);
      await passTime(HOUR + 5);
      await live.refund(provider, bob.w, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
      expect(BigInt(r.valueWei)).to.be.gt(0n);
    });

    it("a claimed lock is closed too (Bob's side: Alice claimed, the lock is over)", async () => {
      const alice = party();
      const bob = party();
      const payout = party();
      const preimage = rand32();
      const hashlock = sha256Raw(preimage);
      await fund(bob.address, amount + ethers.parseEther("0.2"));
      await fund(alice.address, ethers.parseEther("0.2"));
      const l = await bobLocks({ bob, alice, hashlock });
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase: "done" });
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/still open on chain/);
      await live.claim(provider, alice.w, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage });
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
      expect(r.role).to.equal("bob");
    });

    it("Alice after the claim: her key received the ETH she bought and paid the reveal's fee; the sweep sends all of it on, exactly", async () => {
      const alice = party();
      const bob = party();
      const payout = party();
      const preimage = rand32();
      const hashlock = sha256Raw(preimage);
      await fund(bob.address, amount + ethers.parseEther("0.2"));
      await fund(alice.address, ethers.parseEther("0.05")); // the reserve
      const l = await bobLocks({ bob, alice, hashlock });
      const file = swapFile({ role: "alice", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase: "revealed" });
      // the lock is open: Alice's reveal still needs her key
      await expect(live.sweep(provider, alice.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/still open on chain.*Alice's reveal still needs this key's gas/);
      await live.claim(provider, alice.w, { ...tgt, contract: htlcAddr, lockId: l.lockId, secret: preimage });
      const before = await bal(alice.address);
      expect(before).to.be.gt(amount);
      const to0 = await bal(payout.address);
      const r = await live.sweep(provider, alice.w, sweepArgs(file, payout.address));
      expect(r.role).to.equal("alice");
      expect(await bal(payout.address)).to.equal(to0 + before - 21000n * CAP_WEI);
      expect(r.valueWei).to.equal((before - 21000n * CAP_WEI).toString());
    });

    it("Alice with a refunded lock may sweep her reserve (the swap failed); with no lock on chain only an ended phase allows it", async () => {
      const alice = party();
      const bob = party();
      const payout = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, amount + ethers.parseEther("0.2"));
      await fund(alice.address, ethers.parseEther("0.05"));
      const noLockFile = (phase) => swapFile({ role: "alice", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase });
      // no lock at all, and the swap is still going: refused
      for (const phase of ["created", "funded", "funding_final", "lock_seen"]) {
        await expect(live.sweep(provider, alice.w, sweepArgs(noLockFile(phase), payout.address)), phase).to.be.rejectedWith(/no lock of this swap is on chain, and the swap file's phase is/);
      }
      // aborted: allowed
      const dry = await live.sweep(provider, alice.w, sweepArgs(noLockFile("aborted"), payout.address, { dryRun: true }));
      expect(dry.sweep.locksSeen).to.deep.equal([]);
      // a lock that Bob refunded: allowed whatever the file's phase
      const l = await bobLocks({ bob, alice, hashlock });
      await passTime(HOUR + 5);
      await live.refund(provider, bob.w, { ...tgt, contract: htlcAddr, lockId: l.lockId });
      const r = await live.sweep(provider, alice.w, sweepArgs(noLockFile("created"), payout.address));
      expect(BigInt(r.valueWei)).to.be.gt(0n);
    });

    it("an ended phase with no lock lets Bob sweep, a running one does not", async () => {
      const bob = party();
      const alice = party();
      const payout = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, ethers.parseEther("0.5"));
      const f = (phase) => swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase });
      await expect(live.sweep(provider, bob.w, sweepArgs(f("funding_final"), payout.address))).to.be.rejectedWith(/no lock of this swap is on chain/);
      await expect(live.sweep(provider, bob.w, sweepArgs(f("aborted"), payout.address, { dryRun: true }))).to.be.fulfilled;
    });

    it("refuses a --to that is not the payout address stored in the file, the key's own address, or any other address", async () => {
      const { bob, payout, file } = await bobSwap();
      const n = await nonce(bob.address);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, party().address))).to.be.rejectedWith(/is not the payout address stored in the swap file/);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, bob.address))).to.be.rejectedWith(/not the payout address stored|key's own address/);
      await expect(live.sweep(provider, bob.w, { swap: file, gasPriceGwei: CAP })).to.be.rejectedWith(/missing required --to/);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, "0x1234"))).to.be.rejectedWith(/not a valid Ethereum address/);
      // a payout in the file that is the key itself
      const self = swapFile({ role: "bob", hashlock: sha256Raw(rand32()), alice: party().address, bob: bob.address, payout: bob.address, phase: "aborted" });
      await expect(live.sweep(provider, bob.w, sweepArgs(self, bob.address))).to.be.rejectedWith(/key's own address/);
      expect(await nonce(bob.address)).to.equal(n);
      // the right one still works
      await live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun: true }));
    });

    it("refuses a key that is not the file's own account, a file without an eth_key record, or one whose record disagrees with the terms", async () => {
      const { alice, bob, payout, hashlock, file } = await bobSwap();
      const stranger = party();
      await fund(stranger.address, ethers.parseEther("0.1"));
      await expect(live.sweep(provider, stranger.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/this key is .* but the swap file's bob_sender is/);
      await expect(live.sweep(provider, alice.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/but the swap file's bob_sender is/);
      const none = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, ethKey: null, phase: "refunded" });
      await expect(live.sweep(provider, bob.w, sweepArgs(none, payout.address))).to.be.rejectedWith(/holds no Ethereum swap key record/);
      const broken = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, ethKey: { address: "nope", payout: payout.address }, phase: "refunded" });
      await expect(live.sweep(provider, bob.w, sweepArgs(broken, payout.address))).to.be.rejectedWith(/eth_key record does not parse/);
      const other = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, ethKey: { address: stranger.address, payout: payout.address }, phase: "refunded" });
      await expect(live.sweep(provider, bob.w, sweepArgs(other, payout.address))).to.be.rejectedWith(/eth_key address .* is not its bob_sender/);
      // a role-less file
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      delete j.role;
      const roleless = path.join(dir, "roleless.json");
      fs.writeFileSync(roleless, JSON.stringify(j));
      await expect(live.sweep(provider, bob.w, sweepArgs(roleless, payout.address))).to.be.rejectedWith(/no role/);
      // no --swap at all
      await expect(live.sweep(provider, bob.w, { to: payout.address, gasPriceGwei: CAP })).to.be.rejectedWith(/sweep needs --swap FILE/);
    });

    it("refuses while the swap file holds a pending lock_eth, refund_eth or reveal_eth intent, or such a pending action", async () => {
      for (const intent of ["lock_eth", "refund_eth", "reveal_eth"]) {
        const { bob, payout, file } = await bobSwap({ intent });
        const n = await nonce(bob.address);
        await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address)), intent).to.be.rejectedWith(new RegExp(`pending ${intent} intent`));
        expect(await nonce(bob.address)).to.equal(n);
      }
      for (const pendingAction of ["lock_eth", "refund_eth", "reveal_eth"]) {
        const { bob, payout, file } = await bobSwap({ pendingAction });
        await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address)), pendingAction).to.be.rejectedWith(new RegExp(`pending ${pendingAction} action`));
      }
      // an intent of another kind does not concern the Ethereum key
      const { bob, payout, file } = await bobSwap({ intent: "claim_noid" });
      await live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun: true }));
    });

    it("refuses while the key has a transaction pending (pending nonce above the latest)", async () => {
      const { bob, payout, file } = await bobSwap();
      await provider.send("evm_setAutomine", [false]);
      const held = await bob.w.sendTransaction({ to: await carol.getAddress(), value: 1n });
      expect(await nonce(bob.address, "pending")).to.equal((await nonce(bob.address)) + 1);
      for (const dryRun of [true, false]) {
        await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun }))).to.be.rejectedWith(/has a transaction pending on this node \(pending nonce \d+, latest nonce \d+\)/);
      }
      await provider.send("evm_setAutomine", [true]);
      await provider.send("evm_mine", []);
      await held.wait();
      await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
    });

    it("refuses a --to that has code (a contract, or an account with a delegation), also in a dry run", async () => {
      const bob = party();
      const alice = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, ethers.parseEther("0.5"));
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: otherContract, phase: "aborted" });
      const n = await nonce(bob.address);
      for (const dryRun of [true, false]) {
        await expect(live.sweep(provider, bob.w, sweepArgs(file, otherContract, { dryRun }))).to.be.rejectedWith(/has code on this chain/);
      }
      // an EIP-7702 delegation designator is code too
      const delegated = party().address;
      await provider.send("hardhat_setCode", [delegated, "0xef0100" + "ab".repeat(20)]);
      const file2 = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: delegated, phase: "aborted" });
      await expect(live.sweep(provider, bob.w, sweepArgs(file2, delegated))).to.be.rejectedWith(/has code on this chain/);
      expect(await nonce(bob.address)).to.equal(n);
    });

    it("refuses on the wrong chain, and the mainnet gate is the other sends'", async () => {
      const { bob, payout, hashlock, alice } = await bobSwap();
      const n = await nonce(bob.address);
      const wrongChain = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, chain: 11155111, phase: "refunded" });
      await expect(live.sweep(provider, bob.w, sweepArgs(wrongChain, payout.address))).to.be.rejectedWith(/chain id mismatch: --chain-id is 11155111 but the RPC endpoint reports 31337/);
      // a --chain-id that disagrees with the file
      const second = await bobSwap();
      const file = second.file;
      await expect(live.sweep(provider, second.bob.w, sweepArgs(second.file, second.payout.address, { chainId: "1337" }))).to.be.rejectedWith(/--chain-id disagrees with the swap file/);
      // a chain 1 file without --mainnet
      const main = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, chain: 1, phase: "refunded" });
      await expect(live.sweep(provider, bob.w, sweepArgs(main, payout.address))).to.be.rejectedWith(/Ethereum mainnet \(chainId 1\) without --mainnet/);
      // --mainnet with a test file, a cap with no --mainnet, --mainnet with no cap, --mainnet with --gas-price-gwei
      await expect(live.sweep(provider, second.bob.w, { swap: file, to: second.payout.address, mainnet: true, maxFeeGwei: "20" })).to.be.rejectedWith(/--mainnet: the swap file's chain_id is 31337, not 1/);
      await expect(live.sweep(provider, second.bob.w, { swap: file, to: second.payout.address, maxFeeGwei: "20" })).to.be.rejectedWith(/only accepted together with --mainnet/);
      await expect(live.sweep(provider, second.bob.w, { swap: file, to: second.payout.address, mainnet: true })).to.be.rejectedWith(/missing required --max-fee-gwei/);
      await expect(live.sweep(provider, second.bob.w, { swap: file, to: second.payout.address, mainnet: true, maxFeeGwei: "20", gasPriceGwei: "20" })).to.be.rejectedWith(/cannot be combined with --gas-price-gwei/);
      expect(await nonce(bob.address)).to.equal(n);
    });

    it("the mainnet path passes through the same checks: a chain-1 production file on a chain-1 node, with --max-fee-gwei, sweeps", async () => {
      const bob = party();
      const alice = party();
      const payout = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, ethers.parseEther("0.5"));
      const asChain1 = new Proxy(provider, {
        get(t, prop) {
          if (prop === "getNetwork") return async () => ({ chainId: 1n });
          if (prop === "send") return async (method, params) => (method === "eth_chainId" ? "0x1" : provider.send(method, params));
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, chain: 1, phase: "aborted", codeHash: tgt.codeHash });
      // a cap below the base fee is refused (the base fee is 20 gwei here)
      await setBase(20);
      await expect(live.sweep(asChain1, bob.w, { swap: file, to: payout.address, mainnet: true, maxFeeGwei: "15" })).to.be.rejectedWith(/below 1 x the latest base fee/);
      const dry = await live.sweep(asChain1, bob.w, { swap: file, to: payout.address, mainnet: true, maxFeeGwei: "25", dryRun: true });
      expect(dry.chainId).to.equal("1");
      expect(dry.feeCheck).to.include({ minRatio: "1" });
      expect(dry.sweep.feeWei).to.equal((21000n * 25n * GWEI).toString());
      expect(dry.worstCaseFeeWei).to.equal((21000n * 25n * GWEI).toString());
      const before = await bal(bob.address);
      const real = await live.sweep(asChain1, bob.w, { swap: file, to: payout.address, mainnet: true, maxFeeGwei: "25" });
      expect(real.valueWei).to.equal((before - 21000n * 25n * GWEI).toString());
    });

    it("refuses a fee cap below the base fee, and a balance that does not exceed the fee", async () => {
      const { bob, payout, file } = await bobSwap();
      await setBase(40);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address, { gasPriceGwei: "20" }))).to.be.rejectedWith(/below 1 x the latest base fee/);
      await setBase(1);
      // a key that holds almost nothing
      const bob2 = party();
      const alice = party();
      const file2 = swapFile({ role: "bob", hashlock: sha256Raw(rand32()), alice: alice.address, bob: bob2.address, payout: payout.address, phase: "aborted" });
      await fund(bob2.address, 21000n * CAP_WEI);
      await expect(live.sweep(provider, bob2.w, sweepArgs(file2, payout.address))).to.be.rejectedWith(/nothing to sweep/);
    });

    it("an unresolved lock record beside the swap file refuses; one that names a refunded or claimed lock does not", async () => {
      const { bob, payout, file, l } = await bobSwap();
      const record = file + ".lock-sent";
      const rec = (lockId) => JSON.stringify({ version: 1, lock_word: "0x" + "11".repeat(32), lock_id: lockId, sender: bob.address, nonce: 0, tx_hash: null, at: 1 }) + "\n";
      // a record whose lock is not on chain (it may be pending, dropped or never mined)
      fs.writeFileSync(record, rec(rand32()));
      const n = await nonce(bob.address);
      for (const dryRun of [true, false]) {
        await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun }))).to.be.rejectedWith(/lock record .* exists .* and it is not resolved \(the lock 0x[0-9a-f]{64} it names is not on chain/);
      }
      expect(await nonce(bob.address)).to.equal(n);
      // junk, a directory, another sender, an oversized file: all unresolved
      fs.writeFileSync(record, "not json");
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/it cannot be read/);
      fs.writeFileSync(record, JSON.stringify({ version: 1, lock_id: l.lockId, sender: party().address, nonce: 0, at: 1 }));
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/it names another sender/);
      fs.writeFileSync(record, " ".repeat(5000));
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/not a record this tool wrote|it cannot be read/);
      fs.rmSync(record);
      fs.mkdirSync(record);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/not a record this tool wrote/);
      fs.rmdirSync(record);
      // the record of the REFUNDED lock: resolved
      fs.writeFileSync(record, rec(l.lockId));
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun: true }));
      expect(r.sweep.recordsResolved).to.be.gte(1);
    });

    it("a per-user lock record (one per chain, sender and lock word) is judged the same way, whatever the swap file is called", async () => {
      const bob = party();
      const alice = party();
      const payout = party();
      const hashlock = sha256Raw(rand32());
      await fund(bob.address, ethers.parseEther("0.5"));
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase: "aborted" });
      const target = live.userLockSentPath(31337, bob.address, hashlock);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ version: 1, lock_word: hashlock, lock_id: rand32(), sender: bob.address, nonce: 0, tx_hash: null, at: 1 }) + "\n");
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/per-user lock record .* is not resolved/);
      // a REAL lock of this swap that is refunded writes its own per-user record, which resolves (the tool never removes it)
      fs.rmSync(target);
      const real = await bobLocks({ bob, alice, hashlock });
      expect(fs.existsSync(target)).to.equal(true);
      await expect(live.sweep(provider, bob.w, sweepArgs(file, payout.address))).to.be.rejectedWith(/still open on chain/);
      await passTime(HOUR + 5);
      await live.refund(provider, bob.w, { ...tgt, contract: htlcAddr, lockId: real.lockId });
      const r = await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
      expect(BigInt(r.valueWei)).to.be.gt(0n);
      expect(fs.existsSync(target), "the sweep does not remove a lock record").to.equal(true);
    });

    it("sweep does not change the swap file", async () => {
      const { bob, payout, file } = await bobSwap();
      const before = fs.readFileSync(file);
      await live.sweep(provider, bob.w, sweepArgs(file, payout.address));
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
    });

    it("a poseidon file reads the same way (the lock word is Addr(secret); the contract is the poseidon artifact)", async () => {
      const bob = party();
      const alice = party();
      const payout = party();
      const hashlock = rand32();
      await fund(bob.address, ethers.parseEther("0.5"));
      const poseidonHash = live.artifactCodeHash("poseidon");
      const addr = (await live.deploy(provider, carol, { lockKind: "poseidon" })).contract;
      const file = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase: "aborted", lockKind: "poseidon", contract: addr, codeHash: poseidonHash });
      const dry = await live.sweep(provider, bob.w, sweepArgs(file, payout.address, { dryRun: true }));
      expect(dry.sweep.locksSeen).to.deep.equal([]);
      // a sha256 artifact's hash pinned in a poseidon file is refused
      const bad = swapFile({ role: "bob", hashlock, alice: alice.address, bob: bob.address, payout: payout.address, phase: "aborted", lockKind: "poseidon", contract: addr, codeHash: tgt.codeHash });
      await expect(live.sweep(provider, bob.w, sweepArgs(bad, payout.address))).to.be.rejectedWith(/pins code_hash .* not the local/);
    });
  });
});
