#!/usr/bin/env python3
"""Tests of the T21 race model (docs/formal/t21_race.py).

    python -m unittest docs/formal/t21_race_test.py        # from the repository root
    python -m unittest t21_race_test                       # from docs/formal

The enumeration and closed-form tests need only the standard library; the tests of the vectorised DP,
the Monte Carlo and the ASERT race are skipped when numpy is not installed.  Run time about two minutes.
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t21_race as t

np = t.np
needs_np = unittest.skipIf(np is None, "numpy not installed")


class Enumeration(unittest.TestCase):
    """The recursion and the rules, against exhaustive expectimax over event sequences."""

    def test_memo_equals_exhaustive(self):
        # memoised expectimax versus the same recursion without memo (every event sequence enumerated)
        for q in (0.3, 0.5, 0.7):
            for st in (0, 1, -1):
                a = t.ref_value(q, 6, st, 1, 0, 9, 2, 3, 1, False, memo=True)
                b = t.ref_value(q, 6, st, 1, 0, 9, 2, 3, 1, False, memo=False)
                self.assertAlmostEqual(a, b, places=12)

    def test_bracket_is_tight(self):
        # undecided mass after the event horizon is negligible in the tiny instances
        for q in (0.2, 0.5, 0.8):
            lo, hi = t.ref_bracket(q, 7, 2, 3, 2, 1, 60)
            self.assertLess(hi - lo, 1e-3)

    @needs_np
    def test_dp_equals_enumeration(self):
        worst = 0.0
        for F, A, rho, nd in [(2, 3, 0, 0), (2, 3, 1, 2), (3, 4, 2, 1), (2, 5, 3, 3), (3, 3, 0, 2), (1, 3, 2, 1)]:
            qs = [0.2, 0.45, 0.5, 0.55, 0.8]
            o = t.solve(qs, 9, F=F, A_MAX=A, rho=rho, n_delay=nd)
            for iq, q in enumerate(qs):
                for S in (2, 3, 5, 9):
                    for a0 in range(0, A + 1, 2):
                        lo, hi = t.ref_bracket(q, S, F, A, rho, nd, 45, a0)
                        v = o.rev_d0[iq, S - o.r_min, a0]
                        self.assertTrue(lo - 1e-9 <= v <= hi + 1e-9, (F, A, rho, nd, q, S, a0, v, lo, hi))
                        worst = max(worst, hi - lo)
        self.assertLess(worst, 1e-3)

    @needs_np
    def test_dp_equals_enumeration_tie_rules(self):
        # the new tie rules (free: wins a fair coin at no cost when it loses; always: wins), against
        # the exhaustive recursion, at the start states and at states with d > 0
        for ties in ('free', 'always'):
            for F, A, rho, nd in [(2, 4, 1, 1), (3, 5, 2, 2), (1, 3, 0, 1)]:
                qs = [0.3, 0.5, 0.6]
                o = t.solve(qs, 8, F=F, A_MAX=A, rho=rho, n_delay=nd, ties=ties, store_rev=True)
                for iq, q in enumerate(qs):
                    for S in (3, 5, 8):
                        for a0 in range(0, A + 1, 2):
                            lo, hi = t.ref_bracket(q, S, F, A, rho, nd, 40, a0, ties)
                            v = o.rev_d0[iq, S - o.r_min, a0]
                            self.assertTrue(lo - 1e-9 <= v <= hi + 1e-9, (ties, F, A, rho, nd, q, S, a0, v, lo, hi))
                for iq, q in enumerate(qs[:2]):
                    for d in range(F + 1):
                        for a in range(A + 1):
                            lo = t.ref_value(q, 6, nd, a, d, 40, F, A, rho, False, True, ties)
                            hi = t.ref_value(q, 6, nd, a, d, 40, F, A, rho, True, True, ties)
                            v = o.rev_all[iq, 6 - o.r_min, d, a]
                            self.assertTrue(lo - 1e-9 <= v <= hi + 1e-9, (ties, q, d, a, v, lo, hi))

    @needs_np
    def test_dp_equals_enumeration_other_states(self):
        # values at states with d > 0 are checked against the recursion on a tiny instance
        F, A, rho, nd = 2, 3, 1, 1
        o = t.solve([0.4, 0.6], 8, F=F, A_MAX=A, rho=rho, n_delay=nd, store_rev=True)
        for iq, q in enumerate([0.4, 0.6]):
            for S in (3, 6, 8):
                for d in range(0, F + 1):
                    for a in range(0, A + 1):
                        lo = t.ref_value(q, S, nd, a, d, 45, F, A, rho, False)
                        hi = t.ref_value(q, S, nd, a, d, 45, F, A, rho, True)
                        v = o.rev_all[iq, S - o.r_min, d, a]
                        self.assertTrue(lo - 1e-9 <= v <= hi + 1e-9, (q, S, d, a, v, lo, hi))


class Limits(unittest.TestCase):
    @needs_np
    def test_q_zero_and_one(self):
        o = t.solve([0.0, 1.0], 10, F=3, A_MAX=12, rho=2, n_delay=3)
        for S in range(2, 11):
            # with no attacker block Bob's claim is included iff S >= n_delay + 2 (n_delay = 3 here);
            # a span shorter than that is lost by the delay alone
            self.assertAlmostEqual(o.rev_d0[0, S - o.r_min, 0], 0.0 if S >= 5 else 1.0, places=12)
            self.assertAlmostEqual(o.rev_d0[1, S - o.r_min, 0], 1.0, places=12)

    def test_q_zero_and_one_reference(self):
        self.assertEqual(t.ref_value(0.0, 8, 2, 0, 0, 40, 3, 4, 2, False), 0.0)
        self.assertEqual(t.ref_value(1.0, 4, 2, 0, 0, 40, 3, 4, 2, False), 1.0)

    def test_classical_catch_up(self):
        # P(ever strictly ahead) from a deficit of z blocks is (q/p)^(z+1) for q < p, huge depth cap
        F = 400
        for q in (0.2, 0.3, 0.4):
            p = 1 - q
            any_, _ = t.single_tables(q, F)
            for z in (0, 1, 2, 3, 5):
                self.assertAlmostEqual(any_[z][0], (q / p) ** (z + 1), places=9)

    def test_reflection_identity_half(self):
        # q = 1/2: P(max_{k<=n} S_k >= 1) = P(S_n >= 1) + P(S_n >= 2), against the recursion of the
        # single-attempt code and against the forward distribution
        for n in (1, 2, 5, 10, 17, 30, 60):
            p1, p2 = t.walk_end_probs(0.5, n)
            self.assertAlmostEqual(t.single_horizon(0.5, n), p1 + p2, places=12)
            self.assertAlmostEqual(t.walk_max_ge1(0.5, n), p1 + p2, places=12)

    def test_single_attempt_order(self):
        for q in (0.3, 0.5, 0.6):
            a, e = t.single_attempt(q)
            self.assertLess(e, a)
            self.assertLessEqual(a, 1.0)
        # at q = 1/2 'at the end' is exactly one half: 19 attacker blocks before 19 honest blocks
        self.assertAlmostEqual(t.single_attempt(0.5)[1], 0.5, places=12)


class Monotone(unittest.TestCase):
    @needs_np
    def test_monotone_in_q_and_S(self):
        qs = [0.1, 0.3, 0.45, 0.5, 0.53, 0.6, 0.8]
        o = t.solve(qs, 80, F=6, A_MAX=30, rho=2, n_delay=3)
        v = o.rev_d0[:, :, 0]
        for iq in range(1, len(qs)):
            for S in range(2, 81):
                self.assertGreaterEqual(v[iq, S - o.r_min] + 1e-12, v[iq - 1, S - o.r_min])
        for iq in range(len(qs)):
            for S in range(3, 81):
                self.assertLessEqual(v[iq, S - o.r_min], v[iq, S - 1 - o.r_min] + 1e-12)

    @needs_np
    def test_monotone_in_A_rho_lead(self):
        qs = [0.4, 0.53]
        a1 = t.solve(qs, 60, F=5, A_MAX=6, rho=2, n_delay=3).rev_d0
        a2 = t.solve(qs, 60, F=5, A_MAX=12, rho=2, n_delay=3).rev_d0
        self.assertTrue((a2[:, :, 0] + 1e-12 >= a1[:, :, 0]).all())
        base = None
        for rho in (0, 1, 2, 4):
            v = t.solve(qs, 60, F=5, A_MAX=10, rho=rho, n_delay=3).rev_d0[:, :, 0]
            if base is not None:
                self.assertTrue((v + 1e-12 >= base).all(), rho)
            base = v
        o = t.solve(qs, 60, F=5, A_MAX=10, rho=2, n_delay=3)
        for a in range(1, 11):          # a bigger head start never hurts
            self.assertTrue((o.rev_d0[:, :, a] + 1e-12 >= o.rev_d0[:, :, a - 1]).all())

    @needs_np
    def test_ties_help_and_waiting_helps(self):
        qs = [0.3, 0.5]
        a = t.solve(qs, 40, F=6, A_MAX=20, n_delay=3)
        b = t.solve(qs, 40, F=6, A_MAX=20, n_delay=3, ties='free')
        c = t.solve(qs, 40, F=6, A_MAX=20, n_delay=3, ties='always')
        self.assertTrue((b.rev_d0 + 1e-12 >= a.rev_d0).all())
        self.assertTrue((c.rev_d0 + 1e-12 >= b.rev_d0).all())
        self.assertGreater(b.rev_d0[1, 30 - b.r_min, 0], a.rev_d0[1, 30 - a.r_min, 0] + 0.01)
        o = t.solve(qs, 60, F=6, A_MAX=20, n_delay=3, store_rev=True)
        w = t.solve_norev(o, 30, 25)
        base = o.rev_d0[:, 30 - o.r_min, 0]
        self.assertTrue(np.allclose(w[:, 0], base))
        for k in range(1, 26):
            # waiting k blocks is at least as good as revealing at once at that point
            self.assertTrue((w[:, k] + 1e-12 >= o.rev_d0[:, 30 + k - o.r_min, 0]).all())
        self.assertTrue((w[:, 25] + 1e-12 >= base).all())

    def test_independent_reference_values(self):
        # reference values from an independent implementation (strict / free / always), clean start, rho 2, F 18, in percent
        if np is None:
            self.skipTest("numpy not installed")
        pts = [(0.40, 132, 5, (0.038, 0.35, 2.8)), (0.45, 361, 11, (0.032, 0.29, 2.9)), (0.45, 132, 5, (2.79, 9.2, 24.8)),
               (0.50, 361, 11, (14.1, 28.5, 51.2)), (0.50, 132, 5, (30.3, 49.6, 69.9))]
        for q, S, nd, ref in pts:
            for ties, want in zip(('strict', 'free', 'always'), ref):
                o = t.solve([q], S, A_MAX=60, n_delay=nd, ties=ties)
                got = 100 * o.rev_d0[0, S - o.r_min, 0]
                self.assertAlmostEqual(got, want, delta=0.02 * want + 0.01, msg=(q, S, ties, got, want))

    def test_percent_formatter(self):
        self.assertEqual(t.pct(0), "0")
        self.assertEqual(t.pct(0.000321), "0.0321")
        self.assertTrue(t.pct(3.2e-4).startswith("0.03"))      # 3.2e-4 is 0.032 %, not 0.00032
        self.assertEqual(t.pct(0.141), "14.1")
        self.assertEqual(t.pct(1e-9), "<0.0001")

    @needs_np
    def test_simple_policy_is_weaker(self):
        qs = [0.3, 0.5, 0.6]
        o = t.solve(qs, 80, F=6, A_MAX=30, n_delay=3)
        s, rm = t.solve_simple(qs, 80, F=6, n_delay=3)
        self.assertTrue((s[:, 2 - rm:81 - rm] <= o.rev_d0[:, 2 - o.r_min:81 - o.r_min, 0] + 1e-12).all())


class MonteCarlo(unittest.TestCase):
    @needs_np
    def test_mc_inside_interval(self):
        pts = [(0.5, 25), (0.4, 20), (0.6, 30), (0.53, 40)]
        for q, S in pts:
            o = t.solve([q], S, F=18, A_MAX=40, rho=2, n_delay=11, want_actions=True)
            dp = o.rev_d0[0, S - o.r_min, 0]
            k, n = t.mc_optimal(o, S, 0, 200000, 4242)
            lo, hi = t.wilson(k, n)
            self.assertTrue(lo <= dp <= hi, (q, S, dp, k / n, lo, hi))

    @needs_np
    def test_mc_free_and_always_ties(self):
        pts = [('free', 0.45, 40), ('free', 0.50, 30), ('always', 0.40, 30)]
        for ties, q, S in pts:
            o = t.solve([q], S, F=18, A_MAX=40, rho=2, n_delay=11, ties=ties, want_actions=True)
            dp = o.rev_d0[0, S - o.r_min, 0]
            k, n = t.mc_optimal(o, S, 0, 200000, 31)
            lo, hi = t.wilson(k, n)
            self.assertTrue(lo <= dp <= hi, (ties, q, S, dp, k / n, lo, hi))

    @needs_np
    def test_mc_with_lead_and_other_rho(self):
        q, S = 0.45, 30
        o = t.solve([q], S, F=18, A_MAX=40, rho=0, n_delay=5, want_actions=True)
        for a0 in (0, 5):
            dp = o.rev_d0[0, S - o.r_min, a0]
            k, n = t.mc_optimal(o, S, a0, 200000, 99 + a0)
            lo, hi = t.wilson(k, n)
            self.assertTrue(lo <= dp <= hi, (a0, dp, k / n, lo, hi))

    @needs_np
    def test_simple_chain_against_direct_simulation(self):
        for q, S in ((0.5, 30), (0.6, 40)):
            s, rm = t.solve_simple([q], S, F=18, rho=2, n_delay=11)
            v = s[0, S - rm]
            k = t.mc_simple_py(q, S, 18, 2, 11, 60000, 17)
            lo, hi = t.wilson(k, 60000)
            self.assertTrue(lo <= v <= hi, (q, S, v, k / 60000, lo, hi))

    @needs_np
    def test_asert_without_feedback_is_block_count(self):
        for q in (0.3, 0.5):
            k, n = t.asert_single(q, 200000, 5, feedback=False)
            lo, hi = t.wilson(k, n)
            sa = t.single_attempt(q)[0]
            self.assertTrue(lo <= sa <= hi, (q, sa, k / n, lo, hi))


if __name__ == "__main__":
    unittest.main()
