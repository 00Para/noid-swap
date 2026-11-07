#!/usr/bin/env node
/*
 * Live-run tooling for the Ethereum side of a NOID <-> ETH swap (HTLC.sol).
 *
 *   node scripts/live.js <command> [flags]        (run from eth/)
 *
 * Commands: keygen, balance, deploy, lock, claim, refund, send, status.
 * See "Live runs (Sepolia)" in eth/README.md for the full sequence.
 *
 * Environment:  ETH_RPC_URL  JSON-RPC endpoint (default http://127.0.0.1:8545)
 *
 * This file is also a module: every command is an exported async function
 * taking (provider, signerOrNull, args) so tests can drive it over Hardhat's
 * in-process network. args use camelCase keys; the signer is built by the CLI
 * wrapper from --key-file, not by these functions.
 *
 * Encoding (same as HTLC.sol / secret.js): the preimage is exactly 32 raw
 * bytes, hashlock = SHA-256 over those 32 bytes, both 0x-prefixed hex.
 *
 * A private key is only ever read from a key file and is never printed.
 * The swap secret is never accepted on the command line: `claim` reads it from
 * stdin (--secret-stdin) or a file (--secret-file) and never prints it.
 * (In-process callers may pass it as args.secret; the CLI cannot.)
 *
 * Gates re-applied here (REVIEW-2 F1/F3/F4/F7). Each one is a refusal, and each
 * one also applies in --dry-run:
 *   lock, claim, refund  --chain-id N is required and must equal eth_chainId. The contract's code must be the code of
 *                        THIS repo's build (REVIEW-3 F1): keccak256(eth_getCode(contract)) must equal
 *                        keccak256(deployedBytecode) of the local artifact (eth/artifacts, `npx hardhat compile`).
 *                        --code-hash 0x.. is optional; when given it must equal the artifact's hash (a hash typed or
 *                        pasted from the counterparty, or from any deploy output, never replaces the artifact's).
 *   claim                now <= timelock - --margin-s (default 1800 s, M_A), and the
 *                        Locked event's block <= the `finalized` block.
 *   lock                 no Locked event with the same hashlock from THIS sender exists in the
 *                        contract's logs, and the lockId itself is unused. Locks by other senders
 *                        under the same hashlock do not block; they are reported (and noted on stderr).
 *   refund               the lock is present, unclaimed, unrefunded, and its timelock passed.
 *
 * Mainnet (chain id 1) is refused unless the signing command (deploy, send, lock, claim, refund) is given --mainnet.
 * With --mainnet: only chain 1 is accepted (a test network is refused, no mixing; --allow-chain-id is refused),
 * --max-fee-gwei N is required (it is the maxFeePerGas of the transaction; --gas-price-gwei is refused), the dry run
 * prints the worst-case fee (gas estimate x cap) and the sender's balance, and the command refuses when the balance
 * cannot cover value + worst-case fee (a real send checks it too). Without --mainnet, --max-fee-gwei is refused.
 * With --swap, the file must say chain_id 1 and the production profile (a file with no `profile` field is production).
 * The command line prints one warning line on stderr when --mainnet is in effect.
 * Under --mainnet, lock, claim and refund REQUIRE --swap FILE (refused without it; there is no warn-and-continue path).
 *
 * Fee safety (REVIEW-4 R4-1). Wherever a fee cap is chosen (--max-fee-gwei on mainnet, --gas-price-gwei elsewhere) the latest
 * block's base fee is read before signing, also in --dry-run: a claim (it publishes the secret) is refused when cap < 2 x base
 * fee, lock and refund when cap < base fee; the output carries `feeCheck` (base fee, cap, ratio, minimum). `claim --replace` and
 * `refund --replace` re-send the same call at the signer's oldest pending nonce (never a second nonce) with both fee fields
 * raised by at least 12.5 % and the cap at least 2 x the base fee; refused when nothing is pending, when the pending transaction
 * is not this call (found by --replace-tx HASH or in the node's pending block), or when the lock is claimed / refunded.
 * On the command line the hash of a sent transaction is printed on stderr before the wait.
 *
 * Keys (REVIEW-4 R4-5): with --swap, claim needs the key of the file's alice_receiver, refund and lock that of bob_sender.
 * Late re-send (REVIEW-4 R4-3): with --swap, when the file's history shows the secret may already be public (reveal_submitted,
 * eth_claim_mined, eth_claim_reorged, eth_reveal_dropped), claim takes the cutoff the intent froze (T_reveal - DE) instead of the
 * stricter timelock - 1800 s; an explicit --margin-s still tightens it.
 *
 * Tied to the swap file (REVIEW-3 F3): lock, claim and refund take --swap FILE, the JSON swap file of
 * `swap-cli` (read-only; the sealed secret in it is never touched). The terms (--chain-id, --contract,
 * and for lock --hashlock, --receiver, --amount-wei, --t-reveal; for claim and refund --lock-id)
 * may then be omitted and are taken from the file; when given they must equal the file's. The file's `code_hash`
 * must equal the local artifact's hash too (REVIEW-3 F1; a file pinning another contract is refused). The file's
 * `pending_intent` must be the matching action (lock_eth, reveal_eth, refund_eth) that `swap-cli tick --apply`
 * recorded; a claim's lock must match the file's receiver, sender, amount and hashlock, and its reveal cutoff is
 * the earlier of `timelock - --margin-s` and the cutoff the intent froze (the file's M_A). --from-block may be omitted
 * and is then the file's `eth_from_block` (REVIEW-3 F7; stored by `swap-cli tick --apply --eth-from-block N`); a given
 * --from-block wins. Without --swap the
 * command line warns once on stderr and behaves as before (the in-process functions do not print).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ARTIFACT_PATH = path.join(__dirname, "..", "artifacts", "contracts", "HTLC.sol", "HTLC.json");
// Chains on which this tool will send transactions: Sepolia, Holesky, Hardhat/ganache-style local.
// Ethereum mainnet (1) is refused unless the command carries --mainnet (see mainnetFlags); it is never in this set.
// Another chain needs an explicit allowChainId.
const ALLOWED_CHAIN_IDS = new Set([11155111n, 17000n, 31337n, 1337n]);
const MAINNET_WARNING = "warning: --mainnet is in effect: this command can spend real ETH on Ethereum mainnet (chainId 1)\n";
const GWEI = 10n ** 9n;
const LOG_RANGE_MAX = 50000; // blocks per eth_getLogs request: the cap of public Sepolia RPCs
const DEFAULT_MARGIN_S = 1800; // M_A, docs/protocol-design.md section 4.3
// REVIEW-4 R4-3: swap-cli history events that show Alice's secret may already be public (engine.rs `secret_may_be_public`).
const SECRET_PUBLIC_EVENTS = new Set(["reveal_submitted", "eth_claim_mined", "eth_claim_reorged", "eth_reveal_dropped"]);
// REVIEW-4 R4-1: a same-nonce replacement must raise both fee fields by at least 12.5 % (geth requires 10 %).
const bumped = (v) => (v * 1125n + 999n) / 1000n;

class UserError extends Error {}

const NO_SWAP_WARNING = "warning: no --swap FILE, the swap file's intent is not checked (REVIEW-3 F3)\n";

// ---------------------------------------------------------------- helpers
function loadArtifact() {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new UserError(`HTLC artifact not found at ${ARTIFACT_PATH}; run "npx hardhat compile" in eth/ first`);
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
}
const htlcInterface = () => new ethers.Interface(loadArtifact().abi);
/** REVIEW-3 F1: keccak256 of the local artifact's runtime code: the one code hash this tool accepts for the HTLC. */
function artifactCodeHash() {
  return ethers.keccak256(loadArtifact().deployedBytecode);
}

