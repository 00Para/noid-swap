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
 * Lock kinds (docs/poseidon-leg.md section 9). The tool talks to one of two contracts, chosen per command:
 *   sha256    HTLC.sol, the default: the lock word is SHA-256(secret); the claim is sent with a FIXED gas limit of 200,000 and is never
 *             simulated either (REVIEW-6 R6-8: eth_estimateGas would carry the secret to the node; the fuzz maximum is 120,993 gas).
 *   poseidon  HTLCPoseidonV2.sol: the lock word is lockAddr = Addr(secret), the Parano1d address of the secret (the same 32 bytes as the
 *             claim authority of the NOID lock). Selected by --lock-kind poseidon (deploy: --contract-kind poseidon) or by the swap
 *             file's lock_kind. The artifact, its code hash, the ABI (the field is lockAddr, not hashlock) all follow the kind. A claim of this
 *             kind (a) compares Addr(secret) with the lock LOCALLY (scripts/poseidon/poseidon2b.js), (b) builds its calldata itself and
 *             refuses to sign anything but exactly 68 bytes (selector, lock id, secret; a suffix would revert and still publish the secret),
 *             (c) is sent with a FIXED gas limit of 1,000,000 (the contract's own floor is 540,000), and (d) is NEVER simulated: no
 *             eth_estimateGas, no eth_call carries the secret to the node. Only the signed raw transaction does. Review V2-6, V2-7.
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
 *                        under the same hashlock do not block, for either lock kind (REVIEW-6 R6-2);
 *                        they are reported (and noted on stderr).
 *   refund               the lock is present, unclaimed, unrefunded, and its timelock passed.
 *   lock --swap FILE     the producer screen of swap-cli must not remember a detection (T21): the marker file FILE.producer-differs (present, or
 *                        not examinable, counts) or the history entry producer_differs_seen. Under the production profile `lock` refuses (also in
 *                        --dry-run) unless the history holds the operator's producer_concentration_overridden (tick --accept-producer-concentration),
 *                        then it only warns; under any other profile it warns. Local reads only, before any network call. A screen, not a defence.
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
 * is not this call (found by --replace-tx HASH or in the node's pending block / pool), when it cannot be found and identified at all
 * (REVIEW-5 R5-2: the command then asks for --replace-tx, it never replaces "whatever sits at the oldest nonce"), or when the lock
 * is claimed / refunded.
 * On the command line the hash of a sent transaction is printed on stderr before the wait.
 *
 * Tip (optional --priority-fee-gwei N, decimal gwei, at most 9 decimals, > 0). Without it the tip is min(cap, 1 gwei), which on a
 * cheap chain can be most of the cap: a block builder is paid the tip first, so the whole cap is spent although the base fee needed a
 * fraction of it. With it the tip is N and maxFeePerGas stays the cap; N above the cap is refused, and so is N with no cap flag
 * (--max-fee-gwei with --mainnet, or --gas-price-gwei). One gas then costs min(cap, base fee + tip): the report shows it as
 * `expectedGasPriceGwei` next to `priorityFeeGwei`; the balance check still uses the cap. Example (mainnet): cap 0.2 gwei, base fee
 * 0.06 gwei, tip 0.01 gwei -> about 0.07 gwei per gas instead of 0.2. Advice: cap at 3-4 x the base fee (the check above keeps a
 * claim at 2 x or more), tip small. A tip below what block builders take can leave the transaction pending; the tool does not look
 * that up. Two guards and one remedy:
 *   - Floor (lock, claim, refund; read from the latest block the cap check already reads, so no extra call; also in --dry-run): a given
 *     N below one tenth of the latest base fee, rounded up to a whole wei, is refused. Example: base fee 0.06 gwei -> floor 0.006 gwei,
 *     so 0.0059 is refused and 0.006 is taken. The floor is never above min(cap, 1 gwei), the tip used without the flag (it matters
 *     only at a base fee above 10 gwei). The report carries `feeCheck.minPriorityFeeGwei`. No floor on a chain without a base fee,
 *     and none for deploy and send (they read no base fee and have no cap check). A lock cannot be replaced, so give the lock a
 *     generous tip, for example half the base fee.
 *   - Warning: one line on stderr whenever the flag is given.
 *   - Remedy, `--replace` (claim, refund): a replacement never tips less than the rule that applies without the flag. Its tip is the
 *     larger of max(N if given, min(cap, 1 gwei)) and the old tip + 12.5 % (rounded up), and is refused above the cap. The small N is
 *     therefore not used for a replacement: with the new cap 0.5 gwei, N 0.001 gwei and an old tip of 0.01 gwei the replacement tips
 *     max(0.001, min(0.5, 1) = 0.5, 0.01125) = 0.5 gwei, that is up to the whole cap. The floor above is not applied to it.
 *
 * A claim that is mined and REVERTS (REVIEW-6 R6-3, for either kind: e.g. it was mined after the timelock) has paid nobody but has put the secret
 * into a block. `claim` then does not fail with a bare message: it prints a JSON result with `reverted: true`, `secretPublic: true`, the `txHash`
 * and the flag to give swap-cli (`tick --reveal-tx HASH`), and exits with status 3. swap-cli reads the transaction and its receipt from the node
 * and records "the secret is public" (the late re-send cutoff then applies); Bob's side can take the secret from the same transaction.
 *
 * Stuck first reveal (REVIEW-5 R5-1): a `claim --replace` that has found and identified the signer's pending claim of THIS lock knows
 * the secret is already in the public mempool, so it uses the late cutoff T_reveal - DE (the intent's `late_cutoff`, or the profile's DE for
 * an older intent) instead of T_reveal - M_A. A first claim, which has no such transaction, keeps the strict M_A rule.
 *
 * Reveal sidecar (T21-11): with --swap, a real claim writes FILE.reveal-sent (lock id, the signed hash when a local key shows it, epoch seconds; exclusive,
 * mode 600, fsynced with its directory) as the last step before the broadcast and sends nothing if that fails. A sidecar of THIS lock beside the file is read
 * as evidence that the secret may be public, like the history events below (same late cutoff); one of another lock is ignored and reported. swap-cli's
 * `tick` reads the same file (history name reveal_sidecar_seen).
 *
 * Claim lock: a real `claim --swap FILE` first creates FILE.claim-lock exclusively (pid and time, nothing secret) and holds it until the send has settled
 * (not through the wait for the receipt, so `claim --replace-tx` from another terminal still works then). If that file exists, or cannot be created, the
 * claim refuses before it touches the sidecar: a claim that died leaves its lock, and the operator deletes it by hand once sure that no other claim for
 * this swap file is running. The tool never removes a lock it did not make. A dry run takes no lock.
 *
 * No redirect, no library retry for the send: a provider from makeProvider (the command line's) turns every HTTP 3xx answer into an error
 * (REDIRECT_REFUSED; put the endpoint's final URL in ETH_RPC_URL), and the claim's send is not retried on HTTP 429 (see sendGuard).
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
const crypto = require("crypto");
const { ethers } = require("ethers");

const ARTIFACT_PATHS = {
  sha256: path.join(__dirname, "..", "artifacts", "contracts", "HTLC.sol", "HTLC.json"),
  poseidon: path.join(__dirname, "..", "artifacts", "contracts", "HTLCPoseidonV2.sol", "HTLCPoseidonV2.json"),
};
const LOCK_KINDS = Object.keys(ARTIFACT_PATHS);
// Review V2-6: HTLCPoseidonV2.claim needs about 0.50 - 0.55 M gas and refuses below MIN_CLAIM_GAS = 540,000; the tool sends it with a limit well above
// both, and never estimates (an estimate would send the secret to the node). Unused gas is not charged: only limit x maxFee must be in the balance.
const POSEIDON_CLAIM_GAS_LIMIT = 1_000_000n;
// Review V2-7: claim(bytes32,bytes32) calldata = 4 + 32 + 32 bytes; the contract refuses (and the secret is already out) anything longer.
const POSEIDON_CLAIM_CALLDATA_BYTES = 68;
// REVIEW-6 R6-8: the sha256 claim is sent with a fixed gas limit too, and never estimated (an estimate would send the secret to the node before the claim
// itself). HTLC.sol's claim is a hash, a storage write and one ETH transfer: the fuzz run (eth/FUZZ.md) measured at most 120,993 gas, so 200,000 clears it with
// a wide margin and, like the poseidon limit, costs only what is used (the balance must cover limit x fee cap at signing).
const SHA256_CLAIM_GAS_LIMIT = 200_000n;
// Chains on which this tool will send transactions: Sepolia, Holesky, Hardhat/ganache-style local.
// Ethereum mainnet (1) is refused unless the command carries --mainnet (see mainnetFlags); it is never in this set.
// Another chain needs an explicit allowChainId.
const ALLOWED_CHAIN_IDS = new Set([11155111n, 17000n, 31337n, 1337n]);
const MAINNET_WARNING = "warning: --mainnet is in effect: this command can spend real ETH on Ethereum mainnet (chainId 1)\n";
const GWEI = 10n ** 9n;
const LOG_RANGE_MAX = 50000; // blocks per eth_getLogs request: the cap of public Sepolia RPCs
const DEFAULT_MARGIN_S = 1800; // M_A, docs/protocol-design.md section 4.3
// REVIEW-4 R4-3: swap-cli history events that show Alice's secret may already be public (engine.rs `secret_may_be_public`).
// (+ REVIEW-6 R6-3 `reveal_reverted_seen`: a claim of this lock was mined and reverted, so its calldata published the secret.)
const SECRET_PUBLIC_EVENTS = new Set(["reveal_submitted", "eth_claim_mined", "eth_claim_reorged", "eth_reveal_dropped", "reveal_pending_seen", "reveal_reverted_seen", "reveal_sidecar_seen"]);
// REVIEW-5 R5-1: DE (Ethereum inclusion delay, seconds) per swap-cli profile (params.rs `de_s`): the late cutoff is T_reveal - DE. Only the
// fallback for a --replace of a reveal_eth intent recorded before REVIEW-5, which carries no `late_cutoff` of its own.
const PROFILE_DE_S = { production: 120n, sepolia: 120n, rehearsal: 60n };
// REVIEW-4 R4-1: a same-nonce replacement must raise both fee fields by at least 12.5 % (geth requires 10 %).
const bumped = (v) => (v * 1125n + 999n) / 1000n;

class UserError extends Error {}

/**
 * REVIEW-6 R6-3: a transaction that WAS sent and mined but reverted (receipt status 0). A reverted claim has still put the secret into a block, so the
 * caller of `claim` turns this into an explicit result (`reverted: true, secretPublic: true`) instead of a bare failure. `hash` and `blockNumber` are the
 * transaction's. Its message is the old one ("transaction X failed (status 0)").
 */
class RevertedTx extends UserError {
  constructor(hash, receipt) {
    super(`transaction ${hash} failed (status ${receipt ? receipt.status : null})`);
    this.hash = hash;
    this.blockNumber = receipt ? receipt.blockNumber : null;
  }
}

const NO_SWAP_WARNING = "warning: no --swap FILE, the swap file's intent is not checked (REVIEW-3 F3)\n";
const PRIORITY_FEE_WARNING =
  "warning: --priority-fee-gwei is in effect: a tip below what block builders take can leave the transaction pending; --replace then re-sends it with a higher cap and pays up to the whole cap (the small tip is not used for a replacement)\n";

// ---------------------------------------------------------------- helpers
/** The lock kind of a command: `args.lockKind` (set from --lock-kind / --contract-kind or the swap file), else sha256. */
function kindOf(args) {
  const given = args ? (args.lockKind !== undefined && args.lockKind !== null && args.lockKind !== "" ? args.lockKind : args.contractKind) : undefined;
  const k = given !== undefined && given !== null && given !== "" ? given : "sha256";
  if (!LOCK_KINDS.includes(k)) throw new UserError(`unknown lock kind "${k}" (${LOCK_KINDS.join(" or ")})`);
  return k;
}
function loadArtifact(kind = "sha256") {
  const p = ARTIFACT_PATHS[kind];
  if (!p) throw new UserError(`unknown lock kind "${kind}" (${LOCK_KINDS.join(" or ")})`);
  if (!fs.existsSync(p)) {
    throw new UserError(`${kind === "poseidon" ? "HTLCPoseidonV2" : "HTLC"} artifact not found at ${p}; run "npx hardhat compile" in eth/ first`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const htlcInterface = (kind = "sha256") => new ethers.Interface(loadArtifact(kind).abi);
/** REVIEW-3 F1: keccak256 of the local artifact's runtime code: the one code hash this tool accepts for the contract of this lock kind. */
function artifactCodeHash(kind = "sha256") {
  return ethers.keccak256(loadArtifact(kind).deployedBytecode);
}
/** The lock word of a decoded Locked event / getLock record: `lockAddr` for HTLCPoseidonV2, `hashlock` for HTLC.sol. */
const lockWordOf = (kind, obj) => (kind === "poseidon" ? obj.lockAddr : obj.hashlock);
/** Addr(secret) as the 0x bytes32 the poseidon contract compares: computed LOCALLY with the JavaScript port (tied to the vendor crate by the vectors test). */
function localAddr(secretHex) {
  const { addr } = require("./poseidon/poseidon2b.js");
  return "0x" + Buffer.from(addr(Buffer.from(secretHex.slice(2), "hex"))).toString("hex");
}
/** The word a preimage must produce for a lock of this kind (SHA-256, or Addr). */
function localLockWord(kind, secretHex) {
  return kind === "poseidon" ? localAddr(secretHex) : ethers.sha256(secretHex).toLowerCase();
}
function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
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
  const tipWei = priorityFlag(args);
  if (args.mainnet !== true) {
    if (args.maxFeeGwei !== undefined) throw new UserError("--max-fee-gwei is only accepted together with --mainnet (a test network does not take a fee cap); refusing");
    if (tipWei !== null && args.gasPriceGwei === undefined) {
      throw new UserError("--priority-fee-gwei needs a fee cap to sit under (--max-fee-gwei with --mainnet, or --gas-price-gwei on a test network); refusing");
    }
    return { mainnet: false, capWei: null, tipWei };
  }
  if (args.allowChainId !== undefined) throw new UserError("--mainnet cannot be combined with --allow-chain-id (mainnet and other chains are never mixed); refusing");
  if (args.gasPriceGwei !== undefined) throw new UserError("--mainnet cannot be combined with --gas-price-gwei; --max-fee-gwei is the only fee setting on mainnet; refusing");
  const s = String(need(args, "maxFeeGwei", "max-fee-gwei"));
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new UserError("--max-fee-gwei must be a positive decimal number of gwei (at most 9 decimals)");
  const capWei = ethers.parseUnits(s, "gwei");
  if (capWei === 0n) throw new UserError("--max-fee-gwei must be > 0");
  if (tipWei !== null && tipWei > capWei) throw tipAboveCap(tipWei, capWei);
  return { mainnet: true, capWei, tipWei };
}

/** --priority-fee-gwei (optional): the tip in wei, or null when absent. Same strictness as --max-fee-gwei. */
function priorityFlag(args) {
  if (args.priorityFeeGwei === undefined) return null;
  const s = String(args.priorityFeeGwei);
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new UserError("--priority-fee-gwei must be a positive decimal number of gwei (at most 9 decimals)");
  const tipWei = ethers.parseUnits(s, "gwei");
  if (tipWei === 0n) throw new UserError("--priority-fee-gwei must be > 0");
  return tipWei;
}
function tipAboveCap(tipWei, capWei) {
  return new UserError(`--priority-fee-gwei ${ethers.formatUnits(tipWei, "gwei")} gwei is above the fee cap ${ethers.formatUnits(capWei, "gwei")} gwei; the tip cannot exceed the cap; refusing`);
}

/** Under --mainnet, lock / claim / refund must be tied to a swap file; there is no fallback to bare flags. */
function requireSwapOnMainnet(args) {
  if (args.mainnet === true && (args.swap === undefined || args.swap === null || args.swap === "")) {
    throw new UserError("--mainnet requires --swap FILE for lock, claim and refund (the file's chain, profile and pending intent are checked); refusing");
  }
}

function feeOverrides(args) {
  const { mainnet, capWei, tipWei } = mainnetFlags(args);
  // On mainnet the cap is the maxFeePerGas; the tip is --priority-fee-gwei when given (never above the cap, checked by mainnetFlags),
  // else at most 1 gwei and never above the cap.
  if (mainnet) return { maxFeePerGas: capWei, maxPriorityFeePerGas: tipWei !== null ? tipWei : capWei < GWEI ? capWei : GWEI };
  if (args.gasPriceGwei === undefined) return {};
  const s = String(args.gasPriceGwei);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new UserError("--gas-price-gwei must be a positive decimal number");
  const max = ethers.parseUnits(s, "gwei");
  if (max === 0n) throw new UserError("--gas-price-gwei must be > 0");
  if (tipWei !== null && tipWei > max) throw tipAboveCap(tipWei, max);
  // EIP-1559 fields: the override is the max fee; the tip is --priority-fee-gwei when given, else capped at 1 gwei.
  return { maxFeePerGas: max, maxPriorityFeePerGas: tipWei !== null ? tipWei : max < GWEI ? max : GWEI };
}

/**
 * REVIEW-4 R4-1: refuse a fee cap that the next few blocks can outrun. `mult` is 2 for a claim (it publishes the secret, so it
 * must not get stuck) and for a replacement, 1 for lock / refund. Applies in --dry-run too. Returns the report that is
 * printed ({ baseFeeGwei, maxFeeGwei, ratio, minRatio }), or null when no cap was chosen (the node then prices the
 * transaction itself at 2 x base fee + tip) or the chain has no base fee and is not mainnet.
 */
async function checkFeeCap(provider, fees, mult, mainnet, why, flagTip = null) {
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
  // The tip that will be used, and what one gas will really cost at this base fee: min(cap, base fee + tip). The balance check stays at the cap.
  const tip = fees.maxPriorityFeePerGas;
  if (tip !== undefined && tip !== null) {
    report.priorityFeeGwei = ethers.formatUnits(tip, "gwei");
    report.expectedGasPriceGwei = ethers.formatUnits(base + tip < cap ? base + tip : cap, "gwei");
  }
  if (cap < mult * base) {
    throw new UserError(
      `refusing: the fee cap ${report.maxFeeGwei} gwei is below ${mult} x the latest base fee (base fee ${report.baseFeeGwei} gwei in block ${blk.number}; ` +
        `cap / base fee = ${report.ratio}, the minimum is ${mult}): ${why}. Give a higher --max-fee-gwei (mainnet) or --gas-price-gwei`
    );
  }
  // Floor for a typed tip (flagTip is the --priority-fee-gwei value, null without the flag): a tenth of the base fee, rounded up to a whole
  // wei. A mistyped tip (0.0001 for 0.01) would leave the transaction pending, and a lock cannot be replaced. Not applied to the tip a
  // replacement chooses (replacePlan passes no flagTip: it never tips less than min(cap, 1 gwei)), nor to deploy and send, which read no base fee.
  // The floor is never above the tip the tool would use without the flag, min(cap, 1 gwei): at a base fee above 10 gwei a typed 1 gwei
  // stays allowed, so the floor only ever stops a tip smaller than the default.
  if (flagTip !== null) {
    const tenth = (base + 9n) / 10n;
    const noFlagTip = cap < GWEI ? cap : GWEI;
    const floor = tenth < noFlagTip ? tenth : noFlagTip;
    report.minPriorityFeeGwei = ethers.formatUnits(floor, "gwei");
    if (flagTip < floor) {
      throw new UserError(
        `refusing: --priority-fee-gwei ${ethers.formatUnits(flagTip, "gwei")} gwei is below a tenth of the latest base fee (${report.baseFeeGwei} gwei in block ${blk.number}): ` +
          `such a tip can leave the transaction pending; give at least ${report.minPriorityFeeGwei} gwei or drop the flag; refusing`
      );
    }
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
    const fromRaw = (hit) => ({
      hash: hit.hash,
      to: hit.to,
      data: hit.input !== undefined ? hit.input : hit.data,
      maxFeePerGas: hit.maxFeePerGas ? BigInt(hit.maxFeePerGas) : null,
      maxPriorityFeePerGas: hit.maxPriorityFeePerGas ? BigInt(hit.maxPriorityFeePerGas) : null,
      gasPrice: hit.gasPrice ? BigInt(hit.gasPrice) : null,
    });
    try {
      const pb = await provider.send("eth_getBlockByNumber", ["pending", true]);
      const hit = pb && Array.isArray(pb.transactions) ? pb.transactions.find((x) => x && typeof x === "object" && sameAddr(x.from, from) && BigInt(x.nonce) === BigInt(nonce)) : null;
      if (hit) t = fromRaw(hit);
    } catch {
      /* a node without a pending block */
    }
    if (!t) {
      // REVIEW-5 R5-2: a transaction priced under the base fee is usually absent from the pending block; geth-style nodes list
      // the whole pool of one sender under txpool_contentFrom (pending: { "<nonce>": tx }).
      try {
        const pool = await provider.send("txpool_contentFrom", [from]);
        const hit = pool && pool.pending ? pool.pending[String(nonce)] : null;
        if (hit && typeof hit === "object" && (hit.from === undefined || sameAddr(hit.from, from)) && BigInt(hit.nonce) === BigInt(nonce)) t = fromRaw(hit);
      } catch {
        /* no txpool namespace on this node */
      }
    }
  }
  if (t && t.data === undefined) t.data = "0x";
  return t;
}

/**
 * REVIEW-5 R5-2: find and identify the transaction a --replace would replace. The signer's OLDEST pending nonce must hold a
 * pending transaction that is this very call (`name` of this lock at this contract): it is looked for by --replace-tx HASH, else in the
 * node's pending block and pool. When it cannot be found, or is something else, the command refuses (never "whatever sits at the
 * oldest nonce": a key shared between swaps could cancel another swap's claim or lock). Returns { from, nonce, old }.
 */
async function resolveReplaced(provider, signer, args, { name, contractAddr, lockId }) {
  const from = await signer.getAddress();
  const [latestN, pendingN] = await Promise.all([provider.getTransactionCount(from, "latest"), provider.getTransactionCount(from, "pending")]);
  if (pendingN <= latestN) {
    throw new UserError(`--replace: ${from} has no pending transaction (latest nonce ${latestN} = pending nonce ${pendingN}); nothing to replace; refusing (send the ${name} without --replace)`);
  }
  const nonce = latestN;
  const old = await findPendingTx(provider, args, from, nonce);
  if (!old) {
    throw new UserError(
      `--replace: the pending transaction of ${from} at nonce ${nonce} could not be shown by this node (one priced under the base fee is often missing from its pending block), ` +
        `so it cannot be checked to be this ${name} of lock ${lockId}; give --replace-tx HASH (the hash printed when it was sent); refusing`
    );
  }
  let parsed = null;
  try {
    parsed = htlcInterface(kindOf(args)).parseTransaction({ data: old.data });
  } catch {
    /* not an HTLC call */
  }
  if (!old.to || !sameAddr(old.to, contractAddr) || !parsed || parsed.name !== name || String(parsed.args[0]).toLowerCase() !== lockId.toLowerCase()) {
    throw new UserError(`--replace: the pending transaction at nonce ${nonce} is not a ${name} of lock ${lockId} at ${contractAddr}; replacing it would cancel something else; refusing`);
  }
  return { from, nonce, old };
}

/**
 * REVIEW-4 R4-1: --replace. Re-send the SAME call at the signer's OLDEST pending nonce with both fee fields raised by at
 * least 12.5 % and the cap at least 2 x the latest base fee. Refuses when the signer has nothing pending, or when the pending
 * transaction there is not found and identified as this very call (claim / refund of this lock; R5-2). Never a second nonce.
 * `resolved` is the result of resolveReplaced when the caller has it already. Returns { fees, report }.
 */
async function replacePlan(provider, signer, args, ctx, resolved) {
  const { mainnet } = mainnetFlags(args);
  const { nonce, old } = resolved || (await resolveReplaced(provider, signer, args, ctx));
  const blk = await latestBlock(provider);
  const base = blk.baseFeePerGas;
  if ((base === null || base === undefined) && mainnet) throw new UserError("refusing: the latest block carries no baseFeePerGas, so the replacement fee cannot be checked against it");
  const minByBase = 2n * (base || 0n);
  const oldCap = old.maxFeePerGas !== null && old.maxFeePerGas !== undefined ? old.maxFeePerGas : old.gasPrice;
  const oldTip = old.maxPriorityFeePerGas !== null && old.maxPriorityFeePerGas !== undefined ? old.maxPriorityFeePerGas : old.gasPrice;
  const minCap = oldCap !== null && bumped(oldCap) > minByBase ? bumped(oldCap) : minByBase;
  const minTip = oldTip !== null ? bumped(oldTip) : 0n;
  const given = feeOverrides(args);
  const { tipWei: flagTip } = mainnetFlags(args);
  let cap;
  let tip;
  if (given.maxFeePerGas !== undefined) {
    cap = given.maxFeePerGas;
    // A replacement is a rescue, so it never tips less than the rule that applies without the flag, min(cap, 1 gwei): a small
    // --priority-fee-gwei is not used here. The tip is the larger of (the flag, if given, and that rule) and the old tip + 12.5 %.
    // Both the flag (checked in mainnetFlags / feeOverrides) and the rule are at most the cap. The old tip + 12.5 % cannot pass the
    // cap either: a pending transaction has old tip <= old cap, and the cap was already required to be >= old cap + 12.5 % (below).
    // So the last refusal in this branch is a safeguard that no valid pending transaction reaches.
    const rule = cap < GWEI ? cap : GWEI;
    const asked = flagTip !== null && flagTip > rule ? flagTip : rule;
    tip = asked > minTip ? asked : minTip;
    if (cap < minCap) {
      throw new UserError(
        `--replace: the new fee cap ${ethers.formatUnits(cap, "gwei")} gwei is below the minimum ${ethers.formatUnits(minCap, "gwei")} gwei ` +
          `(the larger of 2 x the latest base fee ${ethers.formatUnits(base || 0n, "gwei")} gwei and the old cap ${oldCap === null ? "unknown" : ethers.formatUnits(oldCap, "gwei") + " gwei"} + 12.5 %); refusing`
      );
    }
    if (tip > cap) throw new UserError(`--replace: the replacement tip ${ethers.formatUnits(tip, "gwei")} gwei (the larger of min(cap, 1 gwei), the given tip and the old tip + 12.5 %) is above the fee cap ${ethers.formatUnits(cap, "gwei")} gwei; give a higher cap; refusing`);
  } else {
    tip = minTip > GWEI ? minTip : GWEI;
    cap = minCap > minByBase + tip ? minCap : minByBase + tip;
  }
  const feeCheck = await checkFeeCap(provider, { maxFeePerGas: cap, maxPriorityFeePerGas: tip }, 2n, mainnet, FEE_WHY.claim);
  const report = {
    feeCheck,
    replace: {
      nonce,
      replacesTx: old.hash ? old.hash : null,
      oldFeeKnown: true,
      oldMaxFeeGwei: oldCap === null ? null : ethers.formatUnits(oldCap, "gwei"),
      oldTipGwei: oldTip === null ? null : ethers.formatUnits(oldTip, "gwei"),
      newMaxFeeGwei: ethers.formatUnits(cap, "gwei"),
      newTipGwei: ethers.formatUnits(tip, "gwei"),
    },
  };
  return { fees: { maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce }, report };
}

/** Fees and report for one signing call: the --replace plan, or the cap checked against the base fee. `resolved`: see replacePlan. */
async function feePlan(provider, signer, args, { name, contractAddr, lockId }, resolved) {
  if (args.replaceTx !== undefined && args.replace !== true) throw new UserError("--replace-tx needs --replace; refusing");
  if (args.replace === true) {
    if (name !== "claim" && name !== "refund") throw new UserError("--replace exists for claim and refund only; refusing");
    return replacePlan(provider, signer, args, { name, contractAddr, lockId }, resolved);
  }
  if (args.replace !== undefined && args.replace !== false) throw new UserError("--replace is a flag without a value");
  const fees = feeOverrides(args);
  const { mainnet, tipWei } = mainnetFlags(args);
  const feeCheck = await checkFeeCap(provider, fees, name === "claim" ? 2n : 1n, mainnet, name === "claim" ? FEE_WHY.claim : FEE_WHY.other, tipWei);
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

/**
 * The timestamp of a mined block, for the record only. A public endpoint can lag for a moment right after a block is mined and answer
 * null for it, so the read is retried a few times (5 tries, 2 s apart); nothing is ever re-sent. Still unknown: timestamp null and a note
 * that says why, plus one line on stderr.
 */
async function readBlockTimestamp(provider, blockNumber, { tries = 5, delayMs = 2000 } = {}) {
  const wait = delayMs === undefined ? 2000 : Number(delayMs);
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((res) => setTimeout(res, wait));
    try {
      const b = await provider.getBlock(blockNumber);
      if (b) return { timestamp: b.timestamp, note: null };
    } catch {
      // treated like a block the node does not serve yet
    }
  }
  const note = "block not served by the node yet";
  process.stderr.write(`note: the timestamp of block ${blockNumber} is not known (${note}); the result records blockTimestamp null\n`);
  return { timestamp: null, note };
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
const SECRET_MAY_BE_OUT = new Set(["BadCalldataLength", "InsufficientGas", "TimelockExpired", "InvalidPreimage", "TransferFailed"]);
function explain(e) {
  // A redirect answer refused by makeProvider: its message is complete and carries no part of the configured URL.
  if (isRedirectAnswer(e)) return e.message;
  // HTLCPoseidonV2's errors are those of HTLC.sol plus two, so its interface reads both; HTLC.sol's is the fallback.
  const ifaces = [];
  for (const kind of ["poseidon", "sha256"]) {
    try {
      ifaces.push(htlcInterface(kind));
    } catch {
      /* artifact missing: try the other, then the plain message */
    }
  }
  const candidates = [e && e.data, e && e.error && e.error.data, e && e.info && e.info.error && e.info.error.data];
  for (const d of candidates) {
    const data = typeof d === "string" ? d : d && typeof d.data === "string" ? d.data : null;
    if (data) {
      for (const iface of ifaces) {
        try {
          const parsed = iface.parseError(data);
          if (parsed) {
            // A claim that reverted has still put the secret into a transaction the network may have seen: the lock stays claimable, resend.
            const note = SECRET_MAY_BE_OUT.has(parsed.name) && parsed.name !== "InvalidPreimage" ? " (a claim transaction carries the secret: treat it as possibly public)" : "";
            return `contract reverted: ${parsed.name}()${note}`;
          }
        } catch {
          /* not one of this interface's */
        }
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
    ...(req.maxPriorityFeePerGas !== undefined && req.maxPriorityFeePerGas !== null ? { priorityFeeGwei: ethers.formatUnits(req.maxPriorityFeePerGas, "gwei") } : {}),
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

/** The balance must cover value + gasLimit x fee cap (the cap given, else the node's suggestion), checked before anything is signed. */
async function requireFundsFor(provider, from, req, gasLimit) {
  let cap = req.maxFeePerGas !== undefined ? req.maxFeePerGas : req.gasPrice;
  if (cap === undefined || cap === null) {
    const fd = await provider.getFeeData();
    cap = fd.maxFeePerGas !== null && fd.maxFeePerGas !== undefined ? fd.maxFeePerGas : fd.gasPrice;
  }
  if (cap === undefined || cap === null) return;
  const need = (req.value || 0n) + gasLimit * cap;
  const bal = await provider.getBalance(from);
  if (bal < need) {
    throw new UserError(
      `refusing: the sender ${from} holds ${ethers.formatEther(bal)} ETH but gas limit ${gasLimit} x fee cap ${ethers.formatUnits(cap, "gwei")} gwei (+ value ${ethers.formatEther(req.value || 0n)} ETH) = ${ethers.formatEther(need)} ETH must be available, ` +
        `or the claim would not be sent at all (unused gas is not charged)`
    );
  }
}

// ------------------------------------------------ no library retry for the claim's send
// ethers re-sends a request by itself when the endpoint answers HTTP 429 (a backoff or the `retry-after` value, up to the request's 300 s timeout).
// For a read that is fine. For the request that carries the signed claim it is not: a throttled first attempt was never accepted by the node, so the
// library's repeat minutes later would be the real publication, possibly after the reveal cutoff. `execute` therefore sets `sendGuard.noRetry` for
// that one send; the provider built by `makeProvider` has a `retryFunc` that reads it (`_getConnection()` hands out clones of the request, and
// `clone()` copies the retry function, so the closure over this shared object reaches every clone). Every other request keeps the retry.
// A provider not built by `makeProvider` (an in-process node in a test) has no such function: the switch is simply unused.
// Redirects: when an endpoint answers 301, 302, 307 or 308 the library builds a NEW request for the address the answer names (`redirect()`), and that
// new request has neither this retry function nor the wrapper below. If the second endpoint then answered 429, the library would repeat the signed
// claim by itself, late, unseen. So a provider from `makeProvider` never reaches that branch: its `getUrlFunc` turns every 3xx answer into an error
// (REDIRECT_REFUSED) before the library looks at the status. `clone()` copies `getUrlFunc` as well, so the wrapper reaches every clone. This tool
// follows no redirect, for a read or for the send; the operator puts the endpoint's final address into ETH_RPC_URL.
const sendGuard = { noRetry: false };

/** The error a provider from `makeProvider` throws for an HTTP 3xx answer. It carries no part of the configured URL or of the address the answer names. */
class RedirectRefused extends Error {
  constructor(statusCode, locationScheme) {
    super(
      `the endpoint answered with a redirect (HTTP ${statusCode}${locationScheme ? `, to an ${locationScheme}:// address` : ""}); this tool never follows redirects: ` +
        `put the endpoint's final URL in ETH_RPC_URL.`
    );
    this.name = "RedirectRefused";
    this.code = "REDIRECT_REFUSED";
    this.statusCode = statusCode;
  }
}

/** The provider the command line uses: a JSON-RPC provider over HTTP whose automatic retry on HTTP 429 is switched off while `sendGuard.noRetry` is set, and that follows no redirect. */
function makeProvider(url) {
  const request = new ethers.FetchRequest(url);
  request.retryFunc = async () => !sendGuard.noRetry;
  const inner = request.getUrlFunc; // the getter returns the library's default when none is set
  request.getUrlFunc = async (req, signal) => {
    const resp = await inner(req, signal);
    if (resp && resp.statusCode >= 300 && resp.statusCode <= 399) {
      // Only the scheme of the address named is kept: the rest (host, path, query) can hold an API key.
      const m = /^(https?):\/\//i.exec(String((resp.headers && resp.headers.location) || ""));
      throw new RedirectRefused(resp.statusCode, m ? m[1].toLowerCase() : null);
    }
    return resp;
  };
  return new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
}

/** True when the error is the endpoint's HTTP 429 answer (a server error of the library with that status). */
function isThrottledAnswer(e) {
  return !!e && e.code === "SERVER_ERROR" && !!e.response && e.response.statusCode === 429;
}

/** True when the error is the refusal of a redirect answer by a provider from `makeProvider`. */
function isRedirectAnswer(e) {
  return !!e && e.code === "REDIRECT_REFUSED";
}

/**
 * Dry-run or send one transaction. Returns { dry: true, out } or
 * { dry: false, resp, receipt, chainId, from }. Never includes keys.
 * opts.hideData: the calldata carries the secret, so a dry run prints its length only.
 * opts.fees: fee fields (and nonce) already chosen and checked by feePlan; else the command's own flags.
 * opts.preSend: optional async guard, run once everything is prepared and immediately before the transaction is signed and broadcast
 * (never in a dry run). If it throws, nothing is sent. It is called with the populated transaction (nonce, fees, chain id filled in). The claim uses it
 * to re-check the reveal cutoff after the slow steps and to write the reveal sidecar (T21-11) just before the broadcast.
 * opts.lastCheck: optional SYNCHRONOUS guard, only together with opts.preSend; if it throws, nothing is sent. With a local key (an ethers.BaseWallet)
 * the transaction is signed locally after preSend, lastCheck runs, and the very next call hands the signed bytes to `provider.broadcastTransaction`:
 * nothing but the local signature and this synchronous check sits between the sidecar and the bytes going to the node. With any other signer it runs
 * just before `signer.sendTransaction`, which does its own network reads before it broadcasts, so the check is weaker there.
 * opts.afterSend: optional callback (it must not throw), run as soon as the broadcast call has returned or thrown, before the wait for the
 * receipt (only together with opts.preSend). The claim uses it to release its lock file (see takeClaimLock).
 */
async function execute(provider, signer, args, tx, extra = {}, opts = {}) {
  const chainId = await assertAllowedChain(provider, args);
  const { mainnet, capWei } = mainnetFlags(args);
  const from = await signer.getAddress();
  const req = { ...tx, ...(opts.fees || feeOverrides(args)) }; // opts.fees: the checked / replacement fees (and nonce) of feePlan
  // opts.fixedGas (the poseidon claim): the gas limit is chosen by the tool and nothing is ever estimated, because an estimate would send the
  // calldata (the secret) to the node before the claim itself (review V2-6). The limit is also what the balance must cover at the fee cap.
  const fixedGas = opts.fixedGas !== undefined && opts.fixedGas !== null ? BigInt(opts.fixedGas) : null;
  if (fixedGas !== null) req.gasLimit = fixedGas;
  // opts.preSend is a guard that must be the LAST thing before the broadcast. Without a fixed gas limit the gas estimate (a network read, which
  // would also send the calldata, i.e. the secret, to the node) runs inside sendTransaction, after the guard: refuse such a caller outright.
  if (typeof opts.preSend === "function" && fixedGas === null) {
    throw new Error("execute: opts.preSend requires opts.fixedGas (otherwise a gas estimate would run between the guard and the broadcast)");
  }
  // A replacement is estimated against the LATEST state, without its nonce: the pool state (the pending transaction it
  // replaces, e.g. the very claim) would make a pending-state estimate revert (AlreadyClaimed) on some nodes.
  const replacing = req.nonce !== undefined;
  const estimate = async () => {
    if (fixedGas !== null) return fixedGas;
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
  if (fixedGas !== null && !mainnet) await requireFundsFor(provider, from, req, fixedGas);
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
      ...(fixedGas !== null ? { gasLimit: gas.toString(), gasEstimate: null, gasEstimateNote: "not estimated: a fixed gas limit is used and the calldata is never sent to the node before the transaction" } : { gasEstimate: gas.toString() }),
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
  let toSend = req;
  let resp;
  if (typeof opts.preSend === "function") {
    // Fill nonce, chain id and fees first, so that no network read is left between the guard and the broadcast. Only with a fixed gas limit: then
    // nothing is estimated and the calldata (the secret) goes to the node only inside the transaction itself.
    if (fixedGas !== null && typeof signer.populateTransaction === "function") toSend = await signer.populateTransaction(req);
    await opts.preSend(toSend);
    const sendVia = signer.provider || provider;
    if (signer instanceof ethers.BaseWallet && sendVia && typeof sendVia.broadcastTransaction === "function") {
      // A local key: sign here (local work, no network) and hand the signed bytes to the node ourselves. `signer.sendTransaction` would populate
      // the transaction a second time, and that re-detects the network (an eth_chainId request with a long timeout) before anything is signed
      // or sent: a stalled endpoint could then delay the broadcast past the cutoff after every check had passed.
      const raw = await signer.signTransaction(toSend);
      // Nothing but the synchronous check below may sit between the last cutoff check and the call that sends the bytes: no await, no other call.
      // The send is one HTTP request and the library never repeats it: the library's own retry (it re-sends a request by itself when the endpoint
      // answers HTTP 429, with a backoff, for up to the request's 300 s timeout) is switched off for this one send (see sendGuard). A throttled
      // first attempt was never accepted by the node, so a repeat minutes later would be the real publication, long after the last check; instead
      // the send fails and the claim says so. What remains, and is NOT fixed here (TASKS.md T21-17): the request's own duration. The node has the
      // bytes as soon as the request is delivered, but a stalled connection can delay the delivery, and that delay has no firm bound: the
      // library's 300 s is an inactivity timer on the socket (any traffic resets it), the name lookup and the connect have no library timeout,
      // and on a timeout the library rejects without aborting the request. A redirect answer (301, 302, 307, 308, or any 3xx) is NOT followed by
      // a provider from `makeProvider`: it becomes an error (REDIRECT_REFUSED), so the signed bytes are offered to the one endpoint only.
      if (typeof opts.lastCheck === "function") opts.lastCheck();
      sendGuard.noRetry = true;
      try {
        resp = await sendVia.broadcastTransaction(raw);
      } finally {
        sendGuard.noRetry = false; // the receipt polling after the send keeps the library's normal retry behaviour
        if (typeof opts.afterSend === "function") opts.afterSend(); // the send has settled (answered or failed): the claim lock is let go here, not after the receipt wait
      }
    } else {
      // Any other signer (a node-held account, a hardware or remote signer) does its own network reads inside `sendTransaction` before it
      // broadcasts, so the last check is weaker here. The command line always uses a local key (`loadSigner` builds an ethers.Wallet).
      // The library's retry on HTTP 429 is off for the whole call here too (it covers those reads as well).
      if (typeof opts.lastCheck === "function") opts.lastCheck();
      sendGuard.noRetry = true;
      try {
        resp = await signer.sendTransaction(toSend);
      } finally {
        sendGuard.noRetry = false;
        if (typeof opts.afterSend === "function") opts.afterSend();
      }
    }
  } else {
    resp = await signer.sendTransaction(toSend);
  }
  // The hash is shown before the wait: a stuck transaction needs it for --replace-tx. (The command line sets onSent.)
  if (typeof args.onSent === "function") args.onSent({ hash: resp.hash, nonce: resp.nonce, maxFeePerGas: resp.maxFeePerGas, maxPriorityFeePerGas: resp.maxPriorityFeePerGas });
  let receipt;
  try {
    receipt = await resp.wait(confirmationsOf(args));
  } catch (e) {
    // ethers 6 turns a status-0 receipt into CALL_EXCEPTION with the receipt attached (`data` is null: the reason is not decoded). Keep the hash.
    if (e && e.code === "CALL_EXCEPTION" && e.receipt && e.receipt.status === 0) throw new RevertedTx(resp.hash, e.receipt);
    throw e;
  }
  if (!receipt || receipt.status !== 1) throw new RevertedTx(resp.hash, receipt);
  return { dry: false, resp, receipt, chainId, from };
}

// ------------------------------------------------ the swap file (REVIEW-3 F3)
function profileOf(v) {
  if (v === undefined) return "production";
  if (typeof v !== "string" || v === "") throw new UserError("swap file profile must be a non-empty string");
  return v;
}

// ------------------------------------------------ the producer screen's memory (T21)
// Bob's tool (`swap-cli tick`) keeps a screen on who produces the Parano1d blocks. A tick that sees two honest nodes disagree on a block's
// producer remembers it: the marker file `<swap file>.producer-differs` and, from `tick --apply`, the history entry `producer_differs_seen`.
// Under `production` the tool then refuses to offer the lock. But an intent recorded by an EARLIER tick stays pending, and this script used to
// check only the intent, so the lock still went out. `lock` therefore reads the same memory itself: pure local file reads, before any network
// call, signing or send. It refuses in a dry run too, so that the dry run shows the operator the truth.
// It is a screen, not a defence. The marker is presence only, as in the Rust reader (`producer_marker::read`): a clean "not found" is absent,
// anything else (a file, a directory, a link, an empty or garbage file, a failed lstat) counts as present. Nothing is parsed here.
const PRODUCER_MARKER_SUFFIX = ".producer-differs";
const PRODUCER_DIFFERS_EVENT = "producer_differs_seen";
const PRODUCER_OVERRIDE_PREFIX = "producer_concentration_overridden";

/** Where the remembered detection is on record for this swap file: { marker: string|null, history: boolean }. Reads nothing but local metadata. */
function producerDetection(sw) {
  const markerPath = sw.file + PRODUCER_MARKER_SUFFIX;
  let marker = null;
  try {
    fs.lstatSync(markerPath);
    marker = `${markerPath} exists`;
  } catch (e) {
    if (!(e && e.code === "ENOENT")) marker = `${markerPath} cannot be examined (${e && e.code ? e.code : "error"}), which counts as present`;
  }
  return { marker, history: sw.producerDiffersSeen === true };
}

/** `lock` only: refuse (production, no override) or warn (override recorded, or any other profile) when the producer screen remembers a detection. */
function checkProducerMemory(sw) {
  const found = producerDetection(sw);
  if (found.marker === null && !found.history) return;
  const evidence = [found.marker === null ? null : `the marker file ${found.marker}`, found.history ? `the swap file's history holds "${PRODUCER_DIFFERS_EVENT}"` : null].filter(Boolean).join(" and ");
  const what = `the producer screen of swap-cli remembers that two Parano1d nodes named different producers for the same block (${evidence})`;
  if (sw.profile !== "production") {
    process.stderr.write(`WARNING: ${what}; under the ${sw.profile} profile this only warns. A screen, not a defence.\n`);
    return;
  }
  if (sw.producerOverridden) {
    process.stderr.write(
      `WARNING: ${what}; this lock goes ahead only because the swap file records the operator's ${PRODUCER_OVERRIDE_PREFIX} (tick --accept-producer-concentration). A screen, not a defence.\n`
    );
    return;
  }
  throw new UserError(
    `refusing: ${what}, and under the production profile that screen refuses the lock. ` +
      "This is a screen, not a defence. Do not send this lock. If nothing was sent, cancel the intent with `swap-cli intent FILE --cancel` (with the same chain flags as tick). " +
      "The way on is `--accept-producer-concentration` on the next `tick --apply` (it is recorded in the swap file and printed on every tick), or ending this swap and starting a new one with a new swap file. Once a `tick --apply` has run, removing the marker does not clear it."
  );
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
      // As swap-cli stores it: `public.params.eth.lock_kind`, absent for `sha256` (the default is not written).
      lockKind: eth.lock_kind === undefined ? "sha256" : String(eth.lock_kind),
      intent: j.pending_intent || null,
      // REVIEW-4 R4-3: swap-cli's own predicate (`secret_may_be_public`): the file shows Alice's claim reached the network.
      secretMayBePublic: Array.isArray(j.history) && j.history.some((h) => h && SECRET_PUBLIC_EVENTS.has(h.event)),
      // The producer screen of swap-cli (T21): its remembered detection is the history entry `producer_differs_seen`; the operator's waiver is an
      // entry whose event starts with `producer_concentration_overridden` (`tick --accept-producer-concentration`). Only `lock` reads them.
      producerDiffersSeen: Array.isArray(j.history) && j.history.some((h) => h && h.event === PRODUCER_DIFFERS_EVENT),
      // The override counts only when its entry comes AFTER the last detection entry (an older override, e.g. for a concentration, must not waive a later disagreement).
      producerOverridden: Array.isArray(j.history) && (() => {
        const ev = j.history.map((h) => (h && typeof h.event === "string" ? h.event : ""));
        const lastDetection = ev.lastIndexOf(PRODUCER_DIFFERS_EVENT);
        return ev.some((e, i) => e.startsWith(PRODUCER_OVERRIDE_PREFIX) && i > lastDetection);
      })(),
      ethFromBlock: j.eth_from_block === undefined || j.eth_from_block === null ? null : uint("swap file eth_from_block", j.eth_from_block),
    };
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`--swap ${abs}: ${e.message}`);
    throw e;
  }
}

// ------------------------------------------------ the reveal sidecar (T21-11)
// `claim --swap FILE` writes `FILE.reveal-sent` just before it broadcasts the claim, so that a reveal which was sent and then dropped (or whose
// process died before any `swap-cli tick` saw it) is still on record: swap-cli and this script read the file as evidence that the secret MAY be
// public (the late re-send cutoff T_reveal - DE applies). It holds the lock id, the signed transaction's hash when it is known before the
// broadcast, and the time; never the secret, a key, or anything of the swap file.
// The rule: the sidecar is durable first, then the send; if it cannot be made durable, nothing is sent. A sidecar that exists without a send
// having been attempted would relax a later cutoff wrongly; a send without a durable sidecar would lose the evidence.
// A NEW sidecar: the bytes go to a temporary file beside it (mode 600, written in a loop until every byte is out, fsynced, closed); a foreign or
// not-a-sidecar file at the final name is moved aside under `.stale-*` (never deleted); the temporary file is published with a hard link (atomic, and
// never over an existing name) or, where hard links are refused, renamed onto the final name (atomic, not exclusive); the directory is synced; the
// final file is read back and compared byte for byte. The final name is never opened for writing, so a half-written file cannot appear there. If any
// step fails, what this call created is removed (it is not evidence: nothing was sent) and the claim is refused; it is removed only if it still
// holds what this call wrote (or debris), never another process's record. A file at the name that cannot be examined or read (an I/O error) is
// never moved aside: it may be a good sidecar, so the claim is refused. Two claims for one swap file at the same time are excluded by the claim
// lock (`FILE.claim-lock`, see takeClaimLock): a real claim with --swap holds it from before the sidecar is read until the send has settled.
// A sidecar of this lock that ALREADY exists is evidence of an earlier attempt and is never deleted or truncated by this code, whatever fails: its
// own bytes are written again through a new temporary file (fsynced, checked) and renamed over it, so that the data and the entry are made
// durable now, whatever happened to the earlier attempt's own flush. If that fails, the claim is refused and the old file stays.
// Limits, stated plainly: the read-back is served from the page cache, so it catches a short or corrupted write but does not prove what is on the
// disk. On Windows (Node, measured on local NTFS and on a `\\wsl.localhost` share alike) fsync on a handle opened for writing succeeds, a directory
// cannot be flushed at all, and whether a successful fsync through the share reaches the disk inside the Linux VM is not known: there the
// durability is best effort.
const REVEAL_SIDECAR_SUFFIX = ".reveal-sent";
const REVEAL_SIDECAR_MAX_BYTES = 4096;
const revealSidecarPath = (swapFile) => String(swapFile) + REVEAL_SIDECAR_SUFFIX;
const codeOf = (e) => (e && e.code ? e.code : "error");

// ------------------------------------------------ the claim lock
// A real `claim --swap FILE` holds `FILE.claim-lock` while it can touch the sidecar and send: from before the sidecar is first read until the send has
// settled (the broadcast call returned or threw, or something before it threw). Without it two claims for one swap file could lose each other's
// sidecar: one publishes it and sends, the other's rename overwrites it, and that one's later refusal removes it again. The lock is created
// exclusively (an existing name is never replaced); it holds one small JSON line (version, pid, Unix seconds): nothing secret.
// It fails CLOSED. If the file exists, or cannot be created for any other reason, the claim refuses before it reads or writes anything beside the swap
// file. A lock is never taken over, deleted or judged stale here, not by the pid and not by the age: a claim that died leaves its lock, and the
// operator removes it by hand once sure that no other claim for this swap is running. It is not held while the receipt is awaited, so a
// `claim --replace-tx` from another terminal is possible then. A dry run takes no lock (it writes nothing).
const CLAIM_LOCK_SUFFIX = ".claim-lock";
const claimLockPath = (swapFile) => String(swapFile) + CLAIM_LOCK_SUFFIX;

/** What the lock file at `file` says about its holder, for the refusal message (never throws). */
function describeClaimLock(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && Number.isSafeInteger(j.pid) && Number.isSafeInteger(j.at)) return `it records pid ${j.pid}, taken at Unix second ${j.at}`;
  } catch {
    /* unreadable or not our line: say so below */
  }
  return "its content could not be read";
}

/**
 * Take the claim lock of a swap file. Throws a UserError (nothing touched beside the swap file) if it is held or cannot be created. Returns
 * { file, release() }: release() is idempotent, never throws, and removes the file only if it still holds the bytes this call wrote (a failed write
 * of those bytes counts: a prefix of them, even none, is still ours). A release that fails is reported on stderr and changes nothing else.
 */
function takeClaimLock(swapFile) {
  const file = claimLockPath(swapFile);
  const body = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, at: Math.floor(Date.now() / 1000) }) + "\n", "utf8");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    const how =
      e && e.code === "EEXIST"
        ? `another claim for this swap file is running, or an earlier one died: the lock file ${file} exists (${describeClaimLock(file)})`
        : `the lock file ${file} could not be created (${codeOf(e)}), so it is not known whether another claim for this swap file is running`;
    throw new UserError(
      `refusing: ${how}. Nothing was read or written beside the swap file and nothing was sent. If you are sure that no other claim for this swap file is running, ` +
        `delete ${file} by hand and run the claim again; this tool never removes a lock it did not make`
    );
  }
  try {
    writeAllSync(fd, body);
    fs.fsyncSync(fd);
  } catch {
    /* best effort: the file's existence is the lock, its content only helps the operator */
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nothing to do */
    }
  }
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        const got = fs.readFileSync(file);
        if (got.length <= body.length && body.subarray(0, got.length).equals(got)) fs.unlinkSync(file);
        else process.stderr.write(`warning: the claim lock ${file} now holds another record and was left in place\n`);
      } catch (e) {
        if (e && e.code === "ENOENT") return; // already gone
        process.stderr.write(`warning: the claim lock ${file} could not be removed (${codeOf(e)}); delete it by hand before the next claim for this swap file\n`);
      }
    },
  };
}

