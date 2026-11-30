#!/usr/bin/env node
/*
 * Live-run tooling for the Ethereum side of a NOID <-> ETH swap (HTLC.sol).
 *
 *   node scripts/live.js <command> [flags]        (run from eth/)
 *
 * Commands: keygen, balance, address, deploy, lock, claim, refund, send, sweep, reserve, status.
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
 * A private key is only ever read from a key file (--key-file) or from a pipe on stdin (--key-stdin) and is never printed.
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
 *                        then it only warns; under any other profile it warns. The same for a pending lock the screen refused: the history entry
 *                        producer_alert_lock_pending:<decided_at>[:kind] of THIS intent (written by `tick --apply` for every kind of refusal) refuses
 *                        the lock unless an override entry comes after it. An override counts only AFTER the entry it waives (by position); with the
 *                        marker file and no detection entry in the history no override counts (run `tick --apply` first). Without --swap no
 *                        producer check is made and a warning says so. Local reads only, before any network call. A screen, not a defence.
 *
 * lock --swap FILE   a REAL send (not a dry run) must be handed the APPROVAL of a fresh read-only `swap-cli tick`: --approved-intent (the `decided_at` of the
 *                      lock_eth intent the tick held), --approved-terms (the SHA-256 of the lock's terms in the fixed encoding of `approvalText`, which this script
 *                      recomputes from what it is about to send) and --approved-at (the tick's own Unix time; refused when older than 120 s, the engine's
 *                      observation age limit, or more than 5 s ahead of this machine's clock). Any one missing, malformed or different refuses, nothing sent; no
 *                      flag or environment variable skips it. The only supported way to send a lock is scripts/live/lock.sh, which runs that tick right before and
 *                      hands the three values over from the tick's own output. It is a binding, not a proof (whoever reads the swap file can compute the values).
 *                      The approval is NOT single-use; for this swap file a second send of the same lock is meant to be made impossible by five checks of this script: the duplicate-hashlock rule
 *                      (mined Locked events), the lock lock FILE.lock-lock (exclusive, held from before the checks until the send has settled), the pending-nonce check
 *                      (an extra: nodes drop pending transactions), the lock record FILE.lock-sent (written and synced before the broadcast, never removed by
 *                      this tool once the bytes may have left; the operator removes it by hand on one of two proofs, see scripts/live/README.md) and the per-user lock
 *                      record, one file per chain, sender and lock word in the `.noid-swap/lock-sent` directory of the account's home (the home the operating system's
 *                      account database gives the user that runs this script, not the HOME (Linux, macOS) or USERPROFILE (Windows) of the environment: one that
 *                      names another directory is refused, and so is a run with SUDO_UID or SUDO_USER set; `su`, `runas`, another login and another machine cannot be
 *                      detected and have no record). It is written beside FILE.lock-sent, and on its own by a lock without --swap, and found by every real lock whatever the name of the swap
 *                      file; same proofs. The guards were tested offline (Hardhat's in-process network and stubs); real locks were sent through them in live runs 17 to 20,
 *                      but the REFUSAL of a second send has never run against a real chain.
 *                      Another machine or another user account still has the duplicate rule only (and, with a swap file, the pending-nonce check of its own node).
 * lock, claim --swap FILE  the file must have ONE name: a swap file with more than one hard link is refused (the claim lock and the marker files are named from
 *                      the path, so a second name gets its own claim lock and misses a marker beside the first). Only where the file system reports a link count.
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
 * `tick` reads the same file (history name reveal_sidecar_seen). It is looked for beside the swap file's real path and, when the file was reached by
 * another name (a link), beside that name too, as swap-cli does (an older `live.js` wrote it there); a match at either place counts. Leftover `*.tmp`
 * files of an interrupted sidecar write are never removed: a claim lists them in its output (`revealSidecarTmpFiles`) and says they are no evidence.
 *
 * Receiver code (R7-7, T11: EOAs only): a claim is never estimated, so the receiver's code is read at "latest" and "pending" twice: early (after the cutoff
 * check, before the log scans; also in --dry-run, which then shows what the real run would do) and immediately before signing, in one round with the latest
 * block. The order in the last step is: code read and block read together, the code judged, the cutoff and timelock evaluated from that block, the reveal
 * sidecar written (with --swap), the signature, then the synchronous wall-clock check, then the broadcast. A FIRST claim refuses on any code (a contract, or
 * an EIP-7702 delegation, 0xef0100...), on a failed read and on an answer that is not hex: nothing signed, nothing sent. With --replace (a verified pending
 * claim of this lock exists, so the secret is already public in it and the replacement has the same nonce and receiver) the read is informational: the claim
 * goes on and the output carries `receiverCodeWarning`, with a WARNING line on stderr. That holds only when the pending claim carries THIS lock's secret (the lock word computed locally
 * from its preimage argument equals the lock's hashlock: decided the same with and without --secret, so a dry run and the real run agree); a pending claim with another
 * preimage is judged by the rule of a first claim, for the receiver's code AND for the late cutoff below (replacePreimageNote, and a NOTE on stderr). Applies with
 * and without --swap. (The nonce and fee rules of --replace do not depend on the preimage: see the code of claimChecked.)
 *
 * status: read-only (signs nothing, sends nothing, writes nothing). Flags --contract, --lock-id (required), --from-block, --lock-kind, and optionally
 * --chain-id (must equal eth_chainId) and --code-hash (must equal the keccak256 of the code at the address). A refusal names the flag or the cause: no
 * code at the address, a code hash that is not an HTLC's, a node error (its own words are printed, not ethers' "could not coalesce error"; anything that
 * looks like an address, scheme://..., is cut out of them). Every contract read is made at the one block the run started from. A lock that is not found is
 * reported as missing (`exists: false`, `trustworthy: true`) only when that block is at most 120 s old (STATUS_FRESH_BLOCK_S) AND --chain-id was given and
 * matched (the same contract address can exist on another chain). On an older block it is `exists: null`, state "unknown (the node is behind the chain's tip)",
 * `trustworthy: false`; on a fresh block without --chain-id it is `exists: false`, `trustworthy: false`, state "not found on chain N, but not trusted: --chain-id was not given", with a note that says so (exit 0 in every case). The note
 * names the chain id the node reported, says whether --chain-id and --code-hash were checked, gives the block's time and this machine's clock in UTC, and says
 * that a lock still pending in the mempool is not seen. A getLock that says "not found" while the event scan of the same run shows a Locked event for the id is an error (the node
 * contradicts itself); a lock that exists with no Locked event in the scanned range gets a note.
 *
 * Claim lock: a real `claim --swap FILE` first creates FILE.claim-lock exclusively (pid and time, nothing secret) and holds it until the send has settled,
 * that is until the sender's socket has CLOSED (see "Time bound on the send"; not through the wait for the receipt, so `claim --replace-tx` from another
 * terminal still works then). If the close cannot be confirmed within 5 s the lock is left on disk with a message, and the operator deletes it by hand. If that file exists, or cannot be created, the
 * claim refuses before it touches the sidecar: a claim that died leaves its lock, and the operator deletes it by hand once sure that no other claim for
 * this swap file is running. The tool never removes a lock it did not make. A dry run takes no lock.
 *
 * No redirect, no library retry: a provider from makeProvider (the command line's) turns every HTTP 3xx answer to a READ into an error (REDIRECT_REFUSED; put
 * the endpoint's final URL in ETH_RPC_URL). The claim's send does not go through the library at all (see the next paragraph); the `lock` send still does,
 * and is not retried on HTTP 429 (see sendGuard).
 *
 * Time bound on the send (claim only; eth/scripts/bounded-send.js states the guarantee and its limits). The claim carries the swap's secret, so the moment its
 * bytes leave this machine is the moment the secret may be public: it must not be later than the reveal cutoff. ethers cannot bound that (its timeout is an
 * inactivity timer, DNS and connect have no limit, its abort does not reach the socket, the body is queued before the connection exists, the send is batched with
 * two reads). So a real claim is sent by a small hand-written sender: ONE unbatched eth_sendRawTransaction on a fresh connection (no agent, no keep-alive, no retry,
 * no redirect), the connection made FIRST (a stall or failure there is a proven "nothing was sent" and leaves no sidecar), then a synchronous check as the last
 * statement before the write (now + 20 s answer window + 10 s guard <= the cutoff that rules, and now < the timelock; "now" is the later of the wall clock and
 * the latest block's time plus the monotonic time elapsed since it was read), a kill timer armed in the same block, and at the deadline the socket is reset.
 * The send budget is therefore 30 s: the last moment to START the send is cutoff - 30 s, and its bytes are out by cutoff - 10 s. Order inside the last step:
 * connect, then the code and block reads, the verdicts, the cutoff and timelock evaluation, the sidecar, the signature, the check, the write. Four outcomes:
 * not_sent (proven: nothing written), accepted, delivered_rejected (the endpoint's node refused it; the endpoint has the secret), unknown (no complete answer, a
 * redirect, HTTP 429, any other status, a reset); only not_sent says "nothing was sent". A real claim needs a LOCAL key (the command line always has one) and a
 * provider made by makeProvider (an in-process test provider needs args.unboundedSendInProcess, which the command line cannot set), and is refused while
 * NODE_USE_ENV_PROXY (or --use-env-proxy) is in effect: the sender connects directly and never uses a proxy. `refund` and `lock` keep the library path.
 *
 * Keys (REVIEW-4 R4-5): with --swap, claim needs the key of the file's alice_receiver, refund and lock that of bob_sender.
 * Late re-send (REVIEW-4 R4-3): with --swap, when the file's history shows the secret may already be public (reveal_submitted,
 * eth_claim_mined, eth_claim_reorged, eth_reveal_dropped), claim takes the cutoff the intent froze (T_reveal - DE) instead of the
 * stricter timelock - 1800 s; an explicit --margin-s still tightens it. A --replace of a pending claim grants the late cutoff only when that claim carries this lock's secret.
 *
 * The swap's own Ethereum key (swap wallet, piece 2b; swap-cli seals it in the swap file, `swap-cli ethkey emit FILE | node scripts/live.js ... --key-stdin`):
 *   --key-stdin      lock, claim, refund and sweep (and `address`) read the key from stdin instead of --key-file; exactly one of the two. stdin must be a pipe (a terminal
 *                    is refused, the key would be typed in the clear) and holds exactly ONE line, the key (0x and 64 hex). With claim AND --secret-stdin together the
 *                    framing is exactly TWO lines: the key, then the secret; one line or three, a blank line, or anything else is refused. Nothing of either is ever
 *                    shown in an error. Every check on the key (claim: it must be alice_receiver; lock and refund: bob_sender) is unchanged, whatever the source.
 *   keygen --stdout  a fresh key from the OS random generator (32 bytes, checked valid), written as two lines, the address then the key, to a pipe only (a terminal is
 *                    refused): node scripts/live.js keygen --stdout | swap-cli ethkey new --out KEYFILE. swap-cli has no secp256k1 code, so it is this tool that makes the key
 *                    and recomputes the address: `address --key-stdin [--expect ADDRESS]` prints the address of the key on stdin, and refuses when --expect differs.
 *   sign-message --key-stdin|--key-file F --message-hex 0x..   signs one EIP-191 personal message (the bytes given as 0x-hex, nothing else is accepted) with the key and prints
 *                    JSON {address, signature} (the signature: 65 bytes, 0x + 130 hex, v 27 or 28). Offline: no node, no network. Exactly one of the two key flags. DOMAIN RULE: the
 *                    tool refuses (exit status 1, nothing signed) unless the message bytes start with the ASCII text `no1d-swap-v1 ` (the handover's tuples do), so a signature of
 *                    this command can never be read as another protocol's message, and the EIP-191 prefix (the byte 0x19 first) keeps it from being a valid Ethereum transaction.
 *                    At most 2,048 bytes. The key is registered as a secret (scrubbed from every message) and is never printed.
 *   verify-message --address ADDR --message-hex 0x.. --signature 0x..   read-only, offline, no key: recovers the signer of the EIP-191 message and prints JSON {valid, recovered};
 *                    exit status 0 when `recovered` is ADDR, 3 when it is not (including a signature that is malformed, has a high s or a v other than 27 or 28: valid false,
 *                    recovered null). The domain prefix is not demanded here (it is a check of the bytes the caller built).
 *   balance --address ADDR   read-only: the balance in wei, and the latest and the pending nonce.
 *   reserve --role alice|bob --swap FILE --key-stdin|--key-file F [--mainnet --max-fee-gwei N | --gas-price-gwei N]   read-only. REQUIRES the key (exactly one of the two) and
 *                    refuses, before any amount or address is printed (exit status 1), unless the address recomputed from the key is the file's own account (alice_receiver for
 *                    Alice, bob_sender for Bob) and the file's eth_key address when it has one: a stated address that is not the key's would be a deposit nobody can spend.
 *                    The ETH the swap's key must hold (amendment C): Alice, the claim's
 *                    fixed gas limit (200,000 sha256, 1,000,000 poseidon) x the fee ceiling x 1.25; Bob, the swap's amount_wei + (the lock's + the refund's gas ceiling) x the fee
 *                    ceiling x 1.25 (the gas ceilings are LOCK_GAS_RESERVE and REFUND_GAS_RESERVE below: above what the live runs measured). The fee ceiling is the cap a send
 *                    would use (--max-fee-gwei on mainnet, --gas-price-gwei elsewhere, else the node's own suggestion). Prints the numbers (wei, decimal strings) and
 *                    `covered`; exit status 0 when the key's balance covers it, 3 when it does not. Integer arithmetic only.
 *   sweep --swap FILE --to ADDR --key-stdin|--key-file F [--dry-run]   sends the key's whole balance minus the fee (21,000 gas x the capped fee) to ADDR, and refuses unless ALL
 *                    hold: the key is the file's own account (alice_receiver for Alice, bob_sender for Bob) and the file's eth_key record's address; ADDR is the payout address
 *                    stored in the file's eth_key record (and not the key itself); the file holds no pending lock_eth, refund_eth or reveal_eth intent (nor a pending action
 *                    of those kinds); the node is on the file's chain (and mainnet only with --mainnet, the production file and --max-fee-gwei) and the contract is the pinned
 *                    artifact; ADDR has no code (eth_getCode empty: a contract or an EIP-7702 delegation is refused, amendment M); the key has no pending transaction (pending
 *                    nonce = latest nonce); no lock of THIS swap (the file's lock word, from this key as sender for Bob, to this key as receiver from bob_sender for Alice)
 *                    is open on chain: every such lock must be claimed or refunded; and no unresolved lock record exists (FILE.lock-sent, the per-user record): a record
 *                    counts as resolved only when the lock it names shows claimed or refunded on chain. With NO lock of this swap on chain at all the file's phase must be an
 *                    ended one (aborted, refunded, lost, done). The same fee-cap checks as the other sends apply. --dry-run prints what it would send. Not run on a public network.
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
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("node:perf_hooks");
const { ethers } = require("ethers");
const bsend = require("./bounded-send.js");

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
// Swap wallet, piece 2b (amendment C): the gas CEILINGS the reserve of Bob's key is computed from. The lock and the refund are estimated, not fixed, so these are not limits
// of a transaction: they sit above what the live runs measured (poseidon lock 600,174 estimated, 583,853 mined; poseidon refund 158,608; sha256 lock 149,197 and refund 66,577
// on the local chain) so the reserve covers them with room. The claim's gas is the fixed limit above.
const LOCK_GAS_RESERVE = { sha256: 250_000n, poseidon: 700_000n };
const REFUND_GAS_RESERVE = { sha256: 100_000n, poseidon: 200_000n };
const TRANSFER_GAS = 21_000n; // a plain ETH transfer to an address without code
const RESERVE_NUM = 125n; // the reserve is gas x fee ceiling x 1.25, in integers: (x * 125 + 99) / 100
const RESERVE_DEN = 100n;
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
// `lock` without --swap reads no swap file, so none of the producer-screen checks (T21) run: not the marker, not the history, not the pending-lock
// latch. On a local test chain there is no swap file and this is the normal way; with a swap-cli swap file it removes a barrier.
const NO_SWAP_LOCK_WARNING =
  "WARNING: lock without --swap FILE: NO producer check was made (the marker file, the history and the pending-lock alert of swap-cli's producer screen, T21, all live in the swap file). Fine for a local test chain; for a real swap pass --swap FILE (lock.sh does)\n";
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
  return redact(plainNodeText(String(msg).split("\n")[0]));
}

async function readStdinText(maxBytes = 4096, flagName = "--secret-stdin") {
  if (process.stdin.isTTY) {
    throw new UserError(
      flagName === "--secret-stdin"
        ? "--secret-stdin: stdin is a terminal, so the secret would be typed in the clear; pipe it in " + "(swap-cli secret FILE | node scripts/live.js claim --secret-stdin ...)"
        : `${flagName}: stdin is a terminal, so the key would be typed in the clear; pipe it in (swap-cli ethkey emit FILE | node scripts/live.js ... ${flagName})`
    );
  }
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += c.length;
    if (n > maxBytes) throw new UserError(flagName === "--secret-stdin" ? "--secret-stdin: input is far longer than a 32-byte secret" : `${flagName}: input is far longer than a key and a secret`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ETH_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** A Wallet from the key's text. The text is registered as a secret (every message is scrubbed of it) and never shown in an error. */
function signerFromKeyText(provider, text, where) {
  if (!ETH_KEY_RE.test(text)) throw new UserError(`${where}: the key must be 0x followed by exactly 64 hex characters; its text is not shown`);
  registerSecret(text);
  try {
    return new ethers.Wallet(text, provider);
  } catch {
    throw new UserError(`${where}: not a valid secp256k1 private key; its text is not shown`);
  }
}

/**
 * --key-stdin: read the key (and, with --secret-stdin on a claim, the secret) from ONE read of stdin. The framing is exactly: with --key-stdin alone ONE line, the key; with
 * --key-stdin and --secret-stdin TWO lines, the key and then the secret. A terminal, another number of lines, a blank line and a malformed line are refused, and no message
 * carries the text. The secret goes to `args.secret` (the in-process way readSecret takes it; the command line itself cannot set it) and `args.secretStdin` is dropped, so
 * stdin is not read a second time. Returns the key's text.
 */