function need(args, key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === "") {
    throw new UserError(`missing required --${flag || key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
  }
  return args[key];
}
function hex32(name, v) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new UserError(`${name} must be 0x followed by exactly 64 hex chars (32 bytes)`);
  }
  return v.toLowerCase();
}
function address(name, v) {
  try {
    return ethers.getAddress(v);
  } catch {
    throw new UserError(`${name} is not a valid Ethereum address (or has a bad checksum): ${v}`);
  }
}
function uint(name, v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new UserError(`${name} must be a non-negative decimal integer`);
  return BigInt(v);
}
function confirmationsOf(args) {
  const n = args.confirmations === undefined ? 1 : Number(args.confirmations);
  if (!Number.isInteger(n) || n < 1) throw new UserError("--confirmations must be an integer >= 1");
  return n;
}
function marginOf(args) {
  if (args.marginS === undefined) return BigInt(DEFAULT_MARGIN_S);
  return uint("--margin-s", args.marginS);
}
/**
 * --mainnet / --max-fee-gwei, validated before anything touches the network. Returns { mainnet, capWei }.
 * Without --mainnet: --max-fee-gwei is refused (capWei null). With it: --max-fee-gwei is required, --allow-chain-id
 * and --gas-price-gwei are refused (the cap is the only fee setting; a test network is never mixed in).
 */
function mainnetFlags(args) {
  if (args.mainnet !== undefined && args.mainnet !== true && args.mainnet !== false) throw new UserError("--mainnet is a flag without a value");
  if (args.mainnet !== true) {
    if (args.maxFeeGwei !== undefined) throw new UserError("--max-fee-gwei is only accepted together with --mainnet (a test network does not take a fee cap); refusing");
    return { mainnet: false, capWei: null };
  }
  if (args.allowChainId !== undefined) throw new UserError("--mainnet cannot be combined with --allow-chain-id (mainnet and other chains are never mixed); refusing");
  if (args.gasPriceGwei !== undefined) throw new UserError("--mainnet cannot be combined with --gas-price-gwei; --max-fee-gwei is the only fee setting on mainnet; refusing");
  const s = String(need(args, "maxFeeGwei", "max-fee-gwei"));
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new UserError("--max-fee-gwei must be a positive decimal number of gwei (at most 9 decimals)");
  const capWei = ethers.parseUnits(s, "gwei");
  if (capWei === 0n) throw new UserError("--max-fee-gwei must be > 0");
  return { mainnet: true, capWei };
}

/** Under --mainnet, lock / claim / refund must be tied to a swap file; there is no fallback to bare flags. */
function requireSwapOnMainnet(args) {
  if (args.mainnet === true && (args.swap === undefined || args.swap === null || args.swap === "")) {
    throw new UserError("--mainnet requires --swap FILE for lock, claim and refund (the file's chain, profile and pending intent are checked); refusing");
  }
}

function feeOverrides(args) {
  const { mainnet, capWei } = mainnetFlags(args);
  // On mainnet the cap is the maxFeePerGas; the tip is at most 1 gwei and never above the cap.
  if (mainnet) return { maxFeePerGas: capWei, maxPriorityFeePerGas: capWei < GWEI ? capWei : GWEI };
  if (args.gasPriceGwei === undefined) return {};
  const s = String(args.gasPriceGwei);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new UserError("--gas-price-gwei must be a positive decimal number");
  const max = ethers.parseUnits(s, "gwei");
  if (max === 0n) throw new UserError("--gas-price-gwei must be > 0");
  // EIP-1559 fields: the override is the max fee; the tip is capped at 1 gwei.
  return { maxFeePerGas: max, maxPriorityFeePerGas: max < GWEI ? max : GWEI };
}

/**
 * REVIEW-4 R4-1: refuse a fee cap that the next few blocks can outrun. `mult` is 2 for a claim (it publishes the secret, so it
 * must not get stuck) and for a replacement, 1 for lock / refund. Applies in --dry-run too. Returns the report that is
 * printed ({ baseFeeGwei, maxFeeGwei, ratio, minRatio }), or null when no cap was chosen (the node then prices the
 * transaction itself at 2 x base fee + tip) or the chain has no base fee and is not mainnet.
 */
async function checkFeeCap(provider, fees, mult, mainnet, why) {
  const cap = fees.maxFeePerGas;
  if (cap === undefined) return null;
  const blk = await latestBlock(provider);
  const base = blk.baseFeePerGas;
  if (base === null || base === undefined) {
    if (mainnet) throw new UserError("refusing: the latest block carries no baseFeePerGas, so the fee cap cannot be checked against it");
    return null;
  }
  const report = {
    block: blk.number,
    baseFeeWei: base.toString(),
    baseFeeGwei: ethers.formatUnits(base, "gwei"),
    maxFeeWei: cap.toString(),
    maxFeeGwei: ethers.formatUnits(cap, "gwei"),
    ratio: base === 0n ? "n/a (base fee 0)" : (Number((cap * 100n) / base) / 100).toFixed(2),
    minRatio: mult.toString(),
  };
  if (cap < mult * base) {
    throw new UserError(
      `refusing: the fee cap ${report.maxFeeGwei} gwei is below ${mult} x the latest base fee (base fee ${report.baseFeeGwei} gwei in block ${blk.number}; ` +
        `cap / base fee = ${report.ratio}, the minimum is ${mult}): ${why}. Give a higher --max-fee-gwei (mainnet) or --gas-price-gwei`
    );
  }
  return report;
}
const FEE_WHY = {
  claim: "a claim publishes the secret, so it must not get stuck when the base fee rises (R4-1)",
  other: "the transaction could not be included once the base fee has risen (R4-1)",
};

/** The pending transaction of `from` at `nonce`, if it can be found: by hash (--replace-tx), else in the node's pending block. Or null. */
async function findPendingTx(provider, args, from, nonce) {
  let t = null;
  if (args.replaceTx !== undefined) {
    const hash = hex32("--replace-tx", args.replaceTx);
    const tx = await provider.getTransaction(hash);
    if (!tx) throw new UserError(`--replace-tx ${hash} is not known to this node; refusing`);
    if (tx.blockNumber !== null && tx.blockNumber !== undefined) throw new UserError(`--replace-tx ${hash} is already mined (block ${tx.blockNumber}); nothing to replace; refusing`);
    if (!sameAddr(tx.from, from) || BigInt(tx.nonce) !== BigInt(nonce)) {
      throw new UserError(`--replace-tx ${hash} is from ${tx.from} nonce ${tx.nonce}, not this signer ${from} at its oldest pending nonce ${nonce}; refusing`);
    }
    t = tx;
  } else {
    try {
      const pb = await provider.send("eth_getBlockByNumber", ["pending", true]);
      const hit = pb && Array.isArray(pb.transactions) ? pb.transactions.find((x) => x && typeof x === "object" && sameAddr(x.from, from) && BigInt(x.nonce) === BigInt(nonce)) : null;
      if (hit) {
        t = {
          hash: hit.hash,
          to: hit.to,
          data: hit.input !== undefined ? hit.input : hit.data,
          maxFeePerGas: hit.maxFeePerGas ? BigInt(hit.maxFeePerGas) : null,
          maxPriorityFeePerGas: hit.maxPriorityFeePerGas ? BigInt(hit.maxPriorityFeePerGas) : null,
          gasPrice: hit.gasPrice ? BigInt(hit.gasPrice) : null,
        };
      }
    } catch {
      /* a node without a pending block: the old fee stays unknown */
    }
  }
  if (t && t.data === undefined) t.data = "0x";
  return t;
}

/**
 * REVIEW-4 R4-1: --replace. Re-send the SAME call at the signer's OLDEST pending nonce with both fee fields raised by at
 * least 12.5 % and the cap at least 2 x the latest base fee. Refuses when the signer has nothing pending, or when the pending
 * transaction found there is not this very call (claim / refund of this lock). Never a second nonce. Returns { fees, report }.
 */
async function replacePlan(provider, signer, args, { name, contractAddr, lockId }) {
  const { mainnet } = mainnetFlags(args);
  const from = await signer.getAddress();
  const [latestN, pendingN] = await Promise.all([provider.getTransactionCount(from, "latest"), provider.getTransactionCount(from, "pending")]);
  if (pendingN <= latestN) {
    throw new UserError(`--replace: ${from} has no pending transaction (latest nonce ${latestN} = pending nonce ${pendingN}); nothing to replace; refusing (send the ${name} without --replace)`);
  }
  const nonce = latestN;
  const old = await findPendingTx(provider, args, from, nonce);
  if (old) {
    let parsed = null;
    try {
      parsed = htlcInterface().parseTransaction({ data: old.data });
    } catch {
      /* not an HTLC call */
    }
    if (!old.to || !sameAddr(old.to, contractAddr) || !parsed || parsed.name !== name || String(parsed.args[0]).toLowerCase() !== lockId.toLowerCase()) {
      throw new UserError(`--replace: the pending transaction at nonce ${nonce} is not a ${name} of lock ${lockId} at ${contractAddr}; replacing it would cancel something else; refusing`);
    }
  }
  const blk = await latestBlock(provider);
  const base = blk.baseFeePerGas;
  if ((base === null || base === undefined) && mainnet) throw new UserError("refusing: the latest block carries no baseFeePerGas, so the replacement fee cannot be checked against it");
  const minByBase = 2n * (base || 0n);
  const oldCap = old ? (old.maxFeePerGas !== null && old.maxFeePerGas !== undefined ? old.maxFeePerGas : old.gasPrice) : null;
  const oldTip = old ? (old.maxPriorityFeePerGas !== null && old.maxPriorityFeePerGas !== undefined ? old.maxPriorityFeePerGas : old.gasPrice) : null;
  const minCap = oldCap !== null && bumped(oldCap) > minByBase ? bumped(oldCap) : minByBase;
  const minTip = oldTip !== null ? bumped(oldTip) : 0n;
  const given = feeOverrides(args);
  let cap;
  let tip;
  if (given.maxFeePerGas !== undefined) {
    cap = given.maxFeePerGas;
    tip = given.maxPriorityFeePerGas > minTip ? given.maxPriorityFeePerGas : minTip;
    if (cap < minCap) {
      throw new UserError(
        `--replace: the new fee cap ${ethers.formatUnits(cap, "gwei")} gwei is below the minimum ${ethers.formatUnits(minCap, "gwei")} gwei ` +
          `(the larger of 2 x the latest base fee ${ethers.formatUnits(base || 0n, "gwei")} gwei and the old cap ${oldCap === null ? "unknown" : ethers.formatUnits(oldCap, "gwei") + " gwei"} + 12.5 %); refusing`
      );
    }
    if (tip > cap) throw new UserError(`--replace: the replacement tip ${ethers.formatUnits(tip, "gwei")} gwei (old tip + 12.5 %) is above the fee cap ${ethers.formatUnits(cap, "gwei")} gwei; give a higher cap; refusing`);
  } else {
    tip = minTip > GWEI ? minTip : GWEI;
    cap = minCap > minByBase + tip ? minCap : minByBase + tip;
  }
  const feeCheck = await checkFeeCap(provider, { maxFeePerGas: cap }, 2n, mainnet, FEE_WHY.claim);
  const report = {
    feeCheck,
    replace: {
      nonce,
      replacesTx: old && old.hash ? old.hash : null,
      oldFeeKnown: old !== null,
      oldMaxFeeGwei: oldCap === null ? null : ethers.formatUnits(oldCap, "gwei"),
      oldTipGwei: oldTip === null ? null : ethers.formatUnits(oldTip, "gwei"),
      newMaxFeeGwei: ethers.formatUnits(cap, "gwei"),
      newTipGwei: ethers.formatUnits(tip, "gwei"),
      note: old ? undefined : "the old transaction was not found on this node (give --replace-tx HASH): its fee is unknown, so the node itself enforces the replacement bump and rejects an underpriced one",
    },
  };
  return { fees: { maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce }, report };
}

/** Fees and report for one signing call: the --replace plan, or the cap checked against the base fee. */
async function feePlan(provider, signer, args, { name, contractAddr, lockId }) {
  if (args.replaceTx !== undefined && args.replace !== true) throw new UserError("--replace-tx needs --replace; refusing");
  if (args.replace === true) {
    if (name !== "claim" && name !== "refund") throw new UserError("--replace exists for claim and refund only; refusing");
    return replacePlan(provider, signer, args, { name, contractAddr, lockId });
  }
  if (args.replace !== undefined && args.replace !== false) throw new UserError("--replace is a flag without a value");
  const fees = feeOverrides(args);
  const feeCheck = await checkFeeCap(provider, fees, name === "claim" ? 2n : 1n, mainnetFlags(args).mainnet, name === "claim" ? FEE_WHY.claim : FEE_WHY.other);
  return { fees, report: feeCheck ? { feeCheck } : {} };
}

/** Same packing as HTLC.computeLockId. */
function computeLockIdLocal(sender, receiver, amount, hashlock, timelock) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint256", "bytes32", "uint256"],
    [sender, receiver, amount, hashlock, timelock]
  );
}

async function latestBlock(provider) {
  const b = await provider.getBlock("latest");
  if (!b) throw new UserError("node returned no latest block");
  return b;
}

async function assertAllowedChain(provider, args) {
  const chainId = (await provider.getNetwork()).chainId;
  const { mainnet } = mainnetFlags(args);
  if (mainnet) {
    if (chainId !== 1n) {
      throw new UserError(`--mainnet is given but the node is chain ${chainId}, not Ethereum mainnet (chainId 1); mainnet and test networks are never mixed; refusing`);
    }
    return chainId;
  }
  const extra = args.allowChainId !== undefined ? uint("allow-chain-id", args.allowChainId) : null;
  if (chainId === 1n) throw new UserError("refusing to send transactions on Ethereum mainnet (chainId 1) without --mainnet (which also needs --max-fee-gwei)");
  if (!ALLOWED_CHAIN_IDS.has(chainId) && chainId !== extra) {
    throw new UserError(
      `chainId ${chainId} is not a known test network (allowed: ${[...ALLOWED_CHAIN_IDS].join(", ")}); ` +
        `pass --allow-chain-id ${chainId} if you really mean it`
    );
  }
  return chainId;
}

function requireSigner(signer) {
  if (!signer) throw new UserError("this command needs a signer (--key-file)");
  return signer;
}

// ------------------------------------------------- secrets never get printed
// Secrets that passed through this process; scrubbed from every message we print.
const SECRETS = new Set();
function registerSecret(hex) {
  SECRETS.add(hex.toLowerCase().replace(/^0x/, ""));
}
function redact(text) {
  let t = String(text);
  for (const sec of SECRETS) t = t.replace(new RegExp(sec, "ig"), "[secret redacted]");
  return t;
}

/** Decode a revert into something readable, without ever including tx secrets. */
function explain(e) {
  let iface = null;
  try {
    iface = htlcInterface();
  } catch {
    /* artifact missing: fall through to the plain message */
  }
  const candidates = [e && e.data, e && e.error && e.error.data, e && e.info && e.info.error && e.info.error.data];
  for (const d of candidates) {
    const data = typeof d === "string" ? d : d && typeof d.data === "string" ? d.data : null;
    if (data && iface) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return `contract reverted: ${parsed.name}()`;
      } catch {
        /* not one of ours */
      }
    }
  }
  const msg = (e && (e.shortMessage || e.message)) || String(e);
  return redact(String(msg).split("\n")[0]);
}

async function readStdinText(maxBytes = 4096) {
  if (process.stdin.isTTY) {
    throw new UserError(
      "--secret-stdin: stdin is a terminal, so the secret would be typed in the clear; pipe it in " +
        "(swap-cli secret FILE | node scripts/live.js claim --secret-stdin ...)"
    );
  }
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += c.length;
    if (n > maxBytes) throw new UserError("--secret-stdin: input is far longer than a 32-byte secret");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The 32-byte secret as 0x-hex, or null when none was given. Sources (exactly one):
 * --secret-stdin, --secret-file PATH, or (in-process only) args.secret. Never echoed.
 */
async function readSecret(args) {
  const given = [args.secret !== undefined, args.secretStdin === true, args.secretFile !== undefined].filter(Boolean).length;
  if (given > 1) throw new UserError("give the secret by exactly one of --secret-stdin or --secret-file");
  if (given === 0) return null;
  let text;
  let where;
  if (args.secret !== undefined) {
    text = args.secret;
    where = "secret";
  } else if (args.secretFile !== undefined) {
    const file = path.resolve(String(args.secretFile));
    if (!fs.existsSync(file)) throw new UserError(`secret file not found: ${file}`);
    text = fs.readFileSync(file, "utf8");
    where = "--secret-file";
  } else {
    text = await readStdinText();
    where = "--secret-stdin";
  }
  const secret = hex32(where, String(text).trim());
  registerSecret(secret);
  return secret;
}

/**
 * The mainnet fee report for one transaction and the balance check. Refuses when the sender's balance is below
 * value + gas estimate x cap. All amounts in wei (decimal strings) plus an ETH rendering.
 */
async function mainnetCosts(provider, from, req, gas, capWei) {
  const value = req.value || 0n;
  const worst = gas * capWei;
  const required = value + worst;
  const balanceWei = await provider.getBalance(from);
  const costs = {
    maxFeeGwei: ethers.formatUnits(capWei, "gwei"),
    worstCaseFeeWei: worst.toString(),
    worstCaseFeeEth: ethers.formatEther(worst),
    requiredWei: required.toString(),
    requiredEth: ethers.formatEther(required),
    senderBalanceWei: balanceWei.toString(),
    senderBalanceEth: ethers.formatEther(balanceWei),
  };
  if (balanceWei < required) {
    throw new UserError(
      `refusing: the sender ${from} holds ${costs.senderBalanceEth} ETH but amount ${ethers.formatEther(value)} ETH + worst-case fee ` +
        `${costs.worstCaseFeeEth} ETH (gas estimate ${gas} x ${costs.maxFeeGwei} gwei) = ${costs.requiredEth} ETH is needed`
    );
  }
  return costs;
}

/**
 * Dry-run or send one transaction. Returns { dry: true, out } or
 * { dry: false, resp, receipt, chainId, from }. Never includes keys.
 * opts.hideData: the calldata carries the secret, so a dry run prints its length only.
 * opts.fees: fee fields (and nonce) already chosen and checked by feePlan; else the command's own flags.
 */
async function execute(provider, signer, args, tx, extra = {}, opts = {}) {
  const chainId = await assertAllowedChain(provider, args);
  const { mainnet, capWei } = mainnetFlags(args);
  const from = await signer.getAddress();
  const req = { ...tx, ...(opts.fees || feeOverrides(args)) }; // opts.fees: the checked / replacement fees (and nonce) of feePlan
  // A replacement is estimated against the LATEST state, without its nonce: the pool state (the pending transaction it
  // replaces, e.g. the very claim) would make a pending-state estimate revert (AlreadyClaimed) on some nodes.
  const replacing = req.nonce !== undefined;
  const estimate = async () => {
    if (!replacing) return signer.estimateGas(req);
    // (ethers' estimateGas sends no block tag, so ask the node directly.)
    const rpcTx = { from, to: req.to, data: req.data || "0x" };
    if (req.value) rpcTx.value = "0x" + BigInt(req.value).toString(16);
    return BigInt(await provider.send("eth_estimateGas", [rpcTx, "latest"]));
  };
  let gas = null;
  let costs = {};
  if (mainnet) {
    // Fee safety on chain 1, dry run or real: worst case = gas estimate x cap; the balance must cover value + worst case.
    gas = await estimate();
    costs = await mainnetCosts(provider, from, req, gas, req.maxFeePerGas === undefined ? capWei : req.maxFeePerGas);
  }
  if (replacing && gas === null && !args.dryRun) gas = await estimate();
  if (replacing && gas !== null) req.gasLimit = gas;
  if (args.dryRun) {
    if (gas === null) gas = await estimate();
    const data = req.data || "0x";
    const out = {
      dryRun: true,
      sent: false,
      chainId: chainId.toString(),
      from,
      to: req.to === undefined ? null : req.to,
      valueWei: (req.value || 0n).toString(),
      gasEstimate: gas.toString(),
      ...costs,
      ...extra,
    };
    if (opts.hideData) {
      out.dataLength = (data.length - 2) / 2;
    } else if (data.length > 2050) {
      out.dataLength = (data.length - 2) / 2;
      out.dataKeccak256 = ethers.keccak256(data);
    } else {
      out.data = data;
    }
    return { dry: true, out };
  }
  const resp = await signer.sendTransaction(req);
  // The hash is shown before the wait: a stuck transaction needs it for --replace-tx. (The command line sets onSent.)
  if (typeof args.onSent === "function") args.onSent({ hash: resp.hash, nonce: resp.nonce, maxFeePerGas: resp.maxFeePerGas, maxPriorityFeePerGas: resp.maxPriorityFeePerGas });
  const receipt = await resp.wait(confirmationsOf(args));
  if (!receipt || receipt.status !== 1) throw new UserError(`transaction ${resp.hash} failed (status ${receipt && receipt.status})`);
  return { dry: false, resp, receipt, chainId, from };
}

// ------------------------------------------------ the swap file (REVIEW-3 F3)
function profileOf(v) {
  if (v === undefined) return "production";
  if (typeof v !== "string" || v === "") throw new UserError("swap file profile must be a non-empty string");
  return v;
}

/** Parse the parts of the swap file this script needs. Read-only; `secret` is never looked at. */
function readSwapFile(file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new UserError(`--swap: swap file not found: ${abs}`);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new UserError(`--swap: ${abs} is not valid JSON (${e.message})`);
  }
  const eth = j && j.public && j.public.params && j.public.params.eth;
  if (!eth || j.public.hashlock === undefined) throw new UserError(`--swap: ${abs} has no public.params.eth / public.hashlock; is it a swap-cli swap file?`);
  try {
    return {
      file: abs,
      chainId: uint("swap file chain_id", eth.chain_id),
      // As swap-cli stores it: `public.params.profile`, absent for `production` (the default is not written).
      profile: profileOf(j.public.params.profile),
      contract: address("swap file contract", eth.contract),
      codeHash: eth.code_hash ? hex32("swap file code_hash", eth.code_hash) : null,
      amountWei: uint("swap file amount_wei", eth.amount_wei),
      aliceReceiver: address("swap file alice_receiver", eth.alice_receiver),
      bobSender: address("swap file bob_sender", eth.bob_sender),
      hashlock: hex32("swap file hashlock", j.public.hashlock),
      intent: j.pending_intent || null,
      // REVIEW-4 R4-3: swap-cli's own predicate (`secret_may_be_public`): the file shows Alice's claim reached the network.
      secretMayBePublic: Array.isArray(j.history) && j.history.some((h) => h && SECRET_PUBLIC_EVENTS.has(h.event)),
      ethFromBlock: j.eth_from_block === undefined || j.eth_from_block === null ? null : uint("swap file eth_from_block", j.eth_from_block),
    };
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`--swap ${abs}: ${e.message}`);
    throw e;
  }
}

/** A flag that may be omitted (then the file's value is used) but, when given, must equal the file's. */
function agree(flag, given, fromFile, same) {
  if (given === undefined || given === null || given === "") return fromFile;
  if (!same(given, fromFile)) {
    throw new UserError(`${flag} disagrees with the swap file: you gave ${given}, the file has ${fromFile}; refusing`);
  }
  return given;
}
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sameUint = (a, b) => {
  try {
    return uint("value", a) === uint("value", b);
  } catch {
    return false;
  }
};

/**
 * Bind a lock / claim / refund call to the swap file. Returns { args, sw }: `args` with the file's terms filled in
 * (every given flag was checked against the file), `sw` the parsed file; `sw` is null when there is no --swap (the
 * command line warns about that once, in `main`; in-process callers stay quiet). `want` is the intent action this command carries out.
 */
function bindSwap(args, want) {
  if (args.swap === undefined) return { args, sw: null }; // the CLI wrapper has already warned (main)
  const sw = readSwapFile(need(args, "swap"));
  const merged = { ...args };
  if (args.mainnet === true) {
    // Mainnet: the file must be a mainnet production swap, whatever the flags say.
    if (sw.chainId !== 1n) throw new UserError(`--mainnet: the swap file's chain_id is ${sw.chainId}, not 1; refusing`);
    if (sw.profile !== "production") throw new UserError(`--mainnet: the swap file's profile is ${sw.profile}, not production; refusing`);
  }
  merged.chainId = agree("--chain-id", args.chainId, sw.chainId.toString(), sameUint);
  merged.contract = agree("--contract", args.contract, sw.contract, sameAddr);
  // REVIEW-3 F1: the file must pin the code of this repo's artifact; a given --code-hash must agree with the file (and so with the artifact).
  if (sw.codeHash === null) throw new UserError(`--swap ${sw.file}: the file pins no code_hash; refusing`);
  if (sw.codeHash !== artifactCodeHash()) {
    throw new UserError(`the swap file pins code_hash ${sw.codeHash}, which is not the local artifact's ${artifactCodeHash()} (a different value means a different contract); refusing`);
  }
  merged.codeHash = agree("--code-hash", args.codeHash, sw.codeHash, sameAddr);
  // REVIEW-3 F7: the log-scan start is stored in the file by `swap-cli tick --apply`; --from-block, when given, wins (no comparison).
  if ((args.fromBlock === undefined || args.fromBlock === null || args.fromBlock === "") && sw.ethFromBlock !== null) merged.fromBlock = sw.ethFromBlock.toString();
  const intent = sw.intent;
  if (!intent) throw new UserError(`the swap file has no pending intent; expected ${want}. Run swap-cli tick --apply first and use the parameters it recorded`);
  if (intent.action !== want) {
    throw new UserError(`the swap file's pending intent is ${intent.action}, but this command carries out ${want}; refusing`);
  }
  const ip = intent.params || {};
  if (want === "lock_eth") {
    // The intent's own parameters must be this swap's terms (a hand-edited file is caught here too).
    if (ip.hashlock !== undefined && !sameAddr(ip.hashlock, sw.hashlock)) throw new UserError(`the intent's hashlock ${ip.hashlock} differs from the file's hashlock ${sw.hashlock}; refusing`);
    if (ip.receiver !== undefined && !sameAddr(ip.receiver, sw.aliceReceiver)) throw new UserError(`the intent's receiver ${ip.receiver} differs from the file's alice_receiver ${sw.aliceReceiver}; refusing`);
    if (ip.amount_wei !== undefined && !sameUint(ip.amount_wei, sw.amountWei)) throw new UserError(`the intent's amount_wei ${ip.amount_wei} differs from the file's amount_wei ${sw.amountWei}; refusing`);
    if (ip.t_reveal === undefined) throw new UserError("the lock_eth intent carries no t_reveal; refusing");
    merged.hashlock = agree("--hashlock", args.hashlock, sw.hashlock, sameAddr);
    merged.receiver = agree("--receiver", args.receiver, sw.aliceReceiver, sameAddr);
    merged.amountWei = agree("--amount-wei", args.amountWei, sw.amountWei.toString(), sameUint);
    merged.tReveal = agree("--t-reveal", args.tReveal, String(ip.t_reveal), sameUint);
  } else {
    if (typeof ip.lock_id !== "string") throw new UserError(`the ${want} intent carries no lock_id; refusing`);
    merged.lockId = agree("--lock-id", args.lockId, ip.lock_id, sameAddr);
  }
  return { args: merged, sw };
}

