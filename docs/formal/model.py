#!/usr/bin/env python3
"""Explicit-state model checker for the NOID <-> ETH hash-time-locked swap (docs/protocol-design.md
sections 2, 4, 8; gates in swap-cli/src/params.rs).

Standard library only (Python 3.12).  Usage:

    python model.py demo                 # happy-path witnesses (non-vacuity), one per configuration
    python model.py relations            # the inequality checks of every parameter set
    python model.py witness [toy]        # the two excused losses (reveal-then-die, F9)
    python model.py base [toy|scaled|scaled6]   # all gates on: every invariant, every configuration
    python model.py ablate [toy|scaled]  # each gate switched off in turn (invariant x gate table)
    python model.py sweep [toy|scaled]   # assumption / slack sweeps (stall, reorgs, margins, ...)
    python model.py all                  # everything (what docs/formal/README.md reports)

Time unit: one TICK = tau_fast (20 s in production).  One NOID block per tick at the planning-fast
rate; the adversary may skip blocks (slow chain, up to LAG) or burst (faster than planned, BURST).
The state holds only RELATIVE quantities (blocks until D, ticks until T_reveal, ages), so two
situations that differ by a time shift are the same state; the BFS depth of a state is the number
of ticks since the start of the first run that reached it.

Configurations (who is protected, who is the adversary):
  A   Alice honest (may crash)  vs  Bob arbitrary            -> S1, S4        (Alice's safety)
  B   Bob honest, prompt (may crash)  vs  Alice arbitrary    -> S2            (Bob's safety)
  L   both honest and prompt, no crash, environment hostile within the stated bounds -> L1 (liveness)
  LD  both honest, free timing, no crash -> L2 (no pointless lock: completion stays reachable)
S3 (no stuck funds) is checked in every configuration.
"""
import sys
import time
from array import array
from dataclasses import dataclass, replace

# ----------------------------------------------------------------------------------------------
# State layout (a list of small ints; stored as a bytes object)
# ----------------------------------------------------------------------------------------------
(DL, SKU, BUR, FS, FA, LS, LA, TL, CS, CA, RS, RA_, XP, BK, LL, NP, NH, BP, ST, RN, RE, EV, AD, BD, BRD) = range(25)
NFIELDS = 25
FIELD_NAMES = ("DL", "SKU", "BUR", "FS", "FA", "LS", "LA", "TL", "CS", "CA", "RS", "RA", "XP", "BK", "LL",
               "NP", "NH", "BP", "ST", "RN", "RE", "EV", "AD", "BD", "BRD")
#  DL  blocks until D (D - tip), clamped at 0          FS  NOID funding: 0 none 1 pending 2 mined 3 cancelled (reorg)
#  SKU blocks skipped so far (slow chain budget)       FA  blocks pending / blocks since mined (clamped)
#  BUR extra blocks produced (fast chain budget)       LS  ETH lock: 0 none 1 pending 2 mined 3 cancelled (reorg)
#  LA  ticks pending / since mined (clamped)           TL  ticks until T_reveal (clamped at 0)
#  CS  ETH claim: 0 none/dropped 1 pending 2 mined ok 3 mined too late (reverted)    CA  age / ticks since drop
#  RS  ETH refund: 0 none 1 pending 2 mined             RA_ age
#  XP  the secret is public (claim broadcast)           BK  Bob knows the secret
#  LL  ticks until Bob is forced to learn it            NP  NOID close of the lock to Bob: 0 none 1 pending 2 mined
#  NH  blocks since the close was mined (clamped NF)    BP  Bob's proving countdown
#  ST  stall budget used                                RN  NOID reorgs used     RE ETH reorgs used
#  EV  mempool evictions (epoch rotation) used          AD/BD  Alice/Bob crashed     BRD  Bob must re-detect a dropped close

SETTLED = 255  # first byte of a collapsed settled state


# ----------------------------------------------------------------------------------------------
# Parameters
# ----------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Params:
    name: str
    D: int          # D_offset: Alice's deadline, in blocks after the lock is created
    W: int          # W_A    : Alice's reveal window offered by Bob (ticks)
    WMIN: int       # W_A_min (I3)
    MA: int         # M_A    : Alice's reveal margin before T_reveal (I2)
    FE: int         # Ethereum finality (ticks)
    DE: int         # max Ethereum inclusion delay (ticks)
    RA: int         # Alice's reaction bound (ticks): rebroadcast a dropped claim, reveal when enabled
    DET: int        # Delta_detect: Bob learns the secret at most this long after the claim is mined
    PA: int         # P_auth: ticks to prove and submit one claim
    RD: int         # ticks for Bob to notice that his close was evicted / reorged away
    NF: int         # NOID rollback depth: final once tip >= h_mined + NF (the chain: 18); B_final = NF + 1
    B_EPOCH: int
    B_FEE: int
    B_SAFETY: int
    B_FUND: int     # Alice's funding is mined within this many blocks
    B_BOB: int      # Bob locks within this many blocks after the funding is final (reaction bound, liveness runs)
    MARGIN: int
    N_NOID: int     # NOID reorgs (each drops a not-yet-final inclusion)
    N_ETH: int      # Ethereum reorgs
    N_EVICT: int    # mempool evictions of Bob's pending close (epoch rotation)
    LAG: int = 0    # blocks the adversary may skip (slow chain)
    BURST: int = 0  # extra blocks the adversary may add (faster than tau_fast: outside the design)
    FEE_OK: bool = True     # max_fee >= the fee floor
    STALL: int = -2         # -2 => B_EPOCH + B_FEE ; -1 => unlimited ; n >= 0 => n
    WADV: tuple = ()        # the T_reveal windows an arbitrary Bob may pick (ticks); () => all of 1..W+MA
    # The environment's true bounds, when they differ from the budgets the gates use (-1 => same as the budget).
    # Used by the robustness sweeps: the gates keep their numbers, the world gets slower.
    FE_ENV: int = -1
    DET_ENV: int = -1
    PA_ENV: int = -1

    @property
    def fe_env(self):
        return self.FE if self.FE_ENV < 0 else self.FE_ENV

    @property
    def det_env(self):
        return self.DET if self.DET_ENV < 0 else self.DET_ENV

    @property
    def pa_env(self):
        return self.PA if self.PA_ENV < 0 else self.PA_ENV

    @property
    def B_FINAL(self):
        return self.NF + 1

    @property
    def PA2(self):
        return 2 * self.PA

    @property
    def B_POST(self):
        return self.B_EPOCH + self.B_FEE + self.B_FINAL + self.B_SAFETY

    @property
    def stall(self):
        return self.B_EPOCH + self.B_FEE if self.STALL == -2 else self.STALL

    def rhs(self, w):
        """Right-hand side of (I1) in blocks, with tau_fast = 1 tick."""
        return w + self.DET + self.PA2 + self.B_POST

    def d_derived(self):
        return self.B_FUND + self.B_FINAL + self.B_BOB + self.rhs(self.W) + self.MARGIN

    def adv_windows(self):
        return self.WADV if self.WADV else tuple(range(1, self.W + self.MA + 1))