async function readKeyStdin(args) {
  if (args.keyFile !== undefined) throw new UserError("give the key by exactly one of --key-file or --key-stdin; refusing");
  const both = args.secretStdin === true;
  const text = await readStdinText(4096, "--key-stdin");
  let body = text;
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (body.endsWith("\r")) body = body.slice(0, -1);
  const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const want = both ? 2 : 1;
  if (lines.length !== want || lines.some((l) => l.trim() === "")) {
    throw new UserError(
      both
        ? "--key-stdin with --secret-stdin: stdin must be exactly two lines, the key and then the secret; anything else is refused (nothing is shown)"
        : "--key-stdin: stdin must be exactly one line, the key; anything else is refused (nothing is shown)"
    );
  }
  const key = lines[0].trim();
  if (!ETH_KEY_RE.test(key)) throw new UserError("--key-stdin: the key must be 0x followed by exactly 64 hex characters; its text is not shown");
  registerSecret(key);
  if (both) {
    const secret = hex32("--secret-stdin", lines[1].trim());
    registerSecret(secret);
    args.secret = secret;
    delete args.secretStdin;
  }
  return key;
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
        `or the transaction would not be sent at all (unused gas is not charged)`
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
const BOUNDED_URL = Symbol("noid-swap.bounded-url");

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
  const provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  // The address the bounded sender (bounded-send.js) connects to for a real claim: the same endpoint the reads use. A private symbol, not printed anywhere.
  Object.defineProperty(provider, BOUNDED_URL, { value: String(url), enumerable: false });
  return provider;
}

/** The endpoint address a provider from `makeProvider` carries for the bounded sender, or null (an in-process provider of a test has none). */
function boundedUrlOf(provider) {
  return provider && typeof provider[BOUNDED_URL] === "string" ? provider[BOUNDED_URL] : null;
}

/** True when the error is the refusal of a redirect answer by a provider from `makeProvider`. */
function isRedirectAnswer(e) {
  return !!e && e.code === "REDIRECT_REFUSED";
}

// ------------------------------------------------ the outcome of the claim's bounded send (bounded-send.js)
/**
 * What the bounded sender made of a claim's send, as an error the caller turns into text: outcome "not_sent" (proven: no byte of the claim was written),
 * "delivered_rejected" (the endpoint's node refused it: the endpoint has the secret) or "unknown" (the secret may be out). Never thrown for "accepted".
 * Fields: outcome, stage (not_sent), reason (sanitized, from the sender), status, retryAfter, hash (known before the send), alarm, rst, clockJump, closeConfirmed, killedByDeadline.
 */
class SendOutcomeError extends Error {
  constructor(o) {
    super("");
    this.name = "SendOutcomeError";
    this.outcome = o.outcome;
    this.stage = o.stage || null;
    this.reason = o.reason || "";
    this.status = o.status === undefined ? null : o.status;
    this.retryAfter = o.retryAfter || null;
    this.hash = o.hash || null;
    this.alarm = o.alarm || null;
    this.redirect = o.redirect === true;
    this.throttled = o.throttled === true;
    this.rst = o.rst === true;
    this.clockJump = o.clockJump === true;
    this.closeConfirmed = o.closeConfirmed !== false;
    this.killedByDeadline = o.killedByDeadline === true;
    this.timeBoundBroken = o.timeBoundBroken === true;
    this.message = sendOutcomeText(this, {});
  }
}

const NOT_SENT_STAGE = {
  url: "the endpoint address could not be used",
  dns: "stopped while resolving the endpoint's name",
  connect: "stopped while connecting",
  tls: "stopped during the TLS handshake",
  check: "stopped at the check before the write",
  closed: "the connection was closed before the write",
  sign: "stopped while signing",
};

/**
 * The words for an outcome of the claim's send (one function for every outcome, with and without --swap). ctx: hasSwap, sidecarFile (the sidecar written for
 * this attempt, or null), fate (not_sent: what happened to a sidecar this call had written), lockFile (the claim lock, when it was left on disk).
 */
function sendOutcomeText(o, ctx = {}) {
  const hash = o.hash ? ` Transaction hash ${o.hash}: look for it on a second endpoint.` : "";
  const next =
    ctx.hasSwap === true
      ? ctx.sidecarFile
        ? ` Run tick --apply now: the reveal sidecar ${ctx.sidecarFile} was written before the send and stays, so swap-cli treats the secret as possibly public and a re-send is judged by the late cutoff.`
        : " Run tick --apply now; a re-send is judged by the late cutoff."
      : " There is no sidecar (no --swap): nothing records this attempt; run swap-cli tick --apply against your swap file now.";
  const tail =
    (o.timeBoundBroken ? " TIME BOUND NOT KEPT: the machine was suspended or stalled during the send, so the claim may have reached the network later than the cutoff allowed; treat the secret as public." : "") +
    (o.alarm ? ` ALARM: ${o.alarm}.` : "") +
    (o.killedByDeadline && !o.rst ? " The connection could not be reset: the operating system may still retransmit a segment written before the kill for its retransmission period." : "") +
    (o.closeConfirmed === false
      ? ` The connection could not be confirmed closed within ${bsend.sendTiming().closeWaitMs / 1000} s${ctx.lockFile ? `; the claim lock file ${ctx.lockFile} is left: delete it by hand after this process has exited` : ""}.`
      : "");
  if (o.outcome === "not_sent") {
    const where = NOT_SENT_STAGE[o.stage] || "stopped before the write";
    return `Nothing was sent (${where}): ${o.reason}.${ctx.fate ? ` ${ctx.fate.charAt(0).toUpperCase()}${ctx.fate.slice(1)}.` : " No reveal sidecar of this attempt was left."}${tail}`;
  }
  if (o.outcome === "delivered_rejected") {
    return `The endpoint received the claim and its node refused it (${o.reason}). The endpoint has seen the secret: treat it as public.${hash}${next}${tail}`;
  }
  // unknown
  const strict = ` Run tick --apply first in any case; only if you are then certain it was not forwarded, you may re-send with --margin-s ${DEFAULT_MARGIN_S}, which keeps the strict cutoff.`;
  if (o.throttled) {
    return (
      "The endpoint answered HTTP 429 (throttled) to the request that carried only this claim. Endpoints usually refuse a throttled request before a node sees it, " +
      "but this cannot be known here: the claim MAY have reached the network and the secret may be public. This tool never repeats a reveal by itself." +
      `${hash}${next}${strict}${tail}`
    );
  }
  if (o.redirect) {
    return (
      `The endpoint answered a redirect (HTTP ${o.status}) to the request that carried only this claim; this tool never follows a redirect, so the claim was not sent anywhere else. ` +
      "Whether the endpoint's own node saw it cannot be known here: the claim MAY have reached the network and the secret may be public. This tool never repeats a reveal by itself." +
      ` To use the right address, put the endpoint's final URL in ETH_RPC_URL.${hash}${next}${strict}${tail}`
    );
  }
  return `The claim may have reached the network (${o.reason}); the secret may be public. This tool never repeats a reveal by itself.${hash}${next}${tail}`;
}

/**
 * Environment settings that would make Node route requests through a proxy. The bounded sender connects directly and never uses one, so the reads and the
 * send would take different paths: a real claim is refused while any of them is in effect. Returns the sentence, or null.
 */
function envProxyRefusal(env = process.env, execArgv = process.execArgv) {
  const v = env.NODE_USE_ENV_PROXY;
  const flagged = (list) => list.some((a) => /^--use-env-proxy(=|$)/.test(String(a)));
  const inOptions = flagged(String(env.NODE_OPTIONS || "").split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, "")));
  if ((v !== undefined && v !== "" && v !== "0") || inOptions || flagged(execArgv || [])) {
    return "refusing: Node is set to route requests through the environment's proxy (NODE_USE_ENV_PROXY or --use-env-proxy), but the claim's send connects directly and never uses a proxy, so the reads and the send would take different paths; unset it for this command (nothing was signed, nothing was sent)";
  }
  return null;
}

/**
 * The claim's send through the bounded sender. Returns a TransactionResponse (ethers) for the accepted transaction; throws a SendOutcomeError for every
 * other outcome, or the error opts.lastCheck threw (a refusal at the check, nothing sent). Order (see "Time bound on the send"): connect first (nothing is
 * written, no sidecar exists yet), then opts.preSend (reads, verdicts, sidecar), the local signature, then the sender's synchronous check, the write and
 * the kill timer in one block. The claim lock (opts.afterSend) is let go only after the sender's socket has closed.
 */
async function boundedBroadcast(provider, signer, args, toSend, opts) {
  const url = boundedUrlOf(provider);
  if (url === null) {
    throw new UserError("refusing: a real claim is sent through the bounded sender, which needs the endpoint address of a provider made by makeProvider (the command line always has one); nothing was signed, nothing was sent");
  }
  if (!(signer instanceof ethers.BaseWallet)) {
    throw new UserError("refusing: a real claim is signed with a local key (--key-file): the bounded sender needs the signed bytes before the send, and a node-held or remote signer would do its own network reads between the last check and the broadcast; nothing was signed, nothing was sent");
  }
  const sp = signer.provider;
  if (sp && sp !== provider && boundedUrlOf(sp) !== url) {
    throw new UserError("refusing: the signer and the provider talk to different endpoints; nothing was signed, nothing was sent");
  }
  if (typeof opts.preSend !== "function" || typeof opts.lastCheck !== "function") throw new Error("execute: opts.boundedSend requires opts.preSend and opts.lastCheck");
  let conn;
  try {
    conn = await bsend.openBoundedConnection(url);
  } catch (e) {
    if (e instanceof bsend.BoundedSendError) throw new SendOutcomeError({ outcome: "not_sent", stage: e.stage, reason: e.message });
    throw e;
  }
  try {
    await opts.preSend(toSend);
  } catch (e) {
    conn.destroy(); // nothing was written on it
    throw e;
  }
  let raw;
  let txObj;
  try {
    raw = await signer.signTransaction(toSend);
    txObj = ethers.Transaction.from(raw);
  } catch {
    conn.destroy();
    throw new SendOutcomeError({ outcome: "not_sent", stage: "sign", reason: "the transaction could not be signed" });
  }
  const hash = txObj.hash;
  let res;
  try {
    res = await conn.sendOnce({
      rawTx: raw,
      expectedHash: hash,
      check: opts.lastCheck,
      sanitize: redact,
      onSignal: typeof opts.onSignal === "function" ? (sig) => opts.onSignal(sig, { hash }) : undefined,
    });
  } catch {
    // sendOnce throws only before it has done anything (its arguments are refused): nothing was written.
    conn.destroy();
    throw new SendOutcomeError({ outcome: "not_sent", stage: "check", reason: "the send could not be started" });
  }
  // The socket has closed (or the close wait ran out): no byte of this attempt can leave any more, so the claim lock may go.
  if (typeof opts.afterSend === "function") opts.afterSend({ closeConfirmed: res.closeConfirmed });
  if (res.outcome === "not_sent") {
    // The check's own refusal is a UserError that already carries its sidecar fate. Anything else that failed before the write (a bug in the check, the request
    // that could not be built or set up) is a plain not_sent: the caller takes the sidecar this call made back, instead of the "may have reached the network" text.
    if (res.error instanceof UserError) throw res.error;
    throw new SendOutcomeError({ ...res, stage: res.stage || "check", reason: res.error ? "the check before the write failed unexpectedly" : res.reason });
  }
  let r = res;
  if (r.outcome === "delivered_rejected" && r.nonceTooLow === true) r = await bsend.settleNonceTooLow(r, (h) => provider.getTransactionReceipt(h), hash);
  if (r.outcome !== "accepted") {
    throw new SendOutcomeError({ ...r, hash, closeConfirmed: res.closeConfirmed, rst: res.rst, killedByDeadline: res.killedByDeadline, clockJump: res.clockJump, timeBoundBroken: res.timeBoundBroken });
  }
  // Accepted by the node (or already known / already mined). Show the hash before the wait: a stuck transaction needs it for --replace-tx.
  if (typeof args.onSent === "function") args.onSent({ hash, nonce: txObj.nonce, maxFeePerGas: txObj.maxFeePerGas, maxPriorityFeePerGas: txObj.maxPriorityFeePerGas });
  // The block the replacement scan of resp.wait starts from is the one read BEFORE the write (preSend): a replacement mined between the write and now would
  // otherwise be missed and the wait could hang. Only without it (no preSend reading) is it read now.
  let startBlock = typeof opts.startBlock === "function" ? opts.startBlock() : null;
  if (startBlock === null || startBlock === undefined) {
    try {
      startBlock = await provider.getBlockNumber();
    } catch {
      startBlock = null; // only the replacement detection of resp.wait is lost
    }
  }
  try {
    const network = await provider.getNetwork();
    const wrapped = provider._wrapTransactionResponse(txObj, network);
    return startBlock === null ? wrapped : wrapped.replaceableTransaction(startBlock);
  } catch {
    // A provider without the library's internal wrapper: the minimal response the caller needs.
    return {
      hash,
      nonce: txObj.nonce,
      maxFeePerGas: txObj.maxFeePerGas,
      maxPriorityFeePerGas: txObj.maxPriorityFeePerGas,
      wait: (confirms) => provider.waitForTransaction(hash, confirms),
    };
  }
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
 * receipt (only together with opts.preSend). The claim uses it to release its lock file (see takeClaimLock). On the bounded path it is called with
 * { closeConfirmed } and only after the sender's socket has closed.
 * opts.startBlock: () => the block number read in preSend (before the write), where the replacement scan of the receipt wait starts (bounded path).
 * opts.boundedSend: the claim's send goes through bounded-send.js (see "Time bound on the send" in the header): connect first, then opts.preSend, the
 * signature, and opts.lastCheck as the synchronous check right before the write. Needs opts.preSend, opts.lastCheck, a local key and a provider from
 * makeProvider. opts.onSignal(signal, { hash }) is told when a catchable signal reset the socket during the send window.
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
  let sentShown = false; // the bounded path shows the hash itself, as soon as the node has accepted the transaction
  if (typeof opts.preSend === "function") {
    // Fill nonce, chain id and fees first, so that no network read is left between the guard and the broadcast. Only with a fixed gas limit: then
    // nothing is estimated and the calldata (the secret) goes to the node only inside the transaction itself.
    if (fixedGas !== null && typeof signer.populateTransaction === "function") toSend = await signer.populateTransaction(req);
    if (opts.boundedSend === true) {
      // The claim: the bounded sender (bounded-send.js). Order: connect, preSend (reads, verdicts, sidecar), sign, synchronous check, write, kill timer.
      resp = await boundedBroadcast(provider, signer, args, toSend, opts);
      sentShown = true;
    } else {
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
        // the send fails and the claim says so. What remains is the request's own duration (the library's 300 s is an inactivity timer, the name lookup
        // and the connect have no library timeout, and on a timeout the library rejects without aborting the request). THIS path is no longer the claim's:
        // a claim goes through the bounded sender (opts.boundedSend, bounded-send.js); this path is the `lock`'s (decision D5: unchanged, a lock carries no
        // secret) and the in-process path of the tests (args.unboundedSendInProcess). A redirect answer (301, 302, 307, 308, or any 3xx) is NOT followed by
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
    }
  } else {
    resp = await signer.sendTransaction(toSend);
  }
  // The hash is shown before the wait: a stuck transaction needs it for --replace-tx. (The command line sets onSent.)
  if (!sentShown && typeof args.onSent === "function") args.onSent({ hash: resp.hash, nonce: resp.nonce, maxFeePerGas: resp.maxFeePerGas, maxPriorityFeePerGas: resp.maxPriorityFeePerGas });
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
// The latch `swap-cli tick --apply` writes when the screen refuses a `lock_eth` intent that is still pending (engine.rs): the entry is
// `producer_alert_lock_pending:<the intent's decided_at>` and, since the 2026-11-10 batch, `...:<decided_at>:<kind of the finding>`. It is
// written for EVERY kind of refusal (concentration over the limit, data that cannot be verified, second node missing or differing, a remembered
// detection), so this script can refuse a pending lock on the latch alone.
const PRODUCER_LOCK_LATCH_PREFIX = "producer_alert_lock_pending:";

/** Where the remembered detection is on record for this swap file: { marker: string|null, history: boolean }. Reads nothing but local metadata. */
function producerDetection(sw) {
  // The marker is looked for beside the path as given (resolved) and, when that is another name, beside the real path too (a link to the swap
  // file): swap-cli writes it beside the path it was given. Either one counts; a name that cannot be examined counts as present.
  const names = [sw.file + PRODUCER_MARKER_SUFFIX];
  if (sw.realFile && sw.realFile !== sw.file) names.push(sw.realFile + PRODUCER_MARKER_SUFFIX);
  const notes = [];
  for (const markerPath of names) {
    try {
      fs.lstatSync(markerPath);
      notes.push(`${markerPath} exists`);
    } catch (e) {
      if (!(e && e.code === "ENOENT")) notes.push(`${markerPath} cannot be examined (${e && e.code ? e.code : "error"}), which counts as present`);
    }
  }
  return { marker: notes.length === 0 ? null : notes.join(" and "), history: sw.producerDiffersSeen === true };
}

/**
 * Where the entries that matter sit in the swap file's history, by position (the history is append-only, so position is order):
 * the last detection entry, the last pending-lock latch entry of THIS intent, and the last override entry. -1 = none. A latch entry of an
 * earlier, cancelled intent has another decided_at and is not looked at. If the intent's decided_at cannot be read, any latch entry counts.
 */
function producerHistoryPositions(sw) {
  const ev = Array.isArray(sw.historyEvents) ? sw.historyEvents : [];
  // decided_at is the engine's Unix time (a u64). Anything else (a hand edit: an object, a float, a negative or huge number) is not matched against a
  // latch's name, so any latch counts (fail closed).
  const rawAt = sw.intent ? sw.intent.decided_at : undefined;
  const decidedAt = Number.isSafeInteger(rawAt) && rawAt >= 0 ? String(rawAt) : null;
  const latchBase = decidedAt === null ? PRODUCER_LOCK_LATCH_PREFIX : `${PRODUCER_LOCK_LATCH_PREFIX}${decidedAt}`;
  let lastLatch = -1;
  let lastOverride = -1;
  ev.forEach((e, i) => {
    if (decidedAt === null ? e.startsWith(latchBase) : e === latchBase || e.startsWith(`${latchBase}:`)) lastLatch = i;
    if (e.startsWith(PRODUCER_OVERRIDE_PREFIX)) lastOverride = i;
  });
  return { lastDetection: ev.lastIndexOf(PRODUCER_DIFFERS_EVENT), lastLatch, lastOverride };
}

/**
 * `lock` only: refuse (production, no waiver) or warn (waiver recorded, or any other profile) when the producer screen of swap-cli has refused
 * this lock: a remembered detection (the marker file or the history entry), or a latch entry for THIS pending intent (a tick found the screen
 * refusing it, whatever the kind of refusal). A waiver is an override entry that comes AFTER the entry it waives, by position in the history.
 * Local reads only.
 */
function checkProducerMemory(sw) {
  const found = producerDetection(sw);
  const pos = producerHistoryPositions(sw);
  const latched = pos.lastLatch >= 0;
  const detected = found.marker !== null || found.history;
  if (!detected && !latched) return;
  const production = sw.profile === "production";
  const refusals = []; // texts of the memories that stand (production, no waiver after them)
  let needsApply = false; // the marker is there but the history holds no detection entry yet
  let latchStands = false; // the latch of this intent stands (nothing waives it)
  const waived = []; // texts of the memories an override entry waives
  if (detected) {
    const evidence = [found.marker === null ? null : `the marker file ${found.marker}`, found.history ? `the swap file's history holds "${PRODUCER_DIFFERS_EVENT}"` : null].filter(Boolean).join(" and ");
    const what = `the producer screen of swap-cli remembers that two Parano1d nodes named different producers for the same block (${evidence})`;
    // A marker with no detection entry in the history: there is no entry for an override to come after, so no override entry can be told from an
    // older one (e.g. one for a concentration). Nothing counts until a `tick --apply` has written the detection into the history (an outside read, 2026-11-10).
    const markerOnly = found.marker !== null && !found.history;
    if (!production) waived.push(what);
    else if (markerOnly) {
      needsApply = true;
      refusals.push(`${what}, and under the production profile that screen refuses the lock`);
    } else if (pos.lastOverride > pos.lastDetection) waived.push(what);
    else refusals.push(`${what}, and under the production profile that screen refuses the lock`);
  }
  if (latched) {
    const what = `the swap file's history holds a "${PRODUCER_LOCK_LATCH_PREFIX}..." entry for this pending lock_eth intent: a tick found the producer screen refusing it (a share over the limit, data that could not be verified, a second node missing or differing, or a remembered detection)`;
    if (!production) waived.push(what);
    else if (pos.lastOverride > pos.lastLatch) waived.push(what);
    else {
      refusals.push(`${what}, and no ${PRODUCER_OVERRIDE_PREFIX} entry comes after it`);
      latchStands = true;
    }
  }
  if (refusals.length > 0) {
    throw new UserError(
      `refusing: ${refusals.join("; and ")}. ` +
        "This is a screen, not a defence. Do not send this lock. If nothing was sent, cancel the intent with `swap-cli intent FILE --cancel` (with the same chain flags as tick). " +
        "The way on is `--accept-producer-concentration` on the next `tick --apply` (it is recorded in the swap file and printed on every tick), or ending this swap and starting a new one with a new swap file. Once a `tick --apply` has run, removing the marker does not clear it." +
        (needsApply
          ? ` The swap file's history holds no "${PRODUCER_DIFFERS_EVENT}" entry yet, so no override can count: run \`swap-cli tick --apply\` (it writes the detection into the history), pass \`--accept-producer-concentration\` on that tick if you accept the risk, and then run this lock again.`
          : "") +
        (latchStands
          ? " A latch stays on record even if the screen passes again: the flag writes no override entry on a pass, so then the way on is to cancel the intent (`swap-cli intent FILE --cancel`, same chain flags as tick) and let a `tick --apply` record a new one."
          : "")
    );
  }
  for (const what of waived) {
    process.stderr.write(
      production
        ? `WARNING: ${what}; this lock goes ahead only because the swap file records the operator's ${PRODUCER_OVERRIDE_PREFIX} (tick --accept-producer-concentration). A screen, not a defence.\n`
        : `WARNING: ${what}; under the ${sw.profile} profile this only warns. A screen, not a defence.\n`
    );
  }
}

/** The `eth_key` record of a swap file as { address, payout } (checksummed), null when there is none, { invalid: true } when it does not parse. Never throws. */
function ethKeyRecordOf(rec) {
  if (rec === undefined || rec === null) return null;
  try {
    return { address: ethers.getAddress(rec.address), payout: ethers.getAddress(rec.payout) };
  } catch {
    return { invalid: true };
  }
}

/** Parse the parts of the swap file this script needs. Read-only; `secret` is never looked at. */
function readSwapFile(file, want = null) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new UserError(`--swap: swap file not found: ${abs}`);
  // The claim lock and the reveal sidecar are named from the REAL path of the swap file, so that the same file reached through a link gets the same
  // lock and the same sidecar (an outside read, 2026-11-10). If the real path cannot be found out, nothing that is keyed to it can be trusted: refuse.
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    throw new UserError(`--swap: the real path of ${abs} cannot be determined (${codeOf(e)}); the claim lock and the reveal sidecar are named from it, so refusing`);
  }
  // One name per swap file for a lock and a claim (an outside read, 2026-11-10): realpath resolves links of the symbolic kind, not hard links, so the same
  // file under two names would get two claim locks and a marker file beside the other name would be missed. A link count above 1 is refused, with the fix.
  // Only where the file system reports a count: a share or file system that reports 0, 1 or nothing (some network shares do) gets no refusal here.
  if (want === "lock_eth" || want === "reveal_eth") {
    let nlink;
    try {
      nlink = fs.statSync(real).nlink;
    } catch (e) {
      throw new UserError(`--swap: the link count of ${real} cannot be read (${codeOf(e)}); refusing`);
    }
    if (typeof nlink === "number" && nlink > 1) {
      throw new UserError(
        `--swap: ${abs} has ${nlink} hard links (names for the same file). The claim lock and the marker files are named from the path, so a second name would get its own claim lock and miss a marker beside the first: ` +
          `keep one name (remove the other links, or copy the file to a new one and delete the old names), then run again; refusing`
      );
    }
  }
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
      // Where the claim lock and the reveal sidecar live (their names are this plus a suffix). Equal to `file` unless the file is reached through a link.
      realFile: real,
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
      // Swap wallet, piece 2b (sweep and reserve only; lock, claim and refund never look at these): the file's role ("alice" or "bob", else null), the phase's name, the kind of
      // a pending action, and the `eth_key` record (the address of the party's own Ethereum account and the payout address the sweep goes to; `{ invalid: true }` when the
      // record does not parse, which only sweep reads, and refuses).
      role: j.role === "alice" || j.role === "bob" ? j.role : null,
      phaseName: j.phase && typeof j.phase === "object" && typeof j.phase.phase === "string" ? j.phase.phase : null,
      pendingActionKind: j.pending_action && typeof j.pending_action === "object" && typeof j.pending_action.kind === "string" ? j.pending_action.kind : null,
      ethKey: ethKeyRecordOf(j.eth_key),
      // REVIEW-4 R4-3: swap-cli's own predicate (`secret_may_be_public`): the file shows Alice's claim reached the network.
      secretMayBePublic: Array.isArray(j.history) && j.history.some((h) => h && SECRET_PUBLIC_EVENTS.has(h.event)),
      // The producer screen of swap-cli (T21): its remembered detection is the history entry `producer_differs_seen`; the operator's waiver is an
      // entry whose event starts with `producer_concentration_overridden` (`tick --accept-producer-concentration`). Only `lock` reads them.
      producerDiffersSeen: Array.isArray(j.history) && j.history.some((h) => h && h.event === PRODUCER_DIFFERS_EVENT),
      // The event names in order (a non-string event is ""): `checkProducerMemory` judges the detection, the pending-lock latch and the override by
      // position. An override counts only when its entry comes AFTER the entry it waives (an older override, e.g. for a concentration, must not waive a
      // later disagreement or a later refusal).
      historyEvents: Array.isArray(j.history) ? j.history.map((h) => (h && typeof h.event === "string" ? h.event : "")) : [],
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