/** The lock on chain must be the swap file's lock: receiver, sender, amount and hashlock. */
function checkLockAgainstSwap(l, sw) {
  const pairs = [
    ["receiver", l.receiver, sw.aliceReceiver, sameAddr, "alice_receiver"],
    ["sender", l.sender, sw.bobSender, sameAddr, "bob_sender"],
    ["amount", l.amount.toString(), sw.amountWei.toString(), sameUint, "amount_wei"],
    ["hashlock", l.hashlock, sw.hashlock, sameAddr, "hashlock"],
  ];
  for (const [what, onChain, inFile, same, fileKey] of pairs) {
    if (!same(onChain, inFile)) throw new UserError(`the lock's ${what} on chain is ${onChain} but the swap file's ${fileKey} is ${inFile}; refusing`);
  }
}

// ------------------------------------------- target checks (F1) and log scans (F3)
/**
 * --chain-id is mandatory for lock / claim / refund. REVIEW-3 F1: the code hash is the local artifact's
 * (`artifactCodeHash`; a missing artifact is a UserError). --code-hash is optional and, when given, must equal it.
 */
function targetFlags(args) {
  const chainId = uint("--chain-id", need(args, "chainId", "chain-id"));
  const fromArtifact = artifactCodeHash();
  let codeHash = fromArtifact;
  if (args.codeHash !== undefined && args.codeHash !== null && args.codeHash !== "") {
    codeHash = hex32("--code-hash", args.codeHash);
    if (codeHash !== fromArtifact) {
      throw new UserError(`--code-hash ${codeHash} is not the code hash of this repo's compiled artifact, ${fromArtifact}: a different value means a different contract; refusing`);
    }
  }
  return { chainId, codeHash };
}