def design_relations(p):
    """(name, holds, detail).  The first group mirrors Gates::validate in swap-cli/src/params.rs; the second
    group is what the model additionally needs (derived in README.md section 'Parameters')."""
    r = []
    r.append(("design  W_A_min <= W_A (I3)", p.WMIN <= p.W, f"{p.WMIN} <= {p.W}"))
    r.append(("design  M_A > eth_finality (I2)", p.MA > p.FE, f"{p.MA} > {p.FE}"))
    r.append(("design  W_A_min - M_A >= eth_finality + Delta_detect", p.WMIN - p.MA >= p.FE + p.DET,
              f"{p.WMIN - p.MA} >= {p.FE + p.DET}"))
    r.append(("design  D_offset = B_fund + B_final + B_bob + RHS(I1)(W_A) + margin", p.D == p.d_derived(),
              f"{p.D} == {p.B_FUND}+{p.B_FINAL}+{p.B_BOB}+{p.rhs(p.W)}+{p.MARGIN} = {p.d_derived()}"))
    need_ma = p.FE + 2 * p.DE + p.RA
    r.append(("model   M_A >= FE + 2*DE + RA  (one Ethereum reorg of Alice's claim is survivable)", p.MA >= need_ma,
              f"{p.MA} >= {p.FE}+2*{p.DE}+{p.RA} = {need_ma}"))
    need_w = p.DE + p.FE + p.RA + p.MA
    r.append(("model   W_A_min >= DE + FE + RA + M_A  (Alice can still reveal inside the minimum window)", p.WMIN >= need_w,
              f"{p.WMIN} >= {p.DE}+{p.FE}+{p.RA}+{p.MA} = {need_w}"))
    need_bs = p.NF + p.RD + p.PA + 1
    r.append(("model   B_safety >= NF + RD + PA + 1  (one NOID reorg of Bob's close at the last non-final moment)",
              p.B_SAFETY >= need_bs, f"{p.B_SAFETY} >= {p.NF}+{p.RD}+{p.PA}+1 = {need_bs}"))
    return r


@dataclass(frozen=True)
class Gates:
    I1: bool = True     # Bob locks only if his claim can be final before D; clamps T_reveal to T_max
    I2c: bool = True    # Alice reveals only if T_reveal - now >= M_A
    I2f: bool = True    # ... and only once Bob's lock is final
    I3: bool = True     # Bob refuses a window shorter than W_A_min
    FF: bool = True     # Bob locks only once Alice's NOID funding is final (design 2.2 step 7; extra gate)

    def off(self, name):
        return replace(self, **{name: False})

    def label(self):
        off = [n for n in ("I1", "I2c", "I2f", "I3", "FF") if not getattr(self, n)]
        return "all gates on" if not off else "gate off: " + ",".join(off)


CONFIGS = {
    # alice_honest, bob_honest, forced (prompt honest reactions), crash, noid_hostile, eth_reorg_claim, eth_cancel_lock,
    # fund_cancel, third_party, bob_refund_sim, free_alice_reveal
    "A": dict(alice_honest=True, bob_honest=False, crash="alice", noid_hostile=False,
              eth_drop_claim=True, eth_cancel_lock=True, fund_cancel=False, third_party=False, bob_refund=True),
    "B": dict(alice_honest=False, bob_honest=True, crash="bob", noid_hostile=True,
              eth_drop_claim=False, eth_cancel_lock=False, fund_cancel=True, third_party=True, bob_refund=False),
    "L": dict(alice_honest=True, bob_honest=True, crash=None, noid_hostile=True,
              eth_drop_claim=True, eth_cancel_lock=False, fund_cancel=False, third_party=False, bob_refund=False),
    "LD": dict(alice_honest=True, bob_honest=True, crash=None, noid_hostile=True,
               eth_drop_claim=True, eth_cancel_lock=False, fund_cancel=False, third_party=False, bob_refund=False),
}


