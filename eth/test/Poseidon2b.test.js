// Poseidon2b on the EVM: does contracts/Poseidon2b.sol reproduce Parano1d's Addr(s)?
//
// Three independent things are checked here:
//   1. contracts/Poseidon2b.sol is byte-identical to what scripts/poseidon/gen.js generates from the
//      Rust spec, and the field-arithmetic code the tests exercise is the SAME text as the copy
//      inside the permutation.
//   2. The Solidity agrees with the published vectors (always) and with the plain JavaScript
//      reference scripts/poseidon/poseidon2b.js (shift-and-add multiply, naive 4x4 MDS, BigInt;
//      constants parsed from equiv/portable/src, never typed) on a FIXED-SEED set of inputs:
//      206 secrets, 40 permutation states, 10 Derive cases. Nothing here is skipped or shrunk: if
//      the machine cannot run the set, a test FAILS with a message (see "memory" below).
//   3. HTLCPoseidon behaves like HTLC.sol.
//
// Reproducibility: every pseudo-random input comes from SHA-256 in counter mode over a fixed seed
// (POSEIDON_SEED overrides it, to widen coverage across runs). A failing input can be re-run.
//
// Memory: Hardhat's EDR runtime keeps the per-opcode trace of every EVM call in native memory,
// about 30 MB per 0.43 M-gas Poseidon call, and releases it only when the provider is recreated.
// The ~300 permutation-sized calls in this file would need ~9 GB if left alone. So the file calls
// `hardhat_reset` (which drops the old provider) plus a forced GC every few calls and redeploys what
// it needs. That changes nothing about what is computed. If fewer than MIN_CHUNK calls fit in the
// free RAM, the run fails with an explicit message instead of passing a smaller test.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const vm = require("vm");
const { execFileSync } = require("child_process");
const P = require("../scripts/poseidon/poseidon2b.js");
const gen = require("../scripts/poseidon/gen.js");

const { TOWER_TO_FLAT, ROUND_CONSTANTS, MDS_FULL, MDS_PARTIAL, M128, gfMul, towerToFlat, flatToTower, permuteTower } = P;
const jsAddr = P.addr;
const jsDerive = P.derive;