/**
 * Before anything is sent (and in --dry-run): eth_chainId must equal --chain-id (and be an allowed test chain,
 * or exactly chain 1 with --mainnet and nothing else with it), and keccak256(eth_getCode(contract)) must equal the artifact's code hash (REVIEW-3 F1).
 */
async function verifyTarget(provider, args, contractAddr) {
  const want = targetFlags(args);
  const actual = BigInt(await provider.send("eth_chainId", []));
  if (mainnetFlags(args).mainnet) {
    if (want.chainId !== 1n) throw new UserError(`--mainnet needs --chain-id 1 (got ${want.chainId}); mainnet and test networks are never mixed; refusing`);
    if (actual !== 1n) throw new UserError(`--mainnet is given but the RPC endpoint reports chain ${actual}, not 1; mainnet and test networks are never mixed; refusing`);
  } else if (actual === 1n || want.chainId === 1n) {
    throw new UserError("refusing to send transactions on Ethereum mainnet (chainId 1) without --mainnet (which also needs --max-fee-gwei)");
  }
  if (actual !== want.chainId) {
    throw new UserError(`chain id mismatch: --chain-id is ${want.chainId} but the RPC endpoint reports ${actual}; refusing`);
  }
  await assertAllowedChain(provider, args);
  const code = await provider.getCode(contractAddr);
  if (code === "0x") throw new UserError(`no contract code at ${contractAddr} on chain ${actual}; refusing`);
  const codeHash = ethers.keccak256(code);
  if (codeHash !== want.codeHash) {
    throw new UserError(`code hash mismatch: --code-hash is ${want.codeHash} but keccak256(code at ${contractAddr}) is ${codeHash}; refusing`);
  }
  return { chainId: actual, codeHash };
}

