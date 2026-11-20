#!/usr/bin/env python3
"""T21 model: a concentrated miner against Bob's NOID claim (docs/protocol-design.md threat T21,
report in docs/miner-concentration.md).

Needs numpy for the full grid (the unit tests also run a pure-Python reference that does not).

The game, in plain words.  Alice reveals the secret on Ethereum.  Bob's NOID claim must be mined on
Parano1d before height D and must then become final (18 blocks on top of it, 19 blocks counting the
claim block).  If it is not final in time, Alice's refund opens at D and she keeps both legs.  Alice
holds a share q of the hashrate.  She can mine a private fork; whenever her fork is strictly longer
than the public chain (and branches off at most 18 public blocks below the tip) she may publish it,
the public chain is replaced, and Bob's claim, if it was in the replaced blocks, is dropped from the
chain.  The chain does not put it back in the mempool: Bob's tool must notice and re-send it, which
takes rho block events.  Honest miners include the claim in the first block they mine after it is
broadcast and before the last valid height D-1.  She wins if the claim is not in the public chain
when the public tip reaches D-1.  She may try again and again; this file computes her best play
(the exact optimum by backward induction on the blocks left, r = D - public tip), a simple play
(publish the moment you are strictly ahead), and a Monte Carlo check of the optimal play.
Time is counted in block events (each event is hers with probability q, honest with 1 - q); all
difficulty is equal on the branches (the work race with the real ASERT rule is checked separately,
see `python t21_race.py asert`).  Ties: two blocks on one parent have equal work and the smaller hash
wins, and she sees both hashes first, so a tie costs her nothing when it would lose.  Three rules:
strict (never publish a tie: a lower bound), free (a published tie wins with probability 1/2), always
(every published tie wins: an upper bound).

    python t21_race.py grid            # the full grid -> t21_results.csv and t21_results.md
    python t21_race.py quick           # tiny smoke run
    python t21_race.py single          # single-attempt table
    python t21_race.py asert           # work race with ASERT (Monte Carlo)
Parameters: F finality depth (18: final at 19 blocks), A_MAX private-lead cap, rho re-broadcast
delay in block events, n_delay blocks before Bob's first broadcast, q hashrate share.
"""
import sys
import math
import time
import random
from functools import lru_cache

try:
    import numpy as np
except ImportError:  # the pure-Python reference below does not need it
    np = None

ALWAYS_MIN_D = 1     # 'always' tie rule: a tie of d >= ALWAYS_MIN_D blocks always wins

# Status encoding of the claim, shared by the reference and the numpy code
#   m >= 0 : DROP(m) (not yet broadcast, m block events to go);  0 is PEND (broadcast, not in the chain)
#   -k     : IN(k), k blocks deep counting the claim block (k = F + 1 is final)


# ----------------------------------------------------------------------------------------------
# Pure-Python reference: expectimax over event sequences with the same rules (for the tests)
# ----------------------------------------------------------------------------------------------
def ref_value(q, r, st, a, d, n, F, A_MAX, rho, upper, memo=True, ties='strict', tie_form='A'):
    """Best attacker value from state (r, st, a, d) with at most n further block events.
    Undecided after n events counts as 0 (upper=False, a lower bound) or 1 (upper=True).
    ties: 'strict' (never publish an equal-length chain), 'free' (at a = d >= 1 a tie is published and
    wins with probability 1/2, costs nothing when it would lose: she sees both hashes first),
    'always' (as 'free' for d = 1; for d >= 2 the tie always wins).  tie_form 'A': the coin is seen
    before choosing (1/2 max(X, T) + 1/2 X); 'B': chosen before (max(X, 1/2 T + 1/2 continue))."""
    p = 1.0 - q
    cache = {}

    def att(s):
        return s - 1 if s > 0 else s

    def event_value(r, st, a, d, n):
        """continue option: take one block event (n >= 1)"""
        # attacker block
        v = q * val(r, att(st), min(a + 1, A_MAX), d, n - 1)
        if p > 0:
            if st < 0:
                k = -st
                if k + 1 == F + 1 or d + 1 == F + 1:
                    h = 0.0
                else:
                    h = val(r - 1, -(k + 1), a, d + 1, n - 1)
            else:
                ns = -1 if st == 0 else st - 1   # PEND: honest block includes the claim (r >= 2 here)
                if d + 1 == F + 1:
                    if ns < 0:
                        h = 0.0
                    else:
                        h = val(r - 1, ns, 0, 0, n - 1)
                else:
                    h = val(r - 1, ns, a, d + 1, n - 1)
            v += p * h
        return v

    def val(r, st, a, d, n):
        if st >= 0 and r <= 1:
            return 1.0
        if n == 0:
            return 1.0 if upper else 0.0
        key = (r, st, a, d, n)
        if memo and key in cache:
            return cache[key]
        cont = best = event_value(r, st, a, d, n)
        if st >= 0 and (a, d) != (0, 0):
            best = max(best, event_value(r, st, 0, 0, n))
        for m in range(d + 1, a + 1):
            j = m - d
            nr = r - j
            ns = st if st >= 0 else rho
            if nr <= 1:
                best = 1.0
                break
            best = max(best, val(nr, ns, a - m, 0, n))
        if ties != 'strict' and d >= 1 and a == d and best < 1.0:
            T = val(r, st if st >= 0 else rho, 0, 0, n)
            if ties == 'always' and d >= ALWAYS_MIN_D:
                best = max(best, T)
            elif tie_form == 'A':
                best = 0.5 * max(best, T) + 0.5 * best
            else:
                best = max(best, 0.5 * T + 0.5 * cont)
        if memo:
            cache[key] = best
        return best

    return val(r, st, a, d, n)


def ref_bracket(q, S, F, A_MAX, rho, n_delay, n_events, a0=0, ties='strict', tie_form='A'):
    """(lower, upper) bound of the optimal value at the start state of the table."""
    lo = ref_value(q, S, n_delay, a0, 0, n_events, F, A_MAX, rho, False, True, ties, tie_form)
    hi = ref_value(q, S, n_delay, a0, 0, n_events, F, A_MAX, rho, True, True, ties, tie_form)
    return lo, hi


# ----------------------------------------------------------------------------------------------
# Exact DP, vectorised over q, status and depth (numpy)
# ----------------------------------------------------------------------------------------------
class Layout:
    """Index layout of the claim statuses: 0 = PEND, 1..M = DROP(m), M+1..M+F = IN(k)."""

    def __init__(self, F, rho, n_delay):
        self.F = F
        self.M = max(rho, n_delay, 1)
        self.nn = self.M + 1                 # number of non-IN statuses
        self.ns = self.nn + F
        M = self.M
        self.sa = np.arange(self.ns)         # status after an attacker block
        self.sa[1:self.nn] = np.arange(0, M)
        self.hs = np.zeros(self.ns, dtype=np.int64)     # status after an honest block (-1: Bob wins)
        self.hs[0] = self.nn                 # PEND -> IN(1)
        self.hs[1:self.nn] = np.arange(0, M)
        for k in range(1, F + 1):
            self.hs[self.nn + k - 1] = self.nn + k if k < F else -1
        self.rho = rho
        # status whose Q row applies when she publishes: non-IN keep their own, IN -> DROP(rho)
        self.qrow = np.concatenate([np.arange(self.nn), np.full(F, rho)])
        self.is_in = np.arange(self.ns) >= self.nn

    def idx_in(self, k):
        return self.nn + k - 1


class DP:
    """Results of solve(): V at the reveal state for every r, optional policy."""
    pass