# ----------------------------------------------------------------------------------------------
# The model
# ----------------------------------------------------------------------------------------------
class Model:
    def __init__(self, p, g, cfg, crash=True):
        assert p.D < SETTLED
        self.p, self.g, self.cfgname = p, g, cfg
        self.c = dict(CONFIGS[cfg])
        if not crash:
            self.c["crash"] = None
        self.labels = {}      # label tuple -> id
        self.label_list = []
        self.stall = p.stall
        self.capFA = p.NF + p.B_BOB
        self.capLA = max(p.FE, p.fe_env) + p.RA

    # ---- helpers -------------------------------------------------------------------------
    def lab(self, labels):
        i = self.labels.get(labels)
        if i is None:
            i = len(self.label_list)
            self.labels[labels] = i
            self.label_list.append(labels)
        return i

    def initial(self):
        s = [0] * NFIELDS
        s[DL] = self.p.D
        return s

    def stall_left(self, s):
        return self.stall < 0 or s[ST] < self.stall

    # ---- one tick ------------------------------------------------------------------------
    def successors(self, s):
        """All successor states of s: list of (state list, label tuple)."""
        cur = [(s[:], ())]
        for step in (self.s_eth_lock, self.s_eth_claim, self.s_eth_refund, self.s_eth_reorg,
                     self.s_noid_env, self.s_blocks, self.s_crash, self.s_learn, self.s_alice, self.s_bob):
            nxt = []
            for st, lab in cur:
                nxt.extend(step(st, lab))
            cur = nxt
        for st, lab in cur:
            self.end_of_tick(st)
        return cur

    def end_of_tick(self, s):
        p = self.p
        if s[LS] == 1:
            s[LA] = min(s[LA] + 1, p.DE)
        elif s[LS] == 2:
            s[LA] = min(s[LA] + 1, self.capLA)
        if s[CS] == 1:
            s[CA] = min(s[CA] + 1, p.DE)
        elif s[CS] == 2:
            s[CA] = min(s[CA] + 1, p.fe_env)
        elif s[CS] == 0 and s[XP]:
            s[CA] = min(s[CA] + 1, p.RA)
        if s[RS] == 1:
            s[RA_] = min(s[RA_] + 1, p.DE)
        elif s[RS] == 2:
            s[RA_] = min(s[RA_] + 1, p.fe_env)
        if s[TL] > 0:
            s[TL] -= 1
        if s[XP] and not s[BK] and s[LL] > 0:
            s[LL] -= 1

    # ---- Ethereum environment ------------------------------------------------------------
    def s_eth_lock(self, s, lab):
        if s[LS] != 1:
            return [(s, lab)]
        out = []
        if s[LA] < self.p.DE:
            out.append((s[:], lab))                   # not mined yet
        if s[TL] > 0:
            s[LS], s[LA] = 2, 0
            out.append((s, lab + (("lock_mined",),)))
        else:                                         # newLock reverts: timelock <= block.timestamp
            s[LS], s[LA], s[TL] = 0, 0, 0
            out.append((s, lab + (("lock_reverted",),)))
        return out

    def s_eth_claim(self, s, lab):
        if s[CS] != 1:
            return [(s, lab)]
        p = self.p
        out = []
        if s[CA] < p.DE:
            out.append((s[:], lab))
        if s[LS] == 2 and s[TL] > 0 and s[RS] != 2:
            s[CS], s[CA] = 2, 0
            ev = ("claim_mined_ok",)
        else:                                         # claim() needs block.timestamp < timelock
            s[CS], s[CA] = 3, 0
            ev = ("claim_mined_late",)
        if s[XP] and not s[BK]:
            s[LL] = min(s[LL], p.det_env)
        out.append((s, lab + (ev,)))
        return out

    def s_eth_refund(self, s, lab):
        if s[RS] != 1:
            return [(s, lab)]
        out = []
        if s[RA_] < self.p.DE:
            out.append((s[:], lab))
        if s[TL] == 0 and s[LS] == 2 and s[CS] != 2:
            s[RS], s[RA_] = 2, 0
            out.append((s, lab + (("refund_mined",),)))
        else:                                         # refund() reverted (claimed, or before T_reveal)
            s[RS], s[RA_] = 0, 0
            out.append((s, lab + (("refund_reverted",),)))
        return out

    def s_eth_reorg(self, s, lab):
        c, p = self.c, self.p
        out = [(s, lab)]
        if s[RE] >= p.N_ETH:
            return out
        if c["eth_drop_claim"] and s[CS] == 2 and s[CA] < p.fe_env:
            t = s[:]
            t[CS], t[CA], t[RE] = 0, 0, t[RE] + 1
            out.append((t, lab + (("eth_reorg_drops_claim",),)))
        if c["eth_cancel_lock"] and s[LS] == 2 and s[LA] < p.fe_env and s[RS] == 0:
            t = s[:]
            t[LS], t[RE] = 3, t[RE] + 1
            if t[CS] in (1, 2):
                t[CS] = 3
            out.append((t, lab + (("eth_reorg_cancels_lock",),)))
        return out

    # ---- NOID environment ----------------------------------------------------------------
    def s_noid_env(self, s, lab):
        c, p = self.c, self.p
        out = [(s, lab)]
        if not c["noid_hostile"]:
            return out
        res = []
        for st, l in out:
            res.append((st, l))
            if st[NP] == 1 and st[EV] < p.N_EVICT:                       # epoch rotation evicts the pending close
                t = st[:]
                t[NP], t[EV], t[BRD] = 0, t[EV] + 1, 1
                res.append((t, l + (("evicted_by_rotation",),)))
            if st[NP] == 2 and st[NH] < p.NF and st[RN] < p.N_NOID:       # reorg drops the not-yet-final close
                t = st[:]
                t[NP], t[NH], t[RN], t[BRD] = 0, 0, t[RN] + 1, 1
                res.append((t, l + (("noid_reorg_drops_close",),)))
            if c["fund_cancel"] and st[FS] == 2 and st[FA] < p.NF and st[RN] < p.N_NOID:   # Alice double-spends her funding
                t = st[:]
                t[FS], t[RN] = 3, t[RN] + 1
                t[NP], t[NH] = 0, 0
                res.append((t, l + (("noid_reorg_cancels_funding",),)))
            if (c["third_party"] and st[XP] and st[NP] == 0 and st[FS] == 2 and st[DL] >= 2 and p.FEE_OK):
                t = st[:]                                                  # anyone holding the secret closes to Bob
                t[NP], t[NH] = 1, 0
                res.append((t, l + (("third_party_close_submitted",),)))
        return res

    def s_blocks(self, s, lab):
        p = self.p
        opts = [1]
        if s[SKU] < p.LAG:
            opts.append(0)
        if s[BUR] < p.BURST:
            opts.append(2)
        out = []
        for k in opts:
            t = s if len(opts) == 1 else s[:]
            base = lab
            if k == 0:
                t[SKU] += 1
                base = lab + (("no_noid_block",),)
                out.append((t, base))
                continue
            if k == 2:
                t[BUR] += 1
                base = lab + (("two_noid_blocks",),)
            cur = [(t, base)]
            for _ in range(k):
                nxt = []
                for st, l in cur:
                    nxt.extend(self.apply_block(st, l))
                cur = nxt
            out.extend(cur)
        return out

    def apply_block(self, s, lab):
        p, c = self.p, self.c
        dl_old = s[DL]
        s[DL] = dl_old - 1 if dl_old > 0 else 0
        can_incl = dl_old >= 2                       # the new block's height is < D
        if s[FS] == 2:
            s[FA] = min(s[FA] + 1, self.capFA)
        if s[NP] == 2:
            s[NH] = min(s[NH] + 1, p.NF)
        out = [(s, lab)]
        # funding inclusion
        if s[FS] == 1:
            res = []
            for st, l in out:
                st[FA] += 1
                if st[FA] < p.B_FUND:
                    res.append((st[:], l))
                st[FS], st[FA] = 2, 0
                res.append((st, l + (("funding_mined",),)))
            out = res
        # Bob's close of the lock
        if s[NP] == 1:
            res = []
            for st, l in out:
                if st[NP] != 1:
                    res.append((st, l))
                    continue
                if not can_incl or not p.FEE_OK:
                    st[NP], st[BRD] = 0, 1
                    res.append((st, l + (("close_expired_branch_flips",),)))
                    continue
                if c["noid_hostile"] and self.stall_left(st):
                    t = st[:]
                    if p.stall >= 0:
                        t[ST] += 1
                    res.append((t, l + (("close_deferred_one_block",),)))
                st[NP], st[NH] = 2, 0
                res.append((st, l + (("close_mined",),)))
            out = res
        # a pending close whose branch flips at the next height is evicted
        fin = []
        for st, l in out:
            if st[NP] == 1 and st[DL] <= 1:
                st[NP], st[BRD] = 0, 1
                l = l + (("close_evicted_branch_flips",),)
            fin.append((st, l))
        return fin

    # ---- crash ---------------------------------------------------------------------------
    def s_crash(self, s, lab):
        out = [(s, lab)]
        who = self.c["crash"]
        if who == "alice" and not s[AD]:
            t = s[:]
            t[AD] = 1
            out.append((t, lab + (("ALICE_CRASHES",),)))
        elif who == "bob" and not s[BD]:
            t = s[:]
            t[BD] = 1
            out.append((t, lab + (("BOB_CRASHES",),)))
        return out

    # ---- Bob learns the secret (honest Bob) ----------------------------------------------
    def s_learn(self, s, lab):
        if not (self.c["bob_honest"] and s[XP] and not s[BK] and not s[BD]):
            return [(s, lab)]
        out = []
        if s[LL] > 0:
            out.append((s[:], lab))
        s[BK], s[LL] = 1, 0
        out.append((s, lab + (("bob_learns_secret",),)))
        return out

    # ---- Alice ---------------------------------------------------------------------------
    def s_alice(self, s, lab):
        c, g, p = self.c, self.g, self.p
        if c["alice_honest"]:
            if s[AD]:
                return [(s, lab)]
            if s[FS] == 0:
                s[FS], s[FA] = 1, 0
                lab = lab + (("alice_funds",),)
            out = []
            cond = (s[XP] == 0 and s[LS] == 2 and s[CS] == 0 and (not g.I2f or s[LA] >= p.FE)
                    and (not g.I2c or s[TL] >= p.MA))
            forced_now = self.cfgname == "L" and s[LA] >= p.FE + p.RA
            rebroadcast = s[XP] == 1 and s[CS] == 0 and s[TL] > 0
            if cond:
                if not forced_now:
                    out.append((s[:], lab))
                s[CS], s[CA], s[XP] = 1, 0, 1
                s[LL] = p.det_env + s[TL]
                if not c["bob_honest"]:
                    s[BK] = 1
                out.append((s, lab + (("alice_reveals",),)))
                return out
            if rebroadcast:
                if s[CA] < p.RA:
                    out.append((s[:], lab))
                s[CS], s[CA] = 1, 0
                out.append((s, lab + (("alice_rebroadcasts_claim",),)))
                return out
            return [(s, lab)]
        # arbitrary Alice
        out = [(s, lab)]
        res = []
        for st, l in out:
            res.append((st, l))
            if st[FS] == 0:
                t = st[:]
                t[FS], t[FA] = 1, 0
                res.append((t, l + (("alice_funds",),)))
            if st[XP] == 0 and st[LS] == 2 and st[CS] == 0:
                t = st[:]
                t[CS], t[CA], t[XP] = 1, 0, 1
                t[LL] = p.det_env + t[TL]
                res.append((t, l + (("alice_reveals",),)))
        return res

    # ---- Bob -----------------------------------------------------------------------------
    def s_bob(self, s, lab):
        c, g, p = self.c, self.g, self.p
        if not c["bob_honest"]:
            return self.bob_adversary(s, lab)
        if s[BD]:
            return [(s, lab)]
        out = []
        # lock the ETH
        if s[LS] == 0 and s[DL] >= 1:
            seen = s[FS] == 2 and (not g.FF or s[FA] >= p.NF)
            if seen:
                tmax = s[DL] - p.B_POST - p.DET - p.PA2
                w = min(p.W, tmax) if g.I1 else p.W
                ok = w >= (p.WMIN if g.I3 else 1)
                if ok:
                    forced_now = self.cfgname == "L" and s[FA] >= p.NF + p.B_BOB
                    if not forced_now:
                        out.append((s[:], lab))
                    s[LS], s[LA], s[TL] = 1, 0, w
                    out.append((s, lab + (("bob_locks", w),)))
                    return out
        # claim the NOID
        if s[BK]:
            if s[BP] > 0:
                s[BP] -= 1
                if s[BP] == 0 and s[NP] == 0 and s[DL] >= 2 and p.FEE_OK:
                    s[NP], s[NH], s[BRD] = 1, 0, 0
                    lab = lab + (("bob_submits_close",),)
            elif s[NP] == 0 and s[FS] == 2 and s[DL] >= 2 and p.FEE_OK:
                s[BP] = p.pa_env + (p.RD if s[BRD] else 0)
                lab = lab + (("bob_starts_proving", s[BP]),)
        return [(s, lab)]

    def bob_adversary(self, s, lab):
        c, p = self.c, self.p
        out = []
        # an arbitrary Bob locks at any time, with any window
        if s[LS] == 0 and s[DL] >= 1:
            out.append((s[:], lab))
            for w in p.adv_windows():
                t = s[:]
                t[LS], t[LA], t[TL] = 1, 0, w
                out.append((t, lab + (("bob_locks", w),)))
        else:
            out.append((s, lab))
        res = []
        for st, l in out:
            if st[BK] and st[NP] == 0 and st[FS] == 2 and st[DL] >= 2 and p.FEE_OK:
                st[NP], st[NH] = 1, 0
                l = l + (("bob_submits_close",),)
            if c["bob_refund"] and st[TL] == 0 and st[LS] == 2 and st[CS] != 2 and st[RS] == 0:
                st[RS], st[RA_] = 1, 0
                l = l + (("bob_broadcasts_refund",),)
            res.append((st, l))
        return res

    # ---- outcome of a state --------------------------------------------------------------
    def eth_owner(self, s):
        p = self.p
        if s[CS] == 2 and s[CA] >= p.fe_env:
            return "A"
        if s[LS] == 3:
            return "B"
        if s[LS] == 0:
            return "B" if (s[DL] == 0 or s[BD]) else None
        if s[TL] == 0 and s[CS] != 2:
            return "B"
        return None

    def noid_owner(self, s):
        p = self.p
        if s[FS] == 3:
            return "A"
        if not p.FEE_OK and s[FS] == 2:
            return "STUCK" if s[DL] == 0 else None      # neither the claim nor the recovery can be admitted
        if s[NP] == 2 and s[NH] >= p.NF:
            return "B"
        if s[DL] == 0 and s[NP] == 0:
            return "A"
        return None

    def classify(self, s):
        """None while open, else (noid owner, eth owner)."""
        e = self.eth_owner(s)
        if e is None:
            return None
        n = self.noid_owner(s)
        if n is None:
            return None
        return n, e

    def s4_violated(self, s):
        """(S4) Alice revealed, is alive, and Bob's refund (or lock cancellation) succeeded anyway."""
        return bool(self.c["alice_honest"] and s[XP] and not s[AD] and (s[RS] == 2 or s[LS] == 3))

    def settled_key(self, s, out):
        n, e = out
        return bytes([SETTLED, "A B STUCK".split().index(n), "A B".split().index(e), s[XP], s[AD], s[BD], s[BK],
                      int(self.s4_violated(s))])