/** eth_getLogs in ranges of at most `maxRange` blocks (inclusive bounds), oldest first. */
async function getLogsChunked(provider, filter, fromBlock, toBlock, maxRange = LOG_RANGE_MAX) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += maxRange) {
    const end = Math.min(start + maxRange - 1, toBlock);
    out.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
  }
  return out;
}

/**
 * First block at which `addr` has code, by binary search over eth_getCode. Returns null when the node
 * cannot answer for old blocks (non-archive endpoints) or the address has no code; callers then scan from 0.
 */
async function findDeploymentBlock(provider, addr, latest) {
  try {
    if ((await provider.getCode(addr, latest)) === "0x") return null;
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await provider.getCode(addr, mid)) === "0x") lo = mid + 1;
      else hi = mid;
    }
    return lo;
  } catch {
    return null;
  }
}

/** --from-block if given, else the contract's deployment block if it can be found cheaply, else 0. */
async function resolveFromBlock(provider, contractAddr, args, latest) {
  if (args.fromBlock !== undefined) {
    const n = uint("--from-block", args.fromBlock);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new UserError("--from-block is too large");
    return Number(n);
  }
  const b = await findDeploymentBlock(provider, contractAddr, latest);
  return b === null ? 0 : b;
}

/** Every Locked event of the contract, optionally for one lockId, scanned in 50,000-block chunks. */
async function lockedEvents(provider, contractAddr, lockId, fromBlock, toBlock) {
  const iface = htlcInterface();
  const topics = [iface.getEvent("Locked").topicHash];
  if (lockId) topics.push(lockId);
  const logs = await getLogsChunked(provider, { address: contractAddr, topics }, fromBlock, toBlock);
  return logs.map((log) => ({ log, args: iface.parseLog(log).args }));
}

// -------------------------------------------------------------- commands
/** keygen: write a fresh private key (mode 0600, never overwrite). Prints only the address. */
async function keygen(_provider, _signer, args) {
  const out = need(args, "out");
  const file = path.resolve(out);
  if (fs.existsSync(file)) throw new UserError(`refusing to overwrite existing file ${file}`);
  const wallet = ethers.Wallet.createRandom();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, wallet.privateKey + "\n", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code === "EEXIST") throw new UserError(`refusing to overwrite existing file ${file}`);
    throw e;
  }
  return { address: wallet.address, keyFile: file };
}

/** Load a Wallet from a key file (0x + 64 hex, one line). */
function loadSigner(provider, keyFile) {
  if (!keyFile) throw new UserError("missing required --key-file");
  const file = path.resolve(keyFile);
  if (!fs.existsSync(file)) throw new UserError(`key file not found: ${file}`);
  const text = fs.readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new UserError(`key file ${file} is not "0x" + 64 hex chars`);
  return new ethers.Wallet(text, provider);
}

async function balance(provider, _signer, args) {
  const a = address("ADDRESS", need(args, "address", "ADDRESS"));
  const [bal, net, blockNumber] = await Promise.all([provider.getBalance(a), provider.getNetwork(), provider.getBlockNumber()]);
  return { address: a, balanceWei: bal.toString(), balanceEth: ethers.formatEther(bal), chainId: net.chainId.toString(), blockNumber };
}