def solve(qs, S_max, F=18, A_MAX=80, rho=2, n_delay=11, store_rev=False, want_actions=False,
          r_min=None, progress=None, ties='strict', tie_form='A'):
    """Backward induction in r = D - public tip.  qs: list of hashrate shares.
    Returns an object with
      .r_min, .rev_d0[iq, r - r_min, a]    = V(r, DROP(n_delay), a, d = 0)
      .rev_all[iq, r - r_min, d, a]        (only if store_rev)
      .act[r - r_min] int8 (ns, nd, na)    (only if want_actions, one q)
    """
    if np is None:
        raise RuntimeError("numpy is required for the vectorised DP")
    qs = np.asarray(qs, dtype=float)
    nq = len(qs)
    L = Layout(F, rho, n_delay)
    ns, nn, nd, na = L.ns, L.nn, F + 1, A_MAX + 1
    if ties not in ('strict', False, None):
        assert A_MAX > F, "the tie rules need A_MAX > F"
    p = (1.0 - qs)[:, None, None, None]
    if r_min is None:
        r_min = -F
    nl = S_max - r_min + 1
    out = DP()
    out.r_min, out.F, out.A_MAX, out.rho, out.n_delay, out.qs = r_min, F, A_MAX, rho, n_delay, qs
    out.L = L
    out.rev_d0 = np.zeros((nq, nl, na))
    if store_rev:
        out.rev_all = np.zeros((nq, nl, nd, na))
        out.qrev = np.zeros((nq, nl, na))
    if want_actions:
        assert nq == 1
        out.act = np.zeros((nl, ns, nd, na), dtype=np.int8)
        out.act_tie = np.zeros((nl, ns, nd, na), dtype=bool)
        out.ties = ties if ties not in (False, None) else 'strict'
        out.tie_form = tie_form
    ev = np.arange(na)
    aa = np.arange(na)[None, :]
    dd = np.arange(nd)[:, None]
    e_mat = aa - dd                                   # (nd, na)
    e_valid = e_mat >= 1
    e_idx = np.where(e_valid, e_mat, 0)
    Vp = np.zeros((nq, ns, nd, na))
    Vp[:, :nn] = 1.0                                  # virtual layer r_min - 1 (non-IN: she has won)
    Qp = np.ones((nq, nn, na))
    Qp[:, :, 0] = 0.0
    Qj = np.zeros((nn, na), dtype=np.int64) if want_actions else None
    hs_safe = np.where(L.hs >= 0, L.hs, 0)
    row_dead = L.hs < 0
    new_in = L.hs >= nn
    d_cols = np.arange(F)
    for ri in range(nl):
        r = r_min + ri
        # --- publish table Q(r, s, e) from layer r - 1
        W = Vp[:, :nn, 0, :]
        Q = np.zeros_like(Qp)
        Q[:, :, 1:] = np.maximum(W[:, :, :-1], Qp[:, :, :-1])
        if want_actions:
            Qjn = np.zeros_like(Qj)
            Qjn[:, 1:] = np.where(W[0, :, :-1] >= Qp[0, :, :-1], 1, Qj[:, :-1] + 1)
            Qj = Qjn
        Qp = Q
        P = Q[:, L.qrow][:, :, e_idx]                 # (nq, ns, nd, na)
        P = np.where(e_valid[None, None], P, 0.0)
        # --- honest-block continuation
        G = Vp[:, hs_safe]
        H = np.empty((nq, ns, nd, na))
        H[:, :, :F, :] = G[:, :, 1:, :]
        H[:, :, F, :] = G[:, :, 0, 0][..., None]
        H[:, new_in, F, :] = 0.0
        H[:, row_dead] = 0.0
        pH = p * H
        V = np.zeros((nq, ns, nd, na))
        # --- pass 1: d = 0 (no rebase option)
        V0 = V[:, :, 0, :]
        _fill_layer(V0, qs, pH[:, :, 0, :], P[:, :, 0, :], None, L, A_MAX)
        if r <= 1:
            V[:, :nn, 0, :] = 1.0
        # --- pass 2: d >= 1 (rebase to a = 0, d = 0 allowed for non-IN)
        R = np.zeros((nq, ns))
        R[:, :nn] = V[:, :nn, 0, 0]
        V1 = V[:, :, 1:, :]
        P1 = P[:, :, 1:, :]
        tie = None
        if ties not in ('strict', False, None):
            tie = (V[:, :, 0, 0][:, L.qrow], 'always' if ties == 'always' else 'free', tie_form)
        _fill_layer(V1, qs, pH[:, :, 1:, :], P1, R, L, A_MAX, tie)
        if r <= 1:
            V[:, :nn] = 1.0
        out.rev_d0[:, ri, :] = V[:, n_delay, 0, :]
        if store_rev:
            out.rev_all[:, ri] = V[:, n_delay]
            out.qrev[:, ri] = Q[:, n_delay]
        if want_actions:
            _record_actions(out.act[ri], V, qs[0], pH, P, R, Qj, L, A_MAX, nd, out.act_tie[ri], tie)
        Vp = V
        if progress and ri % 100 == 0:
            progress(r)
    return out


def _bq(q, x):
    """q (shape (nq,)) as a multiplier broadcast against x, whose first axis is the q axis."""
    return q.reshape((len(q),) + (1,) * (x.ndim - 1))


def _fill_layer(V, qs, pH, P, R, L, A_MAX, tie=None):
    """Fill V[..., a] for a = A_MAX .. 0 (V is a view into the layer, first axis = q, second =
    status).  pH and P have the shape of V; R (shape (nq, ns), or None) is the value of a rebase."""
    sa, nn = L.sa, L.nn
    # cap row a = A_MAX: an attacker block leaves a unchanged
    X = P[..., A_MAX].copy()
    if R is not None:
        X = np.maximum(X, R.reshape(R.shape + (1,) * (X.ndim - 2)))
    c = pH[..., A_MAX]
    pm = 1.0 - _bq(qs, c)
    with np.errstate(divide="ignore", invalid="ignore"):
        fix = np.where(pm > 0, c / np.where(pm > 0, pm, 1.0), 0.0)
    cap = np.maximum(X, fix)                      # statuses that stay put on an attacker block
    for s in range(1, nn):                        # DROP(m) -> DROP(m-1): in order of m
        cap[:, s] = np.maximum(X[:, s], _bq(qs, cap[:, s]) * cap[:, s - 1] + c[:, s])
    V[..., A_MAX] = cap
    Rx = None if R is None else R.reshape(R.shape + (1,) * (V.ndim - 3))
    for a in range(A_MAX - 1, -1, -1):
        att = V[..., a + 1][:, sa]
        best = np.maximum(_bq(qs, att) * att + pH[..., a], P[..., a])
        if Rx is not None:
            best = np.maximum(best, Rx)
        if tie is not None and 1 <= a <= V.shape[2]:
            # the entry with d = a has a = d: an equal-length chain may be published (T = value of
            # the state (a = 0, d = 0) with the status after the claim is dropped, same layer)
            T, mode, form = tie
            di = a - 1
            xs = best[:, :, di]
            if mode == 'always' and a >= ALWAYS_MIN_D:
                new = np.maximum(xs, T)
            elif form == 'A':
                new = 0.5 * np.maximum(xs, T) + 0.5 * xs
            else:
                cont = _bq(qs, att) * att + pH[..., a]
                new = np.maximum(xs, 0.5 * T + 0.5 * cont[:, :, di])
            best[:, :, di] = new
        V[..., a] = best