/**
 * Judge the text of a sidecar for this lock (the one rule used by the reader and by the re-publish). state: "matching" (this lock: evidence),
 * "foreign" (another lock id: ignored) or "unreadable" (not a sidecar this tool wrote: ignored).
 */
function classifyRevealSidecarText(text, want, file) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { state: "unreadable", file, note: `${file} is not valid JSON; it is ignored` };
  }
  const okShape =
    j !== null &&
    typeof j === "object" &&
    j.version === 1 &&
    typeof j.lock_id === "string" &&
    /^[0-9a-f]{64}$/.test(j.lock_id) &&
    (j.tx_hash === null || (typeof j.tx_hash === "string" && /^[0-9a-f]{64}$/.test(j.tx_hash))) &&
    Number.isSafeInteger(j.at) &&
    j.at >= 0;
  if (!okShape) return { state: "unreadable", file, note: `${file} does not have the reveal sidecar's fields; it is ignored` };
  if (j.lock_id !== want) {
    return { state: "foreign", file, note: `${file} belongs to another lock (${j.lock_id}), not this swap's ${want}; it is ignored` };
  }
  return { state: "matching", file, txHash: j.tx_hash, at: j.at };
}

/**
 * Read the sidecar of a swap file for this lock. state: "absent", "matching" (this lock: evidence), "foreign" (another lock id: ignored) or
 * "unreadable" (not a sidecar this tool wrote: ignored). Read-only; never throws for a bad file.
 * An "unreadable" result with io: true (and the error code) means the file could not be examined or read at all: an I/O problem, not bad content.
 * Readers ignore it like any unreadable file, but it may be a good sidecar of this lock, so the writer refuses to move it aside.
 */