// =============================================================================================
// bech32m (BIP-350) decoder for Parano1d `o1...` addresses
// =============================================================================================
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function bech32mDecode(str) {
  const pos = str.lastIndexOf("1");
  const hrp = str.slice(0, pos);
  const data = [...str.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error("bech32m: bad character");
  const expanded = [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  if (bech32Polymod(expanded.concat(data)) !== 0x2bc830a3) throw new Error("bech32m: bad checksum");
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) throw new Error("bech32m: bad padding");
  return { hrp, bytes: Buffer.from(bytes) };
}

// =============================================================================================
// helpers
// =============================================================================================
const hex32 = (buf) => "0x" + Buffer.from(buf).toString("hex");
const HOUR = 3600;
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const increaseTime = async (s) => {
  await ethers.provider.send("evm_increaseTime", [s]);
  await ethers.provider.send("evm_mine", []);
};
const setNextTimestamp = (t) => ethers.provider.send("evm_setNextBlockTimestamp", [t]);

/** Deterministic byte stream: SHA-256(seed | label | counter). One stream per label. */
const SEED = process.env.POSEIDON_SEED || "noid-swap/poseidon2b/cross-check/v1";
function makeRng(label) {
  let ctr = 0;
  const bytes = (n) => {
    const chunks = [];
    for (let have = 0; have < n; have += 32) {
      chunks.push(crypto.createHash("sha256").update(`${SEED}|${label}|${ctr++}`).digest());
    }
    return Buffer.concat(chunks).subarray(0, n);
  };
  return {
    bytes,
    u128: () => BigInt("0x" + bytes(16).toString("hex")),
    u32: () => bytes(4).readUInt32BE(0),
  };
}

// Published vectors (PROJECT.md "Conventions", docs/parano1d-capabilities.md section 10)
const VEC_S = Buffer.from([...Array(32).keys()]); // 00 01 ... 1f
const VEC_ADDR_HEX = "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf";
const VEC_ADDR_O1 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const VEC_STOCK_O1 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const VEC_SHA256_HEX = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";

// =============================================================================================
// the fixed cross-check set, with its JS-side expectations
// =============================================================================================
// All expected values are computed by the JS reference at file load, BEFORE any test creates the
// Hardhat network: the computation blocks the event loop for several seconds, and done after the
// EDR provider existed, the next eth_call crashed the Node 24 process every time.
const N_RANDOM_SECRETS = 200; // plus the structured ones below
const N_STATES = 40;
const N_DERIVES = 10;
const N_MUL = 100;
const N_SQR = 100;
const N_CONV = 50;

function buildCases() {
  const c = {};
  let rng = makeRng("mul");
  c.mulA = [0n, 1n, 0n, 1n, M128, 1n << 127n, 1n << 127n, 0x87n, M128];
  c.mulB = [0n, 1n, rng.u128(), rng.u128(), M128, 2n, 1n << 127n, 1n << 127n, 1n << 127n];
  for (let k = 0; k < N_MUL; k++) {
    c.mulA.push(rng.u128());
    c.mulB.push(rng.u128());
  }
  c.mulExp = c.mulA.map((a, i) => gfMul(a, c.mulB[i]));

  rng = makeRng("sqr");
  c.sqr = [0n, 1n, 2n, M128, 1n << 127n, 1n << 64n];
  for (let k = 0; k < N_SQR; k++) c.sqr.push(rng.u128());
  c.sqrExp = c.sqr.map((a) => gfMul(a, a));

  rng = makeRng("conv");
  c.conv = [1n, 2n];
  for (let k = 0; k < N_CONV - 2; k++) c.conv.push(rng.u128());
  c.convIn = c.conv.concat(c.conv); // first half tower->flat, second half flat->tower
  c.convExp = c.conv.map(towerToFlat).concat(c.conv.map(flatToTower));

  // structured secrets first: bits 5-7 of every byte (the published vector never sets them, so it
  // never touches 48 of the 128 TOWER_TO_FLAT rows at run time), all-zero, all-ones, single bits
  const single = (byteIdx, v) => {
    const b = Buffer.alloc(32);
    b[byteIdx] = v;
    return b;
  };
  c.secrets = [Buffer.alloc(32), Buffer.alloc(32, 0xff), Buffer.alloc(32, 0xe0), Buffer.alloc(32, 0x80), single(0, 0x01), single(31, 0x80)];
  rng = makeRng("secret");
  for (let k = 0; k < N_RANDOM_SECRETS; k++) c.secrets.push(rng.bytes(32));
  c.addrExp = c.secrets.map((s) => hex32(jsAddr(s)));

  rng = makeRng("state");
  c.states = [];
  for (let k = 0; k < N_STATES; k++) c.states.push([rng.u128(), rng.u128(), rng.u128(), rng.u128()]);
  c.permExp = c.states.map(permuteTower).flat();

  rng = makeRng("derive");
  c.masters = [];
  c.indices = [];
  for (let k = 0; k < N_DERIVES; k++) {
    c.masters.push(rng.bytes(32));
    c.indices.push(k === 0 ? 0 : k === 1 ? 0xffffffff : 1 + (rng.u32() % (2 ** 31 - 1)));
  }
  c.deriveExp = c.masters.map((m, i) => hex32(jsDerive(m, c.indices[i])));
  return c;
}
const t0 = Date.now();
const R = buildCases();
const PRECOMPUTE_MS = Date.now() - t0;

const gas = {}; // collected gas numbers, printed at the end

// ---- memory management (see the header) ----------------------------------------------------------
const MARGIN_MB = 250; // keep this much free for the process itself and the other suites
const MIN_CHUNK = 6; // permutation-sized calls that must fit between two recycles (addrStockGas is 4)
const MAX_CHUNK = 24;
const mem = { perPerm: 0, chunk: 0, used: 0, recycles: 0 };
let H = null; // current Poseidon2bHarness instance (invalidated by every recycle)

const gc = (() => {
  try {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
  } catch (e) {
    return null;
  }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drop the EDR provider (and with it the retained native traces) and start a fresh chain. */
async function recycle() {
  await ethers.provider.send("hardhat_reset", []);
  H = null;
  mem.used = 0;
  mem.recycles++;
  if (gc) {
    gc();
    await sleep(50);
    gc();
  }
}
/** Make room for `perms` permutation-sized EVM calls (recycles the chain if the chunk is used up). */
async function budget(perms) {
  if (!mem.chunk) await calibrate();
  if (mem.used + perms > mem.chunk) await recycle();
  mem.used += perms;
}
/** The harness, deployed on the current chain, with room for `perms` permutation-sized calls. */
async function harness(perms) {
  await budget(perms);
  if (!H) H = await (await ethers.getContractFactory("Poseidon2bHarness")).deploy();
  return H;
}
/** Once per process: measure the retention per call and size the chunk. Fails, never skips. */
async function calibrate() {
  if (mem.chunk) return;
  H = await (await ethers.getContractFactory("Poseidon2bHarness")).deploy();
  const arg = hex32(VEC_S);
  await H.addr(arg); // warm-up: EDR lazy initialisation is not representative
  const before = process.memoryUsage().rss;
  await H.addr(arg);
  await H.addr(arg);
  mem.perPerm = Math.max(5, (process.memoryUsage().rss - before) / 2 / 1e6);
  mem.used = 3;
  const freeMB = os.freemem() / 1e6;
  mem.chunk = Math.min(MAX_CHUNK, Math.floor((freeMB - MARGIN_MB) / mem.perPerm));
  if (mem.chunk < MIN_CHUNK) {
    mem.chunk = 0; // make the next test fail again with the same message
    throw new Error(
      `Poseidon2b tests cannot run on this machine: EDR retains ~${Math.round(mem.perPerm)} MB per Poseidon call, ` +
        `${Math.round(freeMB)} MB are free and ${MARGIN_MB} MB must stay free, so fewer than ${MIN_CHUNK} calls fit ` +
        `between two chain recycles. Close other programs (the wallet node, WSL) and run again. ` +
        `This is a FAILURE, not a skip: the Solidity has not been checked.`
    );
  }
}

// =============================================================================================
describe("Poseidon2b generator (scripts/poseidon/gen.js)", function () {
  this.timeout(120000);
  const SOL = path.resolve(__dirname, "../contracts/Poseidon2b.sol");
  const GEN = path.resolve(__dirname, "../scripts/poseidon/gen.js");

  it("regenerating contracts/Poseidon2b.sol into a temp file is byte-identical to the committed contract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poseidon-gen-"));
    const out = path.join(dir, "Poseidon2b.sol");
    try {
      // through the command line, exactly as a human regenerates it
      execFileSync(process.execPath, [GEN, "--out", out], { stdio: "pipe" });
      const fresh = fs.readFileSync(out);
      const committed = fs.readFileSync(SOL);
      expect(fresh.equals(committed), `fresh generation (${fresh.length} bytes) differs from ${SOL} (${committed.length} bytes); run "npm run poseidon:gen" and review the diff`).to.equal(true);
      // and the in-process render() agrees with the CLI
      expect(Buffer.from(gen.render(), "utf8").equals(committed)).to.equal(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gmul/gsqr: the copies the unit tests call are the same text as the copy inside the permutation", () => {
    const lines = fs.readFileSync(SOL, "utf8").split("\n");
    // Yul `function NAME(` ... closing brace at 12 spaces, together with the Solidity function around it
    const grab = (name) => {
      const found = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim().startsWith(`function ${name}(`)) continue;
        let j = i;
        while (lines[j] !== "            }") j++;
        let k = i;
        while (!/^ {4}function (\w+)/.test(lines[k])) k--;
        found.push({ owner: /^ {4}function (\w+)/.exec(lines[k])[1], text: lines.slice(i, j + 1).join("\n") });
      }
      return found;
    };
    for (const name of ["gmul", "gsqr"]) {
      const copies = grab(name);
      expect(copies.map((c) => c.owner).sort(), `${name} copies`).to.deep.equal(["_permute", "gmulFlat", "gsqrFlat"]);
      expect(copies[0].text.length).to.be.greaterThan(500);
      for (const c of copies) expect(c.text, `${name} in ${c.owner} differs from the other copies`).to.equal(copies[0].text);
    }
  });
});