/**
 * Is a process with this pid alive on THIS machine? Words for the refusal message only; the answer never lets the lock be taken over.
 * Signal 0 sends nothing: "no such process" = not alive, "not permitted" = alive (another user's). A pid can be reused by an unrelated process, and
 * a lock made on another machine or by another kind of process (e.g. a different shell's pid space) records a pid that means nothing here, so the
 * sentence always says that the operator decides.
 */
function pidLiveness(pid, kill = process.kill, noun = "claim") {
  let alive;
  try {
    kill(pid, 0);
    alive = true;
  } catch (e) {
    if (e && e.code === "ESRCH") alive = false;
    else if (e && e.code === "EPERM") alive = true;
    else return "whether that process is still alive could not be determined";
  }
  return alive
    ? `a process with that pid is alive on this machine, so another ${noun} may well be running (the pid may also have been reused by an unrelated process)`
    : `no process with that pid is alive on this machine, so the ${noun} that took it probably died (a lock made on another machine would show the same: check before deleting)`;
}

/** What the lock file at `file` says about its holder, for the refusal message (never throws). */
function describeClaimLock(file, noun = "claim") {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && Number.isSafeInteger(j.pid) && j.pid > 0 && Number.isSafeInteger(j.at)) return `it records pid ${j.pid}, taken at Unix second ${j.at}; ${pidLiveness(j.pid, process.kill, noun)}`;
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
  return takeSwapLock(claimLockPath(swapFile), "claim");
}

/** The exclusive lock file behind takeClaimLock (a claim) and the lock lock (a lock): `file` is the full name, `noun` the word the messages use. */
function takeSwapLock(file, noun) {
  const body = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, at: Math.floor(Date.now() / 1000) }) + "\n", "utf8");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    const how =
      e && e.code === "EEXIST"
        ? `another ${noun} for this swap file is running, or an earlier one died: the lock file ${file} exists (${describeClaimLock(file, noun)})`
        : `the lock file ${file} could not be created (${codeOf(e)}), so it is not known whether another ${noun} for this swap file is running`;
    throw new UserError(
      `refusing: ${how}. Nothing was read or written beside the swap file and nothing was sent. If you are sure that no other ${noun} for this swap file is running, ` +
        `delete ${file} by hand and run the ${noun} again; this tool never removes a lock it did not make`
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
    /** The lock stays on disk (the bounded sender could not confirm its socket closed): every later release() does nothing. The operator deletes the file by hand. */
    leave() {
      released = true;
    },
    release() {
      if (released) return;
      released = true;
      try {
        const got = fs.readFileSync(file);
        if (got.length <= body.length && body.subarray(0, got.length).equals(got)) fs.unlinkSync(file);
        else process.stderr.write(`warning: the ${noun} lock ${file} now holds another record and was left in place\n`);
      } catch (e) {
        if (e && e.code === "ENOENT") return; // already gone
        process.stderr.write(`warning: the ${noun} lock ${file} could not be removed (${codeOf(e)}); delete it by hand before the next ${noun} for this swap file\n`);
      }
    },
  };
}

// ------------------------------------------------ the lock lock and the lock record (2026-11-10)
// The duplicate rule of `lock` reads MINED Locked events only, so a second real lock could pass while the first send is still in flight or timed out
// unconfirmed (Bob would lock twice). Four layers are meant to close that window on the lock side; refusing a lock is always the safe direction (no lock, no ETH at risk):
//  (a) the lock lock `FILE.lock-lock`: a real `lock --swap FILE` takes it exclusively (the claim lock's code and its fail-closed handling, a file of its own
//      so a claim and a lock never meet) before any check and holds it until the send has settled;
//  (b) the pending-nonce check: the sender has no transaction pending on the node (pending nonce above latest nonce). An extra only: nodes drop pending
//      transactions, so (c) and (d) are the checks that count;
//  (c) the lock record `FILE.lock-sent`: written and synced BEFORE the broadcast (lock word, lock id, sender, nonce, signed hash when the key is local, time;
//      nothing secret), created exclusively. A later real lock refuses while it exists. The tool NEVER removes it once the bytes may have left (only a
//      call that was refused before the broadcast takes back the record it made itself). The operator removes it by hand, only on one of two proofs (see
//      `lockSentRefusal`; scripts/live/README.md, "Clearing a FILE.lock-sent record"). A record that cannot be examined counts as present;
//  (d) the per-user lock record (an outside read of the public copy 70be980): (c) is named from the swap file's path, so a renamed or copied swap file does not find it.
//      The per-user record is keyed by WHAT is locked, not by a file name: one file per chain id, sender and lock word in `<account home>/.noid-swap/lock-sent/` (nothing in it
//      is secret). The account home is the one the operating system's account database gives the user that runs this script (`os.userInfo().homedir`), NOT the HOME or
//      USERPROFILE of the environment (`os.homedir()` reads only HOME on Linux and macOS and only USERPROFILE on Windows). What this refuses, and what it does not (see `userLockSentDir`):
//        - a HOME (Linux, macOS) or USERPROFILE (Windows) that names a directory other than the account's home (a changed variable, a wrapper that moves HOME, a `sudo` that
//          kept the caller's HOME and cleared its SUDO_ variables) is refused: that would hide the earlier record;
//        - `sudo` usually runs as another user account (its homes are then usually that account's; some setups keep the caller's HOME), which does not see this user's records.
//          It is refused through the two variables `sudo` sets: a run with SUDO_UID or SUDO_USER set and not empty (an empty one counts as unset). `su`, `runas`, another
//          login and another machine cannot be detected and have no record;
//        - cron, a service unit and `env -i` take HOME from the account database or leave it unset (`os.homedir()` then falls back to the account database), unless they set it
//          themselves: then the homes are equal and the records are found. One that sets another HOME is a changed HOME and is refused.
//      Only the mismatch refusal names both homes (it prints "empty or not readable" for an empty one); the sudo refusal and the refusal for an account home that cannot be read
//      name no path.
//      It holds what (c) holds plus the chain id,
//      the contract, the lock kind and the real path of the swap file (null without one). It is written in the same step as (c) and by the same rules (exclusive, synced and
//      read back before the broadcast; if it cannot be made durable nothing is sent and only this call's own bytes are taken back), by EVERY real lock (with a swap file under
//      any name, where it is written beside (c), and without --swap, where it is the only record), found by every real lock, never removed once the broadcast was reached,
//      and cleared by the same two proofs and the same operator section. It does not reach another machine or another user account, and the homes of the helper modes
//      (the Windows profile folder under `LIVE_PLATFORM=wsl`, the Unix home under `native` on macOS and Linux) are homes of different accounts (`wsl` mode and Git Bash `native` mode
//      under the same Windows account share the Windows profile folder): see scripts/live/README.md.
const LOCK_LOCK_SUFFIX = ".lock-lock";
const LOCK_SENT_SUFFIX = ".lock-sent";
const lockLockPath = (swapFile) => String(swapFile) + LOCK_LOCK_SUFFIX;
const lockSentPath = (swapFile) => String(swapFile) + LOCK_SENT_SUFFIX;
const LOCK_SENT_MAX_BYTES = 4096;
const CLEARING_NAME = "Clearing a FILE.lock-sent record"; // the section of scripts/live/README.md and docs/runbook-two-party.md the refusals point at
const USER_LOCK_SENT_SUBDIR = [".noid-swap", "lock-sent"];

/** What the record at `file` says (for the refusal message; never throws). */
function describeLockSent(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > LOCK_SENT_MAX_BYTES) return "it is not a record this tool wrote (not a regular file, or too large)";
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.version === 1 && typeof j.sender === "string" && Number.isSafeInteger(j.nonce) && Number.isSafeInteger(j.at)) {
      const swap = typeof j.swap_file === "string" ? `, swap file ${j.swap_file}` : "";
      return `it records sender ${j.sender}, nonce ${j.nonce}, transaction hash ${j.tx_hash === null ? "unknown (no local key)" : j.tx_hash}, lock id ${j.lock_id}, written at Unix second ${j.at}${swap}`;
    }
  } catch {
    /* say so below */
  }
  return "its content could not be read";
}

/** Names the record can be under: beside the real path and beside the path as given. { file, why } of the first one that is there (or cannot be examined), else null. */
function findLockSent(sw) {
  const names = [lockSentPath(sw.realFile)];
  if (sw.file && sw.file !== sw.realFile) names.push(lockSentPath(sw.file));
  for (const file of names) {
    try {
      fs.lstatSync(file);
    } catch (e) {
      if (e && e.code === "ENOENT") continue;
      return { file, why: `it cannot be examined (${codeOf(e)}), which counts as present` };
    }
    return { file, why: describeLockSent(file) };
  }
  return null;
}

// The home the tests give the per-user records. It is set only by `setUserLockSentHomeForTests`: no command line flag and no environment variable sets it, and only code
// running in this process that loads this file as a module (the tests) can call it. While it is set, the checks of `userLockSentDir` on the account home are skipped.
let userLockSentHomeSeam = null;

/** Test seam: use `dir` (an absolute path) as the home of the per-user records; `null` clears it. Only code running in this process that loads this file as a module can call it. */
function setUserLockSentHomeForTests(dir) {
  if (dir === null) {
    userLockSentHomeSeam = null;
    return;
  }
  if (typeof dir !== "string" || dir === "" || !path.isAbsolute(dir)) throw new Error("setUserLockSentHomeForTests: the home must be an absolute path, or null");
  userLockSentHomeSeam = dir;
}

/** The home of the user account as the operating system's account database gives it (not read from the environment). Throws a UserError when it cannot be determined. */
function accountHome() {
  let home;
  try {
    home = os.userInfo().homedir;
  } catch (e) {
    throw new UserError(`the home directory of this user account cannot be determined (${codeOf(e)})`);
  }
  if (typeof home !== "string" || home === "" || !path.isAbsolute(home)) throw new UserError("the home directory of this user account cannot be determined (it is empty or not an absolute path)");
  return home;
}

/** True when `a` and `b` are absolute paths of the same directory: equal after path.resolve (without regard to letter case on Windows), else equal after resolving links. */
function sameDirectory(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "" || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (norm(a) === norm(b)) return true;
  try {
    const real = fs.realpathSync.native || fs.realpathSync;
    return norm(real(a)) === norm(real(b));
  } catch {
    return false;
  }
}

/**
 * The directory of the per-user lock records: `<account home>/.noid-swap/lock-sent`, where the account home is the one the operating system's account database gives this
 * user (`os.userInfo().homedir`), not the HOME or USERPROFILE of the environment. Throws a UserError (the caller refuses; a record that cannot be placed counts as present):
 *  - when SUDO_UID or SUDO_USER is set and not empty: the tool runs under sudo, which is another user account that does not see the calling user's records;
 *  - when the account home cannot be determined (an empty or relative one is not trusted);
 *  - when the environment's home (`os.homedir()`, which reads only HOME on Linux and macOS and only USERPROFILE on Windows) is not the same directory as the account home, i.e. a
 *    HOME (Linux, macOS) or USERPROFILE (Windows) that names another directory (a changed variable, a wrapper that moves HOME, a `sudo` that kept the caller's HOME and cleared
 *    its SUDO_ variables): the records live under the account home, and the tool refuses rather than look in the wrong place. Only this refusal names both homes ("empty or not
 *    readable" for an empty one); the sudo refusal and the refusal for an unreadable account home name no path. An empty SUDO_UID or SUDO_USER counts as unset.
 * It does NOT detect `su`, `runas`, another login or another machine: they run as another account or place, which has no record. `sudo` usually runs as another user account
 * (its homes are then usually that account's; some setups keep the caller's HOME); it is refused through the two variables it sets. Cron, a service unit and `env -i` take HOME
 * from the account database or leave it unset (`os.homedir()` then falls back to the account database), unless they set it themselves: then the homes are equal and the records
 * are found; one that sets another HOME is a changed HOME and is refused.
 * (Under the test seam, see above, the seam's home is used and these checks are skipped.)
 */
