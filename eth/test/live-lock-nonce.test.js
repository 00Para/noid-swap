"use strict";
/*
 * Two copies of one swap file running the real `live.lock` against a local Hardhat chain:
 * Copy A sends the real lock at nonce 0. Copy B (with a log-blind provider returning no
 * Locked logs and no lock-sent record on disk) attempts a second real lock with the same
 * fresh per-swap Ethereum key and is refused by the latest-nonce check in eth/scripts/live.js.
 * Removing that refusal in live.js makes this test fail.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isolated = require("./helpers/isolated-home");
const { live } = require("./helpers/live-module");

const HOUR = 3600;
const GWEI = 10n ** 9n;
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const sha256Raw = (hex32) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

describe("two copies running real live.lock on Hardhat (fresh swap key nonce check)", function () {
  this.timeout(120000);

  let provider, funder, htlcAddr, codeHash, tmpRoot;
  const amount = ethers.parseEther("0.2");

  before(async function () {
    provider = hre.ethers.provider;
    [funder] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("HTLC");
    const htlc = await Factory.deploy();
    await htlc.waitForDeployment();
    htlcAddr = await htlc.getAddress();
    codeHash = live.artifactCodeHash("sha256");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-two-copy-lock-"));
  });

  after(function () {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeBobSwapFile(dir, { bobAddr, aliceAddr, payoutAddr, hashlock, tReveal, decidedAt }) {
    const file = path.join(dir, "bob.swap.json");
    const j = {
      version: 1,
      role: "bob",
      phase: { role: "bob", phase: "funding_final" },
      public: {
        hashlock,
        claim_authority: "o1test",
        params: {
          profile: "rehearsal",
          eth: {
            chain_id: 31337,
            contract: htlcAddr.toLowerCase(),
            code_hash: codeHash,
            lock_kind: "sha256",
            amount_wei: amount.toString(),
            alice_receiver: aliceAddr.toLowerCase(),
            bob_sender: bobAddr.toLowerCase(),
          },
        },
      },
      pending_intent: {
        action: "lock_eth",
        decided_at: decidedAt,
        phase_at_decision: "funding_final",
        noid_tip: 100,
        eth_block: 1,
        params: {
          action: "lock_eth",
          hashlock,
          receiver: aliceAddr.toLowerCase(),
          amount_wei: amount.toString(),
          t_reveal: tReveal,
        },
      },
      eth_key: {
        address: bobAddr.toLowerCase(),
        payout: payoutAddr.toLowerCase(),
        secret: { ciphertext: "not-read-by-live.js" },
      },
      history: [],
    };
    fs.writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 });
    return file;
  }

  it("refuses Copy B's real lock on a log-blind provider after Copy A mined lock #1 at nonce 0", async function () {
    const bobKey = rand32();
    const bobWallet = new ethers.Wallet(bobKey, provider);
    const aliceAddr = new ethers.Wallet(rand32()).address;
    const payoutAddr = new ethers.Wallet(rand32()).address;
    const secret = rand32();
    const hashlock = sha256Raw(secret);

    // Fund Bob with MORE than 2x the lock amount + gas, so balance alone would allow a double lock.
    await (await funder.sendTransaction({ to: bobWallet.address, value: amount * 3n })).wait();

    const latestBlk = await provider.getBlock("latest");
    const tRevealA = latestBlk.timestamp + HOUR;
    // Copy B ran its own tick slightly later and therefore chose a different T_reveal, producing a
    // distinct lockId so getLock(lockId_B) is empty (only log scan or latestNonce !== 0 can stop it).
    const tRevealB = tRevealA + 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const decidedAt = nowSec - 5;

    const dirA = path.join(tmpRoot, "copy-a");
    const dirB = path.join(tmpRoot, "copy-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const swapA = writeBobSwapFile(dirA, { bobAddr: bobWallet.address, aliceAddr, payoutAddr, hashlock, tReveal: tRevealA, decidedAt });
    const swapB = writeBobSwapFile(dirB, { bobAddr: bobWallet.address, aliceAddr, payoutAddr, hashlock, tReveal: tRevealB, decidedAt });

    const approvalFor = (tReveal) =>
      live.approvalTermsHash({
        chainId: 31337,
        contract: htlcAddr,
        lockKind: "sha256",
        codeHash,
        bobSender: bobWallet.address,
        receiver: aliceAddr,
        amountWei: amount,
        lockWord: hashlock,
        tReveal,
        decidedAt,
      });

    const argsFor = (swap, tReveal) => ({
      swap,
      keyStdin: true,
      chainId: "31337",
      contract: htlcAddr,
      codeHash,
      gasPriceGwei: "20",
      approvedIntent: String(decidedAt),
      approvedTerms: approvalFor(tReveal),
      approvedAt: String(nowSec),
    });

    // Copy A sends the real lock against the real Hardhat chain: succeeds at nonce 0.
    const resA = await live.lock(provider, bobWallet, argsFor(swapA, tRevealA));
    expect(resA.txHash).to.match(/^0x[0-9a-f]{64}$/i);
    expect(await provider.getTransactionCount(bobWallet.address, "latest")).to.equal(1);
    const balAfterA = await provider.getBalance(htlcAddr);

    // Remove the per-user lock record in the isolated home so Copy B looks like a second computer
    // that has no local lock record of Copy A's lock.
    const lockSentDir = path.join(isolated.home, ".noid-swap", "lock-sent");
    if (fs.existsSync(lockSentDir)) fs.rmSync(lockSentDir, { recursive: true, force: true });

    // Wrap the real Hardhat provider so getLogs ALWAYS returns [] (a log-blind / pruned node),
    // while getTransactionCount still returns the real on-chain nonce (1).
    const blindLogProvider = new Proxy(provider, {
      get(target, prop) {
        if (prop === "getLogs") return async () => [];
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const bobBlindSigner = new ethers.Wallet(bobKey, blindLogProvider);

    // Copy B runs real live.lock on the log-blind provider with its distinct tRevealB/lockId:
    // MUST be refused by the latest-nonce != 0 check in eth/scripts/live.js.
    let err = null;
    try {
      await live.lock(blindLogProvider, bobBlindSigner, argsFor(swapB, tRevealB));
    } catch (e) {
      err = e;
    }
    expect(err, "Copy B must be refused when fresh swap key already has latest nonce 1").to.be.an("error");
    expect(err.message).to.match(/latest nonce 1|already sent/i);

    // Confirm no second lock was sent on chain.
    expect(await provider.getTransactionCount(bobWallet.address, "latest")).to.equal(1);
    expect(await provider.getBalance(htlcAddr)).to.equal(balAfterA);
  });
});