def _record_actions(act, V, q, pH, P, R, Qj, L, A_MAX, nd, act_tie=None, tie=None):
    """Argmax actions for one layer (one q): 0 continue, 1 rebase, 1 + j publish j blocks net."""
    ns, nn, sa = L.ns, L.nn, L.sa
    na = A_MAX + 1
    nxt = np.concatenate([V[0][:, :, 1:], V[0][:, :, A_MAX:A_MAX + 1]], axis=2)   # value at a + 1 (cap)
    cont = q * nxt[sa] + pH[0]
    reb = np.zeros((ns, nd, na))
    reb[:, 1:, :] = R[0][:, None, None]
    pub = P[0]
    best = cont
    a_act = np.zeros((ns, nd, na), dtype=np.int8)
    m1 = reb > best + 1e-15
    best = np.where(m1, reb, best)
    a_act[m1] = 1
    m2 = pub > best + 1e-15
    jj = Qj[L.qrow][:, np.where(np.arange(na)[None, :] - np.arange(nd)[:, None] >= 1,
                                np.arange(na)[None, :] - np.arange(nd)[:, None], 0)]
    a_act = np.where(m2, 1 + jj, a_act).astype(np.int8)
    act[:] = a_act
    if tie is not None:
        best = np.where(m2, pub, best)
        T = tie[0][0]                                  # (ns,)
        e = np.arange(na)[None, :] - np.arange(nd)[:, None]
        at_tie = (e == 0) & (np.arange(nd)[:, None] >= 1)
        act_tie[:] = at_tie[None] & (T[:, None, None] > best + 1e-15)


# ----------------------------------------------------------------------------------------------
# Monte Carlo of the same model with the optimal policy read from the DP (numpy, vectorised runs)
# ----------------------------------------------------------------------------------------------
def wilson(k, n, z=2.5758293035489004):
    """Wilson score interval, 99 % by default."""
    if n == 0:
        return (0.0, 1.0)
    ph = k / n
    den = 1 + z * z / n
    cen = (ph + z * z / (2 * n)) / den
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return (max(0.0, cen - half), min(1.0, cen + half))


def mc_optimal(o, S, a0, runs, seed, max_steps=100000):
    """Simulate the game from (r = S, DROP(n_delay), a = a0, d = 0) with the stored optimal actions
    (o was built by solve(..., want_actions=True) for ONE q).  Returns (wins, runs)."""
    assert hasattr(o, "act")
    L, F, A = o.L, o.F, o.A_MAX
    q = float(o.qs[0])
    rng = np.random.default_rng(seed)
    nn, sa, hs = L.nn, L.sa, L.hs
    r = np.full(runs, S, dtype=np.int64)
    st = np.full(runs, o.n_delay, dtype=np.int64)
    a = np.full(runs, min(a0, A), dtype=np.int64)
    d = np.zeros(runs, dtype=np.int64)
    res = np.zeros(runs, dtype=np.int8)          # 1 attacker won, 0 undecided/Bob
    act_idx = np.arange(runs)
    steps = 0
    while act_idx.size and steps < max_steps:
        steps += 1
        # (0) an equal-length chain (free tie: fair coin seen before publishing; always: d >= 2 wins)
        if getattr(o, "ties", "strict") != "strict":
            ai = act_idx
            cand = (a[ai] == d[ai]) & (d[ai] >= 1)
            if cand.any():
                ci = ai[cand]
                better = o.act_tie[r[ci] - o.r_min, st[ci], d[ci], a[ci]]
                coin = rng.random(ci.size) < 0.5
                go = better & (coin | ((o.ties == "always") & (d[ci] >= ALWAYS_MIN_D)))
                if go.any():
                    j = ci[go]
                    st[j] = np.where(st[j] >= nn, o.rho, st[j])
                    a[j] = a[j] - d[j]
                    d[j] = 0
                    win = (st[j] < nn) & (r[j] <= 1)
                    if win.any():
                        res[j[win]] = 1
                        keep = np.ones(act_idx.size, dtype=bool)
                        keep[np.searchsorted(act_idx, j[win])] = False
                        act_idx = act_idx[keep]
                        if not act_idx.size:
                            break
        # (1) actions until every live run chooses CONTINUE
        while True:
            ac = o.act[r[act_idx] - o.r_min, st[act_idx], d[act_idx], a[act_idx]]
            nz = ac != 0
            if not nz.any():
                break
            ii = act_idx[nz]
            code = ac[nz].astype(np.int64)
            reb = code == 1
            if reb.any():
                j = ii[reb]
                a[j] = 0
                d[j] = 0
            pub = ~reb
            if pub.any():
                j = ii[pub]
                jj = code[pub] - 1                       # blocks the public tip moves up
                m = d[j] + jj
                r[j] -= jj
                st[j] = np.where(st[j] >= nn, o.rho, st[j])
                a[j] = a[j] - m
                d[j] = 0
            win = (st[ii] < nn) & (r[ii] <= 1)
            if win.any():
                res[ii[win]] = 1
                keep = np.ones(act_idx.size, dtype=bool)
                pos = np.searchsorted(act_idx, ii[win])
                keep[pos] = False
                act_idx = act_idx[keep]
        if not act_idx.size:
            break
        # (2) one block event
        i = act_idx
        att = rng.random(i.size) < q
        ia = i[att]
        ih = i[~att]
        st[ia] = sa[st[ia]]
        a[ia] = np.minimum(a[ia] + 1, A)
        ns_ = hs[st[ih]]
        dead = ns_ < 0
        r[ih] -= 1
        d[ih] += 1
        st[ih] = np.where(dead, 0, ns_)
        over = d[ih] == F + 1
        newin = ns_ >= nn
        lose = dead | (over & newin)
        reb = over & ~newin & ~dead
        a[ih[reb]] = 0
        d[ih[reb]] = 0
        # finished: Bob wins
        fin = np.zeros(runs, dtype=bool)
        fin[ih[lose]] = True
        win = (st[i] < nn) & (r[i] <= 1) & ~fin[i]
        res[i[win]] = 1
        fin[i[win]] = True
        act_idx = i[~fin[i]]
    return int(res.sum()), runs


# ----------------------------------------------------------------------------------------------
# The simple policy: publish the moment she is strictly ahead, never hold a lead
# ----------------------------------------------------------------------------------------------
def solve_simple(qs, S_max, F=18, rho=2, n_delay=11, r_min=None):
    """Markov chain value of the simple policy (publish at once when strictly ahead, re-base after
    every publish and when d reaches F).  State per layer: (status, d, z = d - a with 0 <= z <= d).
    Returns array [iq, r - r_min] = value at (r, DROP(n_delay), d = 0, z = 0) and r_min."""
    qs = np.asarray(qs, dtype=float)
    nq = len(qs)
    L = Layout(F, rho, n_delay)
    ns, nn, sa, hs = L.ns, L.nn, L.sa, L.hs
    if r_min is None:
        r_min = -F
    nl = S_max - r_min + 1
    nd = F + 1
    out = np.zeros((nq, nl))
    Wp = np.zeros((nq, ns, nd, nd))
    Wp[:, :nn] = 1.0
    p = (1.0 - qs)[:, None, None]
    hs_safe = np.where(hs >= 0, hs, 0)
    new_in = hs >= nn
    zi = np.arange(nd)
    for ri in range(nl):
        r = r_min + ri
        # honest-block continuation H[s, d, z] (value after the event)
        G = Wp[:, hs_safe]                               # (nq, ns, d, z) at layer r - 1
        H = np.zeros((nq, ns, nd, nd))
        # d + 1 <= F - 1, z + 1: ordinary move
        if F >= 2:
            H[:, :, :F - 1, :nd - 1] = G[:, :, 1:F, 1:nd]
        # d + 1 == F: non-IN statuses re-base, IN statuses stay at d = F with z + 1
        stay = G[:, :, F, 1:nd]                          # (nq, ns, z): d = F, z + 1
        reb = G[:, :, 0, 0]
        H[:, :, F - 1, :nd - 1] = np.where(new_in[None, :, None], stay, reb[:, :, None])
        # d == F: honest block makes d = F + 1: non-IN re-base, IN: Bob wins
        H[:, :, F, :] = np.where(new_in[None, :, None], 0.0, reb[:, :, None])
        H[:, hs < 0] = 0.0
        W = np.zeros((nq, ns, nd, nd))
        # z = 0: an attacker block puts her strictly ahead: publish one net block
        st1 = sa                                          # status after the attacker block
        st2 = np.where(st1 >= nn, rho, st1)
        if r - 1 <= 1:
            pub = np.ones((nq, ns))
        else:
            pub = Wp[:, st2, 0, 0]                        # (nq, ns), layer r - 1 after re-base
        W[:, :, :, 0] = qs[:, None, None] * pub[:, :, None] + p * H[:, :, :, 0]
        for z in range(1, nd):
            W[:, :, :, z] = qs[:, None, None] * W[:, :, :, z - 1][:, sa] + p * H[:, :, :, z]
        # states with z > d do not exist: their values are never read
        if r <= 1:
            W[:, :nn] = 1.0
        out[:, ri] = W[:, n_delay, 0, 0]
        Wp = W
    return out, r_min