function readRevealSidecar(swapFile, lockId) {
  const file = revealSidecarPath(swapFile);
  const want = String(lockId).toLowerCase().replace(/^0x/, "");
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent", file };
    return { state: "unreadable", io: true, code: codeOf(e), file, note: `the reveal sidecar ${file} cannot be examined (${codeOf(e)}); it is ignored` };
  }
  if (!st.isFile() || st.size > REVEAL_SIDECAR_MAX_BYTES) {
    return { state: "unreadable", file, note: `${file} is not a reveal sidecar written by this tool (not a regular file, or too large); it is ignored` };
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { state: "unreadable", io: true, code: codeOf(e), file, note: `the reveal sidecar ${file} could not be read (${codeOf(e)}); it is ignored` };
  }
  return classifyRevealSidecarText(text, want, file);
}

/**
 * Flush a directory entry. With Node on Windows (measured on local NTFS and on a `\\wsl.localhost` share alike) a directory can be opened for
 * reading but fsync on it fails with EPERM, so the entry cannot be flushed from Node there and this returns without doing anything. (fsync on a
 * handle opened for writing succeeds there, on one opened read-only it fails with EPERM.) Whether a successful fsync through the share reaches the
 * disk inside the Linux VM is not known. So on Windows, and above all on the share, the durability of the sidecar is best effort: the data flush is
 * requested and reported successful, the directory entry is not flushed. On Windows EVERY error is ignored here, a failed open included (that is
 * what the code does: the platform check covers the whole try block). Elsewhere a file system that cannot sync a directory (EINVAL, ENOTSUP,
 * ENOSYS, EOPNOTSUPP) is let pass and any other error is thrown.
 */
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (e) {
    if (process.platform === "win32" || (e && ["EINVAL", "ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes(e.code))) return;
    throw e;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Write every byte of `buf` to `fd`. A write that makes no progress (returns 0 or something that is not a count) is an error, never a quiet short file. */
function writeAllSync(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!Number.isInteger(n) || n <= 0 || n > buf.length - off) {
      throw Object.assign(new Error(`write made no progress (returned ${n} with ${buf.length - off} bytes left)`), { code: "ESHORTWRITE" });
    }
    off += n;
  }
}

/** Create `tmp` exclusively (mode 600), write all of `buf`, fsync it, close it. The caller removes `tmp` on failure. */
function writeTmpDurably(tmp, buf) {
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    writeAllSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read `file` back (raw bytes) and require it to equal `buf` byte for byte. Served from the page cache: it catches a short or corrupted write, it does not prove what is on the disk. */
function requireBytes(file, buf, what) {
  const got = fs.readFileSync(file);
  if (!Buffer.isBuffer(got) || !got.equals(buf)) {
    throw Object.assign(new Error(`${what} ${file} does not read back as written`), { code: "EREADBACK" });
  }
}

const sidecarTmpName = (target) => `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* never created, or already gone */
  }
}

/**
 * Take back a sidecar that THIS call created and that must not count as evidence (nothing was sent), and sync the directory (best effort). It is
 * removed only if it still holds exactly the bytes this call wrote, or holds debris that is not a sidecar of any lock (what a short or corrupted
 * write of ours leaves). A file that is a valid sidecar record (of this lock with other bytes, or of another lock) is another process's: it is left
 * where it is. Returns { outcome: "removed" } | { outcome: "other" } | { outcome: "failed", code }.
 */
function removeCreatedRevealSidecar(file, bytes, lockId) {
  const want = String(lockId).toLowerCase().replace(/^0x/, "");
  let res = { outcome: "removed" };
  try {
    let holds = null;
    try {
      holds = fs.readFileSync(file);
    } catch (e) {
      if (e && e.code === "ENOENT") return res; // already gone
      throw e;
    }
    const mine = Buffer.isBuffer(bytes) && Buffer.isBuffer(holds) && holds.equals(bytes);
    const anotherRecord = !mine && ["matching", "foreign"].includes(classifyRevealSidecarText(Buffer.isBuffer(holds) ? holds.toString("utf8") : "", want, file).state);
    if (anotherRecord) {
      res = { outcome: "other" };
    } else {
      fs.unlinkSync(file);
    }
  } catch (e) {
    res = { outcome: "failed", code: codeOf(e) };
  }
  try {
    fsyncDir(path.dirname(path.resolve(file)));
  } catch {
    /* best effort */
  }
  return res;
}

/** What to tell the operator about a sidecar this call had created and then took back (see removeCreatedRevealSidecar). */
function removalFate(res, file) {
  if (res.outcome === "removed") return "the reveal sidecar this call had just written was removed again (nothing was sent, so it is not evidence)";
  if (res.outcome === "other") return `the reveal sidecar ${file} now holds another record and was left in place (it is not this call's)`;
  return `the reveal sidecar ${file} this call had just written could NOT be removed (${res.code}) and stays: delete it by hand, because it would count as evidence of a send that was not made`;
}

/**
 * A sidecar of this lock already exists: it is evidence of an earlier attempt and is never deleted or truncated here. Its own bytes are written
 * again through a new temporary file (fsynced, read back before the swap), renamed over it (atomic), the directory is synced and the result is
 * read back. Any failure leaves the old file where it is and refuses the claim.
 */
function republishRevealSidecar(target, lockHex) {
  const tmp = sidecarTmpName(target);
  try {
    const st = fs.lstatSync(target);
    if (!st.isFile() || st.size > REVEAL_SIDECAR_MAX_BYTES) throw Object.assign(new Error("not a sidecar"), { code: "ENOTSIDECAR" });
    const bytes = fs.readFileSync(target);
    if (bytes.length > REVEAL_SIDECAR_MAX_BYTES || classifyRevealSidecarText(bytes.toString("utf8"), lockHex, target).state !== "matching") {
      throw Object.assign(new Error("the file is no longer a sidecar of this lock"), { code: "ECHANGED" });
    }
    writeTmpDurably(tmp, bytes);
    requireBytes(tmp, bytes, "the new copy"); // before it replaces anything: a bad copy must never take the place of good evidence
    fs.renameSync(tmp, target);
    fsyncDir(path.dirname(path.resolve(target)));
    requireBytes(target, bytes, "the reveal sidecar");
  } catch (e) {
    unlinkQuiet(tmp);
    throw new UserError(
      `refusing: the existing reveal sidecar ${target} could not be made durable again (${codeOf(e)}); it is kept as it is (it is evidence of an earlier attempt and is never deleted); nothing was sent. Fix the directory and retry`
    );
  }
  return { state: "kept", file: target, created: false };
}

/**
 * After `fs.linkSync(tmp, target)` threw: is the file at `target` this call's own link? True when it is the same file as `tmp` (same device and
 * inode, where the file system gives a real inode: not 0) or, where it does not, when its bytes are exactly `body`. The bytes rule is sound because
 * the claim lock excludes every other claim for this swap file, so no other process wrote these bytes (they hold this call's own time and hash); where
 * the lock is not held (a direct call) it is the best that can be said. The caller has just attempted the link, which is what makes the file ours.
 */
function linkIsOurs(tmp, target, body) {
  try {
    const a = fs.statSync(tmp, { bigint: true });
    const b = fs.statSync(target, { bigint: true });
    if (a.ino !== 0n && b.ino !== 0n) return a.dev === b.dev && a.ino === b.ino;
  } catch {
    /* no identity to compare: use the bytes */
  }
  try {
    const got = fs.readFileSync(target);
    return Buffer.isBuffer(got) && got.equals(body);
  } catch {
    return false;
  }
}

/**
 * Record, before the broadcast, that the reveal of `lockId` is about to be sent. Synchronous. Throws a UserError (and the caller then sends
 * nothing) if the sidecar cannot be written and made durable. Returns { state: "written" | "kept", file, created, bytes? }: "written" = this call
 * made the file (bytes = what it wrote); "kept" = a sidecar of this lock was there before (its bytes, so its time and hash, are kept and were
 * written durably again; it is never deleted). created is true only when this call created the file. A file whose CONTENT is not a sidecar of
 * this lock (another lock, bad JSON, wrong fields, not a regular file, too large) is moved aside under `.stale-*`, never deleted; a file that
 * cannot even be examined or read (an I/O error) is neither moved nor deleted: the claim is refused. If a step fails after this call created the
 * file, the file is removed again (only if it still holds what this call wrote or debris, see removeCreatedRevealSidecar): it would otherwise
 * count as evidence of a send that was not made. Two claims for one swap file are excluded by the claim lock the caller holds (see takeClaimLock); the
 * code below still does not rely on that for what it removes (only what holds this call's own bytes).
 */
function writeRevealSidecar(swapFile, lockId, txHash) {
  const target = revealSidecarPath(swapFile);
  const lockHex = String(lockId).toLowerCase().replace(/^0x/, "");
  const hashHex = txHash === null || txHash === undefined ? null : String(txHash).toLowerCase().replace(/^0x/, "");
  const existing = readRevealSidecar(swapFile, lockHex);
  if (existing.state === "matching") return republishRevealSidecar(target, lockHex);
  if (existing.io) {
    // An I/O problem is not bad content: the file may be a good sidecar of this lock, so it must not be hidden under `.stale-*`.
    throw new UserError(
      `refusing: the existing reveal sidecar ${target} could not be examined or read (${existing.code}); it is neither moved nor deleted, because it may be evidence of an earlier attempt; nothing was sent. Fix the directory and retry`
    );
  }
  const at = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ version: 1, lock_id: lockHex, tx_hash: hashHex, at }) + "\n", "utf8");
  const tmp = sidecarTmpName(target);
  let created = false;
  let raced = false;
  try {
    writeTmpDurably(tmp, body);
    if (existing.state !== "absent") {
      // Its content is not a sidecar of this lock: keep it for the operator, out of the way.
      fs.renameSync(target, `${target}.stale-${at}-${crypto.randomBytes(3).toString("hex")}`);
    }
    try {
      // Atomic and exclusive: an existing name is never replaced.
      fs.linkSync(tmp, target);
      created = true;
    } catch (e) {
      if (linkIsOurs(tmp, target, body)) {
        // A link that was made but reported an error (possible on a network file system): the final name IS this call's file. It counts as created by
        // this call, so a later refusal takes it back like any other file of this call. (If it were treated as another process's file, a refusal
        // would keep it as "evidence of an earlier attempt" although nothing was ever sent.)
        created = true;
      } else if (readRevealSidecar(swapFile, lockHex).state === "matching") {
        raced = true; // another process wrote this lock's sidecar a moment ago: it is the evidence, ours is dropped
      } else if (e && e.code === "EEXIST") {
        throw e; // something else sits at the name: never touched
      } else {
        // A file system that refuses hard links (the usual case for a Windows process writing to a `\wsl.localhost` share; also FAT and some
        // mounts; the error code varies): rename the finished temporary file onto the final name. The final name is never opened for writing. A
        // rename is atomic but not exclusive. A foreign sidecar was already moved aside above, and a record of this same lock replaced by a record
        // of this same lock loses nothing but a later `at`. Concurrent claims for one swap file are excluded by the claim lock (takeClaimLock);
        // without it two of them could each replace the other's record, and the one whose read-back then fails would leave the other's record in
        // place (see below) while the other goes on to send.
        fs.renameSync(tmp, target);
        created = true;
      }
    }
    if (!raced) {
      unlinkQuiet(tmp); // after a link; a leftover .tmp would hold the same non-secret fields
      fsyncDir(path.dirname(path.resolve(target)));
      requireBytes(target, body, "the reveal sidecar");
    }
  } catch (e) {
    unlinkQuiet(tmp);
    if (!created) {
      throw new UserError(
        `refusing: the reveal sidecar ${target} could not be written (${codeOf(e)}); nothing was sent. It is written before the claim is broadcast so that a lost reveal stays on record; fix the directory and retry.`
      );
    }
    // Nothing was sent: a sidecar that is not known to be good must not count as evidence later. But only what is ours is removed.
    const res = removeCreatedRevealSidecar(target, body, lockHex);
    if (res.outcome === "other" && e && e.code === "EREADBACK") {
      throw new UserError(
        `refusing: another claim for this swap seems to be running: the reveal sidecar ${target} holds a different record than the one this call wrote; it was left in place; nothing was sent. Two claims for one swap file must never run at the same time`
      );
    }
    const note =
      res.outcome === "other"
        ? ` The file now holds another record and was left in place.`
        : res.outcome === "failed"
          ? ` The half-made file ${target} could not be removed (${res.code}): it stays and must be deleted by hand before retrying, because it would count as evidence of a send that was not made.`
          : "";
    throw new UserError(
      `refusing: the reveal sidecar ${target} could not be written (${codeOf(e)}); nothing was sent. It is written before the claim is broadcast so that a lost reveal stays on record; fix the directory and retry.${note}`
    );
  }
  if (raced) {
    unlinkQuiet(tmp);
    return republishRevealSidecar(target, lockHex);
  }
  return { state: "written", file: target, created: true, bytes: body };
}