# ----------------------------------------------------------------------------------------------
# Breadth-first search
# ----------------------------------------------------------------------------------------------
INVARIANTS = ("S1", "S2", "S3", "S4", "L1", "L2")


class Result:
    pass


class Store:
    """Compact visited set: states live in one bytearray (NFIELDS bytes each, id = index); an open-addressing table of
    32-bit ids finds them.  About 50 bytes per state instead of about 200 for a dict of bytes objects."""

    def __init__(self):
        self.buf = bytearray()
        self.n = 0
        self.cap = 1 << 16
        self.table = array("i", [-1]) * self.cap

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        return bytes(self.buf[i * NFIELDS:(i + 1) * NFIELDS])

    def field(self, i, f):
        return self.buf[i * NFIELDS + f]

    def _grow(self):
        self.cap *= 2
        self.table = array("i", [-1]) * self.cap
        mask = self.cap - 1
        buf, table = self.buf, self.table
        for i in range(self.n):
            h = hash(bytes(buf[i * NFIELDS:(i + 1) * NFIELDS])) & mask
            while table[h] != -1:
                h = (h + 1) & mask
            table[h] = i

    def find_or_add(self, key):
        """key: exactly NFIELDS bytes.  Returns (id, is_new)."""
        if self.n * 2 >= self.cap:
            self._grow()
        mask = self.cap - 1
        table, buf = self.table, self.buf
        h = hash(key) & mask
        while True:
            v = table[h]
            if v == -1:
                table[h] = self.n
                buf += key
                self.n += 1
                return self.n - 1, True
            if buf[v * NFIELDS:(v + 1) * NFIELDS] == key:
                return v, False
            h = (h + 1) & mask


