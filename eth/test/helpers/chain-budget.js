"use strict";
/*
 * Memory budget for tests that make many Poseidon-sized EVM calls.
 *
 * Hardhat's EDR runtime keeps the per-opcode trace of every EVM call (eth_call and transactions)
 * in native memory, about 30-45 MB per 0.43 M-gas Poseidon permutation, and releases it only when
 * the provider is recreated. `hardhat_reset` plus a forced GC does that. This helper measures the
 * retention once per process, sizes a chunk from the free RAM, and recycles the chain between
 * chunks. If fewer than `minChunk` permutation-sized calls fit between two recycles it FAILS with a
 * message (never skips, never shrinks the test). Nothing that is computed changes.
 *
 * Usage:
 *   const b = createChainBudget(ethers, { probe: async (n) => { ...n permutation-sized calls... }, onRecycle: () => { H = null; } });
 *   await b.budget(k);   // before k permutation-sized calls; may recycle the chain (then onRecycle ran)
 */
const os = require("os");
const v8 = require("v8");
const vm = require("vm");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeGc() {
  try {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
  } catch (e) {
    return null;
  }
}

function createChainBudget(ethers, opts) {
  const { probe, onRecycle = () => {}, marginMB = 250, minChunk = 6, maxChunk = 24, what = "Poseidon2b tests" } = opts;
  const gc = makeGc();
  const mem = { perPerm: 0, chunk: 0, used: 0, recycles: 0 };

  async function recycle() {
    await ethers.provider.send("hardhat_reset", []);
    onRecycle();
    mem.used = 0;
    mem.recycles++;
    if (gc) {
      gc();
      await sleep(50);
      gc();
    }
  }

  async function calibrate() {
    if (mem.chunk) return;
    await probe(1); // warm-up: EDR lazy initialisation is not representative
    const before = process.memoryUsage().rss;
    await probe(2);
    mem.perPerm = Math.max(5, (process.memoryUsage().rss - before) / 2 / 1e6);
    mem.used = 3;
    const freeMB = os.freemem() / 1e6;
    mem.chunk = Math.min(maxChunk, Math.floor((freeMB - marginMB) / mem.perPerm));
    if (mem.chunk < minChunk) {
      mem.chunk = 0; // make the next call fail again with the same message
      throw new Error(
        `${what} cannot run on this machine: EDR retains ~${Math.round(mem.perPerm)} MB per Poseidon call, ` +
          `${Math.round(freeMB)} MB are free and ${marginMB} MB must stay free, so fewer than ${minChunk} calls fit ` +
          `between two chain recycles. Close other programs (the wallet node, WSL) and run again. ` +
          `This is a FAILURE, not a skip: the Solidity has not been checked.`
      );
    }
  }

  /** Make room for `perms` permutation-sized calls (recycles the chain if the chunk is used up). */
  async function budget(perms) {
    if (!mem.chunk) await calibrate();
    if (perms > mem.chunk) throw new Error(`a single step needs ${perms} permutation-sized calls but a chunk holds only ${mem.chunk}`);
    if (mem.used + perms > mem.chunk) await recycle();
    mem.used += perms;
  }

  /** Recycle (if needed) so that `perms` more calls fit, without counting them. */
  async function ensure(perms) {
    if (!mem.chunk) await calibrate();
    if (mem.used + perms > mem.chunk) await recycle();
  }

  /** Count `perms` permutation-sized calls that were made without a prior budget() (they cannot be recycled mid-way). */
  function note(perms) {
    mem.used += perms;
  }

  return { budget, ensure, note, recycle, calibrate, mem, hasGc: !!gc };
}

module.exports = { createChainBudget, sleep };
