# Security

## Status, in one paragraph

No1d Swap is young software that moves real value. Ethereum mainnet is open in the desktop program, within caps of 2,500 NOID and
0.5 ETH per swap, and it is meant for two people who have a reason to trust each other. The program itself has not yet run on
Ethereum mainnet; it ran on the Sepolia test network (three two-machine rehearsals, 19 to 20 November 2026). The swap tool and its
helpers settled one swap on Ethereum mainnet (run 8, 5 NOID against 0.001 ETH, 2026-11-06), and the swap's own NOID wallet made its
first real payments on Parano1d mainnet in run 22. Every review so far was made by the project itself; **none came from an outside
party**. The reviews covered: the design (`docs/review-1.md`), seven adversarial code reviews of the swap tool
(`swap-cli/REVIEW-1.md` to `swap-cli/REVIEW-7.md`), two reviews of the Poseidon2b Solidity port, a seeded chaos test, an
explicit-state model check, one independent read of each piece of the program (the autopilot, the swap wallets, the desktop shell
and its secrets, the simpler-swap flow, the page's new look), and two independent reads of the mainnet opening and the launch
screens, each followed by one round of fixes.
`REVIEW-7` lists what it wanted done before a stranger uses the swap tool; read it and `TASKS.md` for the state of each item. Nobody
has reviewed the hashlock's preimage resistance for this use: the lock is only as strong as Parano1d's address function
(Poseidon2b). Two limits are stated in the README: one address mines about half of Parano1d's blocks, which exposes the ETH seller
to a mining majority that is also the NOID seller, and after the reveal the ETH seller's program has about 75 minutes to claim the
NOID, so that computer must be on and online then. Do not use amounts you cannot lose.

## Reporting a problem

Use the repository's issue tracker on GitHub. If the problem could let someone take funds, do not put the details in a public
issue: open an issue that says only "security, please open a private channel" and the maintainer will answer with one (if the
repository has GitHub's private vulnerability reporting enabled, use that instead). There is no public e-mail address for this
project.

What helps: the commit or version you looked at, the file and line, what an attacker would do, and whether you have a test that
shows it. Credit is given in the fix commit unless you ask otherwise.

## Checking a release

Releases are signed with one release key, kept offline by the owner. Its public key is in `desktop/lib/releasekey.js`. Each release
carries `release.json` (the installers' SHA-256 values and an "oldest safe version") and `release.json.sig`. **A release whose
notice does not verify against that public key must not be installed**, and neither must an installer whose SHA-256 differs from its
entry in the signed notice. How to check, and what the key does and does not protect: `docs/release-key.md`. The installers are not
code-signed for Windows or macOS, so those systems warn about them (`docs/building.md`).

## Rules the code is built around

1. Never fund a contract built from `parano1d/contracts/htlc.params.example.json`: its secret is the
   public test vector `00 01 … 1f`.
2. Never use Parano1d's stock `refundable_payment` template for a swap; only the custom `HashTimeLock`
   with `claim_recipient` pinned to the counterparty is safe once the secret is public.
3. One fresh 32-byte secret per swap from the OS random generator. The secret is sealed in the swap
   file, never printed, never on a command line, never in a process listing while a proof runs.
4. `max_fee` at least 5,800 μNOID or both the claim and the refund are locked forever.
5. The counterparty's lock is verified (chain id, contract code hash, amount, hashlock, timelock) before
   anything is sent, and the equivalence receipt is verified by the tool, not trusted from chat.

Files that must never be committed: `eth/keys/`, `btc/keys/`, `*.swap.json`, `*.swap.json.lock`,
`*.receipt`, `passphrase.txt`, `release-key.enc.json` and `*.enc.json`. `.gitignore` covers them; check with `git status` before
every commit.