async function deploy(provider, signer, args) {
  requireSigner(signer);
  mainnetFlags(args);
  const artifact = loadArtifact();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const tx = await factory.getDeployTransaction();
  const from = await signer.getAddress();
  if (args.dryRun) {
    const nonce = await provider.getTransactionCount(from, "pending");
    return (await execute(provider, signer, args, tx, { expectedContract: ethers.getCreateAddress({ from, nonce }) })).out;
  }
  const r = await execute(provider, signer, args, tx);
  const contract = r.receipt.contractAddress;
  if (!contract) throw new UserError("receipt has no contractAddress");
  const code = await provider.getCode(contract);
  return {
    contract,
    txHash: r.receipt.hash,
    blockNumber: r.receipt.blockNumber,
    chainId: r.chainId.toString(),
    codeHash: ethers.keccak256(code),
    matchesArtifact: code.toLowerCase() === artifact.deployedBytecode.toLowerCase(),
    deployer: r.from,
  };
}

async function lock(provider, signer, args0) {
  requireSigner(signer);
  mainnetFlags(args0);
  requireSwapOnMainnet(args0);
  const { args, sw } = bindSwap(args0, "lock_eth");
  const contractAddr = address("--contract", need(args, "contract"));
  const hashlock = hex32("--hashlock", need(args, "hashlock"));
  const tReveal = uint("--t-reveal", need(args, "tReveal", "t-reveal"));
  const receiver = address("--receiver", need(args, "receiver"));
  const amount = uint("--amount-wei", need(args, "amountWei", "amount-wei"));
  if (amount === 0n) throw new UserError("--amount-wei must be > 0");
  if (tReveal > 4102444800n) throw new UserError("--t-reveal looks like milliseconds; it is a UNIX timestamp in seconds");
  targetFlags(args); // fail on a missing --chain-id, a wrong --code-hash or a missing artifact before touching the network
  const target = await verifyTarget(provider, args, contractAddr);
  const blk = await latestBlock(provider);
  if (tReveal <= BigInt(blk.timestamp)) {
    throw new UserError(`--t-reveal ${tReveal} is not after the latest block timestamp ${blk.timestamp}`);
  }
  const iface = htlcInterface();
  const sender = await signer.getAddress();
  if (sw && !sameAddr(sender, sw.bobSender)) {
    throw new UserError(`this key is ${sender} but the swap file's bob_sender is ${sw.bobSender}; refusing`);
  }
  const expectedLockId = computeLockIdLocal(sender, receiver, amount, hashlock, tReveal);

  // F3: never a second lock of OURS under the same hashlock (that is the double-spend: Bob pays twice).
  // A Locked event under the same hashlock from ANOTHER sender must not block us (a third party who knows
  // the public hashlock could otherwise grief the swap with 1 wei); it is reported instead. Logs first,
  // then the state of the exact lockId.
  const fromBlock = await resolveFromBlock(provider, contractAddr, args, blk.number);
  if (fromBlock > blk.number) throw new UserError(`--from-block ${fromBlock} is beyond the latest block ${blk.number}`);
  const events = await lockedEvents(provider, contractAddr, null, fromBlock, blk.number);
  const same = events.filter((e) => e.args.hashlock.toLowerCase() === hashlock);
  const own = same.filter((e) => String(e.args.sender).toLowerCase() === sender.toLowerCase());
  const foreignLocksSameHashlock = same
    .filter((e) => String(e.args.sender).toLowerCase() !== sender.toLowerCase())
    .map((e) => ({ sender: e.args.sender, lockId: e.args.lockId, blockNumber: e.log.blockNumber }));
  if (own.length > 0) {
    const e = own[0];
    throw new UserError(
      `refusing: a Locked event for hashlock ${hashlock} from this sender ${sender} already exists (lockId ${e.args.lockId}, block ${e.log.blockNumber}, ` +
        `${own.length} found); a second lock under the same hashlock would be locked twice`
    );
  }
  if (await fetchLock(provider, contractAddr, expectedLockId)) {
    throw new UserError(`refusing: lock ${expectedLockId} already exists at ${contractAddr}`);
  }
  if (foreignLocksSameHashlock.length > 0) {
    process.stderr.write(
      `note: ${foreignLocksSameHashlock.length} Locked event(s) from other sender(s) already exist under hashlock ${hashlock} ` +
        `(${foreignLocksSameHashlock.map((f) => `${f.sender} lockId ${f.lockId} block ${f.blockNumber}`).join("; ")}); ` +
        `they do not block this lock, but whoever reveals the secret can claim those too
`
    );
  }

  const checks = { codeHash: target.codeHash, scannedFromBlock: fromBlock, lockedEventsScanned: events.length, foreignLocksSameHashlock };
  const tx = { to: contractAddr, data: iface.encodeFunctionData("newLock", [hashlock, tReveal, receiver]), value: amount };
  // REVIEW-4 R4-1: the fee cap must clear the latest base fee (also in --dry-run); --replace does not exist for lock.
  const fp = await feePlan(provider, signer, args, { name: "newLock", contractAddr, lockId: expectedLockId });
  if (args.dryRun) return (await execute(provider, signer, args, tx, { expectedLockId, ...checks, ...fp.report }, { fees: fp.fees })).out;

  const r = await execute(provider, signer, args, tx, {}, { fees: fp.fees });
  let eventLockId = null;
  for (const log of r.receipt.logs) {
    if (log.address.toLowerCase() !== contractAddr.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === "Locked") eventLockId = parsed.args.lockId;
  }
  if (!eventLockId) throw new UserError(`no Locked event in receipt of ${r.receipt.hash}`);
  if (eventLockId.toLowerCase() !== expectedLockId.toLowerCase()) {
    throw new UserError(`lockId mismatch: event ${eventLockId} != locally recomputed ${expectedLockId}`);
  }
  const rb = await provider.getBlock(r.receipt.blockNumber);
  return {
    lockId: eventLockId,
    txHash: r.receipt.hash,
    blockNumber: r.receipt.blockNumber,
    blockTimestamp: rb ? rb.timestamp : null,
    sender,
    chainId: target.chainId.toString(),
    ...checks,
    ...fp.report,
  };
}

async function fetchLock(provider, contractAddr, lockId) {
  const c = new ethers.Contract(contractAddr, htlcInterface(), provider);
  try {
    return await c.getLock(lockId);
  } catch (e) {
    if (/LockNotFound/.test(explain(e)) || (e && e.revert && e.revert.name === "LockNotFound")) return null;
    throw e;
  }
}

async function claim(provider, signer, args0) {
  requireSigner(signer);
  mainnetFlags(args0);
  requireSwapOnMainnet(args0);
  const { args, sw } = bindSwap(args0, "reveal_eth");
  // REVIEW-4 R4-5: the claim is Alice's; swap-cli reads the nonces of alice_receiver (drop detection, cancel guard), so no other key.
  if (sw) {
    const me = await signer.getAddress();
    if (!sameAddr(me, sw.aliceReceiver)) throw new UserError(`this key is ${me} but the swap file's alice_receiver is ${sw.aliceReceiver}; refusing`);
  }
  const contractAddr = address("--contract", need(args, "contract"));
  const lockId = hex32("--lock-id", need(args, "lockId", "lock-id"));
  const margin = marginOf(args);
  const marginGiven = args.marginS !== undefined;
  targetFlags(args);
  const secret = await readSecret(args);
  if (secret === null && !args.dryRun) {
    throw new UserError("claim needs the secret: pipe it to --secret-stdin or pass --secret-file PATH (it is never accepted on the command line)");
  }
  try {
    return await claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw });
  } catch (e) {
    if (e instanceof UserError) throw new UserError(redact(e.message));
    throw new UserError(explain(e)); // ethers errors can carry the calldata, which holds the secret
  }
}

/** claim --dry-run without the secret on mainnet: no gas estimate, so no worst case; the cap and the balance are shown. */
async function mainnetDryRunNote(provider, signer, args) {
  const { capWei } = mainnetFlags(args);
  const balanceWei = await provider.getBalance(await signer.getAddress());
  return {
    maxFeeGwei: ethers.formatUnits(capWei, "gwei"),
    worstCaseFeeWei: null,
    worstCaseFeeNote: "not computed without the real secret (no gas estimate); the balance check runs on the real claim",
    senderBalanceWei: balanceWei.toString(),
    senderBalanceEth: ethers.formatEther(balanceWei),
  };
}

