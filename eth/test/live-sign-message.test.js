"use strict";
/*
 * live.js `sign-message` and `verify-message` (piece 3, step P3.1): an EIP-191 personal-message signature by a key given on a pipe or in a file, and its read-only check.
 * Both commands are offline: no node is asked for anything (the tests point ETH_RPC_URL at a closed port to show it). Nothing here touches a network.
 */
const { expect } = require("chai");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const isolated = require("./helpers/isolated-home"); // before anything else: nothing here may touch the real per-user record
const { live } = require("./helpers/live-module");

const SCRIPT = path.join(__dirname, "..", "scripts", "live.js");
const DOMAIN = "no1d-swap-v1 ";
const hexOf = (text) => "0x" + Buffer.from(text, "utf8").toString("hex");
const newKey = () => "0x" + crypto.randomBytes(32).toString("hex");

// A fixed key and message (a well-known test key; it holds nothing anywhere) and the signature RFC 6979 gives them, pinned.
const FIXED_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FIXED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FIXED_MESSAGE = "0x6e6f31642d737761702d763120616464726573736573"; // "no1d-swap-v1 addresses"
const FIXED_SIGNATURE = "0x8e835385bed233cfaf72b82e6e30de94989dbdd80042cfb2d4dc29681a81bf3703599532ce80875bcfde67dd87541375ff03cecd258c470b19877ccb5699ee6f1c";