def mc_simple_py(q, S, F, rho, n_delay, runs, seed):
    """Direct simulation of the simple policy with plain Python (independent of solve_simple)."""
    rnd = random.Random(seed)
    wins = 0
    for _ in range(runs):
        r, st, a, d = S, n_delay, 0, 0
        while True:
            if st >= 0 and r <= 1:
                wins += 1
                break
            if rnd.random() < q:
                a += 1
                if st > 0:
                    st -= 1
                if a > d:                                  # strictly ahead: publish at once
                    m = d + 1
                    r -= m - d
                    if st < 0:
                        st = rho
                    a, d = a - m, 0
                    if r <= 1:
                        wins += 1
                        break
            else:
                if st < 0:
                    if -st == F or d + 1 == F + 1:
                        break                               # final, or beyond reach
                    st -= 1
                    r -= 1
                    d += 1
                else:
                    st = -1 if st == 0 else st - 1
                    r -= 1
                    d += 1
                    if st < 0 and d >= F:
                        break                               # claim just included, fork out of reach
                    if st >= 0 and d >= F:
                        a, d = 0, 0                        # re-base when d reaches F
    return wins


# ----------------------------------------------------------------------------------------------
# Single attempt (no deadline): one claim block just mined
# ----------------------------------------------------------------------------------------------
def single_tables(q, F=18):
    """Exact tables over (d, a), 0 <= d <= F, 0 <= a <= F + 1, for a fork that branches d public
    blocks below the tip, a private blocks on it, until the honest block that would make d = F + 1.
      any_[d][a] = P(strictly ahead at some moment while d <= F)       ['any moment']
      end_[d][a] = P(strictly ahead just before that last honest block) ['at the end']
    a >= F + 1 counts as ahead for ever (the public chain can have at most F public blocks)."""
    p = 1.0 - q
    any_ = [[0.0] * (F + 2) for _ in range(F + 1)]
    end_ = [[0.0] * (F + 2) for _ in range(F + 1)]
    for d in range(F, -1, -1):
        for a in range(F + 1, -1, -1):
            if a >= F + 1:
                any_[d][a] = end_[d][a] = 1.0
                continue
            if d == F:
                # only attacker blocks can still change a before the end: she needs F + 1 - a of them first
                end_[d][a] = q ** (F + 1 - a)
                any_[d][a] = 1.0 if a > d else q ** (F + 1 - a)
                continue
            end_[d][a] = q * end_[d][a + 1] + p * end_[d + 1][a]
            any_[d][a] = 1.0 if a > d else q * any_[d][a + 1] + p * any_[d + 1][a]
    return any_, end_


def single_attempt(q, F=18, start_d=1):
    """('any moment', 'at the end') for ONE claim block just mined (start_d = 1 public block, the
    claim block) when the number of private blocks mined before it is Geometric: P(a0 = j) = q^j p."""
    p = 1.0 - q
    any_, end_ = single_tables(q, F)
    sa = se = 0.0
    for a0 in range(0, F + 1):
        w = (q ** a0) * p
        sa += w * any_[start_d][a0]
        se += w * end_[start_d][a0]
    tail = q ** (F + 1)
    return sa + tail, se + tail


def walk_max_ge1(q, n):
    """P(max over k <= n of S_k >= 1) for the walk +1 (prob q) / -1 (prob 1 - q) from 0 (exact, DP)."""
    p = 1.0 - q
    dist = {0: 1.0}
    hit = 0.0
    for _ in range(n):
        nd = {}
        for s, w in dist.items():
            if s + 1 >= 1:
                hit += w * q
            else:
                nd[s + 1] = nd.get(s + 1, 0.0) + w * q
            nd[s - 1] = nd.get(s - 1, 0.0) + w * p
        dist = nd
    return hit


def single_horizon(q, n):
    """Same quantity as walk_max_ge1, computed with the recursion style of the single-attempt code:
    P(strictly ahead at some moment within n block events) from a tie, no depth cap."""
    from functools import lru_cache

    @lru_cache(maxsize=None)
    def go(k, z):                      # k events left, z = d - a
        if z < 0:
            return 1.0
        if k == 0:
            return 0.0
        return q * go(k - 1, z - 1) + (1.0 - q) * go(k - 1, z + 1)
    return go(n, 0)


def walk_end_probs(q, n):
    """(P(S_n >= 1), P(S_n >= 2)) for the same walk, from the binomial distribution."""
    p1 = p2 = 0.0
    for k in range(n + 1):
        w = math.comb(n, k) * q ** k * (1 - q) ** (n - k)
        s = 2 * k - n
        if s >= 1:
            p1 += w
        if s >= 2:
            p2 += w
    return p1, p2


# ----------------------------------------------------------------------------------------------
# Optimal stopping before the reveal (she may wait; she must have revealed by r = S)
# ----------------------------------------------------------------------------------------------
class _One:
    """Layout of a single non-IN status (no countdown): used for the 'not yet revealed' phase."""
    sa = np.zeros(1, dtype=np.int64) if np is not None else None
    nn = 1
    ns = 1


def solve_norev(o, S, B_w):
    """Value, for every q of `o`, of the waiting game started B_w public blocks before the latest
    reveal point.  o: solve(..., store_rev=True) covering layers up to S + B_w.  Returns an array
    [iq, k] = value at (r = S + k, not revealed, a = 0, d = 0) for k = 0 .. B_w.
    Rules: before the reveal there is no claim; she may continue, re-base, publish exactly as
    afterwards, or reveal (-> the revealed game from the same (a, d)); at r = S she must reveal; a
    publish that moves the tip below S is followed by an immediate reveal."""
    qs = o.qs
    nq = len(qs)
    F, A = o.F, o.A_MAX
    nd, na = F + 1, A + 1
    r0 = o.r_min
    L = _One()
    out = np.zeros((nq, B_w + 1))
    Vp = o.rev_all[:, S - r0].reshape(nq, 1, nd, na).copy()      # forced reveal at r = S
    out[:, 0] = Vp[:, 0, 0, 0]
    Qp = o.qrev[:, S - r0].reshape(nq, 1, na).copy()
    e_mat = np.arange(na)[None, :] - np.arange(nd)[:, None]
    e_valid = e_mat >= 1
    e_idx = np.where(e_valid, e_mat, 0)
    p = (1.0 - qs)[:, None, None, None]
    for k in range(1, B_w + 1):
        r = S + k
        W = Vp[:, :, 0, :]
        Q = np.zeros_like(Qp)
        Q[:, :, 1:] = np.maximum(W[:, :, :-1], Qp[:, :, :-1])
        Qp = Q
        P = Q[:, [0]][:, :, e_idx]
        P = np.where(e_valid[None, None], P, 0.0)
        Prev = o.rev_all[:, r - r0].reshape(nq, 1, nd, na)
        H = np.empty((nq, 1, nd, na))
        H[:, :, :F, :] = Vp[:, :, 1:, :]
        H[:, :, F, :] = Vp[:, :, 0, 0][..., None]
        pH = p * H
        Pall = np.maximum(P, Prev)
        V = np.zeros((nq, 1, nd, na))
        _fill_layer(V[:, :, 0, :], qs, pH[:, :, 0, :], Pall[:, :, 0, :], None, L, A)
        R = V[:, :, 0, 0].copy()
        _fill_layer(V[:, :, 1:, :], qs, pH[:, :, 1:, :], Pall[:, :, 1:, :], R, L, A)
        Vp = V
        out[:, k] = V[:, 0, 0, 0]
    return out



