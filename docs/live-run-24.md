# Live run 24 — the backup rehearsal's re-run on Sepolia, both sides restored, 2026-11-27

> Clock times in this log are UTC. All of them belong to 2026-11-27. Sepolia block numbers and Parano1d heights are given in short form.

The re-run of the backup rehearsal (the first pass found five problems, fixed as F1 to F5b). The question was whether those
fixes hold on two machines: a swap restored from a backup made before the person's own coins went in must record by itself,
must not ask for a second deposit, and the Ethereum sweep to a never-funded address must be mined. **They held. Both sides were
restored from a backup made before their own coins went in, the swap settled, and every send after the approvals was made by
the programs.** F1, F2, F4 and F5 passed; F3 was not checked; F5b is covered by tests only. Five new low findings (F6 to F10)
are listed below, none of them touching money.

## Setting

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node per
chain, the pinned Sepolia contract. A Windows PC was Alice, a Mac was Bob. Test version 2 of 0.2.0 on both machines (private
commit `ee1591b`: the sweep's gas estimate, the fixes F1 to F5b, the clock line). The PC build was packed locally with the
swap-cli of the earlier release candidate and is a test build only; the Mac build was made on the Mac from the same tree with
the same swap-cli as the first candidate (`swap-cli/`, the lockfiles and `vendor/` unchanged). Both ran their self-test and
quit without a crash.

Numbers of Alice's swap: `h_create` 345,575, lock-by 345,625, `D` 345,877, `W_A` 4,200 s, `max_fee` 50,000 micro-NOID,
check line `7f21d9926952f3a0`. Bob's swap key was new, and Bob's payout address was never funded: the case in which the sweep
failed in the first pass. Alice's deposits: 5.009 NOID to her swap wallet and the 10^15 wei reserve to her swap key.

## What happened

| UTC | who | what |
|---|---|---|
| 04:01 | Alice | Swap made from Bob's invitation code, pasted: terms, pinned contract and Bob's addresses filled by it. Set up and prepared by itself. |
| 04:02 | Alice | Copy for Bob saved (2,625 bytes) and carried over. |
| 04:09 | both | Check lines confirmed on both sides ("the other side's line matches"). |
| 04:11 | both | Backups made before the approvals: Alice's at phase `created`, Bob's at `received`. Each was copied at once to a second file, the "stale" copy. Bob's "Keep this file up to date" box was left unticked for the F1 check. |
| 04:12 | both | Approvals (Alice 04:12:36, Bob soon after). |
| 04:14 | both | Sepolia deposits sent: 0.001 ETH to Alice's swap key (block 12,221,029) and 0.0019 ETH to Bob's swap key (block 12,221,030). |
| 04:15 | Alice | The 5.009 NOID deposit sent from the wallet app, seen at 04:15:49. |
| 04:16:45 | Alice | **Funding sent by the autopilot** (tx `f429bcd7…`, after the 2-block hold). Phase `funded` at 04:17:57, tip 345,562. |
| 04:22 | Alice | Program ended, the run folder moved aside whole (120 files, 2,481,819 bytes before and after). |
| 04:23:44 | Alice | **Restored from the stale copy** (made 04:11:27, phase `created`), no code asked. |
| 04:24:34 | Alice | Approval of the restored copy (its statements include the one-computer line). |
| 04:24:35 | Alice | **F2 passes**: one second later the watch loop was recording, with no Start click. Phase `funded`, no second funding. |
| 04:29:00 | Bob | **Bob's lock sent by the autopilot** (Sepolia block 12,221,096, lock `0x7118…df2b`, tx `0x5a8c…6cc2`, 0.001 ETH, receiver Alice's swap key). |
| 04:31:38 | Alice | The restored Alice saw the lock (phase `lock_seen`). |
| 04:43:54 | Alice | Lock final at 04:43:16. **The restored Alice sent the reveal by itself** (tx `0x7b78…85cb`, block 12,221,164). Phase `revealed` at 04:44:24. |
| 04:44 to 04:51 | Bob | Program stopped, run folder moved aside, **restored from the stale copy** (made 04:11:13, phase `received`), no code asked. First read: tip 345,617. This was after the reveal. |
| 04:52 to 04:54 | Bob | Before the approval: **F4 passes** (below). Approval at 04:54:58. |
| 04:57:49 | Bob | At tip 345,635 (18 blocks after the first sighting) the restored copy adopted its own lock and read the secret from Ethereum on a read-only tick: `funded` to `secret_seen`. |
| 04:57:55 | Bob | The loop switched to recording by itself, no Start. Dry claim ok (4,994,200 micro-NOID out, fee 5,800). **04:58:07 claim sent by the autopilot**, tx `5a135e85…e697`. |
| 04:59:45 | Bob | Claim included in block 345,638, final at 345,656. |
| 05:0x | Alice | **Done**: 0.001 ETH swept to her payout address (tx `0x52895e29…68b0`, dry sweep estimate 21,000, limit 25,200). |
| 05:08:28 | Bob | **Done** at 05:08:20 (claim final). Sweep sent by the autopilot to the never-funded address: estimate 207,391, limit 248,870, block 12,221,282. **Receipt read independently at 05:11: status 1, gas used 204,600.** |

