# Security

## Status, in one paragraph

This is research code that has moved real value only in trial amounts (10 NOID against 0.001 ETH).
It has had two adversarial code reviews by independent review sessions (`swap-cli/REVIEW-2.md`,
`swap-cli/REVIEW-3.md`) and a review of the design (`docs/review-1.md`), all of them internal and
none of them an external human audit. The reviews' must-fix lists are closed in code, but the latest
verdict still reads "not yet safe to hand to a stranger" until a live run exercises the new gates and a
fresh review checks them. Do not use it with amounts you cannot lose.

## Reporting a problem

Use the repository's issue tracker on GitHub. If the problem could let someone take funds, do not put
the details in a public issue: open an issue that says only "security, please open a private channel"
and the maintainer will answer with one (if the repository has GitHub's private vulnerability
reporting enabled, use that instead). There is no public e-mail address for this project.

What helps: the commit you looked at, the file and line, what an attacker would do, and whether you
have a test that shows it. Credit is given in the fix commit unless you ask otherwise.

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
`*.receipt`, `passphrase.txt`. `.gitignore` covers them; check with `git status` before every commit.