describe("Poseidon2b (Parano1d Addr on the EVM)", function () {
  this.timeout(600000);

  before(async () => {
    await calibrate();
  });

  describe("JavaScript reference sanity", () => {
    it("parsed 4x66 round constants, two 4x4 MDS matrices and two 128-entry basis tables", () => {
      expect(ROUND_CONSTANTS.length).to.equal(4);
      expect(ROUND_CONSTANTS[0].length).to.equal(66);
      expect(MDS_FULL).to.deep.equal([[5n, 7n, 1n, 3n], [4n, 6n, 1n, 1n], [1n, 3n, 5n, 7n], [1n, 1n, 4n, 6n]]);
      expect(MDS_PARTIAL[0][0]).to.equal(0x20n);
      expect(MDS_PARTIAL[1][1]).to.equal(0x2000n);
      expect(MDS_PARTIAL[2][2]).to.equal(0x200n);
      expect(MDS_PARTIAL[3][3]).to.equal(0x800n);
      expect(TOWER_TO_FLAT[0]).to.equal(1n);
      // basis maps are inverse of each other
      const rng = makeRng("sanity");
      for (let k = 0; k < 20; k++) {
        const x = rng.u128();
        expect(flatToTower(towerToFlat(x))).to.equal(x);
      }
      // x * x^127 = x^128 = 0x87
      expect(gfMul(2n, 1n << 127n)).to.equal(0x87n);
    });

    it("reproduces Addr(00..1f) and Addr(Derive(00..1f, 0)) from the docs", () => {
      expect(jsAddr(VEC_S).toString("hex")).to.equal(VEC_ADDR_HEX);
      expect(bech32mDecode(VEC_ADDR_O1).bytes.toString("hex")).to.equal(VEC_ADDR_HEX);
      const stock = bech32mDecode(VEC_STOCK_O1);
      expect(stock.hrp).to.equal("o");
      expect(jsAddr(jsDerive(VEC_S, 0)).toString("hex")).to.equal(stock.bytes.toString("hex"));
      expect(crypto.createHash("sha256").update(VEC_S).digest("hex")).to.equal(VEC_SHA256_HEX);
    });

    it("the fixed-seed case set has the promised size", () => {
      expect(R.secrets.length).to.be.at.least(200);
      expect(R.states.length).to.be.at.least(40);
      expect(R.masters.length).to.be.at.least(10);
    });
  });

  // gmul/gsqr: the generator test above proves the copy these call (gmulFlat/gsqrFlat) is the same
  // text as the copy in the permutation; the cross-checks below run the permutation's own copy.
  describe("field arithmetic (Solidity vs JS)", () => {
    it("gmul: 100 random pairs + 9 edge cases", async () => {
      const h = await harness(2);
      const got = (await h.gmulMany(R.mulA, R.mulB)).map(BigInt);
      expect(got).to.deep.equal(R.mulExp);
    });

    it("gsqr: 100 random values + 6 edge cases", async () => {
      const h = await harness(1);
      const got = (await h.gsqrMany(R.sqr)).map(BigInt);
      expect(got).to.deep.equal(R.sqrExp);
    });

    it("basis change: 50 values each way (incl. 1 -> 1 and 2 -> TOWER_TO_FLAT[1]), and the round trip", async () => {
      const h = await harness(2);
      const got = (await h.convMany(R.convIn)).map(BigInt);
      expect(got).to.deep.equal(R.convExp);
      expect(got[0]).to.equal(1n);
      expect(got[1]).to.equal(TOWER_TO_FLAT[1]);
      const back = (await h.convMany(got.slice(0, N_CONV).concat(got.slice(0, N_CONV)))).map(BigInt);
      expect(back.slice(N_CONV)).to.deep.equal(R.conv);
    });
  });

  describe("fixed vectors (Solidity)", () => {
    it("Addr(00 01 .. 1f) = f8183db2...12cf = o1lqvrmv...9xw2", async () => {
      const h = await harness(1);
      const a = await h.addr(hex32(VEC_S));
      expect(a).to.equal("0x" + VEC_ADDR_HEX);
      expect(a).to.equal(hex32(bech32mDecode(VEC_ADDR_O1).bytes));
    });

    it("Addr(Derive(00..1f, 0)) = o125qayv...7wlk, via addrStock and via derive + addr", async () => {
      const expected = hex32(bech32mDecode(VEC_STOCK_O1).bytes);
      expect(await (await harness(4)).addrStock(hex32(VEC_S))).to.equal(expected);
      const d = await (await harness(3)).derive(hex32(VEC_S), 0);
      expect(d).to.equal(hex32(jsDerive(VEC_S, 0)));
      expect(await (await harness(1)).addr(d)).to.equal(expected);
    });

    it("Addr is not SHA-256 and not keccak of the secret", async () => {
      const a = await (await harness(1)).addr(hex32(VEC_S));
      expect(a).to.not.equal("0x" + VEC_SHA256_HEX);
      expect(a).to.not.equal(ethers.keccak256(hex32(VEC_S)));
    });
  });

  describe("random cross-check (Solidity vs JS reference, fixed seed)", () => {
    it(`addr: ${R.secrets.length} secrets (6 structured + ${N_RANDOM_SECRETS} pseudo-random) agree`, async () => {
      for (let i = 0; i < R.secrets.length; i++) {
        const got = await (await harness(1)).addr(hex32(R.secrets[i]));
        expect(got, `secret #${i} = ${hex32(R.secrets[i])} (seed "${SEED}")`).to.equal(R.addrExp[i]);
      }
    });

    it(`permute: ${N_STATES} pseudo-random tower-basis states agree lane by lane`, async () => {
      for (let i = 0; i < R.states.length; i++) {
        const got = (await (await harness(1)).permute(R.states[i])).map(BigInt);
        expect(got, `state #${i} = ${R.states[i].map((x) => "0x" + x.toString(16))} (seed "${SEED}")`).to.deep.equal(R.permExp.slice(4 * i, 4 * i + 4));
      }
    });

    it(`derive: ${N_DERIVES} master secrets and indices agree (index 0 and 0xffffffff included; 3 permutations each)`, async () => {
      for (let i = 0; i < R.masters.length; i++) {
        const got = await (await harness(3)).derive(hex32(R.masters[i]), R.indices[i]);
        expect(got, `master #${i} = ${hex32(R.masters[i])}, index ${R.indices[i]} (seed "${SEED}")`).to.equal(R.deriveExp[i]);
      }
    });
  });

  describe("gas", () => {
    it("addr(): pure execution cost and transaction cost", async () => {
      const h = await harness(6);
      const [g, a] = await h.addrGas(hex32(VEC_S));
      expect(a).to.equal("0x" + VEC_ADDR_HEX);
      gas.addrPure = Number(g);
      const rc = await (await h.addrTx(hex32(VEC_S))).wait();
      gas.addrTx = Number(rc.gasUsed);
      const [gs] = await h.addrStockGas(hex32(VEC_S));
      gas.addrStockPure = Number(gs);
      expect(gas.addrPure).to.be.lessThan(10_000_000);
    });
  });
});