function userLockSentDir() {
  if (userLockSentHomeSeam !== null) return path.join(userLockSentHomeSeam, ...USER_LOCK_SENT_SUBDIR);
  if ((process.env.SUDO_UID !== undefined && process.env.SUDO_UID !== "") || (process.env.SUDO_USER !== undefined && process.env.SUDO_USER !== "")) {
    throw new UserError(
      "this tool runs under sudo (SUDO_UID or SUDO_USER is set), which is another user account: the per-user lock records of the calling user are not visible to it. " +
        "Run it as the user that holds the records"
    );
  }
  const acct = accountHome();
  let envHome = null;
  try {
    envHome = os.homedir();
  } catch {
    envHome = null; // counts as "not the same" below
  }
  if (!sameDirectory(envHome, acct)) {
    throw new UserError(
      `the home of the environment (${typeof envHome === "string" && envHome !== "" ? envHome : "empty or not readable"}) is not the home of this user account (${acct}). ` +
        `The per-user lock records live under the account's home (${path.join(acct, ...USER_LOCK_SENT_SUBDIR)}), whatever HOME or USERPROFILE say, and this tool refuses rather than look in the wrong place: an earlier lock record could be there. ` +
        "Run it as the same user, with HOME and USERPROFILE unchanged"
    );
  }
  return path.join(acct, ...USER_LOCK_SENT_SUBDIR);
}

/** The per-user record of a lock: one file per chain id, sender and lock word (lower case hex), whatever the swap file is called. Throws a UserError for a term that is not well formed. */
function userLockSentPath(chainId, sender, lockWord) {
  const chain = String(chainId);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(chain)) throw new UserError(`the per-user lock record cannot be named: the chain id ${chain} is not a whole number`);
  const s = String(sender).toLowerCase();
  const w = String(lockWord).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) throw new UserError("the per-user lock record cannot be named: the sender is not an address");
  if (!/^0x[0-9a-f]{64}$/.test(w)) throw new UserError("the per-user lock record cannot be named: the lock word is not 32 bytes of hex");
  return path.join(userLockSentDir(), `${chain}-${s.slice(2)}-${w.slice(2)}.json`);
}

/**
 * The per-user record of this lock, or null if there is none: { kind: "user", file, why } when it exists or cannot be examined (that counts as present), also when its place
 * cannot be determined. Never throws, never creates anything (a missing directory means no record).
 */
function findUserLockSent(chainId, sender, lockWord) {
  let file;
  try {
    file = userLockSentPath(chainId, sender, lockWord);
  } catch (e) {
    return {
      kind: "user",
      file: "(unknown place)",
      why: `its place cannot be determined (${e instanceof UserError ? e.message : codeOf(e)}), which counts as present`,
      placeError: e instanceof UserError ? e : null,
    };
  }
  try {
    fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return { kind: "user", file, why: `it cannot be examined (${codeOf(e)}), which counts as present` };
  }
  return { kind: "user", file, why: describeLockSent(file) };
}

/**
 * The refusal when a lock record exists: it says what the record is, what the two proofs are that make removing it by hand safe, and that the tool
 * never removes it. (The duplicate rule refuses first when the lock is mined: this message is for a lock that is not known to be mined.)
 * `found.kind` is "user" for the per-user record, else it is the record beside the swap file.
 */
function lockSentRefusal(found) {
  // A per-user record whose place cannot be determined (an unknown or a different home): there is no record to describe, so the refusal says what is wrong with the place.
  if (found.placeError) return new UserError(`refusing: ${found.placeError.message}. The per-user lock record cannot be looked up; nothing was sent`);
  const user = found.kind === "user";
  return new UserError(
    `refusing: the ${user ? "per-user lock record" : "lock record"} ${found.file} exists (${found.why}). ${user ? "An earlier real lock of this sender under this lock word" : "An earlier real lock for this swap file"} was signed and may have reached the network, and no Locked event of ours for this hashlock is mined, ` +
      "so it is not known whether that lock is pending, dropped or will still be mined; a second lock now could lock ETH twice. Nothing was sent. " +
      "Look the recorded hash up (receipt) and the sender's nonce at a FINALIZED block. Remove the record by hand ONLY if (1) the recorded transaction has a receipt in a finalized block " +
      "with status 0x0 (it reverted and locked nothing; with status 0x1 the lock is mined and the record is kept), or (2) the sender's nonce at a FINALIZED block is above the recorded nonce " +
      "while the recorded hash has no receipt (it can never be mined), AND, whichever proof you use, the contract itself shows no lock: read the record's lock id on two endpoints (`live.js status`) and search the Locked events of this sender " +
      "for this lock word up to the finalized block. If either read shows a lock, that lock IS mined: do not send another. " +
      "\"No receipt for the recorded hash\" proves nothing by itself: a replacement of the same call under another hash (a wallet's \"speed up\") uses the same nonce and can be the one that was mined; " +
      "a record with no transaction hash (no local key) has only the nonce proof, so the two contract reads are mandatory for it. " +
      "If neither proof holds, wait, or let the swap abort: no lock means no ETH at risk. " +
      `${user ? "This per-user record is one file per chain, sender and lock word whatever the swap file is called; remove it only together with a record beside the swap file, if there is one. " : ""}` +
      `This tool never removes the record itself. The exact read-only commands are in the section "${CLEARING_NAME}" of scripts/live/README.md and docs/runbook-two-party.md`
  );
}

/**
 * Write a lock record exclusively (`wx`), fsync it, sync the directory, read it back. Synchronous. Throws a UserError (nothing was sent) when it cannot be made
 * durable; a file that THIS call created and cannot trust is taken back (only if it holds this call's bytes, or a prefix of them: debris of a short
 * write), and an existing record is never touched. `what` is the noun of the messages, `kind` goes to lockSentRefusal. Returns { file, bytes }.
 */