def pad(key):
    return key + bytes(NFIELDS - len(key))


def run(*args, **kw):
    """_run with a retry when the machine is out of memory (the checker needs about 50 bytes per state)."""
    import gc
    for attempt in range(10):
        try:
            return _run(*args, **kw)
        except MemoryError:
            gc.collect()
            print("  (out of memory; retrying in 30 s)", file=sys.stderr)
            time.sleep(30)
    raise MemoryError


def _run(p, g, cfg, max_states=6_000_000, edges=False, stop_when=None, verbose=False, crash=None, keep=False):
    if crash is None:
        crash = not (p.name.startswith('scaled') and cfg == 'B')   # see README: a crash can only add excused losses
    m = Model(p, g, cfg, crash)
    t0 = time.time()
    init = bytes(m.initial())
    keys = Store()
    keys.find_or_add(init)
    parent = array("i", [-1])
    plab = array("i", [-1])
    esrc, edst = (array("i"), array("i")) if edges else (None, None)
    terminals = {}           # settled key -> id
    outcomes = {}            # (noid, eth, xp, ad, bd) -> count of terminal keys
    first = {}               # invariant -> (depth, node id, description)
    counts = {k: 0 for k in INVARIANTS}
    frontier = [0]
    depth = 0
    truncated = False
    stopped = False
    transitions = 0
    c = m.c
    while frontier and not truncated:
        depth += 1
        nxt = []
        for sid in frontier:
            s = list(keys[sid])
            for st, lab in m.successors(s):
                transitions += 1
                lid = m.lab(lab)
                # state-level invariant (S4)
                bad4 = m.s4_violated(st)
                out = m.classify(st)
                key = m.settled_key(st, out) if out is not None else bytes(st)
                nid, is_new = keys.find_or_add(pad(key) if out is not None else key)
                if is_new:
                    parent.append(sid)
                    plab.append(lid)
                    if out is None:
                        nxt.append(nid)
                    else:
                        terminals[pad(key)] = nid
                        n, e = out
                        okey = (n, e, st[XP], st[AD], st[BD])
                        outcomes[okey] = outcomes.get(okey, 0) + 1
                        if c["alice_honest"] and n == "B" and e == "B":
                            if st[XP] and st[AD]:
                                pass                                   # the known reveal-then-die loss, reported separately
                            else:
                                counts["S1"] += 1
                                first.setdefault("S1", (depth, nid, "Bob ends with the NOID and the ETH, Alice alive"))
                        if c["bob_honest"] and n == "A" and e == "A":
                            if st[BD]:
                                pass                                   # the known F9 loss (Bob offline)
                            else:
                                counts["S2"] += 1
                                first.setdefault("S2", (depth, nid, "Alice ends with the ETH and the NOID, Bob alive"))
                        if n == "STUCK" or e == "STUCK":
                            counts["S3"] += 1
                            first.setdefault("S3", (depth, nid, "an amount nobody can recover"))
                        if cfg == "L" and not (n == "B" and e == "A"):
                            counts["L1"] += 1
                            first.setdefault("L1", (depth, nid, f"swap does not complete (NOID to {n}, ETH to {e})"))
                    if bad4:
                        counts["S4"] += 1
                        first.setdefault("S4", (depth, nid, "Alice revealed and is alive, yet Bob's refund / lock cancellation succeeded"))
                if edges:
                    esrc.append(sid)
                    edst.append(nid)
                if len(keys) >= max_states:
                    truncated = True
                    break
            if truncated:
                break
        frontier = nxt
        if stop_when and all(k in first for k in stop_when):
            stopped = True
            break
        if verbose:
            print(f"  depth {depth}: {len(keys)} states", file=sys.stderr)
    r = Result()
    r.model, r.params, r.gates, r.cfg, r.crash = m, p, g, cfg, crash
    r.keys, r.parent, r.plab, r.first, r.counts = keys, parent, plab, first, counts
    r.terminals, r.outcomes = terminals, outcomes
    r.states = len(keys)
    r.transitions = transitions
    r.depth = depth
    r.truncated = truncated
    r.stopped = stopped
    r.seconds = time.time() - t0
    r.esrc, r.edst = esrc, edst
    r.complete_exhausted = not truncated and not frontier
    if edges and not truncated:
        post_process(r)
    r.traces = {inv: trace(r, nid) for inv, (d, nid, desc) in r.first.items() if nid > 0}
    if not keep:
        r.keys = r.parent = r.plab = r.esrc = r.edst = r.terminals = None
    return r


def post_process(r):
    """S3 (every open state can still settle) and L2 (a lock Bob broadcasts can still complete the swap)."""
    n = len(r.keys)
    is_term = bytearray(n)
    success = bytearray(n)
    for key, i in r.terminals.items():
        is_term[i] = 1
        if key[1] == 1 and key[2] == 0:        # NOID to Bob, ETH to Alice
            success[i] = 1
    for name, targets in (("settle", is_term), ("success", success)):
        good = bytearray(targets)
        changed = True
        es, ed = r.esrc, r.edst
        m = len(es)
        while changed:
            changed = False
            for k in range(m - 1, -1, -1):
                if good[ed[k]] and not good[es[k]]:
                    good[es[k]] = 1
                    changed = True
        if name == "settle":
            dead = [i for i in range(n) if not good[i]]
            r.cannot_settle = len(dead)
            if dead:
                r.counts["S3"] += len(dead)
                r.first.setdefault("S3", (0, dead[0], "an open state from which no settlement is reachable (funds locked forever)"))
        else:
            r.success_states = sum(success)
            if r.cfg == "LD":
                kb = r.keys.buf
                bad = [i for i in range(n) if kb[i * NFIELDS] != SETTLED and kb[i * NFIELDS + LS] == 1 and kb[i * NFIELDS + LA] == 1 and not good[i]]
                r.counts["L2"] = len(bad)
                if bad:
                    d = depth_of(r, bad[0])
                    r.first["L2"] = (d, bad[0], "Bob broadcast a lock after which no schedule lets the swap complete")