/** The hash of the claim as it will be signed, when the signer can show it before the broadcast (a local key; null for any other signer). */
async function presignedHash(signer, populatedTx) {
  if (!(signer instanceof ethers.BaseWallet)) return null;
  try {
    return ethers.Transaction.from(await signer.signTransaction(populatedTx)).hash;
  } catch {
    return null;
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
  // T21: a remembered producer-screen detection beats an intent recorded before it. First thing, local reads only; `lock` only (claim and refund are untouched).
  if (want === "lock_eth") checkProducerMemory(sw);
  const merged = { ...args };
  // The lock kind is the file's; a --lock-kind that says otherwise is refused (the artifact, ABI and checks all follow it).
  if (!LOCK_KINDS.includes(sw.lockKind)) throw new UserError(`--swap ${sw.file}: unknown lock_kind "${sw.lockKind}"; refusing`);
  if (args.lockKind !== undefined && args.lockKind !== sw.lockKind) {
    throw new UserError(`--lock-kind ${args.lockKind} disagrees with the swap file, which is a ${sw.lockKind} swap; refusing`);
  }
  merged.lockKind = sw.lockKind;
  const kind = sw.lockKind;
  if (args.mainnet === true) {
    // Mainnet: the file must be a mainnet production swap, whatever the flags say.
    if (sw.chainId !== 1n) throw new UserError(`--mainnet: the swap file's chain_id is ${sw.chainId}, not 1; refusing`);
    if (sw.profile !== "production") throw new UserError(`--mainnet: the swap file's profile is ${sw.profile}, not production; refusing`);
  }
  merged.chainId = agree("--chain-id", args.chainId, sw.chainId.toString(), sameUint);
  merged.contract = agree("--contract", args.contract, sw.contract, sameAddr);
  // REVIEW-3 F1: the file must pin the code of this repo's artifact; a given --code-hash must agree with the file (and so with the artifact).
  if (sw.codeHash === null) throw new UserError(`--swap ${sw.file}: the file pins no code_hash; refusing`);
  if (sw.codeHash !== artifactCodeHash(kind)) {
    throw new UserError(
      `the swap file pins code_hash ${sw.codeHash}, which is not the local ${kind === "poseidon" ? "HTLCPoseidonV2 " : ""}artifact's ${artifactCodeHash(kind)} (a different value means a different contract); refusing`
    );
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
    if (kind === "poseidon") {
      if (args.hashlock !== undefined) throw new UserError("a poseidon swap locks on a lockAddr: give --lock-addr (or nothing, it is taken from the file), not --hashlock; refusing");
      merged.lockAddr = agree("--lock-addr", args.lockAddr, sw.hashlock, sameAddr);
    } else {
      if (args.lockAddr !== undefined) throw new UserError("--lock-addr belongs to a poseidon swap; this file is a sha256 swap: use --hashlock; refusing");
      merged.hashlock = agree("--hashlock", args.hashlock, sw.hashlock, sameAddr);
    }
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
  const fromArtifact = artifactCodeHash(kindOf(args));
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
async function getLogsChunked(provider, filter, fromBlock, toBlock, maxRange = LOG_RANGE_MAX, check = null) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += maxRange) {
    const end = Math.min(start + maxRange - 1, toBlock);
    const part = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    if (check) check(part, start, end);
    out.push(...part);
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

/**
 * Every Locked event of the contract, optionally for one lockId, scanned in 50,000-block chunks. `word` is the event's lock word
 * (`hashlock` or `lockAddr`). (The sha256 kind's pre-lock check still reads every Locked log: it has no provider-cap rule, so nobody can stop it
 * by padding. The poseidon kind uses `lockedEventsBySender`, REVIEW-7 R7-1.)
 */
async function lockedEvents(provider, contractAddr, lockId, fromBlock, toBlock, kind = "sha256") {
  const iface = htlcInterface(kind);
  const topics = [iface.getEvent("Locked").topicHash];
  if (lockId) topics.push(lockId);
  const logs = await getLogsChunked(provider, { address: contractAddr, topics }, fromBlock, toBlock, LOG_RANGE_MAX);
  return logs.map((log) => {
    const args = iface.parseLog(log).args;
    return { log, args, word: lockWordOf(kind, args) };
  });
}

/**
 * REVIEW-7 R7-1: the Locked events of ONE sender (all words, all receivers), from the indexed sender topic, in 50,000-block chunks. In
 * `HTLCPoseidonV2.sol` (and `HTLC.sol`) the event is `Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount,
 * bytes32 lockAddr, uint256 timelock)`, so the sender is topic2; the lock word is in the data and is compared by the caller. The answer is bounded by
 * that sender's own activity, so there is no "exact provider cap size" rule here (the old scan of every Locked log had one, and anyone could trip it
 * by padding the contract). Every log is checked again locally (contract, event, sender topic, lock id recomputed from its own fields), so a
 * provider that ignores the topic filter cannot slip another sender's lock in.
 */
async function lockedEventsBySender(provider, contractAddr, sender, fromBlock, toBlock, kind = "poseidon") {
  const iface = htlcInterface(kind);
  const topic0 = iface.getEvent("Locked").topicHash.toLowerCase();
  const senderTopic = ethers.zeroPadValue(sender, 32).toLowerCase();
  const logs = await getLogsChunked(provider, { address: contractAddr, topics: [topic0, null, senderTopic] }, fromBlock, toBlock, LOG_RANGE_MAX);
  const out = [];
  for (const log of logs) {
    if (log.removed) continue;
    const t = (log.topics || []).map((x) => String(x).toLowerCase());
    if (String(log.address).toLowerCase() !== String(contractAddr).toLowerCase() || t.length !== 4 || t[0] !== topic0 || t[2] !== senderTopic) continue;
    const args = iface.parseLog(log).args;
    const word = lockWordOf(kind, args);
    const id = computeLockIdLocal(args.sender, args.receiver, args.amount, word, args.timelock);
    if (id.toLowerCase() !== String(args.lockId).toLowerCase()) {
      throw new UserError(`refusing: a Locked event (lockId ${args.lockId}, block ${log.blockNumber}) does not recompute its lock id from its own fields; do not trust this node`);
    }
    out.push({ log, args, word });
  }
  return out;
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
  const artifact = loadArtifact(kindOf(args));
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
  const kind = kindOf(args);
  const contractAddr = address("--contract", need(args, "contract"));
  // The lock word: --hashlock (SHA-256 of the secret) for sha256, --lock-addr (A = Addr(s), the NOID claim authority) for poseidon.
  if (kind === "poseidon" && args.hashlock !== undefined) throw new UserError("a poseidon lock is keyed on a lockAddr: give --lock-addr, not --hashlock; refusing");
  if (kind !== "poseidon" && args.lockAddr !== undefined) throw new UserError("--lock-addr belongs to the poseidon lock kind (--lock-kind poseidon); refusing");
  const hashlock = kind === "poseidon" ? hex32("--lock-addr", need(args, "lockAddr", "lock-addr")) : hex32("--hashlock", need(args, "hashlock"));
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
  const iface = htlcInterface(kind);
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
  // REVIEW-7 R7-1: the poseidon kind asks the node for the Locked logs of THIS sender only (indexed topic2 of HTLCPoseidonV2's Locked event) and
  // compares the lock word here. The old scan of every Locked log of the shared contract could be stopped by anyone padding it to a provider cap
  // count, without knowing the address; and the only thing it still guarded was "an earlier lock of this sender". Locks of other senders are
  // therefore not read for this kind (`foreignLocksSameHashlock` stays empty; they cannot hurt: the lock pays only the fixed receiver).
  const events =
    kind === "poseidon"
      ? await lockedEventsBySender(provider, contractAddr, sender, fromBlock, blk.number, kind)
      : await lockedEvents(provider, contractAddr, null, fromBlock, blk.number, kind);
  const same = events.filter((e) => String(e.word).toLowerCase() === hashlock);
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
  if (await fetchLock(provider, contractAddr, expectedLockId, kind)) {
    throw new UserError(`refusing: lock ${expectedLockId} already exists at ${contractAddr}`);
  }
  // Poseidon (review V2-8; REVIEW-6 R6-2): only an earlier lock of THIS sender on the address blocks (the `own` refusal above, any receiver); locks of
  // other senders are reported like for the sha256 kind. Bob's lock pays only the fixed receiver, for an x with Addr(x) = A, and the NOID lock pays
  // only Bob, so a stranger's earlier lock on A costs Bob nothing, while blocking on it would give every observer of A a 1-wei veto.
  if (foreignLocksSameHashlock.length > 0) {
    process.stderr.write(
      `note: ${foreignLocksSameHashlock.length} Locked event(s) from other sender(s) already exist under hashlock ${hashlock} ` +
        `(${foreignLocksSameHashlock.map((f) => `${f.sender} lockId ${f.lockId} block ${f.blockNumber}`).join("; ")}); ` +
        `they do not block this lock, but whoever reveals the secret can claim those too
`
    );
  }

  // `lockedEventsScanned` counts the logs the query returned: every Locked log (sha256), or this sender's Locked logs only (poseidon,
  // `lockedEventsQuery: "sender"`); for that kind `foreignLocksSameHashlock` is always empty because other senders' locks are not read.
  const checks = {
    lockKind: kind,
    codeHash: target.codeHash,
    scannedFromBlock: fromBlock,
    lockedEventsScanned: events.length,
    ...(kind === "poseidon" ? { lockedEventsQuery: "sender" } : {}),
    foreignLocksSameHashlock,
  };
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
  const bt = await readBlockTimestamp(provider, r.receipt.blockNumber, { delayMs: args.blockRetryMs });
  return {
    lockId: eventLockId,
    txHash: r.receipt.hash,
    blockNumber: r.receipt.blockNumber,
    blockTimestamp: bt.timestamp,
    ...(bt.note ? { blockTimestampNote: bt.note } : {}),
    sender,
    chainId: target.chainId.toString(),
    ...checks,
    ...fp.report,
  };
}

/** getLock as a plain record; `hashlock` is the lock word of either kind (HTLCPoseidonV2 names the field lockAddr). */
async function fetchLock(provider, contractAddr, lockId, kind = "sha256") {
  const c = new ethers.Contract(contractAddr, htlcInterface(kind), provider);
  try {
    const r = await c.getLock(lockId);
    return {
      sender: r.sender,
      receiver: r.receiver,
      amount: r.amount,
      hashlock: lockWordOf(kind, r),
      timelock: r.timelock,
      claimed: r.claimed,
      refunded: r.refunded,
      preimage: r.preimage,
    };
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
  // Both kinds (review V2-6, docs/poseidon-leg.md 6 item 5; REVIEW-6 R6-8 extends it to sha256, which no longer estimates either): this tool never
  // simulates the real claim, so a dry run sends the node nothing that contains the secret; it is still refused against a node that is not on this
  // machine, because a dry run has no use for the secret there (every gate runs without it, and the real claim checks it locally). Run the dry run
  // without --secret-stdin.
  if (args.dryRun && secret !== null && process.env.ETH_RPC_URL && !isLoopbackUrl(process.env.ETH_RPC_URL)) {
    throw new UserError(
      "refusing: --dry-run with the secret against a node that is not on this machine. A poseidon claim is never simulated, so nothing would be sent, but the secret has no business near a remote node before the reveal: " +
        "run the dry run WITHOUT --secret-stdin (every gate is checked without it)"
    );
  }
  let claimLock = null;
  try {
    // A real claim with a swap file holds the claim lock from here (before the sidecar is first read, in claimChecked) until the send has settled
    // (execute's afterSend) or anything before it fails (the finally below). A dry run writes nothing and takes none.
    if (sw && secret !== null && !args.dryRun) claimLock = takeClaimLock(sw.file);
    return await claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw, claimLock });
  } catch (e) {
    if (e instanceof UserError) throw new UserError(redact(e.message));
    throw new UserError(explain(e)); // ethers errors can carry the calldata, which holds the secret
  } finally {
    if (claimLock !== null) claimLock.release(); // idempotent; a release that fails is reported on stderr and changes nothing else
  }
}

/** claim --dry-run without the secret on mainnet: no gas estimate, so no worst case; the cap and the balance are shown. */
async function mainnetDryRunNote(provider, signer, args, fees) {
  const { capWei } = mainnetFlags(args);
  const balanceWei = await provider.getBalance(await signer.getAddress());
  return {
    maxFeeGwei: ethers.formatUnits(capWei, "gwei"),
    ...(fees && fees.maxPriorityFeePerGas !== undefined && fees.maxPriorityFeePerGas !== null ? { priorityFeeGwei: ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei") } : {}),
    worstCaseFeeWei: null,
    worstCaseFeeNote: "not computed without the real secret (no gas estimate); the balance check runs on the real claim",
    senderBalanceWei: balanceWei.toString(),
    senderBalanceEth: ethers.formatEther(balanceWei),
  };
}

/** Review V2-7: the poseidon claim is exactly selector + lock id + secret. Refuse to sign anything else (the message never shows the secret). */
function assertPoseidonClaimCalldata(iface, data, lockId, secret) {
  const n = ethers.getBytes(data).length;
  if (n !== POSEIDON_CLAIM_CALLDATA_BYTES) {
    throw new UserError(`refusing to sign: the claim calldata is ${n} bytes, the contract requires exactly ${POSEIDON_CLAIM_CALLDATA_BYTES} (a suffix would revert and still publish the secret)`);
  }
  const expected = (iface.getFunction("claim").selector + lockId.slice(2) + secret.slice(2)).toLowerCase();
  if (data.toLowerCase() !== expected) throw new UserError("refusing to sign: the claim calldata is not selector + lock id + secret");
}

async function claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw, claimLock = null }) {
  const kind = kindOf(args);
  const target = await verifyTarget(provider, args, contractAddr);
  const l = await fetchLock(provider, contractAddr, lockId, kind);
  if (!l) throw new UserError(`no such lock ${lockId} at ${contractAddr}`);
  // REVIEW-3 F3: the lock must be the swap file's, and the cutoff the file froze (M_A) can only tighten the flag's.
  let intentCutoff = null;
  let intentLateCutoff = null; // REVIEW-5 R5-1: T_reveal - DE as the intent froze it (swap-cli records it for every reveal_eth intent)
  if (sw) {
    checkLockAgainstSwap(l, sw);
    const ip = sw.intent.params;
    if (ip.t_reveal === undefined || ip.cutoff === undefined) {
      throw new UserError("the reveal_eth intent carries no t_reveal / cutoff (recorded by an older swap-cli); cancel it and run tick --apply again; refusing");
    }
    if (!sameUint(ip.t_reveal, l.timelock)) throw new UserError(`the lock's timelock on chain is ${l.timelock} but the reveal_eth intent froze t_reveal ${ip.t_reveal}; refusing`);
    intentCutoff = uint("intent cutoff", ip.cutoff);
    if (ip.late_cutoff !== undefined && ip.late_cutoff !== null) intentLateCutoff = uint("intent late_cutoff", ip.late_cutoff);
  }
  if (secret !== null) {
    // sha256: ethers treats a hex string as the raw bytes. poseidon: Addr(secret) computed LOCALLY (nothing is sent anywhere).
    const word = localLockWord(kind, secret);
    if (word.toLowerCase() !== l.hashlock.toLowerCase()) {
      throw new UserError(
        kind === "poseidon"
          ? `refusing: Addr(secret) = ${word} but the lock's lockAddr is ${l.hashlock}`
          : `refusing: sha256(secret) = ${word} but the lock's hashlock is ${l.hashlock}`
      );
    }
  }
  let claimGas = null;
  if (kind === "poseidon") {
    // The contract states its own floor and recommendation (views without the secret). The fixed limit must clear both.
    const c = new ethers.Contract(contractAddr, htlcInterface(kind), provider);
    const [minGas, recGas] = await Promise.all([c.MIN_CLAIM_GAS(), c.RECOMMENDED_CLAIM_GAS_LIMIT()]);
    if (minGas > 540000n || recGas < 650000n || recGas > POSEIDON_CLAIM_GAS_LIMIT) {
      throw new UserError(
        `refusing: the contract states MIN_CLAIM_GAS ${minGas} and RECOMMENDED_CLAIM_GAS_LIMIT ${recGas}; this tool expects a floor of at most 540000 and a recommendation between 650000 and ${POSEIDON_CLAIM_GAS_LIMIT} (its fixed gas limit)`
      );
    }
    claimGas = POSEIDON_CLAIM_GAS_LIMIT;
  } else {
    // REVIEW-6 R6-8: the sha256 claim never goes through eth_estimateGas either (that request carries the calldata, i.e. the secret).
    claimGas = SHA256_CLAIM_GAS_LIMIT;
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
  // REVIEW-5 R5-1/R5-2: --replace names a pending transaction of this signer for this very claim (found and identified, or the command
  // refuses). That transaction is the secret in the mempool: evidence that the secret may be public, with or without the file's history
  // (swap-cli cannot learn of a claim that was only sent). A FIRST claim never has such a transaction and keeps the strict M_A rule.
  let replaced = null;
  if (args.replace === true) replaced = await resolveReplaced(provider, signer, args, { name: "claim", contractAddr, lockId });
  if (replaced !== null && intentLateCutoff === null && sw && PROFILE_DE_S[sw.profile] !== undefined) {
    intentLateCutoff = l.timelock - PROFILE_DE_S[sw.profile]; // an intent from before REVIEW-5: the profile's DE gives the same number
  }
  // REVIEW-4 R4-3: once the file shows the secret may already be public (swap-cli's late re-send, review H1), a re-send
  // publishes nothing new and the cutoff the intent froze (T_reveal - DE) is the authority, not the stricter default margin.
  // An explicit --margin-s still tightens it. Without that evidence the earlier of the two stays the rule.
  // T21-11: a reveal sidecar of THIS lock beside the file (written just before an earlier claim was broadcast) is the same kind of evidence.
  const sidecar = sw ? readRevealSidecar(sw.file, lockId) : null;
  const sidecarEvidence = sidecar !== null && sidecar.state === "matching";
  const lateResend = intentCutoff !== null && (sw.secretMayBePublic || replaced !== null || sidecarEvidence) && !marginGiven;
  if (lateResend) {
    // The cutoff the intent froze, or the later T_reveal - DE it froze for exactly this case (a secret that is public already).
    const late = intentLateCutoff !== null && intentLateCutoff > intentCutoff ? intentLateCutoff : intentCutoff;
    cutoff = late < l.timelock ? late : l.timelock;
    cutoffRule =
      replaced !== null
        ? "T_reveal - DE: the pending claim of this lock at the signer's oldest nonce shows the secret is already public (REVIEW-5 R5-1)"
        : late === intentCutoff
          ? sw.secretMayBePublic
            ? "the swap file's frozen cutoff (the file shows the secret may already be public)"
            : "the swap file's frozen cutoff (the reveal sidecar beside the file shows the secret may already be public)"
          : sw.secretMayBePublic
            ? "the swap file's late cutoff T_reveal - DE (the file shows the secret may already be public)"
            : "the swap file's late cutoff T_reveal - DE (the reveal sidecar beside the file shows the secret may already be public)";
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
  const events = await lockedEvents(provider, contractAddr, lockId, fromBlock, blk.number, kind);
  if (events.length !== 1) {
    throw new UserError(
      events.length === 0
        ? `refusing: no Locked event for ${lockId} found in blocks ${fromBlock}..${blk.number}; cannot prove the lock is final (check --from-block)`
        : `refusing: ${events.length} Locked events for ${lockId}; expected exactly one`
    );
  }
  const ev = events[0];
  if (
    String(ev.word).toLowerCase() !== l.hashlock.toLowerCase() ||
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
    lockKind: kind,
    ...(claimGas !== null ? { gasLimit: claimGas.toString() } : {}),
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
    ...(sidecar !== null ? { revealSidecar: sidecar.state, revealSidecarFile: sidecar.file, ...(sidecar.note ? { revealSidecarNote: sidecar.note } : {}) } : {}),
  };
  // REVIEW-4 R4-1: the fee cap (or the --replace plan) is decided and checked before anything is signed, also without the secret.
  const fp = await feePlan(provider, signer, args, { name: "claim", contractAddr, lockId }, replaced);
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
      gasEstimateNote: `not estimated, ever: a ${kind} claim is sent with a fixed gas limit (${claimGas}) and never simulated (the secret would reach the node)`,
      ...(mainnetFlags(args).mainnet ? await mainnetDryRunNote(provider, signer, args, fp.fees) : {}),
      ...plan,
      ...fp.report,
    };
  }
  const iface = htlcInterface(kind);
  const tx = { to: contractAddr, data: iface.encodeFunctionData("claim", [lockId, secret]) };
  if (kind === "poseidon") assertPoseidonClaimCalldata(iface, tx.data, lockId, secret);
  let r;
  let sidecarWritten = null;
  try {
    // The event scans, the finality lookup and the fee planning above can take minutes on a slow public endpoint: the cutoff is read again
    // (wall clock and latest block, the later one) immediately before the claim is signed, against the same cutoff the early check ended with.
    const preSend = async (populated) => {
      let late;
      try {
        late = await latestBlock(provider);
      } catch (e) {
        throw new UserError(
          `refusing: could not re-read the latest block just before sending (${e instanceof UserError ? e.message : explain(e)}), so the reveal cutoff ${cutoff} cannot be re-checked; nothing was sent`
        );
      }
      if (BigInt(late.timestamp) >= l.timelock) {
        throw new UserError(
          `refusing: timelock ${l.timelock} has passed (latest block timestamp ${late.timestamp}, re-checked just before sending); the claim would revert with the secret in its calldata; nothing was sent`
        );
      }
      const wallLate = BigInt(Math.floor(Date.now() / 1000));
      const nowLate = wallLate > BigInt(late.timestamp) ? wallLate : BigInt(late.timestamp);
      if (nowLate > cutoff) {
        throw new UserError(
          `refusing: past the reveal cutoff. now ${nowLate} > cutoff ${cutoff} (${cutoffRule}; re-checked just before sending: the earlier steps took ${nowLate > now ? nowLate - now : 0n} s) ` +
            `(a late claim publishes the secret and lets the counterparty take both legs; nothing was sent)`
        );
      }
      // T21-11: the sidecar is the last thing preSend does. If it cannot be written and made durable this throws and nothing is sent. With a local
      // key, only the local signature and the synchronous `lastCheck` below sit between this point and the bytes going to the node.
      if (sw) sidecarWritten = writeRevealSidecar(sw.file, lockId, await presignedHash(signer, populated));
    };
    // The fsyncs and the signature can take time (on a network share above all): the cutoff is checked once more against the WALL CLOCK only, in a
    // synchronous guard that runs immediately before the broadcast (for every claim, with or without --swap). No network read can happen after it.
    // If the time ran out, nothing has been sent.
    const lastCheck = () => {
      const wallLast = BigInt(Math.floor(Date.now() / 1000));
      if (!(wallLast > cutoff || wallLast >= l.timelock)) return;
      let fate = "no reveal sidecar was involved (no --swap)";
      if (sidecarWritten !== null) {
        fate = sidecarWritten.created
          ? removalFate(removeCreatedRevealSidecar(sidecarWritten.file, sidecarWritten.bytes, lockId), sidecarWritten.file)
          : `the reveal sidecar ${sidecarWritten.file} that was there before is kept (it is evidence of an earlier attempt)`;
      }
      const afterSidecar = sidecarWritten !== null ? ", after the reveal sidecar was written" : "";
      sidecarWritten = null; // the outer catch must not say the claim may have reached the network: it did not
      throw new UserError(
        `refusing: past the reveal cutoff. now ${wallLast} > cutoff ${cutoff} or >= timelock ${l.timelock} (${cutoffRule}; re-checked against the wall clock immediately before the broadcast${afterSidecar}, which took too long); ${fate}; nothing was sent`
      );
    };
    r = await execute(provider, signer, args, tx, { ...plan, ...fp.report }, { hideData: true, fees: fp.fees, fixedGas: claimGas === null ? undefined : claimGas, preSend, lastCheck, afterSend: claimLock === null ? undefined : () => claimLock.release() });
  } catch (e) {
    // REVIEW-6 R6-3: a claim that was mined and REVERTED (it came too late, or lost a race with the refund) paid nobody and still published the
    // secret in its calldata. Say so in the result, with the hash, instead of a bare failure: the caller must treat the secret as public.
    if (e instanceof RevertedTx) {
      return {
        reverted: true,
        secretPublic: true,
        txHash: e.hash,
        blockNumber: e.blockNumber,
        lockId,
        lockKind: kind,
        note:
          "the claim was mined and REVERTED: it paid nothing, but its calldata is now on chain and the SECRET IS PUBLIC (the counterparty can take the NOID from it). " +
          `Tell swap-cli: tick FILE ... --reveal-tx ${e.hash} --apply (it checks the transaction on the node, then judges a re-send by the late cutoff T_reveal - DE). ` +
          "Do not assume the swap is safe; if the lock is still open and the late cutoff has not passed, the claim can be re-sent (live.js claim --swap FILE after that tick)",
        swapCliFlag: `--reveal-tx ${e.hash}`,
        ...(sidecarWritten ? { revealSidecar: sidecarWritten.state, revealSidecarFile: sidecarWritten.file } : {}),
        ...fp.report,
      };
    }
    if (sidecarWritten) {
      // The sidecar was written before the broadcast and stays: whether the claim reached the network is not known here.
      const base = e instanceof UserError ? redact(e.message) : explain(e);
      // A throttled answer (HTTP 429) most likely means the endpoint did NOT accept the claim. The sidecar stays all the same (the outcome is not
      // proven), and with it a re-run would be judged by the late cutoff: so the advice is to re-run with the strict margin given by hand, which
      // rules whatever the sidecar or the file says, and not to treat the reveal as sent unless the operator has a reason to.
      const throttledAnswer = isThrottledAnswer(e);
      const throttled = throttledAnswer
        ? ` The endpoint refused the send as throttled (HTTP 429), so it most likely did NOT accept the claim; this tool does not repeat a reveal by itself. To send it again as a first reveal, run the claim again now with --margin-s ${DEFAULT_MARGIN_S} (the strict cutoff, whatever the sidecar says).`
        : "";
      // A redirect answer (HTTP 3xx) is the same case: the endpoint did not take the send, and this tool follows no redirect. The advice is the same,
      // with the endpoint's final address put into ETH_RPC_URL first.
      const redirectAnswer = isRedirectAnswer(e);
      const redirected = redirectAnswer
        ? ` The endpoint answered the send with a redirect (HTTP ${e.statusCode}), which this tool never follows, so it most likely did NOT accept the claim; this tool does not repeat a reveal by itself. To send it again as a first reveal, put the endpoint's final URL in ETH_RPC_URL and run the claim again now with --margin-s ${DEFAULT_MARGIN_S} (the strict cutoff, whatever the sidecar says).`
        : "";
      const next = throttledAnswer || redirectAnswer ? "run tick --apply before the claim only if you think it did reach the network" : "run tick --apply";
      throw new UserError(`${base}${throttled}${redirected} (the reveal sidecar ${sidecarWritten.file} was written before the send and stays: the claim may have reached the network, so swap-cli treats the secret as possibly public; ${next})`);
    }
    throw e;
  }
  if (r.dry) return r.out;
  return { txHash: r.receipt.hash, blockNumber: r.receipt.blockNumber, ...(sidecarWritten ? { revealSidecar: sidecarWritten.state, revealSidecarFile: sidecarWritten.file } : {}), ...fp.report };
}

async function refund(provider, signer, args0) {
  requireSigner(signer);
  mainnetFlags(args0);
  requireSwapOnMainnet(args0);
  const { args, sw } = bindSwap(args0, "refund_eth");
  const kind = kindOf(args);
  // REVIEW-4 R4-5: the refund is Bob's; the key must be the swap file's bob_sender (checked before the network is touched).
  if (sw) {
    const me = await signer.getAddress();
    if (!sameAddr(me, sw.bobSender)) throw new UserError(`this key is ${me} but the swap file's bob_sender is ${sw.bobSender}; refusing`);
  }
  const contractAddr = address("--contract", need(args, "contract"));
  const lockId = hex32("--lock-id", need(args, "lockId", "lock-id"));
  targetFlags(args);
  const target = await verifyTarget(provider, args, contractAddr);
  const l = await fetchLock(provider, contractAddr, lockId, kind);
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
  const tx = { to: contractAddr, data: htlcInterface(kind).encodeFunctionData("refund", [lockId]) };
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
  const code = await provider.getCode(contractAddr);
  // The kind is the flag's; without one, whichever local artifact's code hash the contract has (else sha256, as before).
  let kind = "sha256";
  if (args.lockKind !== undefined || args.contractKind !== undefined) kind = kindOf(args);
  else if (code !== "0x") {
    const h = ethers.keccak256(code);
    kind =
      LOCK_KINDS.find((k) => {
        try {
          return artifactCodeHash(k) === h;
        } catch {
          return false;
        }
      }) || "sha256";
  }
  const iface = htlcInterface(kind);
  const blk = await latestBlock(provider);
  const fromBlock = await resolveFromBlock(provider, contractAddr, args, blk.number);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  const l = await fetchLock(provider, contractAddr, lockId, kind);
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
        hashlock: lockWordOf(kind, p.args),
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
    lockKind: kind,
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
    // sha256: SHA-256 of the preimage; poseidon: Addr(preimage), computed locally. The output keeps the key `hashlock` for either word.
    if (out.preimage) out.preimageMatchesHashlock = localLockWord(kind, out.preimage) === l.hashlock.toLowerCase();
  }
  return out;
}

// ------------------------------------------------------------------- CLI
const COMMON = { "confirmations": "v", "dry-run": "b", "gas-price-gwei": "v", "allow-chain-id": "v", "mainnet": "b", "max-fee-gwei": "v", "priority-fee-gwei": "v" };
const TARGET = { "chain-id": "v", "code-hash": "v", "from-block": "v" };
// The Ethereum contract of the swap: `sha256` (HTLC.sol, default) or `poseidon` (HTLCPoseidonV2.sol); with --swap it is the file's.
const KIND = { "lock-kind": "v", "contract-kind": "v" };
const SPECS = {
  keygen: { flags: { out: "v" }, signer: false },
  balance: { flags: {}, positional: "address", signer: false },
  deploy: { flags: { ...COMMON, ...KIND, "key-file": "v" }, signer: true },
  lock: {
    flags: { ...COMMON, ...TARGET, ...KIND, "key-file": "v", contract: "v", hashlock: "v", "lock-addr": "v", "t-reveal": "v", receiver: "v", "amount-wei": "v", swap: "v" },
    signer: true,
  },
  claim: {
    flags: { ...COMMON, ...TARGET, ...KIND, "key-file": "v", contract: "v", "lock-id": "v", "margin-s": "v", "secret-stdin": "b", "secret-file": "v", swap: "v", replace: "b", "replace-tx": "v" },
    signer: true,
  },
  refund: { flags: { ...COMMON, ...KIND, "chain-id": "v", "code-hash": "v", "key-file": "v", contract: "v", "lock-id": "v", swap: "v", replace: "b", "replace-tx": "v" }, signer: true },
  send: { flags: { ...COMMON, "key-file": "v", to: "v", "amount-wei": "v" }, signer: true },
  status: { flags: { ...KIND, contract: "v", "lock-id": "v", "from-block": "v" }, signer: false },
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
  // --contract-kind (deploy's name) and --lock-kind are one setting.
  if (args.contractKind !== undefined) {
    if (args.lockKind !== undefined && args.lockKind !== args.contractKind) throw new UserError("--lock-kind and --contract-kind disagree; they are the same setting");
    args.lockKind = args.contractKind;
    delete args.contractKind;
  }
  if (args.lockKind !== undefined && !LOCK_KINDS.includes(args.lockKind)) throw new UserError(`--lock-kind must be ${LOCK_KINDS.join(" or ")}, got "${args.lockKind}"`);
  return { command, args };
}

const jsonOut = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main(argv) {
  const { command, args } = parseArgs(argv);
  if (args.mainnet === true) process.stderr.write(MAINNET_WARNING);
  if (args.priorityFeeGwei !== undefined) process.stderr.write(PRIORITY_FEE_WARNING);
  // Under --mainnet a missing --swap is a refusal (requireSwapOnMainnet), not a warning.
  if (["lock", "claim", "refund"].includes(command) && args.swap === undefined && args.mainnet !== true) process.stderr.write(NO_SWAP_WARNING);
  const provider = command === "keygen" ? null : makeProvider(process.env.ETH_RPC_URL || "http://127.0.0.1:8545");
  try {
    const signer = SPECS[command].signer ? loadSigner(provider, args.keyFile) : null;
    if (signer) {
      // Shown as soon as the transaction is sent, before the wait for the receipt: a stuck one needs its hash for --replace-tx.
      args.onSent = (s) =>
        process.stderr.write(
          `sent: ${s.hash} nonce ${s.nonce} maxFeePerGas ${s.maxFeePerGas === null || s.maxFeePerGas === undefined ? "?" : ethers.formatUnits(s.maxFeePerGas, "gwei")} gwei ` +
          `maxPriorityFeePerGas ${s.maxPriorityFeePerGas === null || s.maxPriorityFeePerGas === undefined ? "?" : ethers.formatUnits(s.maxPriorityFeePerGas, "gwei")} gwei ` +
            (command === "claim" || command === "refund"
              ? `(waiting for the receipt; if it stays pending: ${command} --replace --replace-tx ${s.hash} with a higher --max-fee-gwei)\n`
              : "(waiting for the receipt)\n")
        );
    }
    const result = await COMMANDS[command](provider, signer, args);
    process.stdout.write(redact(jsonOut(result)) + "\n");
    // REVIEW-6 R6-3: a mined, reverted claim is a result (its JSON names the hash and says the secret is public) but not a success.
    if (result && result.reverted === true) {
      process.stderr.write(`error: the claim ${result.txHash} was mined and REVERTED; the secret is PUBLIC (see the JSON on stdout, then swap-cli tick --reveal-tx)\n`);
      process.exitCode = 3;
    }
  } finally {
    if (provider) provider.destroy();
  }
}

module.exports = {
  keygen, balance, deploy, lock, claim, refund, send, status,
  loadSigner, computeLockIdLocal, parseArgs, UserError, explain, ALLOWED_CHAIN_IDS, MAINNET_WARNING,
  getLogsChunked, findDeploymentBlock, readBlockTimestamp, readSecret, verifyTarget, redact, LOG_RANGE_MAX, DEFAULT_MARGIN_S,
  readRevealSidecar, writeRevealSidecar, revealSidecarPath, REVEAL_SIDECAR_SUFFIX, claimLockPath, CLAIM_LOCK_SUFFIX, execute, makeProvider, sendGuard,
  POSEIDON_CLAIM_GAS_LIMIT, SHA256_CLAIM_GAS_LIMIT, RevertedTx, POSEIDON_CLAIM_CALLDATA_BYTES, localAddr, localLockWord, artifactCodeHash, kindOf, assertPoseidonClaimCalldata, htlcInterface,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${redact(e instanceof UserError ? e.message : explain(e))}\n`);
    process.exit(1);
  });
}