# ----------------------------------------------------------------------------------------------
# The grid (what docs/miner-concentration.md reports)
# ----------------------------------------------------------------------------------------------
# n30 / n20: block events between the reveal and Bob's first broadcast at 30.3 s and at 20 s per
# block ((Delta_detect + P_auth) / block time, rounded up); guaranteed / typical: the span in
# blocks at the latest allowed reveal at the planning rate (20 s) and at 30.3 s per block
# (swap-cli/src/params.rs: RHS(I1) - (W_A - M_A) / block time).  wait: the real swap timeline in
# public blocks at the planning rate: from creation to Bob's lock-by height (D_offset - RHS) plus
# Alice's reveal window ((W_A - M_A) / 20 s); production 107 + 270, sepolia 50 + 120.
PROFILES = {
    "production": dict(n30=11, n20=16, guaranteed=361, typical=453, rhs=631, d_offset=738, w_minus_m=5400, wait=377),
    "sepolia": dict(n30=5, n20=7, guaranteed=132, typical=173, rhs=252, d_offset=302, w_minus_m=2400, wait=170),
}
QS_FINE = [0.20, 0.25, 0.30, 0.35, 0.40, 0.42, 0.44, 0.45, 0.46, 0.47, 0.48, 0.49, 0.50]
QS_HIGH = [0.53, 0.55, 0.60, 0.715, 0.859]
QS = QS_FINE + QS_HIGH
QS_ALWAYS = [0.30, 0.40, 0.45, 0.50, 0.53, 0.60]
SGRID = {
    "production": [20, 30, 41, 60, 100, 132, 150, 173, 200, 265, 300, 361, 400, 453, 500, 600, 800],
    "sepolia": [20, 30, 41, 60, 100, 132, 150, 173, 200, 265, 300, 361, 400, 453, 500, 600],
}
LEAD_CASES = [("clean", 0), ("L0_10", 10), ("L0_20", 20), ("L0_40", 40), ("L0_80", 80)]
RULES = ("strict", "free", "always")
A_MAIN = 160
SENS_S = [41, 100, 132, 200, 361, 453]
MC_RUNS = 200000
MC_SEED = 20261108


def stop_spans(prof):
    P = PROFILES[prof]
    return [100, P["guaranteed"], P["typical"]]


def _row(rows, **kw):
    base = dict(table="", profile="", n_delay="", rho="", F="", A_MAX="", ties="strict", q="", S="", case="",
                p_optimal="", p_simple="", mc="", mc_lo="", mc_hi="", mc_runs="")
    base.update(kw)
    rows.append(base)


def first_below(v, r_min, target, lo=2):
    """Smallest S (>= lo) from which the value stays below target (20 blocks on), or None."""
    top = r_min + v.shape[0]
    for S in range(lo, top):
        if v[S - r_min] < target and all(v[x - r_min] < target for x in range(S, min(S + 20, top))):
            return S
    return None


def run_main(rows, spans, log, prof, rule):
    """Main tables of one profile under one tie rule (30.3 s per block, rho 2, A_MAX 160)."""
    P = PROFILES[prof]
    n = P["n30"]
    grid = SGRID[prof]
    qs = QS_ALWAYS if rule == "always" else QS
    smax = max(grid)
    if rule != "always":
        smax = max(smax, max(stop_spans(prof)) + P["wait"])
    t0 = time.time()
    o = solve(qs, smax, A_MAX=A_MAIN, n_delay=n, ties=rule, store_rev=(rule != "always"))
    simple = rm = None
    if rule == "strict":
        simple, rm = solve_simple(qs, max(grid), n_delay=n)
    log("main %s %s: DP %.1f s" % (prof, rule, time.time() - t0))
    for iq, q in enumerate(qs):
        for tgt in (0.01, 0.001):
            spans[(prof, rule, q, tgt)] = first_below(o.rev_d0[iq, :, 0], o.r_min, tgt)
    for S in grid:
        for iq, q in enumerate(qs):
            for case, L0 in LEAD_CASES:
                _row(rows, table="main", profile=prof, n_delay=n, rho=2, F=18, A_MAX=A_MAIN, ties=rule, q=q, S=S,
                     case=case, p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, L0],
                     p_simple=("%.8f" % simple[iq, S - rm]) if (simple is not None and L0 == 0) else "")
    if rule != "always":
        for S in stop_spans(prof):
            w = solve_norev(o, S, P["wait"])[:, P["wait"]]
            for iq, q in enumerate(qs):
                _row(rows, table="main", profile=prof, n_delay=n, rho=2, F=18, A_MAX=A_MAIN, ties=rule, q=q, S=S,
                     case="wait_timeline", p_optimal="%.8f" % w[iq])
        log("stopping %s %s: %.1f s" % (prof, rule, time.time() - t0))


def run_planning(rows, log):
    """Bob's first broadcast later (20 s per block planning figure), strict tie, clean start."""
    qs = [0.40, 0.45, 0.50, 0.53, 0.60]
    for prof, P in PROFILES.items():
        o = solve(qs, P["typical"], A_MAX=A_MAIN, n_delay=P["n20"])
        for S in (P["guaranteed"], P["typical"]):
            for iq, q in enumerate(qs):
                _row(rows, table="planning20", profile=prof, n_delay=P["n20"], rho=2, F=18, A_MAX=A_MAIN, q=q, S=S,
                     case="clean", p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, 0])
    log("planning20 done")


RHOS = (0, 4, 6, 10, 20)
RHO_Q = [0.40, 0.45, 0.53]


def run_rho(rows, log):
    for prof, P in PROFILES.items():
        for rho in RHOS:
            o = solve(RHO_Q, P["typical"], A_MAX=A_MAIN, n_delay=P["n30"], rho=rho)
            for S in SENS_S:
                if S > P["typical"]:
                    continue
                for iq, q in enumerate(RHO_Q):
                    for case, L0 in (("clean", 0), ("L0_10", 10)):
                        _row(rows, table="rho", profile=prof, n_delay=P["n30"], rho=rho, F=18, A_MAX=A_MAIN, q=q, S=S,
                             case=case, p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, L0])
        log("rho %s done" % prof)


def run_fcap(rows, log):
    n = PROFILES["production"]["n30"]
    for F in (6, 12, 36):
        o = solve([0.50, 0.53], 453, F=F, A_MAX=100, n_delay=n)
        for S in SENS_S:
            for iq, q in enumerate([0.50, 0.53]):
                _row(rows, table="Fcap", profile="production", n_delay=n, rho=2, F=F, A_MAX=100, q=q, S=S,
                     case="clean", p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, 0])
    log("F cap done")


ASENS = (40, 80, 160, 240)
ASENS_S = (361, 1000, 3000)