def events_of(r, i):
    n = 0
    while r.parent[i] >= 0:
        n += len(r.model.label_list[r.plab[i]])
        i = r.parent[i]
    return n


def depth_of(r, i):
    d = 0
    while r.parent[i] >= 0:
        i = r.parent[i]
        d += 1
    return d


# ----------------------------------------------------------------------------------------------
# Traces
# ----------------------------------------------------------------------------------------------
def fmt_event(ev, p, tick):
    code = ev[0]
    if code == "bob_locks":
        return f"Bob broadcasts newLock with T_reveal = t+{ev[1]} (= {tick + ev[1]})"
    if code == "bob_starts_proving":
        return f"Bob starts proving his close ({ev[1]} tick(s) until submission)"
    text = {
        "alice_funds": "Alice funds the NOID lock",
        "funding_mined": "NOID funding mined",
        "lock_mined": "Ethereum lock mined",
        "lock_reverted": "Ethereum lock tx reverts (T_reveal already passed)",
        "alice_reveals": "Alice broadcasts claim(lockId, x): the secret is public",
        "alice_rebroadcasts_claim": "Alice rebroadcasts her dropped claim",
        "claim_mined_ok": "Alice's claim mined before T_reveal (valid)",
        "claim_mined_late": "Alice's claim mined at or after T_reveal (reverts, x still public) or after the lock vanished",
        "eth_reorg_drops_claim": "Ethereum reorg drops Alice's claim",
        "eth_reorg_cancels_lock": "Ethereum reorg removes Bob's lock (double-spend)",
        "bob_learns_secret": "Bob learns the secret",
        "bob_submits_close": "Bob submits the NOID close to himself",
        "third_party_close_submitted": "a third party holding the secret submits the close to Bob",
        "close_mined": "NOID close mined (pays Bob)",
        "close_deferred_one_block": "adversary keeps the pending close out of this block (stall)",
        "close_expired_branch_flips": "pending close dropped: next height >= D, branch flips",
        "close_evicted_branch_flips": "pending close evicted: next height >= D, branch flips",
        "evicted_by_rotation": "epoch rotation evicts the pending close",
        "noid_reorg_drops_close": "NOID reorg drops the (not yet final) close",
        "noid_reorg_cancels_funding": "NOID reorg removes Alice's funding (double-spend)",
        "bob_broadcasts_refund": "Bob broadcasts refund(lockId)",
        "refund_mined": "Bob's refund mined (ETH back to Bob)",
        "refund_reverted": "Bob's refund reverts",
        "ALICE_CRASHES": "ALICE CRASHES (stops acting)",
        "BOB_CRASHES": "BOB CRASHES (stops acting)",
        "no_noid_block": "no NOID block this tick (slow chain)",
        "two_noid_blocks": "two NOID blocks this tick (faster than tau_fast)",
    }
    return text.get(code, code)


def trace(r, nid):
    """Lines describing the shortest path from the start to node nid."""
    path = []
    i = nid
    while r.parent[i] >= 0:
        path.append((r.parent[i], i, r.plab[i]))
        i = r.parent[i]
    path.reverse()
    p = r.params
    lines = []
    for tick, (src, dst, lid) in enumerate(path):
        labels = r.model.label_list[lid]
        s = r.keys[dst]
        if not labels:
            continue
        evs = "; ".join(fmt_event(e, p, tick) for e in labels)
        dl = s[DL] if s[0] != SETTLED else 0
        lines.append(f"  t={tick:<4d} (blocks to D: {r.keys[src][DL] if r.keys[src][0] != SETTLED else 0:<4d}) {evs}")
    s = r.keys[nid]
    if s[0] == SETTLED:
        lines.append(f"  => settled: NOID to {'AB'[s[1]] if s[1] < 2 else 'STUCK'}, ETH to {'AB'[s[2]]}"
                     f"  (secret public={bool(s[3])}, Alice crashed={bool(s[4])}, Bob crashed={bool(s[5])})")
    else:
        lines.append(f"  => at t={len(path)}")
    return lines


# ----------------------------------------------------------------------------------------------
# Parameter sets
# ----------------------------------------------------------------------------------------------
def toy():
    """Small integers.  Inequalities kept (all tight where noted): W_A_min = DE+FE+RA+M_A, M_A = FE+2DE+RA,
    B_safety = NF+RD+PA+1, D_offset as in design 4.2."""
    p = Params(name="toy", D=0, W=16, WMIN=13, MA=7, FE=4, DE=1, RA=1, DET=1, PA=1, RD=1, NF=2,
               B_EPOCH=2, B_FEE=1, B_SAFETY=5, B_FUND=2, B_BOB=3, MARGIN=2, N_NOID=1, N_ETH=1, N_EVICT=1)
    return replace(p, D=p.d_derived())


def scaled():
    """The production table of docs/protocol-design.md 9.1 (ticks of 20 s) divided by about 10.  Terms that cannot
    shrink (one proof = 1 tick, noticing a drop = 1 tick, one block) are kept; the slack of every model inequality
    is kept at about its production ratio, and B_safety = NF + 3 exactly as 21 = 18 + 3 (zero slack, as in production)."""
    p = Params(name="scaled", D=0, W=36, WMIN=27, MA=11, FE=6, DE=1, RA=1, DET=2, PA=1, RD=1, NF=2,
               B_EPOCH=14, B_FEE=6, B_SAFETY=5, B_FUND=2, B_BOB=6, MARGIN=3, N_NOID=1, N_ETH=1, N_EVICT=1,
               WADV=(1, 5, 8, 9, 10, 11, 17, 18, 19, 20, 26, 27, 28, 36, 47))
    return replace(p, D=p.d_derived())


def scaled6():
    """Same rule, divided by about 6 (a larger run, about 1.6 million states per configuration)."""
    p = Params(name="scaled6", D=0, W=60, WMIN=45, MA=15, FE=10, DE=1, RA=1, DET=3, PA=1, RD=1, NF=2,
               B_EPOCH=24, B_FEE=10, B_SAFETY=5, B_FUND=2, B_BOB=10, MARGIN=3, N_NOID=1, N_ETH=1, N_EVICT=1,
               WADV=(1, 7, 14, 15, 16, 24, 25, 26, 32, 44, 45, 46, 60, 75))
    return replace(p, D=p.d_derived())


