"use strict";
/*
 * The floor on the price per gas that the deposit reserve is sized from (live.js `reserve`). When the ceiling is the node's own suggestion the reserve is at least
 * gas x 1 gwei, so a suggestion of a few wei per gas (public Sepolia) no longer makes it almost nothing; a large suggestion and a typed cap give the old value; a sweep and
 * a real send never read the floor. Hardhat's in-process chain; the node's fee suggestion is replaced by a thin wrapper. Nothing here touches a public network.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isolated = require("./helpers/isolated-home"); // before anything else: the per-user lock record must never touch the real home
const { live } = require("./helpers/live-module");

const GWEI = 10n ** 9n;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

describe("the reserve floor (live.js reserve)", function () {
  this.timeout(120000);

  let provider, carol, htlcAddr, tgt, dir;
  const amount = ethers.parseEther("0.3");

  const party = () => {
    const w = new ethers.Wallet(rand32(), provider);
    return { w, address: w.address };
  };

  /** The same provider, except that getFeeData answers with the given suggestion (maxFeePerGas, or gasPrice when maxFeePerGas is null). */
  const withSuggestion = (maxFeePerGas, gasPrice = null) =>
    new Proxy(provider, {
      get(target, prop) {
        if (prop === "getFeeData") return async () => ({ maxFeePerGas, maxPriorityFeePerGas: 1n, gasPrice });
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

  function swapFile({ role, hashlock, alice, bob, payout, lockKind }) {
    const own = role === "alice" ? alice : bob;
    const j = {
      version: 1,
      role,
      public: {
        hashlock,
        claim_authority: "o1test",
        params: { eth: { chain_id: 31337, contract: htlcAddr.toLowerCase(), code_hash: tgt.codeHash, amount_wei: amount.toString(), alice_receiver: alice.toLowerCase(), bob_sender: bob.toLowerCase() } },
      },
      phase: { role, phase: "created" },
      secret: { ciphertext: "not-read-by-live.js" },
      eth_key: { address: own.toLowerCase(), secret: { ciphertext: "not-read" }, payout: payout.toLowerCase() },
    };
    if (lockKind) j.public.params.eth.lock_kind = lockKind;
    const file = path.join(dir, `swap-${crypto.randomBytes(4).toString("hex")}.swap.json`);
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return file;
  }

  const mk = (role, lockKind) => {
    const alice = party();
    const bob = party();
    const file = swapFile({ role, hashlock: sha256Raw(rand32()), alice: alice.address, bob: bob.address, payout: party().address, lockKind });
    return { alice, bob, file };
  };

  beforeEach(async () => {
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    carol = await provider.getSigner(1);
    const d = await live.deploy(provider, carol, {});
    htlcAddr = d.contract;
    tgt = { chainId: "31337", codeHash: d.codeHash };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-reservefloor-"));
    isolated.clearRecords();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    isolated.clearRecords();
  });

  it("the floor is 1 gwei per gas", () => {
    expect(live.RESERVE_FLOOR_WEI).to.equal(GWEI);
  });

  it("a tiny suggestion (20 wei): Alice, poseidon: the reserve is the claim's 1,000,000 gas x the floor, 0.001 ETH", async () => {
    const { alice, file } = mk("alice", "poseidon");
    const r = await live.reserve(withSuggestion(20n), alice.w, { role: "alice", swap: file });
    expect(r.feeCeilingSource).to.equal("the node's fee suggestion");
    expect(r.feeCeilingWei).to.equal("20");
    expect(r.reserveWei).to.equal((1_000_000n * GWEI).toString());
    expect(r.reserveWei).to.equal(ethers.parseEther("0.001").toString());
    expect(r.reserveFloorApplied).to.equal(true);
    expect(r.requiredWei).to.equal(r.reserveWei);
  });

  it("a tiny suggestion (20 wei): Alice, sha256 and Bob (both kinds): gas budget x the floor, Bob's amount on top", async () => {
    const a = mk("alice");
    const ra = await live.reserve(withSuggestion(20n), a.alice.w, { role: "alice", swap: a.file });
    expect(ra.reserveWei).to.equal((200_000n * GWEI).toString());
    for (const [kind, gas] of [["sha256", 350_000n], ["poseidon", 900_000n]]) {
      const b = mk("bob", kind === "poseidon" ? "poseidon" : undefined);
      const rb = await live.reserve(withSuggestion(20n), b.bob.w, { role: "bob", swap: b.file });
      expect(rb.gasTotal).to.equal(gas.toString());
      expect(rb.reserveWei).to.equal((gas * GWEI).toString());
      expect(rb.requiredWei).to.equal((amount + gas * GWEI).toString());
    }
  });

  it("a tiny suggestion given as gasPrice only (no maxFeePerGas) gets the floor too", async () => {
    const { alice, file } = mk("alice");
    const r = await live.reserve(withSuggestion(null, 33n), alice.w, { role: "alice", swap: file });
    expect(r.feeCeilingWei).to.equal("33");
    expect(r.reserveWei).to.equal((200_000n * GWEI).toString());
  });

  it("a large suggestion (50 gwei): the reserve is today's value, gas x ceiling x 1.25, and the floor is not applied", async () => {
    const { alice, file } = mk("alice", "poseidon");
    const r = await live.reserve(withSuggestion(50n * GWEI), alice.w, { role: "alice", swap: file });
    expect(r.reserveWei).to.equal(((1_000_000n * 50n * GWEI * 125n) / 100n).toString());
    expect(r.reserveFloorApplied).to.equal(false);
    const b = mk("bob", "poseidon");
    const rb = await live.reserve(withSuggestion(50n * GWEI), b.bob.w, { role: "bob", swap: b.file });
    expect(rb.reserveWei).to.equal(((900_000n * 50n * GWEI * 125n) / 100n).toString());
  });

  it("a typed cap is reserved as typed, even below the floor (the floor is for the node's suggestion only)", async () => {
    const { alice, file } = mk("alice");
    const r = await live.reserve(withSuggestion(20n), alice.w, { role: "alice", swap: file, gasPriceGwei: "0.000000001" });
    expect(r.feeCeilingSource).to.equal("--gas-price-gwei");
    expect(r.reserveWei).to.equal("250000");
    expect(r.reserveFloorApplied).to.equal(false);
  });
});
