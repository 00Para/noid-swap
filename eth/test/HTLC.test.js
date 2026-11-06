const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");

const HOUR = 3600;

// ---- helpers --------------------------------------------------------------
const rand32 = () => "0x" + crypto.randomBytes(32).toString("hex");
// SHA-256 over the 32 raw bytes of the preimage (no prefix), via Node crypto.
const sha256Raw = (hex32) =>
  "0x" + crypto.createHash("sha256").update(Buffer.from(hex32.slice(2), "hex")).digest("hex");

const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const increaseTime = async (s) => {
  await ethers.provider.send("evm_increaseTime", [s]);
  await ethers.provider.send("evm_mine", []);
};
const setNextTimestamp = (t) => ethers.provider.send("evm_setNextBlockTimestamp", [t]);

describe("HTLC (ETH)", function () {
  const amount = ethers.parseEther("1");
  let htlc, alice, bob, carol;
  let preimage, hashlock, timelock, lockId;

  beforeEach(async () => {
    [alice, bob, carol] = await ethers.getSigners();
    htlc = await (await ethers.getContractFactory("HTLC")).deploy();
    preimage = rand32();
    hashlock = sha256Raw(preimage);
    timelock = (await now()) + 2 * HOUR;
    lockId = await htlc.connect(alice).newLock.staticCall(hashlock, timelock, bob.address, { value: amount });
    await htlc.connect(alice).newLock(hashlock, timelock, bob.address, { value: amount });
  });

  describe("encoding", () => {
    it("contract hashes 32 raw bytes with SHA-256 (known vector: 32 zero bytes)", async () => {
      const zero = "0x" + "00".repeat(32);
      const expected = "0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
      expect(sha256Raw(zero)).to.equal(expected);
      expect(ethers.sha256(zero)).to.equal(expected);
      const tl = (await now()) + HOUR;
      await htlc.connect(alice).newLock(expected, tl, bob.address, { value: 1n });
      const id = await htlc.computeLockId(alice.address, bob.address, 1n, expected, tl);
      await expect(htlc.connect(carol).claim(id, zero)).to.emit(htlc, "Claimed").withArgs(id, zero);
    });

    it("keccak256 of the preimage is NOT accepted as the hashlock", async () => {
      const bad = ethers.keccak256(preimage);
      const tl = (await now()) + HOUR;
      await htlc.connect(alice).newLock(bad, tl, bob.address, { value: 1n });
      const id = await htlc.computeLockId(alice.address, bob.address, 1n, bad, tl);
      await expect(htlc.claim(id, preimage)).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
    });
  });

  describe("newLock", () => {
    it("stores all fields and returns the deterministic lockId", async () => {
      expect(lockId).to.equal(await htlc.computeLockId(alice.address, bob.address, amount, hashlock, timelock));
      const l = await htlc.getLock(lockId);
      expect(l.sender).to.equal(alice.address);
      expect(l.receiver).to.equal(bob.address);
      expect(l.amount).to.equal(amount);
      expect(l.hashlock).to.equal(hashlock);
      expect(l.timelock).to.equal(timelock);
      expect(l.claimed).to.equal(false);
      expect(l.refunded).to.equal(false);
      expect(l.preimage).to.equal(ethers.ZeroHash);
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(amount);
    });

    it("emits Locked with correct args", async () => {
      const tl = timelock + 1;
      const id = await htlc.computeLockId(alice.address, bob.address, amount, hashlock, tl);
      await expect(htlc.connect(alice).newLock(hashlock, tl, bob.address, { value: amount }))
        .to.emit(htlc, "Locked")
        .withArgs(id, alice.address, bob.address, amount, hashlock, tl);
    });

    it("rejects zero amount", async () => {
      await expect(htlc.newLock(hashlock, timelock + 5, bob.address, { value: 0 })).to.be.revertedWithCustomError(
        htlc,
        "ZeroAmount"
      );
    });

    it("rejects timelock not strictly in the future", async () => {
      const t = await now();
      // next block will have timestamp >= t+1, so t (past) and t+1 would both fail; use a clearly-set next ts
      await setNextTimestamp(t + 10);
      await expect(htlc.newLock(hashlock, t + 10, bob.address, { value: 1 })).to.be.revertedWithCustomError(
        htlc,
        "TimelockNotInFuture"
      );
      await expect(htlc.newLock(hashlock, t - 100, bob.address, { value: 1 })).to.be.revertedWithCustomError(
        htlc,
        "TimelockNotInFuture"
      );
      await expect(htlc.newLock(hashlock, 0, bob.address, { value: 1 })).to.be.revertedWithCustomError(
        htlc,
        "TimelockNotInFuture"
      );
    });

    it("rejects zero receiver", async () => {
      await expect(
        htlc.newLock(hashlock, timelock + 5, ethers.ZeroAddress, { value: 1 })
      ).to.be.revertedWithCustomError(htlc, "ZeroReceiver");
    });

    it("rejects a duplicate lock id", async () => {
      await expect(
        htlc.connect(alice).newLock(hashlock, timelock, bob.address, { value: amount })
      ).to.be.revertedWithCustomError(htlc, "LockAlreadyExists");
      // the first lock is untouched
      expect((await htlc.getLock(lockId)).amount).to.equal(amount);
    });

    it("allows distinct locks (different timelock / sender)", async () => {
      await htlc.connect(alice).newLock(hashlock, timelock + 1, bob.address, { value: amount });
      await htlc.connect(carol).newLock(hashlock, timelock, bob.address, { value: amount });
    });

    it("getLock reverts for an unknown id", async () => {
      await expect(htlc.getLock(rand32())).to.be.revertedWithCustomError(htlc, "LockNotFound");
    });
  });

  describe("claim", () => {
    it("happy path: pays receiver, stores preimage, emits Claimed", async () => {
      const before = await ethers.provider.getBalance(bob.address);
      await expect(htlc.connect(carol).claim(lockId, preimage)) // third party submits; bob is paid
        .to.emit(htlc, "Claimed")
        .withArgs(lockId, preimage);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(before + amount);
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(0n);
      const l = await htlc.getLock(lockId);
      expect(l.claimed).to.equal(true);
      expect(l.refunded).to.equal(false);
      expect(l.preimage).to.equal(preimage);
    });

    it("receiver can claim for themselves and net balance changes accordingly", async () => {
      await expect(htlc.connect(bob).claim(lockId, preimage)).to.changeEtherBalances([htlc, bob], [-amount, amount]);
    });

    it("preimage is readable from the Claimed event log by an off-chain watcher", async () => {
      const tx = await htlc.connect(bob).claim(lockId, preimage);
      await tx.wait();
      const logs = await htlc.queryFilter(htlc.filters.Claimed(lockId));
      expect(logs.length).to.equal(1);
      const revealed = logs[0].args.preimage;
      expect(revealed).to.equal(preimage);
      // and it hashes to the original hashlock, exactly as the other chain would verify
      expect(sha256Raw(revealed)).to.equal(hashlock);
    });

    it("wrong preimage reverts", async () => {
      await expect(htlc.connect(bob).claim(lockId, rand32())).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
      expect((await htlc.getLock(lockId)).claimed).to.equal(false);
    });

    it("unknown lock id reverts", async () => {
      await expect(htlc.claim(rand32(), preimage)).to.be.revertedWithCustomError(htlc, "LockNotFound");
    });

    it("claim after timelock reverts (even with the right preimage)", async () => {
      await increaseTime(2 * HOUR + 1);
      await expect(htlc.connect(bob).claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "TimelockExpired");
    });

    it("boundary: claim succeeds at timelock-1, fails at timelock", async () => {
      await setNextTimestamp(timelock - 1);
      await htlc.connect(bob).claim(lockId, preimage); // ok

      // second lock to test exactly-at-timelock
      const tl = (await now()) + HOUR;
      const h2 = sha256Raw(preimage);
      await htlc.connect(alice).newLock(h2, tl, bob.address, { value: 5n });
      const id2 = await htlc.computeLockId(alice.address, bob.address, 5n, h2, tl);
      await setNextTimestamp(tl);
      await expect(htlc.connect(bob).claim(id2, preimage)).to.be.revertedWithCustomError(htlc, "TimelockExpired");
    });

    it("double claim reverts", async () => {
      await htlc.connect(bob).claim(lockId, preimage);
      await expect(htlc.connect(bob).claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
    });

    it("claim after refund reverts", async () => {
      await increaseTime(2 * HOUR); // refund window; claim also dead by now
      await htlc.connect(alice).refund(lockId);
      await expect(htlc.connect(bob).claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
    });
  });

  describe("refund", () => {
    it("before timelock reverts", async () => {
      await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
      await increaseTime(HOUR); // still before 2h
      await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
    });

    it("by non-sender reverts (even after timelock)", async () => {
      await increaseTime(2 * HOUR + 1);
      await expect(htlc.connect(bob).refund(lockId)).to.be.revertedWithCustomError(htlc, "NotSender");
      await expect(htlc.connect(carol).refund(lockId)).to.be.revertedWithCustomError(htlc, "NotSender");
    });

    it("after timelock succeeds: returns funds, emits Refunded, marks refunded", async () => {
      await increaseTime(2 * HOUR + 1);
      const tx = htlc.connect(alice).refund(lockId);
      await expect(tx).to.emit(htlc, "Refunded").withArgs(lockId);
      await expect(tx).to.changeEtherBalances([htlc, alice], [-amount, amount]);
      const l = await htlc.getLock(lockId);
      expect(l.refunded).to.equal(true);
      expect(l.claimed).to.equal(false);
      expect(l.preimage).to.equal(ethers.ZeroHash);
    });

    it("boundary: refund works at exactly timelock", async () => {
      await setNextTimestamp(timelock);
      await htlc.connect(alice).refund(lockId);
    });

    it("after claim reverts", async () => {
      await htlc.connect(bob).claim(lockId, preimage);
      await increaseTime(2 * HOUR + 1);
      await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
    });

    it("double refund reverts", async () => {
      await increaseTime(2 * HOUR + 1);
      await htlc.connect(alice).refund(lockId);
      await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
    });

    it("unknown lock id reverts", async () => {
      await expect(htlc.refund(rand32())).to.be.revertedWithCustomError(htlc, "LockNotFound");
    });
  });

  describe("hazard: receiver contract that rejects ETH", () => {
    // DOCUMENTED HAZARD: if `receiver` cannot accept ETH, claim() reverts with
    // TransferFailed and the funds stay locked until the sender refunds after
    // the timelock. The swap cannot complete on this lock.
    it("claim reverts, funds stay locked, sender can refund after timelock", async () => {
      const rejecter = await (await ethers.getContractFactory("RejectEther")).deploy();
      const rAddr = await rejecter.getAddress();
      const tl = (await now()) + HOUR;
      await htlc.connect(alice).newLock(hashlock, tl, rAddr, { value: amount });
      const id = await htlc.computeLockId(alice.address, rAddr, amount, hashlock, tl);
      const htlcAddr = await htlc.getAddress();
      const held = await ethers.provider.getBalance(htlcAddr);

      await expect(htlc.connect(bob).claim(id, preimage)).to.be.revertedWithCustomError(htlc, "TransferFailed");

      // state fully rolled back: not claimed, preimage not stored, funds still in the contract
      const l = await htlc.getLock(id);
      expect(l.claimed).to.equal(false);
      expect(l.preimage).to.equal(ethers.ZeroHash);
      expect(await ethers.provider.getBalance(htlcAddr)).to.equal(held);
      expect(await ethers.provider.getBalance(rAddr)).to.equal(0n);
      // and no Claimed event was emitted (reverted)
      expect((await htlc.queryFilter(htlc.filters.Claimed(id))).length).to.equal(0);

      // funds are recoverable by the sender once the lock expires
      await increaseTime(HOUR + 1);
      await expect(htlc.connect(alice).refund(id)).to.changeEtherBalances([htlc, alice], [-amount, amount]);
    });
  });

  describe("reentrancy", () => {
    it("receiver re-entering claim() cannot double-spend", async () => {
      const atk = await (await ethers.getContractFactory("Attacker")).deploy();
      const aAddr = await atk.getAddress();
      const tl = (await now()) + HOUR;
      await htlc.connect(alice).newLock(hashlock, tl, aAddr, { value: amount });
      const id = await htlc.computeLockId(alice.address, aAddr, amount, hashlock, tl);
      await atk.arm(await htlc.getAddress(), id, preimage, false);
      await htlc.connect(bob).claim(id, preimage);
      expect(await atk.attempted()).to.equal(true);
      expect(await atk.reentrySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(aAddr)).to.equal(amount); // paid exactly once
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(amount); // original lock from beforeEach intact
    });

    it("sender re-entering refund() cannot double-spend", async () => {
      const atk = await (await ethers.getContractFactory("Attacker")).deploy();
      const aAddr = await atk.getAddress();
      const tl = (await now()) + HOUR;
      const id = await htlc.computeLockId(aAddr, bob.address, amount, hashlock, tl);
      await atk.lock(await htlc.getAddress(), hashlock, tl, bob.address, { value: amount });
      await atk.arm(await htlc.getAddress(), id, preimage, true);
      await increaseTime(HOUR + 1);
      await atk.doRefund(await htlc.getAddress(), id);
      expect(await atk.attempted()).to.equal(true);
      expect(await atk.reentrySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(aAddr)).to.equal(amount);
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(amount); // beforeEach lock intact
    });
  });
});

describe("HTLCERC20", function () {
  const amount = 1000n;
  let htlc, token, alice, bob, carol, preimage, hashlock, timelock, lockId;

  beforeEach(async () => {
    [alice, bob, carol] = await ethers.getSigners();
    htlc = await (await ethers.getContractFactory("HTLCERC20")).deploy();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    await token.mint(alice.address, 10_000n);
    await token.connect(alice).approve(await htlc.getAddress(), 10_000n);
    preimage = rand32();
    hashlock = sha256Raw(preimage);
    timelock = (await now()) + 2 * HOUR;
    lockId = await htlc.computeLockId(alice.address, bob.address, await token.getAddress(), amount, hashlock, timelock);
  });

  it("lock -> claim happy path with preimage in event", async () => {
    await expect(htlc.connect(alice).newLock(hashlock, timelock, bob.address, await token.getAddress(), amount))
      .to.emit(htlc, "Locked")
      .withArgs(lockId, alice.address, bob.address, await token.getAddress(), amount, hashlock, timelock);
    expect(await token.balanceOf(await htlc.getAddress())).to.equal(amount);
    await expect(htlc.connect(carol).claim(lockId, preimage)).to.emit(htlc, "Claimed").withArgs(lockId, preimage);
    expect(await token.balanceOf(bob.address)).to.equal(amount);
    expect((await htlc.getLock(lockId)).preimage).to.equal(preimage);
    await expect(htlc.claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "AlreadyClaimed");
  });

  it("wrong preimage and late claim revert; refund rules enforced", async () => {
    await htlc.connect(alice).newLock(hashlock, timelock, bob.address, await token.getAddress(), amount);
    await expect(htlc.claim(lockId, rand32())).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
    await expect(htlc.connect(alice).refund(lockId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
    await increaseTime(2 * HOUR + 1);
    await expect(htlc.claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "TimelockExpired");
    await expect(htlc.connect(bob).refund(lockId)).to.be.revertedWithCustomError(htlc, "NotSender");
    await expect(htlc.connect(alice).refund(lockId)).to.emit(htlc, "Refunded").withArgs(lockId);
    expect(await token.balanceOf(alice.address)).to.equal(10_000n);
    await expect(htlc.claim(lockId, preimage)).to.be.revertedWithCustomError(htlc, "AlreadyRefunded");
  });

  it("rejects duplicates, zero amount, past timelock", async () => {
    const t = await token.getAddress();
    await htlc.connect(alice).newLock(hashlock, timelock, bob.address, t, amount);
    await expect(htlc.connect(alice).newLock(hashlock, timelock, bob.address, t, amount)).to.be.revertedWithCustomError(
      htlc,
      "LockAlreadyExists"
    );
    await expect(htlc.connect(alice).newLock(hashlock, timelock, bob.address, t, 0)).to.be.revertedWithCustomError(
      htlc,
      "ZeroAmount"
    );
    await expect(htlc.connect(alice).newLock(hashlock, 1, bob.address, t, amount)).to.be.revertedWithCustomError(
      htlc,
      "TimelockNotInFuture"
    );
  });

  it("rejects fee-on-transfer tokens", async () => {
    const fee = await (await ethers.getContractFactory("FeeToken")).deploy();
    await fee.mint(alice.address, 10_000n);
    await fee.connect(alice).approve(await htlc.getAddress(), 10_000n);
    await expect(
      htlc.connect(alice).newLock(hashlock, timelock, bob.address, await fee.getAddress(), amount)
    ).to.be.revertedWithCustomError(htlc, "UnsupportedToken");
  });
});