def production():
    """The real numbers, in ticks of 20 s (state space far too big to enumerate; used for the relations only)."""
    p = Params(name="production", D=728, W=360, WMIN=270, MA=90, FE=57, DE=5, RA=3, DET=15, PA=1, RD=1, NF=18,
               B_EPOCH=144, B_FEE=60, B_SAFETY=21, B_FUND=10, B_BOB=60, MARGIN=18, N_NOID=1, N_ETH=1, N_EVICT=1)
    return p


# ----------------------------------------------------------------------------------------------
# Experiments
# ----------------------------------------------------------------------------------------------
STOP_ON = {"A": ("S1", "S4"), "B": ("S2",), "L": ("L1",), "LD": ("L2",)}
CFG_CHECKS = {"A": ("S1", "S3", "S4"), "B": ("S2", "S3"), "L": ("L1", "S1", "S2", "S3"), "LD": ("L2", "S1", "S2", "S3")}


def verdict(r, inv):
    if r.counts[inv]:
        return f"FAIL@{r.first[inv][0]}"
    if r.truncated:
        return "?"
    if r.stopped:
        return "-"          # the search stopped at the first violation of another invariant
    return "ok"


def show(r, title=None):
    p = r.params
    head = title or f"{p.name} / config {r.cfg} / {r.gates.label()}"
    print(f"- {head}: {r.states:,} states, {r.transitions:,} transitions, depth {r.depth}, {r.seconds:.1f} s"
          + ("  (TRUNCATED)" if r.truncated else "") + ("  (stopped at the first violation)" if r.stopped else ""))
    for inv in CFG_CHECKS[r.cfg]:
        print(f"    {inv}: {verdict(r, inv)}" + (f"   [{r.counts[inv]:,} violating states]" if r.counts[inv] else ""))


def print_trace(r, inv, note=None):
    d, nid, desc = r.first[inv]
    print(f"\n  Shortest trace for {inv} ({d} ticks) [{desc}]" + (f" -- {note}" if note else ""))
    for line in r.traces[inv]:
        print(line)


def outcome_table(r):
    rows = {}
    for (n, e, xp, ad, bd), c in r.outcomes.items():
        label = {("B", "A"): "swap completes", ("A", "B"): "both refunded",
                 ("B", "B"): "Bob keeps both", ("A", "A"): "Alice keeps both"}.get((n, e), f"NOID {n}, ETH {e}")
        rows.setdefault((label, bool(xp), bool(ad), bool(bd)), 0)
        rows[(label, bool(xp), bool(ad), bool(bd))] += c
    return rows


def cmd_relations():
    for p in (toy(), scaled(), scaled6(), production()):
        print(f"\n{p.name}: D={p.D} W={p.W} Wmin={p.WMIN} MA={p.MA} FE={p.FE} DE={p.DE} RA={p.RA} DET={p.DET} PA={p.PA} "
              f"RD={p.RD} NF={p.NF} B_epoch={p.B_EPOCH} B_fee={p.B_FEE} B_safety={p.B_SAFETY} B_fund={p.B_FUND} "
              f"B_bob={p.B_BOB} margin={p.MARGIN}; B_post={p.B_POST}, RHS(I1)(W_A)={p.rhs(p.W)}, stall budget={p.stall}")
        for name, ok, det in design_relations(p):
            print(f"  [{'ok' if ok else 'NO'}] {name}: {det}")


def cmd_demo(p):
    g = Gates()
    print("\nWitnesses that the gates leave room for a completed swap (non-vacuity):")
    for cfg in ("A", "B", "L"):
        r = run(p, g, cfg, edges=False, keep=True)
        ok = [(k, i) for k, i in r.terminals.items() if k[1] == 1 and k[2] == 0 and not k[4] and not k[5]]
        print(f"- config {cfg}: completed swap reachable: {bool(ok)} ({r.states:,} states)")
        if ok and cfg == "L":
            # shortest completed run
            k, i = min(ok, key=lambda ki: depth_of(r, ki[1]))
            print(f"  shortest completed run, {depth_of(r, i)} ticks:")
            for line in trace(r, i):
                print(line)


def cmd_base(p):
    g = Gates()
    print(f"\n=== {p.name}: all gates on ===")
    rows = {}
    for cfg in ("A", "B", "L", "LD"):
        r = run(p, g, cfg, edges=True)
        rows[cfg] = r
        show(r)
        if r.counts["S3"] == 0 and not r.truncated:
            print(f"    S3 (every open state can still settle; no stuck outcome): ok  (cannot_settle={getattr(r, 'cannot_settle', '?')})")
        for k, v in sorted(outcome_table(r).items()):
            print(f"      outcome {k[0]:<18s} secret_public={k[1]!s:<5} alice_crashed={k[2]!s:<5} bob_crashed={k[3]!s:<5}  x{v}")
        for inv in CFG_CHECKS[cfg]:
            if r.counts[inv]:
                print_trace(r, inv)
    return rows


def matrix(rows, title):
    """rows: list of (label, {(cfg): result}).  Prints a markdown invariant x gate table."""
    print(f"\n{title}")
    print("| gate switched off | S1 | S2 | S3 | S4 | L1 | L2 |")
    print("|---|---|---|---|---|---|---|")
    where = {"S1": ("A", "L", "LD"), "S2": ("B", "L", "LD"), "S3": ("A", "B", "L", "LD"), "S4": ("A",), "L1": ("L",), "L2": ("LD",)}
    for label, res in rows:
        cells = []
        for inv in ("S1", "S2", "S3", "S4", "L1", "L2"):
            best = None
            seen = False
            for cfg in where[inv]:
                r = res.get(cfg)
                if r is None:
                    continue
                v = verdict(r, inv)
                if v.startswith("FAIL"):
                    n = int(v[5:])
                    best = n if best is None else min(best, n)
                elif v in ("ok", "?") :
                    seen = True
            cells.append(f"FAIL @ {best} ticks" if best is not None else ("holds" if seen else "-"))
        print(f"| {label} | " + " | ".join(cells) + " |")


def cmd_ablate(p, base_res=None):
    base = Gates()
    print(f"\n=== {p.name}: one gate off at a time ===")
    rows = []
    early = p.name != "toy"
    for gate in (None, "I1", "I2c", "I2f", "I3", "FF"):
        g = base if gate is None else base.off(gate)
        res = {}
        for cfg in ("A", "B", "L", "LD"):
            if gate is None and base_res is not None:
                r = base_res[cfg]
            elif gate is None:
                r = run(p, g, cfg, edges=(cfg in ("LD", "L")))
            else:
                r = run(p, g, cfg, edges=(cfg == "LD"), stop_when=STOP_ON[cfg] if early else None)
            if gate is not None:
                show(r)
            res[cfg] = r
            for inv in CFG_CHECKS[cfg]:
                if gate is not None and r.counts[inv] and inv != "S3":
                    print_trace(r, inv)
        rows.append(("none (baseline)" if gate is None else {"I1": "(I1) Bob's claim can be final before D", "I2c": "(I2) reveal cutoff T_reveal - M_A",
                                                             "I2f": "(I2) Bob's lock final before reveal", "I3": "(I3) window >= W_A_min",
                                                             "FF": "Bob locks only on final funding"}[gate], res))
    matrix(rows, f"Invariant x gate ({p.name} parameters; '-' = not applicable / search stopped before it was decided)")
    return rows