describe("HTLCPoseidon (ETH locked on a Parano1d address)", function () {
  this.timeout(600000);
  const amount = ethers.parseEther("1");
  const rng = makeRng("htlc");
  let htlc, alice, bob, carol;
  let secret, lockAddr, timelock, lockId;

  beforeEach(async () => {
    await budget(3); // the most Poseidon calls one test below makes (recycles the chain if needed)
    [alice, bob, carol] = await ethers.getSigners();
    htlc = await (await ethers.getContractFactory("HTLCPoseidon")).deploy();
    secret = rng.bytes(32);
    lockAddr = hex32(jsAddr(secret)); // computed off-chain by the JS reference, as Alice would
    timelock = (await now()) + 2 * HOUR;
    lockId = await htlc.connect(alice).newLock.staticCall(lockAddr, timelock, bob.address, { value: amount });
    await htlc.connect(alice).newLock(lockAddr, timelock, bob.address, { value: amount });
  });

  it("addrOf matches the off-chain Addr", async () => {
    expect(await htlc.addrOf(hex32(secret))).to.equal(lockAddr);
    expect(await htlc.addrOf(hex32(VEC_S))).to.equal("0x" + VEC_ADDR_HEX);
  });

  it("newLock stores the fields, emits Locked, and the id is deterministic", async () => {
    expect(lockId).to.equal(await htlc.computeLockId(alice.address, bob.address, amount, lockAddr, timelock));
    const l = await htlc.getLock(lockId);
    expect(l.sender).to.equal(alice.address);
    expect(l.receiver).to.equal(bob.address);
    expect(l.amount).to.equal(amount);
    expect(l.lockAddr).to.equal(lockAddr);
    expect(l.timelock).to.equal(timelock);
    expect(l.claimed).to.equal(false);
    expect(l.refunded).to.equal(false);
    await expect(
      htlc.connect(alice).newLock(lockAddr, timelock, bob.address, { value: amount })
    ).to.be.revertedWithCustomError(htlc, "LockAlreadyExists");
    await expect(htlc.newLock(lockAddr, timelock + 5, bob.address, { value: 0 })).to.be.revertedWithCustomError(htlc, "ZeroAmount");
    await expect(htlc.newLock(lockAddr, timelock + 5, ethers.ZeroAddress, { value: 1 })).to.be.revertedWithCustomError(htlc, "ZeroReceiver");
    await expect(htlc.newLock(lockAddr, 0, bob.address, { value: 1 })).to.be.revertedWithCustomError(htlc, "TimelockNotInFuture");
  });

  it("claim with the secret pays the fixed receiver (third party submits) and reports gas", async () => {
    const before = await ethers.provider.getBalance(bob.address);
    const tx = await htlc.connect(carol).claim(lockId, hex32(secret));
    const rc = await tx.wait();
    gas.claim = Number(rc.gasUsed);
    await expect(tx).to.emit(htlc, "Claimed").withArgs(lockId, hex32(secret));
    expect(await ethers.provider.getBalance(bob.address)).to.equal(before + amount);
    const l = await htlc.getLock(lockId);
    expect(l.claimed).to.equal(true);
    expect(l.preimage).to.equal(hex32(secret));
    // the revealed secret is exactly what the Parano1d claim needs
    expect(hex32(jsAddr(secret))).to.equal(l.lockAddr);
  });

  it("claim with the SHA-256 preimage convention (hashlock as lockAddr) does not work: Addr != SHA-256", async () => {
    const sha = "0x" + crypto.createHash("sha256").update(secret).digest("hex");
    const tl = (await now()) + HOUR;
    await htlc.connect(alice).newLock(sha, tl, bob.address, { value: 1n });
    const id = await htlc.computeLockId(alice.address, bob.address, 1n, sha, tl);
    await expect(htlc.claim(id, hex32(secret))).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
  });

  it("wrong secret, unknown lock, double claim revert", async () => {
    await expect(htlc.connect(bob).claim(lockId, hex32(rng.bytes(32)))).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
    await expect(htlc.claim(hex32(rng.bytes(32)), hex32(secret))).to.be.revertedWithCustomError(htlc, "LockNotFound");
    await htlc.connect(bob).claim(lockId, hex32(secret));
    await expect(htlc.connect(bob).claim(lockId, hex32(secret))).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
  });

  it("claim at timelock-1 works, at timelock reverts (timelock checked before the hash)", async () => {
    await setNextTimestamp(timelock - 1);
    await htlc.connect(bob).claim(lockId, hex32(secret));
    const tl = (await now()) + HOUR;
    await htlc.connect(alice).newLock(lockAddr, tl, bob.address, { value: 5n });
    const id2 = await htlc.computeLockId(alice.address, bob.address, 5n, lockAddr, tl);
    await setNextTimestamp(tl);
    await expect(htlc.connect(bob).claim(id2, hex32(secret))).to.be.revertedWithCustomError(htlc, "TimelockExpired");
  });

  it("refund: only the sender, only after the timelock, never after a claim", async () => {
    await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
    await increaseTime(2 * HOUR + 1);
    await expect(htlc.connect(bob).refund(lockId)).to.be.revertedWithCustomError(htlc, "NotSender");
    const tx = htlc.connect(alice).refund(lockId);
    await expect(tx).to.emit(htlc, "Refunded").withArgs(lockId);
    await expect(tx).to.changeEtherBalances([htlc, alice], [-amount, amount]);
    await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
    await expect(htlc.connect(bob).claim(lockId, hex32(secret))).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
  });

  it("refund after claim reverts", async () => {
    await htlc.connect(bob).claim(lockId, hex32(secret));
    await increaseTime(2 * HOUR + 1);
    await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
  });

  it("receiver that rejects ETH: claim reverts, funds stay, sender refunds later", async () => {
    const rejecter = await (await ethers.getContractFactory("RejectEther")).deploy();
    const rAddr = await rejecter.getAddress();
    const tl = (await now()) + HOUR;
    await htlc.connect(alice).newLock(lockAddr, tl, rAddr, { value: amount });
    const id = await htlc.computeLockId(alice.address, rAddr, amount, lockAddr, tl);
    await expect(htlc.connect(bob).claim(id, hex32(secret))).to.be.revertedWithCustomError(htlc, "TransferFailed");
    expect((await htlc.getLock(id)).claimed).to.equal(false);
    await increaseTime(HOUR + 1);
    await expect(htlc.connect(alice).refund(id)).to.changeEtherBalances([htlc, alice], [-amount, amount]);
  });

  after(() => {
    const eth = 3000;
    const usd = (g, gwei) => (g * gwei * 1e-9 * eth).toFixed(2);
    const line = (label, g) => console.log(`        ${label.padEnd(30)} ${g === undefined ? "NOT MEASURED (its test did not run)" : g + " gas"}`);
    console.log("\n      Poseidon2b gas report");
    line("addr() pure execution:", gas.addrPure);
    line("addr() as a tx (receipt):", gas.addrTx);
    line("addrStock() pure (4 perms):", gas.addrStockPure);
    line("HTLCPoseidon.claim (receipt):", gas.claim);
    if (gas.claim !== undefined) console.log(`        claim at 1 gwei / 20 gwei, ETH = ${eth} USD: ${usd(gas.claim, 1)} / ${usd(gas.claim, 20)} USD`);
    console.log(`        seed "${SEED}", JS expectations computed in ${PRECOMPUTE_MS} ms`);
    console.log(
      `        memory: EDR retained ~${Math.round(mem.perPerm)} MB per permutation call; chain recycled ${mem.recycles}x in chunks of ${mem.chunk}` +
        (gc ? "" : " (forced GC unavailable)")
    );
    console.log("");
  });
});
