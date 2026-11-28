# Live run 15 — Alice prepares and never funds (hostile plan L1, scenario A6), 2026-11-11

> Clock times in this log are UTC. All of them belong to 2026-11-11. The Parano1d tip is given in the `tip` column.

The first run of the hostile-counterparty campaign (`docs/hostile-run-plan.md`, L1). Alice's side prepared a swap, Bob's
side took the bundle with `new-bob`, and Alice then never funded. The question was whether Bob's tool gives up by
itself on the real
nodes, without any spend, and whether a lock is then refused. **It did, and it was.** Nothing was sent to either chain:
no funding, no lock, no claim, no fee.

## Setting

5 NOID against 0.001 Sepolia ETH on paper, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one
node per chain (`SINGLE_NODE_OK=1`), the helpers of `scripts/live/` frozen for the run. Sepolia contract
`0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF` (the one of runs 11 to 14), Parano1d contract root
`o1yhxww7pfdx6dua0at6ly0n88vjjhz9r0uxv77j04azrme2a2jy5qm262hg`.

Two things differ from the plan as written, on purpose:

- **One machine, both roles.** The plan says "Alice's machine" and "Bob's machine". What this scenario tests is how each
  tool reacts, not where it runs, and two-machine operation was shown in runs 11 to 14. Both swap files were made by
  one `prepare.sh` on a Windows PC with the helpers under WSL. No bundle was carried between machines; `new-bob` checked
  the bundle (`bundle check: 6efe009ed6569cd9 ok`) and passed its client R self-test (1,711 ms).
- **Ticks by hand, no watch loops.** Bob's file was ticked with `--apply` five times. Alice's file was ticked read-only
  until the abort text appeared and then applied once: the plan's alternative that avoids a held `fund_noid` intent
  (a loop that applies would have recorded one as soon as the funding window opened). So the heights below are the
  heights of the ticks,
  not the first heights at which each answer was available.

Numbers of the swap: `h_create` 300759, lock-by 300809, last lock height 300851 (`h_create + 92`), `D` 301061, log
start on Sepolia 12109929 (a recent finalized block, picked by `setup.sh`).

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 14:48:48 | 300747 | Alice | `prepare.sh`: both swap files, the bundle, the contract definition; then `parano1d-cli contract create` (local, no fee) and `check-object.sh`: "object file OK" |
| 14:49:28 | 300748 | Bob | tick, applied: `wait`, "waiting for Alice's funding"; note "lock-by margin: 61 blocks (lock-by 300809, tip 300748)"; phase `received` |
| 14:49:35 | 300748 | Alice | tick, read-only: `wait`, "node is behind H_create"; note "funding window: 37 blocks left before it is too late to fund" |
| 15:17:25 | 300805 | Bob | tick, applied: still `wait`; note "lock-by margin is short: 4 blocks" |
| 15:17:31 | 300805 | Alice | tick, read-only: `abort`, "too late to fund: tip 300805 + 24 > lock-by 300809"; note "funding window is closed: the last height to fund was 300785" |
| 15:17:49 | 300806 | Alice | tick, applied: `abort` recorded, "too late to fund: tip 300806 + 24 > lock-by 300809"; no intent held; phase `aborted` |
| 15:22:11 | 300813 | Bob | tick, applied: still `wait`, "waiting for Alice's funding" (the lock-by 300809 has passed, the last lock height 300851 has not) |
| 15:44:13 | 300857 | Bob | tick, applied: `abort` recorded, "last lock height 300851 passed before Alice's funding was final"; no intent held; phase `aborted` |
| 15:44:37 | | Bob | `lock.sh --dry-run`: exit 1, "the swap file has no pending intent; expected lock_eth. Run swap-cli tick --apply first and use the parameters it recorded" |

Afterwards `parano1d-cli contract instances` for the object file printed nothing (no instance at the contract root),
and no lock record or lock file of a send exists beside Bob's swap file.

## Against the plan

Every expected text appeared: Bob's `wait` and the lock-by margin note, Alice's "too late to fund", Bob's "last lock
height … passed before Alice's funding was final" at `h_create + 92` or later, and the refusal of the lock dry run for
a file with no `lock_eth` intent. Both files ended `aborted` with no intent held. The producer screen warned on every
tick of Bob's file (largest producer about 47 % of the last 2,880 blocks, the two largest together about 73 %); under
`sepolia` it only warns, and here no lock was ever offered.

## Observations

1. **Bob waits 42 blocks past the lock-by his own note shows.** Between the lock-by (300809) and the last lock height
   (300851) Bob's tool keeps saying "waiting for Alice's funding", although Alice's tool has refused to fund since
   300785. This is as designed (the lock-by is when a lock should be in; the last lock height is the hard limit), and it
   costs Bob nothing, but the note names only the first of the two heights. Low; a wording matter.
2. **Duration.** 55 minutes from `prepare.sh` to Bob's abort (110 blocks, about 30 s a block), with nothing to do in
   between.
3. **No held intent on Alice's side**, because her ticks were read-only until the abort. The other path of the plan
   (an applied loop that records `fund_noid`, then `intent --cancel --i-checked-the-wallet`) was not exercised.

## Not covered

The two-machine form; the watch loops; the cancel of a held `fund_noid` intent; any spend. The scratch files of this
run are a swap that must never be funded now: its windows have passed.