def run_asens(rows, log):
    n = PROFILES["production"]["n30"]
    for A in ASENS:
        t0 = time.time()
        o = solve([0.50, 0.53], 3000, A_MAX=A, n_delay=n)
        for S in ASENS_S:
            for iq, q in enumerate([0.50, 0.53]):
                _row(rows, table="Amax", profile="production", n_delay=n, rho=2, F=18, A_MAX=A, q=q, S=S,
                     case="clean", p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, 0])
        log("A_MAX %d: %.1f s" % (A, time.time() - t0))


LONG_Q = [0.40, 0.45, 0.50]
LONG_S = [500, 800, 1000, 1500, 2000, 2500]
HIGH_LONG_Q = [0.53, 0.55]
HIGH_LONG_S = [500, 1000, 2000]


def run_long(rows, spans, log):
    for prof, P in PROFILES.items():
        for rule in ("strict", "free"):
            t0 = time.time()
            o = solve(LONG_Q, max(LONG_S), A_MAX=120, n_delay=P["n30"], ties=rule)
            for iq, q in enumerate(LONG_Q):
                for tgt in (0.01, 0.001):
                    spans[(prof, rule, q, tgt)] = first_below(o.rev_d0[iq, :, 0], o.r_min, tgt)
                for S in LONG_S:
                    _row(rows, table="long", profile=prof, n_delay=P["n30"], rho=2, F=18, A_MAX=120, ties=rule, q=q,
                         S=S, case="clean", p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, 0])
            log("long %s %s: %.1f s" % (prof, rule, time.time() - t0))
        o = solve(HIGH_LONG_Q, max(HIGH_LONG_S), A_MAX=A_MAIN, n_delay=P["n30"])
        for iq, q in enumerate(HIGH_LONG_Q):
            for S in HIGH_LONG_S:
                _row(rows, table="long", profile=prof, n_delay=P["n30"], rho=2, F=18, A_MAX=A_MAIN, ties="strict", q=q,
                     S=S, case="clean", p_optimal="%.8f" % o.rev_d0[iq, S - o.r_min, 0])
        log("long high %s done" % prof)


# (profile, q, S, tie rule, lead)
MC_POINTS = [("production", 0.53, 361, "strict", 0), ("production", 0.53, 361, "strict", 20),
             ("production", 0.45, 361, "free", 0), ("production", 0.50, 361, "free", 0),
             ("sepolia", 0.45, 132, "free", 0), ("sepolia", 0.50, 132, "free", 0)]


def run_mc(rows, log):
    for prof, q, S, rule, L0 in MC_POINTS:
        n = PROFILES[prof]["n30"]
        o = solve([q], S, A_MAX=A_MAIN, n_delay=n, ties=rule, want_actions=True)
        k, runs = mc_optimal(o, S, L0, MC_RUNS, MC_SEED)
        lo, hi = wilson(k, runs)
        dp = o.rev_d0[0, S - o.r_min, L0]
        _row(rows, table="mc", profile=prof, n_delay=n, rho=2, F=18, A_MAX=A_MAIN, ties=rule, q=q, S=S,
             case="clean" if L0 == 0 else "L0_%d" % L0, p_optimal="%.8f" % dp, mc="%.8f" % (k / runs),
             mc_lo="%.8f" % lo, mc_hi="%.8f" % hi, mc_runs=runs)
        log("mc %s %s q=%.3f S=%d L0=%d: dp %.5f mc %.5f [%.5f, %.5f]%s" % (
            prof, rule, q, S, L0, dp, k / runs, lo, hi, "" if lo <= dp <= hi else "  OUTSIDE"))


# ----------------------------------------------------------------------------------------------
# Robustness: work race with ASERT, one attempt, continuous time (Monte Carlo)
# ----------------------------------------------------------------------------------------------
def asert_single(q, runs, seed, F=18, tau=30.0, halflife=None, feedback=True, chunk=200000):
    """P(attacker branch has strictly more cumulative work at some moment while the public branch
    has between 1 and F blocks) for one attempt starting at the fork point, with ASERT difficulty on
    each branch separately (timestamps = real mining times).  halflife defaults to 6 * tau.
    feedback=False freezes the difficulty (the block-count race).  Returns (wins, runs)."""
    if halflife is None:
        halflife = 6.0 * tau
    rng = np.random.default_rng(seed)
    total = 0
    done_runs = 0
    while done_runs < runs:
        n = min(chunk, runs - done_runs)
        done_runs += n
        nA = np.zeros(n, dtype=np.int64)
        nB = np.zeros(n, dtype=np.int64)
        WA = np.zeros(n)
        WB = np.zeros(n)
        tA = np.zeros(n)
        tB = np.zeros(n)
        nxA = rng.exponential(tau / q, n)
        nxB = rng.exponential(tau / (1 - q), n)
        alive = np.ones(n, dtype=bool)
        win = np.zeros(n, dtype=bool)
        for _ in range(100000):
            idx = np.nonzero(alive)[0]
            if idx.size == 0:
                break
            a_first = nxA[idx] < nxB[idx]
            ia, ib = idx[a_first], idx[~a_first]
            if ia.size:
                devA = (tA[ia] - nA[ia] * tau) if feedback else np.zeros(ia.size)
                WA[ia] += 2.0 ** (-devA / halflife)
                tA[ia] = nxA[ia]
                nA[ia] += 1
                dv = (tA[ia] - nA[ia] * tau) if feedback else np.zeros(ia.size)
                rate = q * 2.0 ** (dv / halflife) / tau
                nxA[ia] = tA[ia] + rng.exponential(1.0, ia.size) / rate
            if ib.size:
                devB = (tB[ib] - nB[ib] * tau) if feedback else np.zeros(ib.size)
                WB[ib] += 2.0 ** (-devB / halflife)
                tB[ib] = nxB[ib]
                nB[ib] += 1
                dv = (tB[ib] - nB[ib] * tau) if feedback else np.zeros(ib.size)
                rate = (1 - q) * 2.0 ** (dv / halflife) / tau
                nxB[ib] = tB[ib] + rng.exponential(1.0, ib.size) / rate
            ahead = alive & (nB >= 1) & (nB <= F) & (WA > WB * (1 + 1e-12))
            win |= ahead
            alive &= ~ahead
            alive &= nB < F + 1
        total += int(win.sum())
    return total, runs




def peak_memory_mb():
    """Peak resident memory of this process in MB (best effort; None when unknown)."""
    try:
        import resource
        v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return v / 1e6 if sys.platform == "darwin" else v / 1e3
    except Exception:
        pass
    try:
        import ctypes
        from ctypes import wintypes as wt

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32, ps = ctypes.windll.kernel32, ctypes.windll.psapi
        k32.GetCurrentProcess.restype = wt.HANDLE
        ps.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(PMC), wt.DWORD]
        ps.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        return pmc.PeakWorkingSetSize / 1e6
    except Exception:
        return None


def cmd_asert(runs=400000, log=print):
    out = []
    for q in (0.3, 0.4, 0.5, 0.53, 0.6):
        k0, n = asert_single(q, runs, 77, feedback=False)
        k1, n = asert_single(q, runs, 78, feedback=True)
        lo, hi = wilson(k1, n)
        sa, _ = single_attempt(q)
        out.append((q, sa, k0, k1, n, lo, hi))
        log("asert q=%.2f block-count %.4f no-feedback %.4f ASERT %.4f [%.4f, %.4f]" % (q, sa, k0 / n, k1 / n, lo, hi))
    return dict(runs=runs, rows=out)


def single_table_md():
    body = []
    for q in (0.30, 0.40, 0.45, 0.50, 0.53, 0.60, 0.715, 0.859):
        sa, se = single_attempt(q)
        any_, end_ = single_tables(q, 18)
        p = 1 - q
        inf = ((q / p) ** 2 * p + q * (q / p) * p + q * q) if q < p else 1.0
        body.append([q, pct(any_[1][0]), pct(end_[1][0]), pct(sa), pct(se), pct(inf)])
    return md_table(["q", "any moment, no earlier private block, %", "at the end, no earlier private block, %",
                     "any moment, with head start, %", "at the end, with head start, %",
                     "any moment, with head start, no depth cap, %"], body)