async function claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw }) {
  const target = await verifyTarget(provider, args, contractAddr);
  const l = await fetchLock(provider, contractAddr, lockId);
  if (!l) throw new UserError(`no such lock ${lockId} at ${contractAddr}`);
  // REVIEW-3 F3: the lock must be the swap file's, and the cutoff the file froze (M_A) can only tighten the flag's.
  let intentCutoff = null;
  if (sw) {
    checkLockAgainstSwap(l, sw);
    const ip = sw.intent.params;
    if (ip.t_reveal === undefined || ip.cutoff === undefined) {
      throw new UserError("the reveal_eth intent carries no t_reveal / cutoff (recorded by an older swap-cli); cancel it and run tick --apply again; refusing");
    }
    if (!sameUint(ip.t_reveal, l.timelock)) throw new UserError(`the lock's timelock on chain is ${l.timelock} but the reveal_eth intent froze t_reveal ${ip.t_reveal}; refusing`);
    intentCutoff = uint("intent cutoff", ip.cutoff);
  }
  if (secret !== null) {
    const digest = ethers.sha256(secret); // ethers treats a hex string as the raw bytes
    if (digest.toLowerCase() !== l.hashlock.toLowerCase()) {
      throw new UserError(`refusing: sha256(secret) = ${digest} but the lock's hashlock is ${l.hashlock}`);
    }
  }
  if (l.claimed) throw new UserError("lock is already claimed");
  if (l.refunded) throw new UserError("lock is already refunded");
  const blk = await latestBlock(provider);
  if (BigInt(blk.timestamp) >= l.timelock) {
    throw new UserError(`timelock ${l.timelock} has already passed (latest block timestamp ${blk.timestamp}); claim would revert`);
  }
  // F3 (I2): the reveal cutoff. The later of the wall clock and the chain clock is the stricter reading.
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const now = wall > BigInt(blk.timestamp) ? wall : BigInt(blk.timestamp);
  let cutoff = l.timelock - margin;
  let cutoffRule = "timelock - margin";
  // REVIEW-4 R4-3: once the file shows the secret may already be public (swap-cli's late re-send, review H1), a re-send
  // publishes nothing new and the cutoff the intent froze (T_reveal - DE) is the authority, not the stricter default margin.
  // An explicit --margin-s still tightens it. Without that evidence the earlier of the two stays the rule.
  const lateResend = intentCutoff !== null && sw.secretMayBePublic && !marginGiven;
  if (lateResend) {
    cutoff = intentCutoff < l.timelock ? intentCutoff : l.timelock;
    cutoffRule = "the swap file's frozen cutoff (the file shows the secret may already be public)";
  } else if (intentCutoff !== null && intentCutoff < cutoff) {
    cutoff = intentCutoff;
    cutoffRule = "the swap file's frozen cutoff";
  }
  if (now > cutoff) {
    throw new UserError(
      `refusing: past the reveal cutoff. now ${now} > cutoff ${cutoff} (timelock ${l.timelock} - margin ${margin} s` +
        `${intentCutoff !== null ? `, or the swap file's frozen cutoff ${intentCutoff}, ${lateResend ? "which rules because the secret may already be public" : "whichever is earlier"}` : ""}) ` +
        `(a late claim publishes the secret and lets the counterparty take both legs; use --margin-s only if you know the risk)`
    );
  }
  // F3: the lock must be final. Find its Locked event and compare its block with the `finalized` block.
  const fromBlock = await resolveFromBlock(provider, contractAddr, args, blk.number);
  const events = await lockedEvents(provider, contractAddr, lockId, fromBlock, blk.number);
  if (events.length !== 1) {
    throw new UserError(
      events.length === 0
        ? `refusing: no Locked event for ${lockId} found in blocks ${fromBlock}..${blk.number}; cannot prove the lock is final (check --from-block)`
        : `refusing: ${events.length} Locked events for ${lockId}; expected exactly one`
    );
  }
  const ev = events[0];
  if (
    ev.args.hashlock.toLowerCase() !== l.hashlock.toLowerCase() ||
    ev.args.receiver !== l.receiver ||
    ev.args.sender !== l.sender ||
    ev.args.amount !== l.amount ||
    ev.args.timelock !== l.timelock
  ) {
    throw new UserError(`refusing: the Locked event for ${lockId} disagrees with getLock(); do not trust this node`);
  }
  let finalized = null;
  try {
    finalized = await provider.getBlock("finalized");
  } catch {
    /* handled below */
  }
  if (!finalized) throw new UserError("refusing: this node does not answer the `finalized` block tag, so the lock's finality cannot be checked");
  if (ev.log.blockNumber > finalized.number) {
    throw new UserError(
      `refusing: the lock is not final yet. Locked in block ${ev.log.blockNumber}, finalized block is ${finalized.number}; wait and retry`
    );
  }

  const plan = {
    lockId,
    receiver: l.receiver,
    amountWei: l.amount.toString(),
    hashlock: l.hashlock,
    timelock: l.timelock.toString(),
    timelockIso: new Date(Number(l.timelock) * 1000).toISOString(),
    marginS: margin.toString(),
    swapFile: sw ? sw.file : null,
    revealCutoff: cutoff.toString(),
    revealCutoffRule: cutoffRule,
    secondsToCutoff: (cutoff - now).toString(),
    lockedBlock: ev.log.blockNumber,
    finalizedBlock: finalized.number,
    codeHash: target.codeHash,
    secretProvided: secret !== null,
  };
  // REVIEW-4 R4-1: the fee cap (or the --replace plan) is decided and checked before anything is signed, also without the secret.
  const fp = await feePlan(provider, signer, args, { name: "claim", contractAddr, lockId });
  if (secret === null) {
    // --dry-run without the secret: all gates passed, but gas cannot be estimated without the real preimage.
    return {
      dryRun: true,
      sent: false,
      chainId: target.chainId.toString(),
      from: await signer.getAddress(),
      to: contractAddr,
      valueWei: "0",
      gasEstimate: null,
      gasEstimateNote: "not estimated: the real secret is needed (a wrong preimage would revert)",
      ...(mainnetFlags(args).mainnet ? await mainnetDryRunNote(provider, signer, args) : {}),
      ...plan,
      ...fp.report,
    };
  }
  const tx = { to: contractAddr, data: htlcInterface().encodeFunctionData("claim", [lockId, secret]) };
  const r = await execute(provider, signer, args, tx, { ...plan, ...fp.report }, { hideData: true, fees: fp.fees });
  if (r.dry) return r.out;
  return { txHash: r.receipt.hash, blockNumber: r.receipt.blockNumber, ...fp.report };
}

async function refund(provider, signer, args0) {
  requireSigner(signer);
  mainnetFlags(args0);
  requireSwapOnMainnet(args0);
  const { args, sw } = bindSwap(args0, "refund_eth");
  // REVIEW-4 R4-5: the refund is Bob's; the key must be the swap file's bob_sender (checked before the network is touched).
  if (sw) {
    const me = await signer.getAddress();
    if (!sameAddr(me, sw.bobSender)) throw new UserError(`this key is ${me} but the swap file's bob_sender is ${sw.bobSender}; refusing`);
  }
  const contractAddr = address("--contract", need(args, "contract"));
  const lockId = hex32("--lock-id", need(args, "lockId", "lock-id"));
  targetFlags(args);
  const target = await verifyTarget(provider, args, contractAddr);
  const l = await fetchLock(provider, contractAddr, lockId);
  if (!l) throw new UserError(`no such lock ${lockId} at ${contractAddr}`);
  if (sw) checkLockAgainstSwap(l, sw);
  const me = await signer.getAddress();
  if (me.toLowerCase() !== l.sender.toLowerCase()) throw new UserError(`only the lock's sender ${l.sender} can refund (this key is ${me})`);
  if (l.claimed) throw new UserError("lock is already claimed; nothing to refund");
  if (l.refunded) throw new UserError("lock is already refunded");
  const blk = await latestBlock(provider);
  if (BigInt(blk.timestamp) < l.timelock) {
    throw new UserError(
      `too early: timelock is ${l.timelock} (${new Date(Number(l.timelock) * 1000).toISOString()}), ` +
        `latest block timestamp is ${blk.timestamp}; ${l.timelock - BigInt(blk.timestamp)} s to go`
    );
  }
  const tx = { to: contractAddr, data: htlcInterface().encodeFunctionData("refund", [lockId]) };
  const fp = await feePlan(provider, signer, args, { name: "refund", contractAddr, lockId });
  const r = await execute(provider, signer, args, tx, { lockId, amountWei: l.amount.toString(), codeHash: target.codeHash, ...fp.report }, { fees: fp.fees });
  if (r.dry) return r.out;
  return { txHash: r.receipt.hash, blockNumber: r.receipt.blockNumber, ...fp.report };
}