function writeRecordExclusive(target, body, what, kind) {
  let fd;
  try {
    fd = fs.openSync(target, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") throw lockSentRefusal({ kind, file: target, why: describeLockSent(target) });
    throw new UserError(`refusing: the ${what} ${target} could not be created (${codeOf(e)}); it is written before the lock is broadcast so that a lock that may be in flight stays on record; nothing was sent. Fix the directory and retry`);
  }
  try {
    writeAllSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDir(path.dirname(path.resolve(target)));
    requireBytes(target, body, `the ${what}`);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
    const res = removeLockSentIfOurs(target, body);
    throw new UserError(`refusing: the ${what} ${target} could not be written durably (${codeOf(e)}); nothing was sent. ${lockSentFate(res, target, what)}`);
  }
  return { file: target, bytes: body };
}

/** The fields of the record beside the swap file, in this order (the bytes of an earlier version of this tool are unchanged). `rec.at` is the time the record gets. */
function lockSentFields(rec) {
  return { version: 1, lock_word: rec.lockWord, lock_id: rec.lockId, sender: rec.sender, nonce: rec.nonce, tx_hash: rec.txHash, at: rec.at === undefined ? Math.floor(Date.now() / 1000) : rec.at };
}

/** The lock record beside the swap file (`swapFile` is its real path). Returns { file, bytes }. */
function writeLockSent(swapFile, rec) {
  const body = Buffer.from(JSON.stringify(lockSentFields(rec)) + "\n", "utf8");
  return writeRecordExclusive(lockSentPath(swapFile), body, "lock record", "file");
}

/**
 * The per-user lock record: what writeLockSent holds, plus the chain id, the contract, the lock kind and the real path of the swap file (null without one). The directory is
 * made (mode 700) if it is not there. A directory that cannot be made, or a file that cannot be made durable, refuses: nothing was sent. Returns { file, bytes }.
 */
function writeUserLockSent(rec) {
  let target;
  try {
    target = userLockSentPath(rec.chainId, rec.sender, rec.lockWord);
  } catch (e) {
    throw new UserError(`refusing: ${e instanceof UserError ? e.message : codeOf(e)}; the per-user lock record is written before the lock is broadcast; nothing was sent`);
  }
  const dir = path.dirname(target);
  try {
    const made = fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // the first directory it had to make, or undefined
    fsyncDir(path.dirname(dir));
    if (made !== undefined && path.dirname(path.resolve(made)) !== path.dirname(dir)) fsyncDir(path.dirname(path.resolve(made))); // a new `.noid-swap`: its entry in the home too
  } catch (e) {
    throw new UserError(`refusing: the directory ${dir} of the per-user lock records could not be made (${codeOf(e)}); the record is written before the lock is broadcast so that a lock that may be in flight stays on record whatever the swap file is called; nothing was sent. Fix the directory and retry`);
  }
  const body = Buffer.from(
    JSON.stringify({ ...lockSentFields(rec), chain_id: String(rec.chainId), contract: rec.contract, lock_kind: rec.lockKind, swap_file: rec.swapFile === undefined ? null : rec.swapFile }) + "\n",
    "utf8"
  );
  return writeRecordExclusive(target, body, "per-user lock record", "user");
}

/** Remove `file` only if it still holds exactly `body` or a prefix of it (including nothing: the debris of our own short write). { outcome: "removed" | "other" | "failed", code? }. */
function removeLockSentIfOurs(file, body) {
  let res = { outcome: "removed" };
  try {
    let holds;
    try {
      holds = fs.readFileSync(file);
    } catch (e) {
      if (e && e.code === "ENOENT") return res;
      throw e;
    }
    if (holds.length <= body.length && body.subarray(0, holds.length).equals(holds)) fs.unlinkSync(file);
    else res = { outcome: "other" };
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

function lockSentFate(res, file, what = "lock record") {
  if (res.outcome === "removed") return `The ${what} this call had written was removed again (nothing was sent, so it is not a trace of a send).`;
  if (res.outcome === "other") return `The file ${file} now holds another record and was left in place.`;
  return `The ${what} ${file} this call had written could NOT be removed (${res.code}) and stays: it makes every later lock refuse until you have looked at it (see the section "${CLEARING_NAME}" of scripts/live/README.md).`;
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
 * The sidecar of a swap file read the way swap-cli reads it (reveal_sidecar.rs `read`), at every place it can be (T21-19 e): beside the REAL path (where
 * this script writes it) and, when the swap file was reached by another name (a link), beside that name too (where an older `live.js` wrote it). A
 * matching one at either place is evidence that a reveal send MAY HAVE STARTED, and that evidence moves a re-send to the LATE cutoff (T_reveal - DE, the
 * cutoff the intent froze) instead of the strict T_reveal - M_A, exactly as swap-cli does; an explicit --margin-s still overrides it. The real path's is
 * looked at first and wins. When neither matches, the answer is the real path's, unless that one is absent: then the other name's (so that its note, if any,
 * is shown). So reading the second place can only find evidence that was missed before (and so loosen the cutoff for a re-send to the late one), never hide it.
 */
function readRevealSidecarOf(sw, lockId) {
  const first = readRevealSidecar(sw.realFile, lockId);
  if (first.state === "matching" || !sw.file || sw.file === sw.realFile) return first;
  const second = readRevealSidecar(sw.file, lockId);
  return second.state === "matching" || first.state === "absent" ? second : first;
}

/**
 * Leftover temporary files of a crashed sidecar write beside the real swap file (`<sidecar>.<pid>.<random>.tmp`), for a note only (T21-18 e). Nothing here
 * removes, renames or reads them: a temporary file is made before the sidecar is published, and the sidecar is published before any send, so one that is
 * left holds no evidence of a send that its sidecar does not. Returns the file names found (a name only; empty when none or the folder cannot be listed).
 */
function leftoverSidecarTmpFiles(swapFile) {
  try {
    const target = path.resolve(revealSidecarPath(swapFile));
    const prefix = path.basename(target) + ".";
    return fs.readdirSync(path.dirname(target)).filter((n) => n.startsWith(prefix) && n.endsWith(".tmp")).map((n) => path.join(path.dirname(target), n));
  } catch {
    return [];
  }
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

// ------------------------------------------------ the approval of a fresh check (an outside read, 2026-11-10)
// A real lock sent with --swap must be handed the approval of a fresh read-only `swap-cli tick` (scripts/live/lock.sh runs the tick and hands it over).
// The approval carries three things, all taken from that tick's own output by lock.sh, none of them from the swap file:
//   --approved-intent  the `decided_at` (Unix seconds) of the lock_eth intent the tick held;
//   --approved-terms   the SHA-256 (64 hex digits) of the lock's terms in the fixed encoding below (`approvalText`), computed by lock.sh from the
//                      tick's `intent.intent.params`, `intent.intent.decided_at` and `swap_terms`;
//   --approved-at      the tick's own Unix time (its `now`).
// This script recomputes the hash from the values it is about to SEND (and from the intent in the swap file it just read) and compares. It refuses
// when any of the three is missing, malformed or different, when the tick is older than the engine's observation age limit (MAX_OBSERVATION_AGE_S, the
// value of the constant of that name in swap-cli's engine.rs; a test compares the two) or dated more than APPROVAL_FUTURE_SKEW_S seconds ahead
// of this machine's clock. No flag and no environment variable skips it; a dry run needs none (it sends nothing). It is a binding, not a proof:
// whoever can read the swap file can compute the three values by hand. The approval is not single-use: a second send of the same lock is made
// impossible by the duplicate-hashlock rule, the lock lock, the pending-nonce check and the lock record (see `lock`).
const MAX_OBSERVATION_AGE_S = 120;
const APPROVAL_FUTURE_SKEW_S = 5;
const APPROVAL_FIRST_LINE = "noid-swap lock approval v1";
const CLOCK_HINT =
  " (the helpers run in WSL and live.js on Windows, with two clocks: a WSL clock that has drifted, for instance after the PC slept, refuses every lock; compare `date +%s` in WSL with the Windows clock, resync, for example with `wsl --shutdown`, and run lock.sh again)";

const lowerHex = (name, v, bytes) => {
  const s = String(v).toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(s)) throw new UserError(`approval: ${name} is not 0x and ${bytes * 2} hex digits`);
  return s;
};
const decimalOf = (name, v) => {
  try {
    return uint(name, v).toString();
  } catch {
    throw new UserError(`approval: ${name} is not a non-negative whole number`);
  }
};

/**
 * The fixed, documented encoding the approval's hash is taken over: UTF-8 text, one `name=value` line each in this order, every line ended by "\n",
 * after a first line that names the version. Hex is lower case with 0x, numbers are decimal with no sign, no leading zero, no spaces.
 *   noid-swap lock approval v1
 *   chain_id=<decimal>          contract=<0x, 20 bytes>       lock_kind=<sha256|poseidon>   code_hash=<0x, 32 bytes>
 *   bob_sender=<0x, 20 bytes>   receiver=<0x, 20 bytes>       amount_wei=<decimal>
 *   lock_word=<0x, 32 bytes>    t_reveal=<decimal>            decided_at=<decimal>
 * (one field per line in the text itself). `lock_word` is the hashlock (sha256 kind) or the lock address Addr(s) (poseidon). scripts/live/env.sh
 * (lock_precheck) builds the same text from the tick's output; a shared test vector in eth/test and scripts/live/selftest.sh keeps the two in step.
 */
function approvalText(t) {
  const kind = String(t.lockKind);
  if (!LOCK_KINDS.includes(kind)) throw new UserError(`approval: lock_kind ${kind} is not one of ${LOCK_KINDS.join(", ")}`);
  return (
    [
      APPROVAL_FIRST_LINE,
      `chain_id=${decimalOf("chain_id", t.chainId)}`,
      `contract=${lowerHex("contract", t.contract, 20)}`,
      `lock_kind=${kind}`,
      `code_hash=${lowerHex("code_hash", t.codeHash, 32)}`,
      `bob_sender=${lowerHex("bob_sender", t.bobSender, 20)}`,
      `receiver=${lowerHex("receiver", t.receiver, 20)}`,
      `amount_wei=${decimalOf("amount_wei", t.amountWei)}`,
      `lock_word=${lowerHex("lock_word", t.lockWord, 32)}`,
      `t_reveal=${decimalOf("t_reveal", t.tReveal)}`,
      `decided_at=${decimalOf("decided_at", t.decidedAt)}`,
    ].join("\n") + "\n"
  );
}
const approvalTermsHash = (t) => crypto.createHash("sha256").update(approvalText(t), "utf8").digest("hex");

/**
 * `t`: the terms this call is about to send, `decidedAt`: the pending intent's `decided_at` from the swap file, `args`: the three flags. Throws a UserError
 * (nothing was sent) unless all three are present and well formed, the intent and the terms are the ones the fresh check approved, and the check is
 * recent. `nowS` is the clock (Unix seconds), a parameter only so a test can place it.
 */
function checkApproval(t, decidedAt, args, nowS = Math.floor(Date.now() / 1000)) {
  const given = { intent: args.approvedIntent, terms: args.approvedTerms, at: args.approvedAt };
  const missing = Object.entries({ "--approved-intent": given.intent, "--approved-terms": given.terms, "--approved-at": given.at })
    .filter(([, v]) => v === undefined || v === null || v === "")
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new UserError(
      `a real lock sent with --swap needs the approval of a fresh read-only \`swap-cli tick\` of this swap file: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing. Send the lock through scripts/live/lock.sh ` +
        "(it runs that fresh check right before the send and hands over the three values: --approved-intent, --approved-terms, --approved-at); " +
        "do not call live.js lock directly. Nothing was sent; refusing"
    );
  }
  const whole = (flag, v, digits) => {
    const text = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
    if (typeof text !== "string" || !new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})$`).test(text)) {
      throw new UserError(`${flag} must be a whole number of seconds (Unix time) without sign, spaces or leading zeros; refusing`);
    }
    return BigInt(text);
  };
  const intentAt = whole("--approved-intent", given.intent, 20);
  if (!Number.isSafeInteger(decidedAt) || decidedAt < 0) {
    throw new UserError("the pending intent in the swap file has no decided_at that can be read as a Unix time, so no approval can be matched to it; refusing");
  }
  if (intentAt !== BigInt(decidedAt)) {
    throw new UserError(
      `--approved-intent ${intentAt} is not the decided_at of the lock_eth intent in the swap file (not shown here: it is the number the fresh check hands over, and a number that stays valid must not be copied from an error message): the fresh check approved another intent than the one this file holds (replaced or cancelled and re-recorded since, or a different file); nothing was sent; run the fresh check again (scripts/live/lock.sh); refusing`
    );
  }
  if (typeof given.terms !== "string" || !/^[0-9a-fA-F]{64}$/.test(given.terms)) throw new UserError("--approved-terms must be the 64 hex digits of a SHA-256; refusing");
  const mine = approvalTermsHash({ ...t, decidedAt });
  if (given.terms.toLowerCase() !== mine) {
    throw new UserError(
      `--approved-terms ${given.terms.toLowerCase()} is not the hash ${mine} of the terms this lock would be sent with (chain, contract, lock kind, code hash, sender, receiver, amount, lock word, T_reveal, decided_at): ` +
        "the fresh check approved other terms than the swap file and the flags give now; nothing was sent; run the fresh check again (scripts/live/lock.sh); refusing"
    );
  }
  const at = whole("--approved-at", given.at, 16);
  const now = BigInt(nowS);
  if (at > now + BigInt(APPROVAL_FUTURE_SKEW_S)) {
    throw new UserError(
      `--approved-at ${at} is ${at - now} s in the future of this machine's clock (${now}; allowed: ${APPROVAL_FUTURE_SKEW_S} s): the fresh check and this script disagree about the time${CLOCK_HINT}; nothing was sent; refusing`
    );
  }
  if (now - at > BigInt(MAX_OBSERVATION_AGE_S)) {
    throw new UserError(
      `the fresh check is ${now - at} s old (taken at ${at}, now ${now}); the limit is ${MAX_OBSERVATION_AGE_S} s, the engine's own observation age limit (MAX_OBSERVATION_AGE_S in swap-cli's engine.rs). ` +
        `It is this old because the check took long to finish or the reads since were slow (run it again), or because the two clocks disagree${CLOCK_HINT}; nothing was sent; run the fresh check again (scripts/live/lock.sh); refusing`
    );
  }
}

/**
 * Bind a lock / claim / refund call to the swap file. Returns { args, sw }: `args` with the file's terms filled in
 * (every given flag was checked against the file), `sw` the parsed file; `sw` is null when there is no --swap (the
 * command line warns about that once, in `main`; in-process callers stay quiet). `want` is the intent action this command carries out.
 */
function bindSwap(args, want) {
  if (args.swap === undefined) return { args, sw: null }; // the CLI wrapper has already warned (main)
  const sw = readSwapFile(need(args, "swap"), want);
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

/**
 * The Locked events of one sender and/or one receiver (both indexed: topic2 and topic3), in 50,000-block chunks, like `lockedEventsBySender` and checked the same way: every
 * log is checked again locally (contract, event, the topics asked for, the lock id recomputed from its own fields), so a provider that ignores a topic filter cannot slip another
 * party's lock in. `who` is { sender?, receiver? } (at least one). `sweep` uses it for the locks of one swap.
 */
async function lockedEventsFor(provider, contractAddr, who, fromBlock, toBlock, kind) {
  if (!who.sender && !who.receiver) throw new Error("lockedEventsFor: a sender or a receiver is required");
  const iface = htlcInterface(kind);
  const topic0 = iface.getEvent("Locked").topicHash.toLowerCase();
  const senderTopic = who.sender ? ethers.zeroPadValue(who.sender, 32).toLowerCase() : null;
  const receiverTopic = who.receiver ? ethers.zeroPadValue(who.receiver, 32).toLowerCase() : null;
  const logs = await getLogsChunked(provider, { address: contractAddr, topics: [topic0, null, senderTopic, receiverTopic] }, fromBlock, toBlock, LOG_RANGE_MAX);
  const out = [];
  for (const log of logs) {
    if (log.removed) continue;
    const t = (log.topics || []).map((x) => String(x).toLowerCase());
    if (String(log.address).toLowerCase() !== String(contractAddr).toLowerCase() || t.length !== 4 || t[0] !== topic0) continue;
    if (senderTopic !== null && t[2] !== senderTopic) continue;
    if (receiverTopic !== null && t[3] !== receiverTopic) continue;
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
/**
 * keygen --stdout: a fresh key, 32 bytes from the OS random generator (never the mnemonic route: that has 128 bits), checked to be a valid secp256k1 secret, written as two
 * lines, the address then the key, to `out` (a pipe: a terminal is refused). Returns { address } (not printed by the caller: the key must not go to a second place).
 */
function keygenStdout(args, out = process.stdout) {
  if (args.out !== undefined) throw new UserError("give exactly one of --out FILE or --stdout");
  if (out.isTTY) {
    throw new UserError(
      "keygen --stdout writes the private key: pipe it (node scripts/live.js keygen --stdout | swap-cli ethkey new --out KEYFILE); stdout is a terminal, so the key would be shown on the screen"
    );
  }
  let wallet = null;
  for (let i = 0; i < 8 && wallet === null; i++) {
    try {
      wallet = new ethers.Wallet("0x" + crypto.randomBytes(32).toString("hex")); // refuses zero and a value at or above the group order: draw again
    } catch {
      wallet = null;
    }
  }
  if (wallet === null) throw new UserError("keygen --stdout: the random generator gave no valid key (8 draws); refusing");
  out.write(`${wallet.address}\n${wallet.privateKey}\n`);
  return { address: wallet.address };
}

/** keygen: write a fresh private key (mode 0600, never overwrite). Prints only the address. */
async function keygen(_provider, _signer, args) {
  if (args.stdout !== undefined) throw new UserError("keygen --stdout writes to the pipe itself (the command line wrapper); in-process use --out FILE");
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
  const [bal, net, blockNumber, nonceLatest, noncePending] = await Promise.all([
    provider.getBalance(a),
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getTransactionCount(a, "latest"),
    provider.getTransactionCount(a, "pending"),
  ]);
  return { address: a, balanceWei: bal.toString(), balanceEth: ethers.formatEther(bal), chainId: net.chainId.toString(), blockNumber, nonceLatest, noncePending };
}

/** address: the address of the key (--key-file or --key-stdin), read-only and offline. With --expect ADDRESS it refuses when the key's address is another one. */
async function keyAddress(_provider, signer, args) {
  requireSigner(signer);
  const a = await signer.getAddress();
  let expected = null;
  if (args.expect !== undefined) {
    expected = address("--expect", args.expect);
    if (!sameAddr(a, expected)) throw new UserError(`the key's address is ${a}, not the expected ${expected}; refusing`);
  }
  return { address: a, matchesExpected: expected === null ? null : true };
}

/** The ASCII text every message of sign-message must start with (the handover's tuples, piece 3). */
const MESSAGE_DOMAIN = "no1d-swap-v1 ";
const MESSAGE_MAX_BYTES = 2048;

/** A message given as 0x-hex bytes; anything else (text, an odd length, an empty message, too long) is refused. */
function messageBytes(v) {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(v)) throw new UserError("--message-hex must be 0x followed by whole bytes in hex (at least one); text is not accepted");
  const bytes = ethers.getBytes(v);
  if (bytes.length > MESSAGE_MAX_BYTES) throw new UserError(`--message-hex is ${bytes.length} bytes; at most ${MESSAGE_MAX_BYTES}`);
  return bytes;
}

/** sign-message: an EIP-191 personal-message signature by the key, only over a message that starts with the domain text. Offline. */
async function signMessage(_provider, signer, args) {
  requireSigner(signer);
  const bytes = messageBytes(need(args, "messageHex", "message-hex"));
  registerSecret(signer.privateKey);
  const head = Buffer.from(MESSAGE_DOMAIN, "ascii");
  if (bytes.length < head.length || !Buffer.from(bytes.subarray(0, head.length)).equals(head)) {
    throw new UserError(`refusing to sign: the message must start with the ASCII text "${MESSAGE_DOMAIN}" (this command signs the handover's tuples only); nothing was signed`);
  }
  return { address: await signer.getAddress(), signature: await signer.signMessage(bytes) };
}

/** verify-message: read-only and offline. valid is true only when the signature is canonical (65 bytes, v 27 or 28, low s) and recovers to --address. */
async function verifyMessage(_provider, _signer, args) {
  const want = address("--address", need(args, "address", "address"));
  const bytes = messageBytes(need(args, "messageHex", "message-hex"));
  const sig = need(args, "signature", "signature");
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new UserError("--signature must be 0x followed by exactly 130 hex characters (65 bytes)");
  let recovered = null;
  const v = parseInt(sig.slice(130), 16);
  if (v === 27 || v === 28) {
    try {
      recovered = ethers.verifyMessage(bytes, sig);
    } catch {
      recovered = null; // a high s, an off-curve r or a failed recovery: not a valid signature
    }
  }
  return { valid: recovered !== null && sameAddr(recovered, want), recovered };
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
  // A real lock with a swap file holds `FILE.lock-lock` from before its checks until the send has settled (execute's afterSend), or until anything
  // before the send throws (the finally below). A dry run writes nothing and takes none. See "the lock lock and the lock record".
  let lockLock = null;
  try {
    if (sw && !args.dryRun) lockLock = takeSwapLock(lockLockPath(sw.realFile), "lock");
    return await lockChecked(provider, signer, args, sw, lockLock);
  } finally {
    if (lockLock !== null) lockLock.release(); // idempotent
  }
}

async function lockChecked(provider, signer, args, sw, lockLock) {
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
  if (args.dryRun) {
    // Local read, stderr only: the dry run otherwise looks clean while the real send would refuse on the lock record of an earlier send.
    const earlier = sw ? findLockSent(sw) : null;
    if (earlier !== null) process.stderr.write(`WARNING: the lock record ${earlier.file} exists (${earlier.why}); a real lock for this swap file would refuse (see the section "${CLEARING_NAME}" of scripts/live/README.md)\n`);
    const earlierUser = findUserLockSent(target.chainId, sender, hashlock);
    if (earlierUser !== null && earlierUser.placeError) process.stderr.write(`WARNING: a real lock would refuse: ${earlierUser.placeError.message}\n`);
    else if (earlierUser !== null) process.stderr.write(`WARNING: the per-user lock record ${earlierUser.file} exists (${earlierUser.why}); a real lock of this sender under this lock word would refuse, whatever the swap file is called (see the section "${CLEARING_NAME}" of scripts/live/README.md)\n`);
    return (await execute(provider, signer, args, tx, { expectedLockId, ...checks, ...fp.report }, { fees: fp.fees })).out;
  }
  let r;
  let written = null; // the lock record this call made (a real lock with a swap file)
  let writtenUser = null; // the per-user lock record this call made (every real lock)
  // What both records say: the lock word, the lock id, the sender, the nonce of the transaction (read from the node when the signer does not put one in) and the signed
  // hash when the key is local. Read in the pre-send step of a real lock.
  const recordOf = async (populated) => {
    const nonce = populated.nonce !== undefined && populated.nonce !== null ? populated.nonce : await provider.getTransactionCount(sender, "pending");
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new UserError("refusing: the transaction has no nonce to put in the lock record; nothing was sent");
    return { lockWord: hashlock, lockId: expectedLockId, sender, nonce, txHash: await presignedHash(signer, populated), at: Math.floor(Date.now() / 1000) };
  };
  if (sw === null) {
    // No swap file: no record beside it, no approval, no lock lock and no pending-nonce check. The per-user record of an earlier real lock refuses (found by chain, sender
    // and lock word), and this lock writes the per-user record itself, by the same rules as one with a swap file: the very last step before the broadcast, so the gas is
    // estimated here and the record is written in the pre-send step.
    const stuckUser = findUserLockSent(target.chainId, sender, hashlock);
    if (stuckUser !== null) throw lockSentRefusal(stuckUser);
    const gasLimit = await signer.estimateGas({ ...tx, ...fp.fees });
    let reachedBroadcast = false;
    const preSend = async (populated) => {
      writtenUser = writeUserLockSent({ ...(await recordOf(populated)), chainId: target.chainId, contract: contractAddr, lockKind: kind, swapFile: null });
    };
    // Runs after the local signature, immediately before the bytes go to the node: from here on the lock may have left this process.
    const lastCheck = () => {
      reachedBroadcast = true;
    };
    try {
      r = await execute(provider, signer, args, tx, {}, { fees: fp.fees, fixedGas: gasLimit, preSend, lastCheck });
    } catch (e) {
      if (writtenUser === null) throw e;
      const base = e instanceof UserError ? redact(e.message) : explain(e);
      if (!reachedBroadcast) {
        throw new UserError(`${base}; ${lockSentFate(removeLockSentIfOurs(writtenUser.file, writtenUser.bytes), writtenUser.file, "per-user lock record")}`);
      }
      // The record stays whatever happens now (a timeout, an error, a revert): the bytes may have left. This tool never clears it.
      throw new UserError(
        `${base} (the per-user lock record ${writtenUser.file} was written before the send and STAYS: the lock may have reached the network, so every later lock of this sender under this lock word refuses until you have looked at it, whatever the swap file is called; ` +
          `see the section "${CLEARING_NAME}" of scripts/live/README.md)`
      );
    }
  } else {
    // The last refusals before the send (every check above stays as it was). First the approval of a fresh read-only tick, of the terms about to be sent.
    const approvedTerms = { chainId: target.chainId, contract: contractAddr, lockKind: kind, codeHash: target.codeHash, bobSender: sender, receiver, amountWei: amount, lockWord: hashlock, tReveal };
    checkApproval(approvedTerms, sw.intent.decided_at, args);
    // (c) a lock record of an earlier send that is not known to be mined: refuse. A record that cannot be examined counts as present.
    const stuck = findLockSent(sw);
    if (stuck !== null) throw lockSentRefusal(stuck);
    // (d) the per-user record of an earlier real lock of this sender under this lock word, whatever the swap file is called (a renamed or copied file does not find (c)).
    const stuckUser = findUserLockSent(target.chainId, sender, hashlock);
    if (stuckUser !== null) throw lockSentRefusal(stuckUser);
    // (b) a transaction of this sender still pending on the node: refuse (an extra; nodes drop pending transactions, the record is what counts).
    const [nonceLatest, noncePending] = await Promise.all([provider.getTransactionCount(sender, "latest"), provider.getTransactionCount(sender, "pending")]);
    if (noncePending > nonceLatest) {
      throw new UserError(
        `refusing: the sender ${sender} has a transaction pending on this node (pending nonce ${noncePending}, latest nonce ${nonceLatest}); an earlier send of this swap's lock may still be mined, and a second lock could lock ETH twice. Nothing was sent. ` +
          `Wait until it is mined or dropped, then look at the contract and at the lock record (the section "${CLEARING_NAME}" of scripts/live/README.md); a node also drops pending transactions, so the record is the check that counts`
      );
    }
    // The gas is estimated here (the same estimate execute would make), so that execute can write the record as the very last step before the broadcast.
    const gasLimit = await signer.estimateGas({ ...tx, ...fp.fees });
    let reachedBroadcast = false;
    const preSend = async (populated) => {
      // The slow steps since the first check (the nonce reads, the gas estimate, populating the transaction) can take long on a stalled endpoint: the approval is
      // judged again, locally, at the last step before the record is written and the bytes are signed.
      checkApproval(approvedTerms, sw.intent.decided_at, args);
      // A local key (the command line's) is populated with its nonce; a node-held account is not (the node picks it at the send), so the nonce it will get is read.
      const rec = await recordOf(populated);
      written = writeLockSent(sw.realFile, rec);
      // The second record, in the same step: if it cannot be made durable nothing is sent, and the catch below takes back both of this call's own records.
      writtenUser = writeUserLockSent({ ...rec, chainId: target.chainId, contract: contractAddr, lockKind: kind, swapFile: sw.realFile });
    };
    // Runs after the local signature, immediately before the bytes go to the node: from here on the lock may have left this process.
    const lastCheck = () => {
      reachedBroadcast = true;
    };
    try {
      r = await execute(provider, signer, args, tx, {}, { fees: fp.fees, fixedGas: gasLimit, preSend, lastCheck, afterSend: () => lockLock.release() });
    } catch (e) {
      if (written === null) throw e;
      const base = e instanceof UserError ? redact(e.message) : explain(e);
      if (!reachedBroadcast) {
        const fates = [lockSentFate(removeLockSentIfOurs(written.file, written.bytes), written.file)];
        if (writtenUser !== null) fates.push(lockSentFate(removeLockSentIfOurs(writtenUser.file, writtenUser.bytes), writtenUser.file, "per-user lock record"));
        throw new UserError(`${base}; ${fates.join(" ")}`);
      }
      // The records stay whatever happens now (a timeout, an error, a revert): the bytes may have left. This tool never clears them.
      throw new UserError(
        `${base} (the lock record ${written.file} was written before the send and STAYS: the lock may have reached the network, so every later lock for this swap file refuses until you have looked at it; ` +
          `see the section "${CLEARING_NAME}" of scripts/live/README.md)` +
          (writtenUser !== null
            ? ` The per-user lock record ${writtenUser.file} was written too and STAYS: every later lock of this sender under this lock word refuses until you have looked at it, whatever the swap file is called.`
            : "")
      );
    }
  }
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
    ...(written !== null ? { lockRecord: written.file } : {}),
    ...(writtenUser !== null ? { userLockRecord: writtenUser.file } : {}),
    ...checks,
    ...fp.report,
  };
}

/** getLock as a plain record; `hashlock` is the lock word of either kind (HTLCPoseidonV2 names the field lockAddr). */
async function fetchLock(provider, contractAddr, lockId, kind = "sha256", blockTag = undefined) {
  const c = new ethers.Contract(contractAddr, htlcInterface(kind), provider);
  try {
    // blockTag (status only): the call is made at that block, so a backend that does not have it errors instead of answering from an older state.
    const r = blockTag === undefined ? await c.getLock(lockId) : await c.getLock(lockId, { blockTag });
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

/**
 * What a --replace did (or, in a dry run, will do) to the reveal sidecar, in words. A replacement never rewrites a sidecar that is there (it records the first
 * attempt); one that is not there is written, naming the replacement. null without --swap or without --replace. `written` is the result of writeRevealSidecar
 * (real run), `early` the reading made before the checks (dry run).
 */
function replaceSidecarNote(sw, replaced, written, early) {
  if (!sw || replaced === null) return null;
  if (written) {
    if (written.state === "kept") return `the reveal sidecar ${written.file} was there before and is kept: it names the first attempt's transaction, not this replacement`;
    if (early && early.state === "matching" && path.resolve(early.file) !== path.resolve(written.file)) {
      return `a sidecar of this lock exists beside the other name ${early.file} and was left as it is; a new one was written beside the real path and names this replacement`;
    }
    return "no reveal sidecar was there before: a new one was written and it names this replacement's transaction (the first attempt is not recorded in it)";
  }
  // writeRevealSidecar looks at the real path only: a matching sidecar beside another name of the file (a link) is evidence, but it is not the one that is kept.
  if (early && early.state === "matching") {
    if (path.resolve(early.file) === path.resolve(revealSidecarPath(sw.realFile))) {
      return `the reveal sidecar ${early.file} is there and will be kept: it names the first attempt's transaction, not this replacement`;
    }
    return `a sidecar of this lock exists beside the other name ${early.file} and is left as it is; a new one will be written beside the real path and names this replacement`;
  }
  return "no reveal sidecar of this lock is there: a new one will be written and it will name this replacement's transaction (the first attempt is not recorded in it)";
}

/** The preimage argument (hex) of the pending transaction `old` when it is a claim call, else null (not a claim, or a call that cannot be decoded). */
function pendingPreimageOf(kind, old) {
  if (!old) return null;
  try {
    const parsed = htlcInterface(kind).parseTransaction({ data: old.data });
    return parsed && parsed.name === "claim" ? String(parsed.args[1]) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------ the receiver's code (R7-7, T11: EOAs only)
// The claim is never estimated, so nothing else would notice a receiver that has (or has gained) code, for instance an EIP-7702 delegation (code starting
// 0xef0100): a claim to a receiver that rejects ETH reverts with the secret in its calldata. The code is read twice, early (before the long scans, so a
// receiver that had code all along fails fast; also in a dry run, so the dry run shows the truth) and again immediately before signing.
//   A FIRST claim: code, a failed read, or an answer that is not hex refuses (nothing signed, nothing sent).
//   A --replace re-send (a verified pending claim of this lock at the oldest nonce exists): the secret is ALREADY public in that transaction, the replacement has
//   the same nonce and the same receiver, so it can never be worse than the pending one, and not sending could leave a stuck claim to miss the timelock.
//   The read is then informational: the claim goes on and a warning says what was found.
/** Read the code of `receiver` at "latest" and at "pending" (a node without pending state answers with latest). Code at either tag counts as code. Never throws. */
async function readReceiverCode(provider, receiver) {
  const [latest, pending] = await Promise.allSettled([provider.getCode(receiver, "latest"), provider.getCode(receiver, "pending")]);
  const isHex = (c) => typeof c === "string" && /^0x[0-9a-fA-F]*$/.test(c);
  if (latest.status === "rejected") return { state: "unreadable", detail: latest.reason instanceof UserError ? latest.reason.message : explain(latest.reason) };
  if (!isHex(latest.value)) return { state: "notHex" };
  // The pending read only ever adds care: a node that cannot answer it, or answers nothing usable, leaves the latest answer to decide.
  const withCode = [latest.value, ...(pending.status === "fulfilled" && isHex(pending.value) ? [pending.value] : [])].find((c) => c !== "0x");
  return withCode === undefined ? { state: "none" } : { state: "code", bytes: (withCode.length - 2) / 2 };
}

/**
 * Judge a reading of the receiver's code. Returns null when there is nothing to say, a warning text (replace mode: `replaced` is the result of resolveReplaced)
 * or throws the refusal of a first claim. `mayBePublic`: the swap file or the reveal sidecar shows an earlier send (weaker evidence than a pending transaction,
 * so it changes the words of the refusal, not the refusal). `when`: "just before signing" or "before the long checks".
 */
function receiverCodeVerdict(rc, { receiver, replaced, replaceJudgedFirst = false, mayBePublic, when }) {
  if (rc.state === "none") return null;
  const codeFact = `the lock's receiver ${receiver} has code on chain (${rc.bytes} bytes, read ${when}; T11: EOAs only, and an EIP-7702 delegation counts too)`;
  const readFact = `could not read the code of the lock's receiver ${receiver} ${when} (${rc.detail})`;
  const hexFact = `the node's answer for the code of the lock's receiver ${receiver} is not a hex string`;
  const fact = rc.state === "code" ? codeFact : rc.state === "unreadable" ? readFact : hexFact;
  if (replaced !== null) {
    const hash = replaced.old && replaced.old.hash ? replaced.old.hash : "(its hash was not shown by the node)";
    return `${fact}; the secret is already public in the pending claim ${hash}; this replacement goes to the same receiver, so if the receiver rejects ETH both revert and only gas is lost`;
  }
  if (rc.state === "unreadable") throw new UserError(`refusing: ${readFact}, so it is not known that the receiver is an account without code (T11: EOAs only); nothing was signed, nothing was sent`);
  if (rc.state === "notHex") throw new UserError(`refusing: ${hexFact} (T11: EOAs only); nothing was signed, nothing was sent`);
  if (mayBePublic) {
    throw new UserError(
      `refusing: ${codeFact}. The secret may already be public (the swap file or the reveal sidecar shows an earlier send), and a claim to a receiver with code can revert; nothing was signed, nothing was sent. ` +
        (replaceJudgedFirst
          ? "Ways out: remove the code or the delegation from the receiver's address. The pending claim does not carry this secret, so this replacement is judged as a first reveal"
          : "Ways out: remove the code or the delegation from the receiver's address, or, if an earlier claim is still pending, use --replace")
    );
  }
  throw new UserError(`refusing: ${codeFact}; a claim to it could revert with the secret public; nothing was signed, nothing was sent`);
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
  // How a real claim is sent (nothing here touches the network): through the bounded sender when the provider carries an endpoint address (the command
  // line's always does; D2: that needs a local key; D4: and no environment proxy), else only for an in-process test provider that says so.
  const boundedSend = boundedUrlOf(provider) !== null;
  if (secret !== null && !args.dryRun) {
    if (boundedSend) {
      if (!(signer instanceof ethers.BaseWallet)) {
        throw new UserError("refusing: a real claim is signed with a local key (--key-file): the bounded sender needs the signed bytes before the send, and a node-held or remote signer would do its own network reads between the last check and the broadcast; nothing was signed, nothing was sent");
      }
      const viaProxy = envProxyRefusal();
      if (viaProxy !== null) throw new UserError(viaProxy);
      // The endpoint address is parsed now, before any read and before the claim lock, so that an address the sender cannot use is refused with nothing touched.
      try {
        bsend.parseEndpoint(boundedUrlOf(provider));
      } catch (e) {
        if (e instanceof bsend.BoundedSendError) throw new UserError(`refusing: ${e.message}; nothing was signed, nothing was sent`);
        throw e;
      }
    } else if (args.unboundedSendInProcess !== true) {
      throw new UserError("refusing: a real claim is sent through the bounded sender, which needs the endpoint address of a provider made by makeProvider (the command line always has one); an in-process provider is for tests and must say so (args.unboundedSendInProcess); nothing was signed, nothing was sent");
    }
  }
  let claimLock = null;
  try {
    // A real claim with a swap file holds the claim lock from here (before the sidecar is first read, in claimChecked) until the send has settled
    // (execute's afterSend) or anything before it fails (the finally below). A dry run writes nothing and takes none.
    if (sw && secret !== null && !args.dryRun) claimLock = takeClaimLock(sw.realFile);
    return await claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw, claimLock, boundedSend });
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

async function claimChecked(provider, signer, args, { contractAddr, lockId, margin, marginGiven, secret, sw, claimLock = null, boundedSend = false }) {
  const kind = kindOf(args);
  // The send budget S (answer window + guard, bounded-send.js): the last moment to START the send is the cutoff minus S, so every cutoff test below is
  // "now + S > cutoff". Only where the claim goes through the bounded sender; the in-process test path has no bound and S = 0 (its tests keep their meaning).
  const sendTime = bsend.sendTiming();
  const tailS = Math.ceil(sendTime.tailMs / 1000);
  const guardS = Math.ceil(sendTime.guardMs / 1000);
  const S = boundedSend ? BigInt(Math.ceil(bsend.sendBudgetMs() / 1000)) : 0n;
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
  // T5: the pending claim is evidence that THIS secret is public only when its own preimage argument is this lock's secret. That is decided from the LOCK WORD, locally
  // (sha256, or the local Addr; nothing is sent anywhere), so a dry run without --secret and the real run agree. Computed once; the late cutoff and the receiver-code
  // rule below both rest on it. Another preimage is judged as a first reveal (the nonce and fee rules still replace the pending transaction).
  const pendingPreimage = replaced !== null ? pendingPreimageOf(kind, replaced.old) : null;
  let carriesSecret = false;
  if (pendingPreimage !== null) {
    try {
      carriesSecret = localLockWord(kind, pendingPreimage).toLowerCase() === l.hashlock.toLowerCase();
    } catch {
      carriesSecret = false;
    }
  }
  if (carriesSecret && secret !== null && pendingPreimage.toLowerCase() !== String(secret).toLowerCase()) {
    throw new UserError(
      `refusing: the given secret is not the preimage in the pending claim ${replaced.old.hash || "(its hash was not shown by the node)"}, although that preimage hashes to the lock's word; the given secret is wrong; nothing was signed, nothing was sent`
    );
  }
  const replacedForCode = carriesSecret ? replaced : null;
  const replaceJudgedFirst = replaced !== null && !carriesSecret;
  let otherPreimageNote = null;
  if (replaceJudgedFirst) {
    const pendingHash = replaced.old && replaced.old.hash ? replaced.old.hash : "(its hash was not shown by the node)";
    otherPreimageNote = `the pending transaction ${pendingHash} is a claim of this lock with a different preimage, so it does not publish this secret; this run is judged as a first reveal (the strict cutoff and the receiver-code refusal apply unless the swap file or the reveal sidecar show an earlier send); it is still replaced (same nonce, same fee rules)`;
    process.stderr.write(`NOTE: ${otherPreimageNote}\n`);
  }
  if (carriesSecret && intentLateCutoff === null && sw && PROFILE_DE_S[sw.profile] !== undefined) {
    intentLateCutoff = l.timelock - PROFILE_DE_S[sw.profile]; // an intent from before REVIEW-5: the profile's DE gives the same number
  }
  // REVIEW-4 R4-3: once the file shows the secret may already be public (swap-cli's late re-send, review H1), a re-send
  // publishes nothing new and the cutoff the intent froze (T_reveal - DE) is the authority, not the stricter default margin.
  // An explicit --margin-s still tightens it. Without that evidence the earlier of the two stays the rule.
  // T21-11: a reveal sidecar of THIS lock beside the file (written just before an earlier claim was broadcast) is the same kind of evidence.
  const sidecar = sw ? readRevealSidecarOf(sw, lockId) : null;
  const sidecarEvidence = sidecar !== null && sidecar.state === "matching";
  const tmpLeft = sw ? [...new Set([...leftoverSidecarTmpFiles(sw.realFile), ...(sw.file !== sw.realFile ? leftoverSidecarTmpFiles(sw.file) : [])])] : [];
  const lateResend = intentCutoff !== null && (sw.secretMayBePublic || carriesSecret || sidecarEvidence) && !marginGiven;
  if (lateResend) {
    // The cutoff the intent froze, or the later T_reveal - DE it froze for exactly this case (a secret that is public already).
    const late = intentLateCutoff !== null && intentLateCutoff > intentCutoff ? intentLateCutoff : intentCutoff;
    cutoff = late < l.timelock ? late : l.timelock;
    cutoffRule =
      carriesSecret
        ? "T_reveal - DE: the pending claim of this lock at the signer's oldest nonce carries this secret, so it is already public (REVIEW-5 R5-1)"
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
  if (now <= cutoff && now + S > cutoff) {
    throw new UserError(
      `refusing: less than ${S} s before the reveal cutoff. now ${now}, cutoff ${cutoff} (${cutoffRule}): the send needs a ${tailS} s answer window and a ${guardS} s guard, so the last moment to start it is ${cutoff - S}; ` +
        `a claim published later can reach the counterparty after the cutoff and lets it take both legs; nothing was sent` +
        (otherPreimageNote !== null ? ` Note: ${otherPreimageNote}` : "")
    );
  }
  if (now > cutoff) {
    throw new UserError(
      `refusing: past the reveal cutoff. now ${now} > cutoff ${cutoff} (timelock ${l.timelock} - margin ${margin} s` +
        `${intentCutoff !== null ? `, or the swap file's frozen cutoff ${intentCutoff}, ${lateResend ? "which rules because the secret may already be public" : "whichever is earlier"}` : ""}) ` +
        `(a late claim publishes the secret and lets the counterparty take both legs; use --margin-s only if you know the risk)` +
        (otherPreimageNote !== null ? ` Note: ${otherPreimageNote}` : "")
    );
  }
  // R7-7, early: the receiver's code, before the long scans (also in a dry run, which then shows what the real run would do). A first claim to a receiver
  // with code is refused here; in replace mode the read only warns (see receiverCodeVerdict). The read is made again immediately before signing.
  const mayBePublic = !!(sw && sw.secretMayBePublic) || sidecarEvidence;
  // The replace rule of the receiver-code check (a warning, not a refusal) rests on the secret being public in the pending claim: see carriesSecret above.
  const earlyReceiverWarning = receiverCodeVerdict(await readReceiverCode(provider, l.receiver), { receiver: l.receiver, replaced: replacedForCode, replaceJudgedFirst, mayBePublic, when: "before the long checks" });
  if (earlyReceiverWarning !== null && args.dryRun) process.stderr.write(`WARNING: ${earlyReceiverWarning}\n`);
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
    swapFile: sw ? sw.realFile : null,
    revealCutoff: cutoff.toString(),
    revealCutoffRule: cutoffRule,
    secondsToCutoff: (cutoff - now).toString(),
    ...(boundedSend
      ? {
          sendBudgetS: Number(S),
          sendAnswerWindowS: tailS,
          sendGuardS: guardS,
          lastStartAt: (cutoff - S).toString(),
          secondsToLastStart: (cutoff - S - now).toString(),
        }
      : {}),
    lockedBlock: ev.log.blockNumber,
    finalizedBlock: finalized.number,
    codeHash: target.codeHash,
    secretProvided: secret !== null,
    ...(sidecar !== null ? { revealSidecar: sidecar.state, revealSidecarFile: sidecar.file, ...(sidecar.note ? { revealSidecarNote: sidecar.note } : {}) } : {}),
    ...(tmpLeft.length > 0
      ? {
          revealSidecarTmpFiles: tmpLeft,
          revealSidecarTmpNote:
            "temporary files of an interrupted sidecar write are left beside the swap file and nothing removed them; they are not evidence that a send happened, and their presence or absence is not evidence that nothing was sent (a sidecar is published before any send: look at the sidecar itself); delete them by hand if you like",
        }
      : {}),
    ...(earlyReceiverWarning !== null ? { receiverCodeWarning: earlyReceiverWarning } : {}),
    ...(otherPreimageNote !== null ? { replacePreimageNote: otherPreimageNote } : {}),
    ...(replaceSidecarNote(sw, replaced, null, sidecar) !== null ? { replaceSidecarNote: replaceSidecarNote(sw, replaced, null, sidecar) } : {}),
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
  let lastReceiverWarning = null; // replace mode only: what the read of the receiver's code just before signing found
  let lockLeft = false; // the claim lock was left on disk because the sender's socket could not be confirmed closed
  let lastBlockRead = null; // { ts, mono }: the latest block's time and the monotonic clock when it was read (preSend), for the synchronous check
  try {
    // The event scans, the finality lookup and the fee planning above can take minutes on a slow public endpoint: the cutoff is read again
    // (wall clock and latest block, the later one) immediately before the claim is signed, against the same cutoff the early check ended with.
    const preSend = async (populated) => {
      // R7-7: the claim is never estimated, so a receiver that has gained code since the early checks (a contract, or an EIP-7702 delegation, which
      // shows as code starting 0xef0100) would make the claim revert with the secret already public. The receiver's code (at "latest" and "pending") and
      // the latest block are read in ONE round, so the window between the code read and the broadcast is one round trip shorter; the code is judged first
      // (a first claim to a receiver with code, or whose code cannot be read, is refused; in replace mode the finding is only a warning), then the cutoff
      // is evaluated from the block just read, and the sidecar is written last. Applies with and without --swap and to a --replace re-send alike.
      const [receiverRead, lateRead] = await Promise.all([readReceiverCode(provider, l.receiver), latestBlock(provider).then((b) => ({ b }), (e) => ({ e }))]);
      lastReceiverWarning = receiverCodeVerdict(receiverRead, { receiver: l.receiver, replaced: replacedForCode, replaceJudgedFirst, mayBePublic, when: "just before signing" });
      if (lastReceiverWarning !== null) process.stderr.write(`WARNING: ${lastReceiverWarning}\n`);
      if (lateRead.e !== undefined) {
        const e = lateRead.e;
        throw new UserError(
          `refusing: could not re-read the latest block just before sending (${e instanceof UserError ? e.message : explain(e)}), so the reveal cutoff ${cutoff} cannot be re-checked; nothing was sent`
        );
      }
      const late = lateRead.b;
      if (BigInt(late.timestamp) >= l.timelock) {
        throw new UserError(
          `refusing: timelock ${l.timelock} has passed (latest block timestamp ${late.timestamp}, re-checked just before sending); the claim would revert with the secret in its calldata; nothing was sent`
        );
      }
      const wallLate = BigInt(Math.floor(Date.now() / 1000));
      const nowLate = wallLate > BigInt(late.timestamp) ? wallLate : BigInt(late.timestamp);
      lastBlockRead = { ts: Number(late.timestamp), mono: performance.now(), number: Number(late.number) };
      if (nowLate <= cutoff && nowLate + S > cutoff) {
        throw new UserError(
          `refusing: less than ${S} s before the reveal cutoff. now ${nowLate}, cutoff ${cutoff} (${cutoffRule}; re-checked just before sending: the earlier steps took ${nowLate > now ? nowLate - now : 0n} s): ` +
            `the send needs a ${tailS} s answer window and a ${guardS} s guard, so the last moment to start it was ${cutoff - S} (a claim published later can reach the counterparty after the cutoff and lets it take both legs; nothing was sent)`
        );
      }
      if (nowLate > cutoff) {
        throw new UserError(
          `refusing: past the reveal cutoff. now ${nowLate} > cutoff ${cutoff} (${cutoffRule}; re-checked just before sending: the earlier steps took ${nowLate > now ? nowLate - now : 0n} s) ` +
            `(a late claim publishes the secret and lets the counterparty take both legs; nothing was sent)`
        );
      }
      // T21-11: the sidecar is the last thing preSend does. If it cannot be written and made durable this throws and nothing is sent. With a local
      // key, only the local signature and the synchronous `lastCheck` below sit between this point and the bytes going to the node.
      if (sw) sidecarWritten = writeRevealSidecar(sw.realFile, lockId, await presignedHash(signer, populated));
    };
    // The fsyncs and the signature can take time (on a network share above all): the cutoff is checked once more against the WALL CLOCK only, in a
    // synchronous guard that runs immediately before the broadcast (for every claim, with or without --swap). No network read can happen after it.
    // If the time ran out, nothing has been sent.
    // The refusal of the synchronous check: take back a sidecar THIS call created (only while it still holds this call's bytes), say what became of it, and
    // throw. `words(afterSidecar)` is the sentence that names the clock reading.
    const refuseAtLastCheck = (words) => {
      let fate = "no reveal sidecar was involved (no --swap)";
      if (sidecarWritten !== null) {
        fate = sidecarWritten.created
          ? removalFate(removeCreatedRevealSidecar(sidecarWritten.file, sidecarWritten.bytes, lockId), sidecarWritten.file)
          : `the reveal sidecar ${sidecarWritten.file} that was there before is kept (it is evidence of an earlier attempt)`;
      }
      const afterSidecar = sidecarWritten !== null ? ", after the reveal sidecar was written" : "";
      sidecarWritten = null; // the outer catch must not say the claim may have reached the network: it did not
      throw new UserError(`${words(afterSidecar)}; ${fate}; nothing was sent`);
    };
    const lastCheck = boundedSend
      ? () => {
          // The bounded sender runs this as the last statement before the write: the later of the wall clock and the block clock (the block read in preSend plus
          // the monotonic time since), so that now + the send budget S must still be <= the cutoff, and now < the timelock.
          const v = bsend.sendWindowVerdict({
            cutoffS: Number(cutoff),
            timelockS: Number(l.timelock),
            blockTsS: lastBlockRead ? lastBlockRead.ts : null,
            monoAtReadMs: lastBlockRead ? lastBlockRead.mono : null,
          });
          if (v.ok) return;
          const nowS = Math.floor(v.nowMs / 1000);
          refuseAtLastCheck(
            (afterSidecar) =>
              `refusing: too late to start the send. ${v.why === "timelock" ? `now ${nowS} >= timelock ${l.timelock}` : `now ${nowS} + send budget ${S} s > cutoff ${cutoff}`} (${cutoffRule}; re-checked immediately before the write${afterSidecar}, which took too long)`
          );
        }
      : () => {
          const wallLast = BigInt(Math.floor(Date.now() / 1000));
          if (!(wallLast > cutoff || wallLast >= l.timelock)) return;
          refuseAtLastCheck(
            (afterSidecar) =>
              `refusing: past the reveal cutoff. now ${wallLast} > cutoff ${cutoff} or >= timelock ${l.timelock} (${cutoffRule}; re-checked against the wall clock immediately before the broadcast${afterSidecar}, which took too long)`
          );
        };
    // The claim lock goes when no byte of this attempt can leave any more: on the bounded path that is after the sender's socket has closed; if the close could not
    // be confirmed the lock stays on disk (leave) and the operator is told.
    const afterSend = (info) => {
      if (claimLock === null) return;
      if (info && info.closeConfirmed === false) {
        lockLeft = true;
        claimLock.leave();
        process.stderr.write(`WARNING: the sender's connection could not be confirmed closed within ${bsend.sendTiming().closeWaitMs / 1000} s; the claim lock file ${claimLock.file} is left on disk: delete it by hand after this process has exited\n`);
        return;
      }
      claimLock.release();
    };
    // A catchable signal during the send window: the sender has reset the socket (nothing more can leave); release the lock, keep the sidecar, say so.
    const onSignal = (sig, info) => {
      if (claimLock !== null) claimLock.release();
      process.stderr.write(
        `interrupted by ${sig} during the claim's send: the connection was reset, so no more of the claim can leave this machine, but it may already have reached the network${info && info.hash ? ` (transaction hash ${info.hash})` : ""}; ` +
          `${sidecarWritten ? `the reveal sidecar ${sidecarWritten.file} stays` : "there is no reveal sidecar"}: run tick --apply now\n`
      );
    };
    r = await execute(provider, signer, args, tx, { ...plan, ...fp.report }, { hideData: true, fees: fp.fees, fixedGas: claimGas === null ? undefined : claimGas, preSend, lastCheck, afterSend, boundedSend, onSignal, startBlock: () => (lastBlockRead ? lastBlockRead.number : null) });
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
        ...(lastReceiverWarning !== null ? { receiverCodeWarning: lastReceiverWarning } : {}),
        ...(otherPreimageNote !== null ? { replacePreimageNote: otherPreimageNote } : {}),
        ...(sidecarWritten ? { revealSidecar: sidecarWritten.state, revealSidecarFile: sidecarWritten.file } : {}),
        ...(replaceSidecarNote(sw, replaced, sidecarWritten, sidecar) !== null ? { replaceSidecarNote: replaceSidecarNote(sw, replaced, sidecarWritten, sidecar) } : {}),
        ...fp.report,
      };
    }
    // The bounded sender's answer (see bounded-send.js): one text for every outcome, with and without --swap. Only "not_sent" says nothing was sent, and then a
    // sidecar this call had written is taken back (only while it still holds this call's bytes); every other outcome leaves the sidecar and says the secret may
    // be public. The 429 and the redirect are `unknown` now: the request carried only this claim, but what the endpoint did with it cannot be known here.
    if (e instanceof SendOutcomeError) {
      let fate = null;
      if (e.outcome === "not_sent" && sidecarWritten !== null) {
        fate = sidecarWritten.created
          ? removalFate(removeCreatedRevealSidecar(sidecarWritten.file, sidecarWritten.bytes, lockId), sidecarWritten.file)
          : `the reveal sidecar ${sidecarWritten.file} that was there before is kept (it is evidence of an earlier attempt)`;
        sidecarWritten = null;
      }
      throw new UserError(
        redact(
          sendOutcomeText(e, {
            hasSwap: !!sw,
            sidecarFile: e.outcome !== "not_sent" && sidecarWritten ? sidecarWritten.file : null,
            fate,
            lockFile: lockLeft && claimLock !== null ? claimLock.file : null,
          })
        )
      );
    }
    if (sidecarWritten) {
      // The sidecar was written before the broadcast and stays: whether the claim reached the network is not known here.
      const base = e instanceof UserError ? redact(e.message) : explain(e);
      throw new UserError(`${base} (the reveal sidecar ${sidecarWritten.file} was written before the send and stays: the claim may have reached the network, so swap-cli treats the secret as possibly public; run tick --apply)`);
    }
    throw e;
  }
  if (r.dry) return r.out;
  return {
    txHash: r.receipt.hash,
    blockNumber: r.receipt.blockNumber,
    ...(sidecarWritten ? { revealSidecar: sidecarWritten.state, revealSidecarFile: sidecarWritten.file } : {}),
    ...(plan.revealSidecarTmpFiles ? { revealSidecarTmpFiles: plan.revealSidecarTmpFiles, revealSidecarTmpNote: plan.revealSidecarTmpNote } : {}),
    ...(lastReceiverWarning !== null ? { receiverCodeWarning: lastReceiverWarning } : {}),
    ...(otherPreimageNote !== null ? { replacePreimageNote: otherPreimageNote } : {}),
    ...(replaceSidecarNote(sw, replaced, sidecarWritten, sidecar) !== null ? { replaceSidecarNote: replaceSidecarNote(sw, replaced, sidecarWritten, sidecar) } : {}),
    ...fp.report,
  };
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

// ------------------------------------------------ reserve and sweep (swap wallet, piece 2b)

/** `x * 1.25` rounded up, in integers. */
const withMargin = (x) => (x * RESERVE_NUM + (RESERVE_DEN - 1n)) / RESERVE_DEN;

/**
 * The fee ceiling a send would use: the cap given (--max-fee-gwei with --mainnet, --gas-price-gwei elsewhere), else the node's own suggestion (maxFeePerGas, else gasPrice).
 * Returns { capWei, source, fees } where `fees` is the fee-field object a send would carry ({} when the node's suggestion is only a number to reserve against).
 */
async function feeCeiling(provider, args) {
  const given = feeOverrides(args);
  if (given.maxFeePerGas !== undefined) return { capWei: given.maxFeePerGas, source: args.mainnet === true ? "--max-fee-gwei" : "--gas-price-gwei", fees: given };
  const fd = await provider.getFeeData();
  const cap = fd.maxFeePerGas !== null && fd.maxFeePerGas !== undefined ? fd.maxFeePerGas : fd.gasPrice;
  if (cap === null || cap === undefined) throw new UserError("the node gave no fee suggestion; give --gas-price-gwei (or --max-fee-gwei with --mainnet) so there is a fee ceiling to reserve against");
  const tip = fd.maxPriorityFeePerGas !== null && fd.maxPriorityFeePerGas !== undefined ? fd.maxPriorityFeePerGas : cap < GWEI ? cap : GWEI;
  return { capWei: cap, source: "the node's fee suggestion", fees: { maxFeePerGas: cap, maxPriorityFeePerGas: tip < cap ? tip : cap } };
}

/** The swap file's chain and profile against --mainnet, and the node's chain against the file's: the one rule bindSwap applies, for the commands that take no intent. */
async function requireSwapChain(provider, args, sw) {
  if (args.mainnet === true) {
    if (sw.chainId !== 1n) throw new UserError(`--mainnet: the swap file's chain_id is ${sw.chainId}, not 1; refusing`);
    if (sw.profile !== "production") throw new UserError(`--mainnet: the swap file's profile is ${sw.profile}, not production; refusing`);
  }
  const chainId = await assertAllowedChain(provider, args);
  if (chainId !== sw.chainId) throw new UserError(`chain id mismatch: the swap file is for chain ${sw.chainId} but the node reports ${chainId}; refusing`);
  return chainId;
}

/**
 * reserve (read-only): the ETH the swap's key must hold before the swap goes on (amendment C), and whether it does. Alice: the claim's fixed gas limit x the fee ceiling x 1.25.
 * Bob: amount_wei + (lock gas ceiling + refund gas ceiling) x the fee ceiling x 1.25. All amounts are wei, decimal strings; integer arithmetic only. `covered` false makes the
 * command line exit with status 3.
 */
async function reserve(provider, signer, args) {
  if (!signer) throw new UserError("reserve needs the swap's key (--key-stdin or --key-file, exactly one): the amount and the address are printed only for a key whose address is the swap file's own; refusing");
  const role = need(args, "role");
  if (role !== "alice" && role !== "bob") throw new UserError("--role must be alice or bob");
  mainnetFlags(args);
  const sw = readSwapFile(need(args, "swap"), "reserve");
  if (sw.role === null) throw new UserError("--swap: the file has no role (alice or bob); is it a swap-cli swap file?");
  if (sw.role !== role) throw new UserError(`--role ${role} but the swap file is ${sw.role}'s; refusing`);
  if (!LOCK_KINDS.includes(sw.lockKind)) throw new UserError(`--swap ${sw.file}: unknown lock_kind "${sw.lockKind}"; refusing`);
  const kind = sw.lockKind;
  const key = role === "alice" ? sw.aliceReceiver : sw.bobSender;
  const keyName = role === "alice" ? "alice_receiver" : "bob_sender";
  // The key must own the stated address: swap-cli cannot compute an Ethereum address, so a wrong stated address would be a deposit nobody can spend. Checked before any node
  // call and before any amount or address is printed.
  const real = await signer.getAddress();
  const stated = [[keyName, key]];
  if (sw.ethKey !== null && sw.ethKey !== undefined) {
    if (sw.ethKey.invalid) throw new UserError("--swap: the file's eth_key record does not parse (address and payout must be Ethereum addresses); refusing");
    stated.push(["eth_key address", sw.ethKey.address]);
  }
  for (const [name, addr] of stated) {
    if (!sameAddr(real, addr)) {
      throw new UserError(`this key does not belong to the swap file's ${name} ${addr} (the key's own address is ${real}); nothing must be deposited to ${addr}: no amount is shown; refusing`);
    }
  }
  const chainId = await requireSwapChain(provider, args, sw);
  const ceiling = await feeCeiling(provider, args);
  const claimGas = kind === "poseidon" ? POSEIDON_CLAIM_GAS_LIMIT : SHA256_CLAIM_GAS_LIMIT;
  const parts = role === "alice" ? { claimGasLimit: claimGas } : { lockGasCeiling: LOCK_GAS_RESERVE[kind], refundGasCeiling: REFUND_GAS_RESERVE[kind] };
  const gas = role === "alice" ? claimGas : LOCK_GAS_RESERVE[kind] + REFUND_GAS_RESERVE[kind];
  const amountWei = role === "bob" ? sw.amountWei : 0n;
  const reserveWei = withMargin(gas * ceiling.capWei);
  const requiredWei = amountWei + reserveWei;
  const balanceWei = await provider.getBalance(key);
  const covered = balanceWei >= requiredWei;
  const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
  return {
    role,
    address: key,
    chainId: chainId.toString(),
    lockKind: kind,
    ...str(parts),
    ...(role === "bob" ? { amountWei: amountWei.toString() } : {}),
    gasTotal: gas.toString(),
    feeCeilingWei: ceiling.capWei.toString(),
    feeCeilingGwei: ethers.formatUnits(ceiling.capWei, "gwei"),
    feeCeilingSource: ceiling.source,
    margin: "1.25",
    reserveWei: reserveWei.toString(),
    requiredWei: requiredWei.toString(),
    balanceWei: balanceWei.toString(),
    shortfallWei: (balanceWei >= requiredWei ? 0n : requiredWei - balanceWei).toString(),
    covered,
    keyChecked: true,
  };
}

/** A lock record (beside the swap file, or the per-user one) is resolved only when the lock it names shows claimed or refunded on chain. { resolved, detail }; never throws except for a node error. */
async function lockRecordResolution(provider, contractAddr, kind, found, keyAddr) {
  if (found.placeError) return { resolved: false, detail: found.placeError.message };
  let rec;
  try {
    const st = fs.lstatSync(found.file);
    if (!st.isFile() || st.size > LOCK_SENT_MAX_BYTES) return { resolved: false, detail: "it is not a record this tool wrote (not a regular file, or too large)" };
    rec = JSON.parse(fs.readFileSync(found.file, "utf8"));
  } catch {
    return { resolved: false, detail: "it cannot be read" };
  }
  if (!rec || rec.version !== 1 || typeof rec.lock_id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rec.lock_id) || typeof rec.sender !== "string") {
    return { resolved: false, detail: "it is not a record this tool wrote" };
  }
  if (!sameAddr(rec.sender, keyAddr)) return { resolved: false, detail: `it names another sender (${rec.sender})` };
  const l = await fetchLock(provider, contractAddr, rec.lock_id, kind);
  if (!l) return { resolved: false, detail: `the lock ${rec.lock_id} it names is not on chain (it may be pending, dropped or never mined)` };
  if (l.claimed || l.refunded) return { resolved: true, detail: `the lock ${rec.lock_id} is ${l.claimed ? "claimed" : "refunded"}` };
  return { resolved: false, detail: `the lock ${rec.lock_id} it names is still open` };
}

/** The refusal of a sweep for a lock record that is not resolved. */
function sweepRecordRefusal(found, why) {
  return new UserError(
    `refusing: the ${found.kind === "user" ? "per-user lock record" : "lock record"} ${found.file} exists (${found.why}) and it is not resolved (${why}), so it is not known whether a lock of this key is still pending or open; ` +
      `a sweep now could take the ETH a lock or a refund still needs. Nothing was sent. A record is resolved when the lock it names shows claimed or refunded on chain; otherwise see the section "${CLEARING_NAME}" of scripts/live/README.md`
  );
}

const ENDED_PHASES = new Set(["aborted", "refunded", "lost", "done"]);
const SWEEP_BLOCKING_ACTIONS = new Set(["lock_eth", "refund_eth", "reveal_eth"]);

/**
 * sweep: send the key's whole balance minus the fee (21,000 gas x the capped fee) to the payout address stored in the swap file. Refuses unless everything in the header's
 * `sweep` paragraph holds (amendments F and M). The local checks come first (the file, the key, --to, the intents), then the node's (chain, contract, --to has no code, no pending
 * nonce, no open lock of this swap, no unresolved lock record), then the fee. `--dry-run` prints what it would send.
 */
async function sweep(provider, signer, args0) {
  requireSigner(signer);
  mainnetFlags(args0);
  if (args0.swap === undefined || args0.swap === null || args0.swap === "") {
    throw new UserError("sweep needs --swap FILE (the payout address, the role and the intents are read from it); refusing");
  }
  const to = address("--to", need(args0, "to"));
  const sw = readSwapFile(args0.swap, "sweep");
  // ---- the file and the key (local)
  if (sw.role === null) throw new UserError("--swap: the file has no role (alice or bob); is it a swap-cli swap file?; refusing");
  if (sw.ethKey === null) throw new UserError("--swap: the file holds no Ethereum swap key record (eth_key): it was made without --eth-key, so it names no payout address and a sweep is refused");
  if (sw.ethKey.invalid) throw new UserError("--swap: the file's eth_key record does not parse (address and payout must be Ethereum addresses); refusing");
  const own = sw.role === "alice" ? sw.aliceReceiver : sw.bobSender;
  const ownName = sw.role === "alice" ? "alice_receiver" : "bob_sender";
  const me = await signer.getAddress();
  if (!sameAddr(me, own)) throw new UserError(`this key is ${me} but the swap file's ${ownName} is ${own}; refusing`);
  if (!sameAddr(sw.ethKey.address, own)) throw new UserError(`the swap file's eth_key address ${sw.ethKey.address} is not its ${ownName} ${own}; refusing`);
  if (!sameAddr(to, sw.ethKey.payout)) throw new UserError(`--to ${to} is not the payout address stored in the swap file (${sw.ethKey.payout}); refusing`);
  if (sameAddr(to, me)) throw new UserError("--to is the key's own address: a sweep to itself sends nothing; refusing");
  // ---- the intents (local): a send of the swap is still to come or may be in flight
  if (sw.intent && SWEEP_BLOCKING_ACTIONS.has(sw.intent.action)) {
    throw new UserError(`the swap file holds a pending ${sw.intent.action} intent: a send of this swap still needs this key; refusing`);
  }
  if (sw.pendingActionKind !== null && SWEEP_BLOCKING_ACTIONS.has(sw.pendingActionKind)) {
    throw new UserError(`the swap file holds a pending ${sw.pendingActionKind} action: a send of this swap may be in flight and still needs this key; refusing`);
  }
  // ---- the file's terms against the node (chain, contract, code)
  const kind = sw.lockKind;
  if (!LOCK_KINDS.includes(kind)) throw new UserError(`--swap ${sw.file}: unknown lock_kind "${kind}"; refusing`);
  const merged = { ...args0, lockKind: kind };
  if (args0.mainnet === true) {
    if (sw.chainId !== 1n) throw new UserError(`--mainnet: the swap file's chain_id is ${sw.chainId}, not 1; refusing`);
    if (sw.profile !== "production") throw new UserError(`--mainnet: the swap file's profile is ${sw.profile}, not production; refusing`);
  }
  merged.chainId = agree("--chain-id", args0.chainId, sw.chainId.toString(), sameUint);
  if (sw.codeHash === null) throw new UserError(`--swap ${sw.file}: the file pins no code_hash; refusing`);
  if (sw.codeHash !== artifactCodeHash(kind)) throw new UserError(`the swap file pins code_hash ${sw.codeHash}, which is not the local artifact's ${artifactCodeHash(kind)}; refusing`);
  merged.codeHash = agree("--code-hash", args0.codeHash, sw.codeHash, sameAddr);
  if ((args0.fromBlock === undefined || args0.fromBlock === null || args0.fromBlock === "") && sw.ethFromBlock !== null) merged.fromBlock = sw.ethFromBlock.toString();
  const contractAddr = sw.contract;
  const target = await verifyTarget(provider, merged, contractAddr);
  // ---- the payout has no code (amendment M): a contract, or an EIP-7702 delegation, may refuse or redirect a plain transfer
  const toCode = await provider.getCode(to);
  if (toCode !== "0x") throw new UserError(`--to ${to} has code on this chain (${(toCode.length - 2) / 2} bytes): a plain transfer to a contract, or to an account with a delegation, may revert or be taken; refusing`);
  // ---- the key has nothing in flight
  const [nonceLatest, noncePending] = await Promise.all([provider.getTransactionCount(me, "latest"), provider.getTransactionCount(me, "pending")]);
  if (noncePending !== nonceLatest) {
    throw new UserError(`refusing: the key ${me} has a transaction pending on this node (pending nonce ${noncePending}, latest nonce ${nonceLatest}); wait until it is mined or dropped, then sweep`);
  }
  // ---- no lock of this swap is open
  const blk = await latestBlock(provider);
  const fromBlock = await resolveFromBlock(provider, contractAddr, merged, blk.number);
  if (fromBlock > blk.number) throw new UserError(`--from-block ${fromBlock} is beyond the latest block ${blk.number}`);
  const who = sw.role === "bob" ? { sender: me } : { sender: sw.bobSender, receiver: me };
  const events = (await lockedEventsFor(provider, contractAddr, who, fromBlock, blk.number, kind)).filter((e) => String(e.word).toLowerCase() === sw.hashlock);
  const seen = [];
  for (const e of events) {
    const l = await fetchLock(provider, contractAddr, e.args.lockId, kind);
    if (!l) throw new UserError(`refusing: a Locked event shows lock ${e.args.lockId} but the contract has no such lock; the node contradicts itself`);
    const state = l.claimed ? "claimed" : l.refunded ? "refunded" : "open";
    seen.push({ lockId: e.args.lockId, state });
    if (state === "open") {
      throw new UserError(
        `refusing: lock ${e.args.lockId} of this swap is still open on chain (not claimed, not refunded; timelock ${l.timelock}): ` +
          (sw.role === "bob" ? "it is Bob's ETH until it is claimed or refunded" : "Alice's reveal still needs this key's gas") +
          "; sweep when it is claimed or refunded"
      );
    }
  }
  if (seen.length === 0 && !ENDED_PHASES.has(String(sw.phaseName))) {
    throw new UserError(
      `refusing: no lock of this swap is on chain, and the swap file's phase is ${sw.phaseName === null ? "unknown" : sw.phaseName}, not an ended one (${[...ENDED_PHASES].join(", ")}): the lock may still be sent or mined, and this key's balance is what it needs`
    );
  }
  // ---- no unresolved lock record (beside the file, and the per-user one)
  const records = [findLockSent(sw), findUserLockSent(target.chainId, me, sw.hashlock)].filter((r) => r !== null);
  for (const found of records) {
    const res = await lockRecordResolution(provider, contractAddr, kind, found, me);
    if (!res.resolved) throw sweepRecordRefusal(found, res.detail);
  }
  // ---- the fee: pinned here, so that the amount is exactly the balance minus what the transaction may cost
  const given = feeOverrides(args0);
  let fees = given;
  if (given.maxFeePerGas === undefined) {
    const ceil = await feeCeiling(provider, args0);
    fees = ceil.fees;
  }
  const { mainnet, tipWei } = mainnetFlags(args0);
  const feeCheck = await checkFeeCap(provider, fees, 1n, mainnet, FEE_WHY.other, tipWei);
  const feeWei = TRANSFER_GAS * fees.maxFeePerGas;
  const balanceWei = await provider.getBalance(me);
  if (balanceWei <= feeWei) {
    throw new UserError(`refusing: the key holds ${ethers.formatEther(balanceWei)} ETH, which does not exceed the fee of the transfer at the cap (${TRANSFER_GAS} gas x ${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei = ${ethers.formatEther(feeWei)} ETH): nothing to sweep`);
  }
  const valueWei = balanceWei - feeWei;
  const extra = {
    sweep: { role: sw.role, key: me, payout: to, balanceWei: balanceWei.toString(), feeWei: feeWei.toString(), valueWei: valueWei.toString(), locksSeen: seen, recordsResolved: records.length, phase: sw.phaseName },
    ...(feeCheck ? { feeCheck } : {}),
  };
  const r = await execute(provider, signer, args0, { to, value: valueWei }, extra, { fees, fixedGas: TRANSFER_GAS });
  if (r.dry) return r.out;
  return { txHash: r.receipt.hash, blockNumber: r.receipt.blockNumber, from: r.from, to, valueWei: valueWei.toString(), feeCapWei: fees.maxFeePerGas.toString(), balanceBeforeWei: balanceWei.toString(), role: sw.role, ...(feeCheck ? { feeCheck } : {}) };
}

// Some providers echo the endpoint, with an API key in it, in their error text: anything that looks like an address (scheme://..., so ws:// and wss:// too) is cut out before the text is printed.
const plainNodeText = (text) => String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address removed]");

// A "no such lock" read is trusted only when the node's latest block is this young (seconds): a lagging or syncing node answers LockNotFound for a lock
// mined after its own tip.
const STATUS_FRESH_BLOCK_S = 120;

/**
 * A read that failed on the node's side, as a plain UserError (A7). ethers hides the node's own words: any JSON-RPC error that is not a call or an
 * estimate (an eth_getLogs the node refuses because its history is pruned, a range limit, a rate limit) becomes the bare "could not coalesce error",
 * with the real text in `error.message`. This names the read that failed and prints that text (first line, cut at 300 characters). A UserError and a
 * refused redirect already say what they mean and pass through.
 */
function nodeReadFailure(e, what) {
  if (e instanceof UserError || isRedirectAnswer(e)) return e;
  // A programming error is not the node's answer: it passes through unchanged (the command line then prints it as an unlabelled error).
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return e;
  const inner = (e && e.error) || (e && e.info && e.info.error) || null;
  const method = (e && e.payload && e.payload.method) || (e && e.info && e.info.payload && e.info.payload.method) || null;
  const raw = inner && typeof inner.message === "string" && inner.message !== "" ? inner.message : (e && (e.shortMessage || e.message)) || String(e);
  const detail = plainNodeText(String(raw).split("\n")[0]).slice(0, 300);
  const codeNote = inner && inner.code !== undefined && inner.code !== null ? ` (node error code ${inner.code})` : "";
  return new UserError(`the node could not answer the read of ${what}${method ? ` (${method})` : ""}: ${detail}${codeNote}; status read nothing more and sent nothing`);
}

async function status(provider, _signer, args) {
  const contractAddr = address("--contract", need(args, "contract"));
  const lockId = hex32("--lock-id", need(args, "lockId", "lock-id"));
  // Optional here (the documents call status without them), but when given they are checked like the other commands check them.
  const wantChain = args.chainId === undefined || args.chainId === null ? null : uint("--chain-id", args.chainId);
  const wantHash = args.codeHash === undefined || args.codeHash === null ? null : hex32("--code-hash", args.codeHash);
  const read = async (what, fn) => {
    try {
      return await fn();
    } catch (e) {
      throw nodeReadFailure(e, what);
    }
  };
  const chainId = BigInt(await read("the chain id", () => provider.send("eth_chainId", [])));
  if (wantChain !== null && wantChain !== chainId) {
    throw new UserError(`chain id mismatch: --chain-id is ${wantChain} but the RPC endpoint reports ${chainId}; refusing`);
  }
  // Every contract read below is pinned to this one block (a backend that lacks it errors; it never answers from an older state).
  const blk = await read("the latest block", () => latestBlock(provider));
  const code = await read("the contract code", () => provider.getCode(contractAddr, blk.number));
  if (code === "0x") {
    throw new UserError(`no contract code at ${contractAddr} on chain ${chainId}: the address is wrong or this is another chain; there is nothing to read`);
  }
  if (wantHash !== null && ethers.keccak256(code) !== wantHash) {
    throw new UserError(`code hash mismatch: --code-hash is ${wantHash} but keccak256(code at ${contractAddr}) is ${ethers.keccak256(code)}; refusing`);
  }
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
  const fromBlock = await resolveFromBlock(provider, contractAddr, args, blk.number);
  let l;
  try {
    l = await fetchLock(provider, contractAddr, lockId, kind, blk.number);
  } catch (e) {
    // A call that reverts with no reason, or answers with bytes that are no lock: the address has code but is not an HTLC that answers getLock
    // (the other kind, or another contract). Any other failure of the call is the node's.
    const inner = e && e.info && e.info.error;
    if (e && (e.code === "BAD_DATA" || (e.code === "CALL_EXCEPTION" && (!inner || inner.code === 3 || /revert/i.test(String(inner.message)))))) {
      throw new UserError(`the contract at ${contractAddr} has code but did not answer getLock like an HTLC of this repo (its code hash is ${ethers.keccak256(code)}); is it the right contract${args.lockKind === undefined ? "" : " and the right --lock-kind"}?`);
    }
    throw nodeReadFailure(e, "the lock");
  }
  const topics = ["Locked", "Claimed", "Refunded"].map((n) => iface.getEvent(n).topicHash);
  const logs = await read("the lock's events", () => getLogsChunked(provider, { address: contractAddr, topics: [topics, lockId] }, fromBlock, blk.number));
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
  const lockedEvent = events.find((ev) => ev.event === "Locked");
  if (!l && lockedEvent) {
    // The clearing procedure treats "no such lock" as a fact about the contract: a node that contradicts itself must not give it.
    throw new UserError(
      `the node contradicts itself: getLock says there is no lock ${lockId} at ${contractAddr} at block ${blk.number}, but the event scan of the same run found a Locked event for it in block ${lockedEvent.blockNumber} (transaction ${lockedEvent.txHash}); do not trust this node for this read, repeat it on another node`
    );
  }
  if (!l) {
    const nowS = Math.floor(Date.now() / 1000);
    const ageS = Math.max(0, nowS - Number(blk.timestamp));
    const checked =
      `the chain id was ${wantChain !== null ? `checked against --chain-id ${wantChain}` : "NOT checked: pass --chain-id"}; ` +
      `the code hash was ${wantHash !== null ? "checked against --code-hash" : "NOT checked: pass --code-hash"}`;
    const where = `contract ${contractAddr} on chain ${chainId} (as the node reports it)`;
    // The two times the staleness rule used, so that a wrong local clock is visible; and what this read cannot see.
    const times = `the block's time is ${new Date(Number(blk.timestamp) * 1000).toISOString()}, this machine's clock says ${new Date(nowS * 1000).toISOString()} (UTC); a lock still pending in the mempool is not seen by this read`;
    if (ageS > STATUS_FRESH_BLOCK_S) {
      out.exists = null;
      out.state = "unknown (the node is behind the chain's tip)";
      out.trustworthy = false;
      out.note =
        `the node did not find a lock with this id at ${where}, but its latest block (${blk.number}) is ${ageS} s old, so a missing lock cannot be trusted (a node that lags behind the chain's tip does not see a recent lock); ` +
        `repeat the read on a node at the chain's tip; ${checked}; ${times}`;
    } else if (wantChain === null) {
      out.trustworthy = false;
      out.state = `not found on chain ${chainId}, but not trusted: --chain-id was not given`;
      out.note =
        `no lock with this id was found at ${where} at block ${blk.number}, but this answer cannot be trusted until --chain-id is passed, because the same contract address can exist on another chain; ` +
        `${checked}; ${times}`;
    } else {
      out.trustworthy = true;
      out.note = `no lock with this id exists at ${where} at block ${blk.number} (the contract answered getLock with LockNotFound; the block is ${ageS} s old); ${checked}; ${times}; check the lock id and the contract`;
    }
  } else if (!lockedEvent) {
    out.note = `the lock exists but no Locked event of it was found in blocks ${fromBlock} to ${blk.number}: the node may have pruned its logs, or --from-block is above the lock's block`;
  }
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
  keygen: { flags: { out: "v", stdout: "b" }, signer: false },
  balance: { flags: { address: "v" }, positional: "address", signer: false },
  address: { flags: { "key-file": "v", "key-stdin": "b", expect: "v" }, signer: true },
  "sign-message": { flags: { "key-file": "v", "key-stdin": "b", "message-hex": "v" }, signer: true },
  "verify-message": { flags: { address: "v", "message-hex": "v", signature: "v" }, signer: false },
  deploy: { flags: { ...COMMON, ...KIND, "key-file": "v" }, signer: true },
  lock: {
    flags: { ...COMMON, ...TARGET, ...KIND, "key-file": "v", "key-stdin": "b", contract: "v", hashlock: "v", "lock-addr": "v", "t-reveal": "v", receiver: "v", "amount-wei": "v", swap: "v", "approved-intent": "v", "approved-terms": "v", "approved-at": "v" },
    signer: true,
  },
  claim: {
    flags: { ...COMMON, ...TARGET, ...KIND, "key-file": "v", "key-stdin": "b", contract: "v", "lock-id": "v", "margin-s": "v", "secret-stdin": "b", "secret-file": "v", swap: "v", replace: "b", "replace-tx": "v" },
    signer: true,
  },
  refund: { flags: { ...COMMON, ...KIND, "chain-id": "v", "code-hash": "v", "key-file": "v", "key-stdin": "b", contract: "v", "lock-id": "v", swap: "v", replace: "b", "replace-tx": "v" }, signer: true },
  send: { flags: { ...COMMON, "key-file": "v", to: "v", "amount-wei": "v" }, signer: true },
  sweep: { flags: { ...COMMON, ...TARGET, "key-file": "v", "key-stdin": "b", swap: "v", to: "v" }, signer: true },
  reserve: { flags: { role: "v", swap: "v", mainnet: "b", "max-fee-gwei": "v", "gas-price-gwei": "v", "allow-chain-id": "v", "key-file": "v", "key-stdin": "b" }, signer: true },
  status: { flags: { ...KIND, contract: "v", "lock-id": "v", "from-block": "v", "chain-id": "v", "code-hash": "v" }, signer: false },
};
const COMMANDS = { keygen, balance, address: keyAddress, "sign-message": signMessage, "verify-message": verifyMessage, deploy, lock, claim, refund, send, sweep, reserve, status };

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
  if (command === "lock" && args.swap === undefined && args.mainnet !== true) process.stderr.write(NO_SWAP_LOCK_WARNING);
  // keygen --stdout writes the key to the pipe and nothing else (no provider, no JSON: the key must not go to a second place).
  if (command === "keygen" && args.stdout === true) {
    keygenStdout(args);
    return;
  }
  const provider = ["keygen", "address", "sign-message", "verify-message"].includes(command) ? null : makeProvider(process.env.ETH_RPC_URL || "http://127.0.0.1:8545");
  try {
    let signer = null;
    if (SPECS[command].signer) {
      if (command === "sign-message" && args.keyStdin !== true && args.keyFile === undefined) throw new UserError("give the key by exactly one of --key-file or --key-stdin; refusing");
      if (args.keyStdin === true) signer = signerFromKeyText(provider, await readKeyStdin(args), "--key-stdin");
      else if (command === "sign-message") {
        // A key that does not load is reported without the library's own text (it may carry the value).
        try {
          signer = loadSigner(provider, args.keyFile);
        } catch (e) {
          throw e instanceof UserError ? e : new UserError("--key-file: not a valid secp256k1 private key; its text is not shown");
        }
      } else signer = loadSigner(provider, args.keyFile);
    }
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
    // reserve: the numbers are the result; "not covered" is exit status 3 (0 when covered).
    // verify-message: the answer is the result; "not valid" is exit status 3 (0 when valid).
    if (command === "verify-message" && result && result.valid === false) process.exitCode = 3;
    if (command === "reserve" && result && result.covered === false) {
      process.stderr.write(`the key ${result.address} holds less than the reserve: ${result.balanceWei} wei of ${result.requiredWei} wei needed (short by ${result.shortfallWei} wei)\n`);
      process.exitCode = 3;
    }
  } finally {
    if (provider) provider.destroy();
  }
}

module.exports = {
  keygen, keygenStdout, balance, keyAddress, signMessage, verifyMessage, MESSAGE_DOMAIN, deploy, lock, claim, refund, send, sweep, reserve, status,
  loadSigner, signerFromKeyText, readKeyStdin, LOCK_GAS_RESERVE, REFUND_GAS_RESERVE, TRANSFER_GAS, lockedEventsFor, withMargin, computeLockIdLocal, parseArgs, UserError, explain, ALLOWED_CHAIN_IDS, MAINNET_WARNING,
  getLogsChunked, findDeploymentBlock, readBlockTimestamp, readSecret, verifyTarget, redact, LOG_RANGE_MAX, DEFAULT_MARGIN_S,
  readRevealSidecar, readRevealSidecarOf, leftoverSidecarTmpFiles, writeRevealSidecar, revealSidecarPath, REVEAL_SIDECAR_SUFFIX, claimLockPath, CLAIM_LOCK_SUFFIX, execute, makeProvider, sendGuard,
  pidLiveness, checkProducerMemory, NO_SWAP_LOCK_WARNING,
  approvalText, approvalTermsHash, checkApproval, MAX_OBSERVATION_AGE_S, APPROVAL_FUTURE_SKEW_S, lockLockPath, LOCK_LOCK_SUFFIX, lockSentPath, LOCK_SENT_SUFFIX,
  userLockSentDir, userLockSentPath, setUserLockSentHomeForTests,
  SendOutcomeError, sendOutcomeText, envProxyRefusal, boundedUrlOf,
  POSEIDON_CLAIM_GAS_LIMIT, SHA256_CLAIM_GAS_LIMIT, RevertedTx, POSEIDON_CLAIM_CALLDATA_BYTES, localAddr, localLockWord, artifactCodeHash, kindOf, assertPoseidonClaimCalldata, htlcInterface,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${redact(e instanceof UserError ? e.message : explain(e))}\n`);
    process.exit(1);
  });
}