# ----------------------------------------------------------------------------------------------
# Output: CSV and Markdown
# ----------------------------------------------------------------------------------------------
CSV_COLS = ["table", "profile", "n_delay", "rho", "F", "A_MAX", "ties", "q", "S", "case", "p_optimal", "p_simple",
            "mc", "mc_lo", "mc_hi", "mc_runs"]


def write_csv(rows, path):
    with open(path, "w", newline="") as f:
        f.write(",".join(CSV_COLS) + "\n")
        for r in rows:
            f.write(",".join(str(r[c]) for c in CSV_COLS) + "\n")


def md_table(head, body):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    for b in body:
        out.append("| " + " | ".join(str(x) for x in b) + " |")
    return "\n".join(out)


def pct(x):
    """A probability (0..1) as a percentage string; always percent, never a bare fraction."""
    v = 100.0 * float(x)
    if v == 0:
        return "0"
    if v >= 10:
        return "%.1f" % v
    if v >= 0.1:
        return "%.2f" % v
    if v >= 0.0001:
        return "%.4f" % v
    return "<0.0001"


class Index:
    def __init__(self, rows):
        self.d = {}
        for r in rows:
            k = (r["table"], r["profile"], r["ties"], str(r["q"]), str(r["S"]), r["case"], str(r["rho"]),
                 str(r["F"]), str(r["A_MAX"]))
            self.d[k] = r

    def get(self, table, profile, ties, q, S, case, rho=2, F=18, A=None):
        for a in ([A] if A is not None else [A_MAIN, 120, 100]):
            k = (table, profile, ties, str(q), str(S), case, str(rho), str(F), str(a))
            if k in self.d:
                return self.d[k]
        raise KeyError((table, profile, ties, q, S, case, rho, F, A))

    def p(self, *a, **kw):
        return float(self.get(*a, **kw)["p_optimal"])


def largest_below(ix, prof, rule, S, case, thr):
    """Largest q of the fine grid (ascending) with P < thr, and the first q above it that fails."""
    best = None
    for q in QS_FINE:
        if ix.p("main", prof, rule, q, S, case) < thr:
            best = q
        else:
            return best, q
    return best, None


def thr_str(res):
    best, nxt = res
    if best is None:
        return "< 0.20"
    return "%.2f" % best if nxt is not None else ">= 0.50"