About 52 minutes from Alice's funding to Bob's done card. Both restores, the reveal and the claim happened with the swap in
flight and no step by a person beyond the two approvals, the deposits and the restores themselves.

## The checks

- **F1: passed.** Bob's "Keep this file up to date" box stayed unticked across the redraws, and his backup state said the
  same until the restored copy made its own backup, ticked. The person's own 30-second look on screen is not stated.
- **F2: passed.** A restored, approved Alice whose own instance is on the chain recorded one second after the approval, with
  no Start click, and sent no second funding. The card said "Your NOID is in the swap contract" and the clock line said "On
  track" with her refund opening 310 blocks away.
- **F4: passed.** The restored Bob, before and after his approval, was asked for no ETH deposit: the Details box said "Your
  lock was already sent from this swap's key ... Do not deposit again", and there was no "needs you" entry. The loop stayed
  read-only until his own lock and the secret were seen at funding finality, then switched to recording by itself.
- **F5: passed.** The sweep to a never-funded address was estimated at 207,391 gas (limit 248,870) and mined with status 1.
  Alice's sweep to a funded address was estimated at 21,000 (limit 25,200). The fixed 21,000 of the first pass is gone.
- **Clock line: seen.** On Bob's card: "On track", the claim-by time with 223 blocks (about 1 h 51 min) left, and "Waiting on
  the chains · keep the program open". It never said the program may be closed.
- **F3 (Details at 980 by 700 under the ticket): not checked.** It needs a person's eyes on a window of that size; the fix was
  checked in a browser window before the run.
- **F5b (a mined, failed send is named as failed): tests only.** A failed send cannot be caused safely on a live network.

## Findings

1. **F6 (low): the invitation code label is empty.** Under "Copy invitation code" the page prints "Invitation code:" with
   nothing after it. The copy itself works. Show the code or drop the label.
2. **F7 (low): "Use code" does not paste.** It reads the box beside it; the person pastes with Ctrl+V first. Name it "Read
   code" with a hint in the box, or read the clipboard on the click.
3. **F8 (low): closing the window left the program in the tray.** Four processes stayed until they were ended by hand. Still
   to check: which control was used, and the tray's Quit and the quit guard's wording.
4. **F9 (low): a stale notice on a restored copy before its approval.** Bob's restored card said "Something needs a look" and
   pointed to "the machine that ran it", although the swap was his own restored copy. It cleared by itself when the lock was
   adopted. The wording needs a variant for restored copies.
5. **F10 (low): the top bar showed "Ethereum mainnet: real funds" on a Sepolia swap.** The chip lights when any listed swap is
   mainnet, and the PC still listed run 23's stopped production folder. It should count only swaps not done or stopped, or
   follow the swap in view.

## Not covered

F3 and F5b as above. Mainnet, the stock variant, and the abort paths with a restored copy. Both restores here were made before
the restored side's own coins were counted a second time; a restore after the claim or after the deadline was not tried. A
little ETH from the first pass stays in an older Bob swap key, untouched.