describe("live.js sign-message and verify-message (piece 3, P3.1)", function () {
  this.timeout(60000);

  let dir;
  beforeEach(() => {
    isolated.clearRecords();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-signmsg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    isolated.clearRecords();
  });

  // ETH_RPC_URL names a closed port: a command that asked a node for anything would fail, so success shows it is offline.
  const cli = (args, input) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ETH_RPC_URL: "http://127.0.0.1:1" } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(input === undefined ? "" : input);
    });
  const noKey = (key, ...texts) => texts.forEach((t) => expect(t, "the key never shows").to.not.match(new RegExp(key.slice(2), "i")));
  const sign = (key, messageHex) => cli(["sign-message", "--key-stdin", "--message-hex", messageHex], key + "\n");
  const verify = (address, messageHex, signature) => cli(["verify-message", "--address", address, "--message-hex", messageHex, "--signature", signature]);

  it("signs, and the signature verifies: the pinned vector, the address of the key, and an independent recovery", async () => {
    const r = await sign(FIXED_KEY, FIXED_MESSAGE);
    expect(r.code, r.err).to.equal(0);
    expect(r.err).to.equal("");
    expect(JSON.parse(r.out)).to.deep.equal({ address: FIXED_ADDRESS, signature: FIXED_SIGNATURE });
    // the same address as `address --key-stdin`
    expect(JSON.parse((await cli(["address", "--key-stdin"], FIXED_KEY + "\n")).out).address).to.equal(FIXED_ADDRESS);
    // an independent check: ethers' own recovery of the EIP-191 message
    expect(ethers.verifyMessage(ethers.getBytes(FIXED_MESSAGE), FIXED_SIGNATURE)).to.equal(FIXED_ADDRESS);
    const v = await verify(FIXED_ADDRESS, FIXED_MESSAGE, FIXED_SIGNATURE);
    expect(v.code, v.err).to.equal(0);
    expect(JSON.parse(v.out)).to.deep.equal({ valid: true, recovered: FIXED_ADDRESS });
    // a lower-case address is the same address
    expect((await verify(FIXED_ADDRESS.toLowerCase(), FIXED_MESSAGE, FIXED_SIGNATURE)).code).to.equal(0);
  });

  it("sign then verify with fresh keys, by pipe and by key file, over several messages", async () => {
    const f = path.join(dir, "k.key");
    for (let i = 0; i < 4; i++) {
      const key = newKey();
      const w = new ethers.Wallet(key);
      const message = hexOf(DOMAIN + "checked " + crypto.randomBytes(24).toString("hex"));
      const piped = await sign(key, message);
      expect(piped.code, piped.err).to.equal(0);
      fs.writeFileSync(f, key + "\n", { mode: 0o600 });
      const filed = await cli(["sign-message", "--key-file", f, "--message-hex", message]);
      expect(filed.code, filed.err).to.equal(0);
      expect(filed.out, "the same key and message give the same signature").to.equal(piped.out);
      const { address, signature } = JSON.parse(piped.out);
      expect(address).to.equal(w.address);
      expect(signature).to.match(/^0x[0-9a-f]{130}$/);
      expect(["1b", "1c"]).to.include(signature.slice(130));
      const v = await verify(w.address, message, signature);
      expect(v.code, v.err).to.equal(0);
      expect(JSON.parse(v.out)).to.deep.equal({ valid: true, recovered: w.address });
      noKey(key, piped.out, piped.err, filed.out, filed.err, v.out, v.err);
    }
  });

  it("a changed message, a changed signature and another address are not valid (exit status 3, the JSON says so)", async () => {
    const message = hexOf(DOMAIN + "checked abc");
    const { signature } = JSON.parse((await sign(FIXED_KEY, message)).out);
    const ok = await verify(FIXED_ADDRESS, message, signature);
    expect(ok.code).to.equal(0);
    // one byte of the message changed
    const changed = hexOf(DOMAIN + "checked abd");
    const m = await verify(FIXED_ADDRESS, changed, signature);
    expect(m.code, m.err).to.equal(3);
    const mj = JSON.parse(m.out);
    expect(mj.valid).to.equal(false);
    expect(mj.recovered).to.match(/^0x[0-9a-fA-F]{40}$/).and.not.equal(FIXED_ADDRESS);
    // one byte of r changed: another signer is recovered, or none
    const r = "0x" + (signature[2] === "0" ? "1" : "0") + signature.slice(3);
    const rr = await verify(FIXED_ADDRESS, message, r);
    expect(rr.code, rr.err).to.equal(3);
    expect(JSON.parse(rr.out).valid).to.equal(false);
    expect(JSON.parse(rr.out).recovered).to.not.equal(FIXED_ADDRESS);
    // another address
    const other = new ethers.Wallet(newKey()).address;
    const a = await verify(other, message, signature);
    expect(a.code, a.err).to.equal(3);
    expect(JSON.parse(a.out)).to.deep.equal({ valid: false, recovered: FIXED_ADDRESS });
  });

  it("a signature in another encoding of the same signer is not valid: v 0 or 1, a high s, an off-curve r", async () => {
    const message = hexOf(DOMAIN + "checked abc");
    const { signature } = JSON.parse((await sign(FIXED_KEY, message)).out);
    const sigObj = ethers.Signature.from(signature);
    // v written as 0 / 1 instead of 27 / 28
    const v01 = signature.slice(0, 130) + (sigObj.yParity === 0 ? "00" : "01");
    const a = await verify(FIXED_ADDRESS, message, v01);
    expect(a.code, a.err).to.equal(3);
    expect(JSON.parse(a.out)).to.deep.equal({ valid: false, recovered: null });
    // the high-s twin (n - s, the other parity): the same signer for a lax verifier, refused here
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = "0x" + signature.slice(2, 66) + (N - BigInt(sigObj.s)).toString(16).padStart(64, "0") + (sigObj.yParity === 0 ? "1c" : "1b");
    const b = await verify(FIXED_ADDRESS, message, highS);
    expect(b.code, b.err).to.equal(3);
    expect(JSON.parse(b.out)).to.deep.equal({ valid: false, recovered: null });
    // r larger than the curve order
    const c = await verify(FIXED_ADDRESS, message, "0x" + "ff".repeat(32) + signature.slice(66));
    expect(c.code, c.err).to.equal(3);
    expect(JSON.parse(c.out).valid).to.equal(false);
    // any other v
    const d = await verify(FIXED_ADDRESS, message, signature.slice(0, 130) + "1d");
    expect(d.code).to.equal(3);
    expect(JSON.parse(d.out)).to.deep.equal({ valid: false, recovered: null });
  });

  it("verify-message refuses malformed input (exit status 1) and needs no key and no node", async () => {
    const message = hexOf(DOMAIN + "x");
    const good = FIXED_SIGNATURE;
    const cases = [
      [["--address", "0x1234", "--message-hex", message, "--signature", good], /not a valid Ethereum address/],
      [["--address", FIXED_ADDRESS, "--message-hex", "hello", "--signature", good], /--message-hex must be 0x followed by whole bytes/],
      [["--address", FIXED_ADDRESS, "--message-hex", "0x123", "--signature", good], /--message-hex must be 0x followed by whole bytes/],
      [["--address", FIXED_ADDRESS, "--message-hex", "0x", "--signature", good], /--message-hex must be 0x followed by whole bytes/],
      [["--address", FIXED_ADDRESS, "--message-hex", message, "--signature", good.slice(0, -2)], /--signature must be 0x followed by exactly 130 hex/],
      [["--address", FIXED_ADDRESS, "--message-hex", message, "--signature", "0x" + "00".repeat(66)], /--signature must be 0x followed by exactly 130 hex/],
      [["--address", FIXED_ADDRESS, "--message-hex", message], /missing required --signature/],
      [["--message-hex", message, "--signature", good], /missing required --address/],
      [["--address", FIXED_ADDRESS, "--message-hex", message, "--signature", good, "--key-stdin"], /unknown flag --key-stdin/],
    ];
    for (const [args, re] of cases) {
      const r = await cli(["verify-message", ...args]);
      expect(r.code, JSON.stringify(args)).to.equal(1);
      expect(r.out).to.equal("");
      expect(r.err).to.match(re);
    }
    // with no stdin at all and a node address that refuses connections, it still answers
    const ok = await cli(["verify-message", "--address", FIXED_ADDRESS, "--message-hex", FIXED_MESSAGE, "--signature", FIXED_SIGNATURE]);
    expect(ok.code, ok.err).to.equal(0);
  });

  it("the domain rule: a message that does not start with `no1d-swap-v1 ` is not signed (exit status 1, nothing printed)", async () => {
    const key = newKey();
    const refused = [
      hexOf("hello"),
      hexOf("no1d-swap-v1"), // the text without its space
      hexOf("No1d-swap-v1 x"),
      hexOf(" no1d-swap-v1 x"),
      hexOf("no1d-swap-v2 x"),
      "0x19" + Buffer.from("Ethereum Signed Message:\n5hello").toString("hex"), // already an EIP-191 text
      "0x" + crypto.randomBytes(32).toString("hex"), // a 32-byte value that could be a hash
      "0xf86c0a8502540be40082520894" + "11".repeat(20) + "88", // the start of an RLP-encoded transaction
    ];
    for (const message of refused) {
      const r = await sign(key, message);
      expect(r.code, message).to.equal(1);
      expect(r.out, "nothing is signed").to.equal("");
      expect(r.err).to.match(/must start with the ASCII text "no1d-swap-v1 "/).and.match(/nothing was signed/);
      noKey(key, r.out, r.err);
    }
    // exactly the prefix alone is allowed (a tuple with nothing after it is the caller's own choice)
    const bare = await sign(key, hexOf(DOMAIN));
    expect(bare.code, bare.err).to.equal(0);
    // the library function refuses the same
    const w = new ethers.Wallet(key);
    await expect(live.signMessage(null, w, { messageHex: hexOf("hello") })).to.be.rejectedWith(/must start with the ASCII text/);
    expect(live.MESSAGE_DOMAIN).to.equal(DOMAIN);
  });

  it("--message-hex takes whole bytes only: text, an odd length, an empty message, no 0x and an over-long message are refused", async () => {
    const key = newKey();
    const long = "0x" + Buffer.from(DOMAIN).toString("hex") + "ab".repeat(2048 - DOMAIN.length + 1);
    const edge = "0x" + Buffer.from(DOMAIN).toString("hex") + "ab".repeat(2048 - DOMAIN.length);
    const bad = ["no1d-swap-v1 x", "0x", "0xabc", Buffer.from(DOMAIN + "x").toString("hex"), "0xzz", long, "0x" + Buffer.from(DOMAIN).toString("hex") + "g0"];
    for (const m of bad) {
      const r = await sign(key, m);
      expect(r.code, m.slice(0, 30)).to.equal(1);
      expect(r.out).to.equal("");
      expect(r.err).to.match(/--message-hex/);
    }
    expect((await sign(key, edge)).code, "2,048 bytes is the limit").to.equal(0);
    const missing = await cli(["sign-message", "--key-stdin"], key + "\n");
    expect(missing.code).to.equal(1);
    expect(missing.err).to.match(/missing required --message-hex/);
  });

  it("exactly one of --key-stdin and --key-file; a bad key or key file is refused without showing it", async () => {
    const key = newKey();
    const f = path.join(dir, "k.key");
    fs.writeFileSync(f, key + "\n", { mode: 0o600 });
    const message = hexOf(DOMAIN + "x");
    const both = await cli(["sign-message", "--key-stdin", "--key-file", f, "--message-hex", message], key + "\n");
    expect(both.code).to.equal(1);
    expect(both.err).to.match(/exactly one of --key-file or --key-stdin/);
    expect(both.out).to.equal("");
    const none = await cli(["sign-message", "--message-hex", message]);
    expect(none.code).to.equal(1);
    expect(none.err).to.match(/exactly one of --key-file or --key-stdin/);
    for (const bad of ["not-a-key-but-private", "0x" + "00".repeat(32), "0x" + "ff".repeat(32), "0x" + "ab".repeat(31), key + "\n" + key]) {
      const r = await sign(bad, message);
      expect(r.code, bad).to.equal(1);
      expect(r.out).to.equal("");
      expect(r.err).to.not.include(bad);
      noKey(key, r.out, r.err);
    }
    // a key file with an invalid key (the zero key is not on the curve's range) and a missing one
    for (const content of ["0x" + "00".repeat(32), "0x" + "ff".repeat(32), "garbage"]) {
      fs.writeFileSync(path.join(dir, "bad.key"), content + "\n", { mode: 0o600 });
      const r = await cli(["sign-message", "--key-file", path.join(dir, "bad.key"), "--message-hex", message]);
      expect(r.code, content).to.equal(1);
      expect(r.out).to.equal("");
      expect(r.err).to.not.include(content.slice(2));
    }
    expect((await cli(["sign-message", "--key-file", path.join(dir, "absent.key"), "--message-hex", message])).err).to.match(/key file not found/);
    // a terminal on stdin is refused before anything is read
    const was = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await expect(live.readKeyStdin({ keyStdin: true })).to.be.rejectedWith(/--key-stdin: stdin is a terminal/);
    } finally {
      process.stdin.isTTY = was;
    }
  });

  it("the key is in no output of any run (success, refusal, bad input)", async () => {
    const key = newKey();
    const f = path.join(dir, "k.key");
    fs.writeFileSync(f, key + "\n", { mode: 0o600 });
    const runs = [
      await sign(key, hexOf(DOMAIN + "a")),
      await sign(key, hexOf("hello")),
      await sign(key, "nothex"),
      await cli(["sign-message", "--key-file", f, "--message-hex", hexOf(DOMAIN + "a")]),
      await cli(["sign-message", "--key-file", f, "--message-hex", hexOf("hello")]),
      await cli(["sign-message", "--key-stdin", "--key-file", f, "--message-hex", hexOf(DOMAIN + "a")], key + "\n"),
      await cli(["sign-message", "--key-stdin", "--message-hex", hexOf(DOMAIN + "a"), "--unknown", "x"], key + "\n"),
    ];
    for (const r of runs) noKey(key, r.out, r.err);
    // the library: its error text and its result are scrubbed too
    const w = new ethers.Wallet(key);
    const res = await live.signMessage(null, w, { messageHex: hexOf(DOMAIN + "a") });
    expect(JSON.stringify(res)).to.not.include(key.slice(2));
    expect(live.redact("the key " + key + " in a text")).to.not.include(key.slice(2));
  });
});