def build_md(rows, spans, asert, info):
    ix = Index(rows)
    L = []
    A = L.append
    A("# T21 model results (generated by `t21_race.py`)")
    A("")
    A("Generated by `%s`. Run time %s, peak memory %s, numpy %s. All numbers are percentages unless stated." % (
        info["command"], info["elapsed"], info["memory"], info["numpy"]))
    A("P(attack) is the probability, under the attacker's best play, that Bob's claim is not final when the public tip")
    A("reaches the deadline D (so that Alice keeps both legs). Model and assumptions: `docs/miner-concentration.md`, section 2.")
    A("`S` = blocks between the reveal and D; `*` marks the span at the latest allowed reveal: guaranteed (planning rate, 20 s per")
    A("block) and typical (30.3 s per block). Clean start = no private lead at the reveal; rho = 2; depth cap 18 (final at 19).")
    A("Tie rules: **strict** = a tie is never published (a lower bound); **free** = at equal length she publishes a tie that wins")
    A("with probability 1/2 and costs nothing when it loses (she sees both hashes first); **always** = every tie she publishes")
    A("wins (an upper bound). `lead L` = she starts with L private blocks (a = L, d = 0). `wait` = optimal stopping: she may")
    A("delay the reveal for the real swap timeline (production 377 public blocks, sepolia 170; derivation in the report).")
    A("Values below 0.0001 % are printed as `<0.0001`; the CSV has the full numbers.")
    A("")
    sel_q = [0.30, 0.40, 0.45, 0.50, 0.53, 0.55, 0.60, 0.715, 0.859]
    for prof, P in PROFILES.items():
        cols = [s for s in SGRID[prof] if s in (20, 41, 60, 100, 132, 173, 200, 265, 300, 361, 453, 600, 800)]
        heads = ["q"] + [("%d*" % s if s in (P["guaranteed"], P["typical"]) else str(s)) for s in cols]
        for rule in ("strict", "free"):
            body = [[q] + [pct(ix.p("main", prof, rule, q, s, "clean")) for s in cols] for q in sel_q]
            A("## 1. %s profile, clean start, %s tie (n_delay %d)" % (prof, rule, P["n30"]))
            A("")
            A(md_table(heads, body))
            A("")
    A("## 2. Cases at the guaranteed and typical spans")
    A("")
    heads = ["q", "strict clean", "free clean", "always clean", "strict lead 10", "strict lead 20", "strict lead 40",
             "strict lead 80", "free lead 10", "free lead 20", "strict wait", "free wait", "simple policy"]
    for prof, P in PROFILES.items():
        for S in (P["guaranteed"], P["typical"]):
            body = []
            for q in QS:
                g = lambda rule, case: ix.p("main", prof, rule, q, S, case)
                row = [q, pct(g("strict", "clean")), pct(g("free", "clean"))]
                row.append(pct(g("always", "clean")) if q in QS_ALWAYS else "")
                row += [pct(g("strict", "L0_10")), pct(g("strict", "L0_20")), pct(g("strict", "L0_40")),
                        pct(g("strict", "L0_80")), pct(g("free", "L0_10")), pct(g("free", "L0_20")),
                        pct(g("strict", "wait_timeline")), pct(g("free", "wait_timeline")),
                        pct(float(ix.get("main", prof, "strict", q, S, "clean")["p_simple"]))]
                body.append(row)
            A("### %s, S = %d" % (prof, S))
            A("")
            A(md_table(heads, body))
            A("")
    A("## 3. Largest share on the grid with P(attack) below 1 % and below 0.1 %")
    A("")
    A("Grid: 0.20, 0.25, 0.30, 0.35, 0.40, 0.42, 0.44, 0.45, 0.46, 0.47, 0.48, 0.49, 0.50. Each cell: the largest grid share")
    A("below the limit / the first grid share above it, which fails.")
    A("")
    body = []
    for prof, P in PROFILES.items():
        for S in (P["guaranteed"], P["typical"]):
            for rule in ("strict", "free"):
                for case, label in (("clean", "clean"), ("L0_10", "lead 10"), ("wait_timeline", "wait")):
                    r1 = largest_below(ix, prof, rule, S, case, 0.01)
                    r2 = largest_below(ix, prof, rule, S, case, 0.001)
                    body.append([prof, S, rule, label, "%s / %s" % (thr_str(r1), r1[1] or "-"),
                                 "%s / %s" % (thr_str(r2), r2[1] or "-")])
    A(md_table(["profile", "S", "tie rule", "case", "below 1 %", "below 0.1 %"], body))
    A("")
    A("## 4. Standard error of a measured share")
    A("")
    A("A share measured over N blocks has standard error sqrt(q (1 - q) / N) (blocks treated as independent draws).")
    A("")
    body = []
    for N in (720, 2880, 20160):
        row = [N]
        for q in (0.30, 0.40, 0.45, 0.50):
            se = math.sqrt(q * (1 - q) / N)
            row.append("%.2f (2 sigma %.2f)" % (100 * se, 200 * se))
        body.append(row)
    A(md_table(["N blocks", "q = 0.30", "q = 0.40", "q = 0.45", "q = 0.50"], body))
    A("")
    A("(Standard error and 2 sigma in percentage points.) Hashrate drift inside a swap is not included.")
    A("")
    A("## 5. Bob's first broadcast later (planning rate 20 s per block: n_delay 16 production, 7 sepolia), strict tie")
    A("")
    body = []
    for prof, P in PROFILES.items():
        for q in (0.40, 0.45, 0.50, 0.53, 0.60):
            S = P["guaranteed"]
            body.append([prof, q, S, pct(ix.p("main", prof, "strict", q, S, "clean")),
                         pct(ix.p("planning20", prof, "strict", q, S, "clean"))])
    A(md_table(["profile", "q", "S", "n_delay at 30.3 s, %", "n_delay at 20 s, %"], body))
    A("")
    A("## 6. Re-send delay rho (block events from a removal until the claim is back), strict tie")
    A("")
    A("rho = 2 is the base case. Bob's tool re-sends within one tick (30 s) of noticing; the rotation guard (the last 4 blocks before")
    A("each 144-block epoch boundary), a pending close by Alice, and an operator who must run the spending step by hand all make")
    A("rho larger. Larger rho favours the attacker.")
    A("")
    for case, label in (("clean", "clean start"), ("L0_10", "lead 10")):
        for prof, P in PROFILES.items():
            ss = [s for s in SENS_S if s <= P["typical"]]
            body = []
            for q in RHO_Q:
                for rho in (0, 2, 4, 6, 10, 20):
                    if rho == 2:
                        vals = [ix.p("main", prof, "strict", q, s, case) for s in ss]
                    else:
                        vals = [ix.p("rho", prof, "strict", q, s, case, rho=rho) for s in ss]
                    body.append([q, rho] + [pct(v) for v in vals])
            A("### %s, %s" % (prof, label))
            A("")
            A(md_table(["q", "rho"] + [str(s) for s in ss], body))
            A("")
    A("## 7. Depth cap F (production, clean start, strict tie; F = 18 is the chain's rule, larger F is hypothetical)")
    A("")
    body = []
    for q in (0.50, 0.53):
        for F in (6, 12, 18, 36):
            if F == 18:
                vals = [ix.p("main", "production", "strict", q, s, "clean") for s in SENS_S]
            else:
                vals = [ix.p("Fcap", "production", "strict", q, s, "clean", F=F, A=100) for s in SENS_S]
            body.append([q, F] + [pct(v) for v in vals])
    A(md_table(["q", "F"] + [str(s) for s in SENS_S], body))
    A("")
    A("## 8. Cap on the private lead A_MAX (production, strict tie, clean start)")
    A("")
    body = []
    for q in (0.50, 0.53):
        for Am in ASENS:
            body.append([q, Am] + ["%.4f" % (100 * ix.p("Amax", "production", "strict", q, s, "clean", A=Am))
                                   for s in ASENS_S])
    A(md_table(["q", "A_MAX"] + ["S = %d" % s for s in ASENS_S], body))
    A("")
    A("## 9. Long spans (clean start)")
    A("")
    for prof in PROFILES:
        for rule in ("strict", "free"):
            body = [[q] + [pct(ix.p("long", prof, rule, q, s, "clean", A=120)) for s in LONG_S] for q in LONG_Q]
            A("%s, %s tie (A_MAX 120):" % (prof, rule))
            A("")
            A(md_table(["q"] + [str(s) for s in LONG_S], body))
            A("")
        body = [[q] + [pct(ix.p("long", prof, "strict", q, s, "clean", A=A_MAIN)) for s in HIGH_LONG_S] for q in HIGH_LONG_Q]
        A("%s, strict tie, shares above one half (A_MAX %d):" % (prof, A_MAIN))
        A("")
        A(md_table(["q"] + [str(s) for s in HIGH_LONG_S], body))
        A("")
    A("### Smallest span S with P(attack) below the limit (clean start; `>N` = not reached within the computed range)")
    A("")
    body = []
    for q in sorted({k[2] for k in spans}):
        row = [q]
        for prof in PROFILES:
            for rule in ("strict", "free"):
                for tgt in (0.01, 0.001):
                    v = spans.get((prof, rule, q, tgt), "n/a")
                    row.append(">range" if v is None else str(v))
        body.append(row)
    heads = ["q"]
    for prof in PROFILES:
        for rule in ("strict", "free"):
            for tgt in ("1 %", "0.1 %"):
                heads.append("%s %s %s" % (prof[:4], rule, tgt))
    A(md_table(heads, body))
    A("")
    A("## 10. Monte Carlo of the optimal policy against the DP (%d runs per point, seed %d)" % (MC_RUNS, MC_SEED))
    A("")
    body = []
    for r in rows:
        if r["table"] == "mc":
            inside = "yes" if float(r["mc_lo"]) <= float(r["p_optimal"]) <= float(r["mc_hi"]) else "NO"
            body.append([r["profile"], r["ties"], r["q"], r["S"], r["case"], "%.4f" % (100 * float(r["p_optimal"])),
                         "%.4f" % (100 * float(r["mc"])), "[%.3f, %.3f]" % (100 * float(r["mc_lo"]), 100 * float(r["mc_hi"])),
                         inside])
    A(md_table(["profile", "tie", "q", "S", "start", "DP, %", "Monte Carlo, %", "99 % interval, %", "DP inside"], body))
    A("")
    A("## 11. Single attempt: one claim block just mined, no deadline")
    A("")
    A(single_table_md())
    A("")
    A("## 12. Work race with ASERT versus the block-count race (one attempt, any moment, depth cap 18, %d runs)" % asert["runs"])
    A("")
    body = [[q, pct(sa), pct(k0 / n), pct(k1 / n), "[%s, %s]" % (pct(lo), pct(hi))] for q, sa, k0, k1, n, lo, hi in asert["rows"]]
    A(md_table(["q", "block-count model (exact), %", "continuous time, no feedback, %", "continuous time, ASERT, %", "ASERT 99 % interval, %"], body))
    A("")
    return "\n".join(L) + "\n"


def cmd_grid(out_dir="."):
    t0 = time.time()
    rows = []
    spans = {}

    def log(s):
        print("[%6.1f s] %s" % (time.time() - t0, s), flush=True)

    for prof in PROFILES:
        for rule in RULES:
            run_main(rows, spans, log, prof, rule)
    run_planning(rows, log)
    run_rho(rows, log)
    run_fcap(rows, log)
    run_long(rows, spans, log)
    run_asens(rows, log)
    run_mc(rows, log)
    asert = cmd_asert(400000, log)
    elapsed = "%.0f s" % (time.time() - t0)
    pk = peak_memory_mb()
    info = dict(command="python t21_race.py grid", elapsed=elapsed, numpy=np.__version__,
                memory=("%.0f MB" % pk) if pk else "not measured")
    write_csv(rows, out_dir + "/t21_results.csv")
    with open(out_dir + "/t21_results.md", "w", newline="\n") as f:
        f.write(build_md(rows, spans, asert, info))
    log("written; total %s" % elapsed)


def cmd_single():
    print(single_table_md())


def cmd_quick():
    o = solve([0.5, 0.53], 60, n_delay=11)
    print("quick: strict P(attack) q=0.5/0.53 S=60:", o.rev_d0[:, 60 - o.r_min, 0])
    o = solve([0.5, 0.53], 60, n_delay=11, ties="free")
    print("quick: free tie:", o.rev_d0[:, 60 - o.r_min, 0])
    print(single_table_md())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "--help"
    if cmd in ("-h", "--help", "help"):
        print(__doc__)
    elif cmd == "grid":
        cmd_grid(sys.argv[2] if len(sys.argv) > 2 else ".")
    elif cmd == "quick":
        cmd_quick()
    elif cmd == "single":
        cmd_single()
    elif cmd == "asert":
        cmd_asert()
    else:
        print(__doc__)
        sys.exit(2)