async function send(provider, signer, args) {
  requireSigner(signer);
  mainnetFlags(args);
  const to = address("--to", need(args, "to"));
  const amount = uint("--amount-wei", need(args, "amountWei", "amount-wei"));
  if (amount === 0n) throw new UserError("--amount-wei must be > 0");
  const r = await execute(provider, signer, args, { to, value: amount });
  if (r.dry) return r.out;
  return { txHash: r.receipt.hash, blockNumber: r.receipt.blockNumber, from: r.from, to, valueWei: amount.toString() };
}

async function status(provider, _signer, args) {
  const contractAddr = address("--contract", need(args, "contract"));
  const lockId = hex32("--lock-id", need(args, "lockId", "lock-id"));
  const iface = htlcInterface();
  const blk = await latestBlock(provider);
  const fromBlock = await resolveFromBlock(provider, contractAddr, args, blk.number);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  const code = await provider.getCode(contractAddr);
  const l = await fetchLock(provider, contractAddr, lockId);
  const topics = ["Locked", "Claimed", "Refunded"].map((n) => iface.getEvent(n).topicHash);
  const logs = await getLogsChunked(provider, { address: contractAddr, topics: [topics, lockId] }, fromBlock, blk.number);
  const events = [];
  let revealed = null;
  for (const log of logs) {
    const p = iface.parseLog(log);
    const ev = { event: p.name, blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.index };
    if (p.name === "Locked") {
      Object.assign(ev, {
        sender: p.args.sender,
        receiver: p.args.receiver,
        amountWei: p.args.amount.toString(),
        hashlock: p.args.hashlock,
        timelock: p.args.timelock.toString(),
      });
    } else if (p.name === "Claimed") {
      ev.preimage = p.args.preimage;
      revealed = p.args.preimage;
    }
    events.push(ev);
  }
  const out = {
    contract: contractAddr,
    chainId: chainId.toString(), // copy into --chain-id
    codeHash: code === "0x" ? null : ethers.keccak256(code), // informational: lock/claim/refund compare against the artifact's hash
    lockId,
    latestBlock: blk.number,
    latestBlockTimestamp: blk.timestamp,
    scannedFromBlock: fromBlock,
    exists: !!l,
    lock: null,
    state: "not found",
    events,
    preimage: revealed,
  };
  if (l) {
    const expired = BigInt(blk.timestamp) >= l.timelock;
    out.state = l.claimed ? "claimed" : l.refunded ? "refunded" : expired ? "expired-unclaimed (refundable)" : "open (claimable)";
    out.lock = {
      sender: l.sender,
      receiver: l.receiver,
      amountWei: l.amount.toString(),
      hashlock: l.hashlock,
      timelock: l.timelock.toString(),
      timelockIso: new Date(Number(l.timelock) * 1000).toISOString(),
      claimed: l.claimed,
      refunded: l.refunded,
      preimage: l.claimed ? l.preimage : null,
    };
    if (l.claimed && revealed === null) out.preimage = l.preimage;
    if (out.preimage) out.preimageMatchesHashlock = ethers.sha256(out.preimage).toLowerCase() === l.hashlock.toLowerCase();
  }
  return out;
}

// ------------------------------------------------------------------- CLI
const COMMON = { "confirmations": "v", "dry-run": "b", "gas-price-gwei": "v", "allow-chain-id": "v", "mainnet": "b", "max-fee-gwei": "v" };
const TARGET = { "chain-id": "v", "code-hash": "v", "from-block": "v" };
const SPECS = {
  keygen: { flags: { out: "v" }, signer: false },
  balance: { flags: {}, positional: "address", signer: false },
  deploy: { flags: { ...COMMON, "key-file": "v" }, signer: true },
  lock: {
    flags: { ...COMMON, ...TARGET, "key-file": "v", contract: "v", hashlock: "v", "t-reveal": "v", receiver: "v", "amount-wei": "v", swap: "v" },
    signer: true,
  },
  claim: {
    flags: { ...COMMON, ...TARGET, "key-file": "v", contract: "v", "lock-id": "v", "margin-s": "v", "secret-stdin": "b", "secret-file": "v", swap: "v", replace: "b", "replace-tx": "v" },
    signer: true,
  },
  refund: { flags: { ...COMMON, "chain-id": "v", "code-hash": "v", "key-file": "v", contract: "v", "lock-id": "v", swap: "v", replace: "b", "replace-tx": "v" }, signer: true },
  send: { flags: { ...COMMON, "key-file": "v", to: "v", "amount-wei": "v" }, signer: true },
  status: { flags: { contract: "v", "lock-id": "v", "from-block": "v" }, signer: false },
};
const COMMANDS = { keygen, balance, deploy, lock, claim, refund, send, status };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !SPECS[command]) {
    throw new UserError(`usage: node scripts/live.js <${Object.keys(SPECS).join("|")}> [flags]`);
  }
  const spec = SPECS[command];
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (name === "preimage" || name === "secret") {
        throw new UserError(
          `--${name} was removed: a secret on the command line lands in shell history and process listings; ` +
            `use --secret-stdin (swap-cli secret FILE | node scripts/live.js claim --secret-stdin ...) or --secret-file PATH`
        );
      }
      const kind = spec.flags[name];
      if (!kind) throw new UserError(`unknown flag --${name} for "${command}"`);
      if (kind === "b") args[camel(name)] = true;
      else {
        const v = rest[++i];
        if (v === undefined || v.startsWith("--")) throw new UserError(`--${name} needs a value`);
        args[camel(name)] = v;
      }
    } else if (spec.positional && args[spec.positional] === undefined) {
      args[spec.positional] = tok;
    } else {
      throw new UserError(/^(0x)?[0-9a-fA-F]{64}$/.test(tok) ? "unexpected argument (a 32-byte hex value; not shown)" : `unexpected argument "${tok}"`);
    }
  }
  return { command, args };
}

const jsonOut = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main(argv) {
  const { command, args } = parseArgs(argv);
  if (args.mainnet === true) process.stderr.write(MAINNET_WARNING);
  // Under --mainnet a missing --swap is a refusal (requireSwapOnMainnet), not a warning.
  if (["lock", "claim", "refund"].includes(command) && args.swap === undefined && args.mainnet !== true) process.stderr.write(NO_SWAP_WARNING);
  const provider = command === "keygen" ? null : new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || "http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
  try {
    const signer = SPECS[command].signer ? loadSigner(provider, args.keyFile) : null;
    if (signer) {
      // Shown as soon as the transaction is sent, before the wait for the receipt: a stuck one needs its hash for --replace-tx.
      args.onSent = (s) =>
        process.stderr.write(
          `sent: ${s.hash} nonce ${s.nonce} maxFeePerGas ${s.maxFeePerGas === null || s.maxFeePerGas === undefined ? "?" : ethers.formatUnits(s.maxFeePerGas, "gwei")} gwei ` +
            (command === "claim" || command === "refund"
              ? `(waiting for the receipt; if it stays pending: ${command} --replace --replace-tx ${s.hash} with a higher --max-fee-gwei)\n`
              : "(waiting for the receipt)\n")
        );
    }
    const result = await COMMANDS[command](provider, signer, args);
    process.stdout.write(redact(jsonOut(result)) + "\n");
  } finally {
    if (provider) provider.destroy();
  }
}

module.exports = {
  keygen, balance, deploy, lock, claim, refund, send, status,
  loadSigner, computeLockIdLocal, parseArgs, UserError, explain, ALLOWED_CHAIN_IDS, MAINNET_WARNING,
  getLogsChunked, findDeploymentBlock, readSecret, verifyTarget, redact, LOG_RANGE_MAX, DEFAULT_MARGIN_S,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${redact(e instanceof UserError ? e.message : explain(e))}\n`);
    process.exit(1);
  });
}