def sweep_cases(p):
    need_ma = p.FE + 2 * p.DE + p.RA
    return [
        ("stall budget unlimited (open question Q1: a min-fee close that is never mined)", dict(STALL=-1), ("B",)),
        ("stall budget = 0", dict(STALL=0), ("B",)),
        ("stall budget + 1 (B_epoch + B_fee + 1 blocks)", dict(STALL=p.B_EPOCH + p.B_FEE + 1), ("B",)),
        ("NOID reorgs of the close: 2 (design budgets one)", dict(N_NOID=2), ("B",)),
        ("NOID reorgs: 0", dict(N_NOID=0), ("B",)),
        ("mempool evictions: 2 (design budgets one extra proof)", dict(N_EVICT=2), ("B",)),
        ("B_safety - 1 (gates budget one block less)", dict(B_SAFETY=p.B_SAFETY - 1), ("B",)),
        ("B_safety = 0", dict(B_SAFETY=0), ("B",)),
        ("NOID blocks faster than tau_fast (one burst block)", dict(BURST=1), ("B",)),
        ("slow chain (2 skipped blocks)", dict(LAG=2), ("B", "L")),
        ("Ethereum reorgs: 2 (design assumes finality bounds the damage)", dict(N_ETH=2), ("A",)),
        (f"M_A at the model bound ({need_ma})", dict(MA=need_ma), ("A",)),
        (f"M_A at the model bound - 1 ({need_ma - 1})", dict(MA=need_ma - 1), ("A",)),
        ("Ethereum inclusion delay + 1", dict(DE=p.DE + 1), ("A",)),
        ("Alice's reaction bound + 1", dict(RA=p.RA + 1), ("A",)),
        ("Ethereum finality + 1 tick in the world, gates unchanged", dict(FE_ENV=p.FE + 1), ("A",)),
        (f"Ethereum finality + {p.MA - need_ma + 1} ticks in the world (one more than the M_A slack), gates unchanged",
         dict(FE_ENV=p.FE + p.MA - need_ma + 1), ("A",)),
        ("no NOID reorg and B_safety = 0 (what is B_safety for?)", dict(N_NOID=0, B_SAFETY=0), ("B",)),
        (f"offered window W_A = DE+FE+RA+M_A ({p.DE + p.FE + p.RA + p.MA}), W_A_min lowered to match", dict(W=p.DE + p.FE + p.RA + p.MA, WMIN=p.DE + p.FE + p.RA + p.MA), ("L",)),
        (f"offered window W_A = DE+FE+RA+M_A - 1 ({p.DE + p.FE + p.RA + p.MA - 1}), W_A_min lowered to match", dict(W=p.DE + p.FE + p.RA + p.MA - 1, WMIN=p.DE + p.FE + p.RA + p.MA - 1), ("L",)),
        ("max_fee below the fee floor (hard safety rule 5)", dict(FEE_OK=False), ("B", "L")),
        ("Delta_detect + 1 in the world, gates unchanged", dict(DET_ENV=p.DET + 1), ("B",)),
        ("P_auth + 1 tick in the world, gates unchanged", dict(PA_ENV=p.PA + 1), ("B",)),
        ("re-detection RD + 1 (world)", dict(RD=p.RD + 1), ("B",)),
    ]


def cmd_sweep(p):
    g = Gates()
    print(f"\n=== {p.name}: assumption and slack sweeps (all gates on) ===")
    print("| case | config | result | states | seconds |")
    print("|---|---|---|---|---|")
    traces = []
    for name, ch, cfgs in sweep_cases(p):
        q = replace(p, **ch)
        for cfg in cfgs:
            r = run(q, g, cfg, edges=False, stop_when=STOP_ON[cfg] if p.name != "toy" else None)
            checks = [i for i in CFG_CHECKS[cfg] if i != "S3"] + ["S3"]
            res = ", ".join(f"{i}={verdict(r, i)}" for i in checks if i in ("S1", "S2", "S3", "S4", "L1"))
            print(f"| {name} | {cfg} | {res} | {r.states:,} | {r.seconds:.1f} |")
            for inv in ("S1", "S2", "S4", "L1"):
                if r.counts[inv]:
                    traces.append((name, cfg, r, inv))
                    break
    for name, cfg, r, inv in traces:
        print(f"\n>>> {name} [config {cfg}]")
        print_trace(r, inv)


def cmd_witness(p):
    """Shortest runs that end in the two excused losses: 'reveal then die' (config A) and F9 (config B)."""
    g = Gates()
    print(f"\n=== {p.name}: the two named losses (excused by S1 / S2) ===")
    r = run(p, g, "A", crash=True, keep=True)
    ks = [(events_of(r, i), i) for k, i in r.terminals.items() if k[1] == 1 and k[2] == 1 and k[3] and k[4]]
    if ks:
        d, i = min(ks)
        print(f"\nReveal then die: Bob ends with the NOID and the ETH after Alice revealed and crashed ({d} ticks):")
        for line in trace(r, i):
            print(line)
    r = run(p, g, "B", crash=True, keep=True)
    ks = [(events_of(r, i), i) for k, i in r.terminals.items() if k[1] == 0 and k[2] == 0 and k[5]]
    if ks:
        d, i = min(ks)
        print(f"\nF9: Alice ends with the ETH and the NOID after Bob crashed ({d} ticks):")
        for line in trace(r, i):
            print(line)


def cmd_all():
    cmd_relations()
    for name, p in (("toy", toy()), ("scaled", scaled())):
        cmd_demo(p)
        cmd_witness(p)
        b = cmd_base(p)
        cmd_ablate(p, b)
        cmd_sweep(p)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "demo"
    which = argv[2] if len(argv) > 2 else "toy"
    p = {"toy": toy, "scaled": scaled, "scaled6": scaled6}.get(which, toy)()
    if cmd == "relations":
        cmd_relations()
    elif cmd == "demo":
        cmd_demo(p)
    elif cmd == "base":
        cmd_base(p)
    elif cmd == "ablate":
        cmd_ablate(p)
    elif cmd == "sweep":
        cmd_sweep(p)
    elif cmd == "witness":
        cmd_witness(p)
    elif cmd == "all":
        cmd_all()
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
