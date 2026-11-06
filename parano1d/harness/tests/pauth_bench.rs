//! M0.5 / Q4: benchmark `P_auth`, the time Bob needs to build one complete claim
//! authorization for the HashTimeLock contract.
//!
//! NOT part of the default `cargo test` run: the test is `#[ignore]` and also does
//! nothing unless `PAUTH_BENCH_N` is set. Run it with
//!
//! ```text
//! PAUTH_BENCH_N=30 cargo test --release --test pauth_bench -- --ignored --nocapture
//! PAUTH_BENCH_N=10 cargo test            --test pauth_bench -- --ignored --nocapture
//! ```
//!
//! Each iteration is what a real Bob client does once per authorization: a FRESH
//! secret and a fresh opening (so no cached statement is reused), build the closing
//! page at a height of the version under test, and prove. The timer covers
//! page construction + witness preparation + proof, wall clock, end to end. The
//! proof is verified afterwards, outside the timed region, so a bench that built
//! garbage would fail loudly. Opening compilation (`pruv` compile) is done before
//! the timer starts: Bob does it once at lock time, not on the claim path.
//!
//! Variants: `raw` (witness = `s`, `A = Addr(s)`) and `stock` (witness =
//! `Derive(m, 0)`, `A = Addr(Derive(m, 0))`, the extra 3 permutations are inside
//! the timer). Versions: V3 (page at height 279,369) and V4 (279,370).
//!
//! Output is one `PAUTH ...` line per (version, variant) with min / p50 / p90 /
//! p99 / max in seconds (nearest-rank percentiles: with N = 30, p99 is the
//! maximum), and a `PAUTH_ENV ...` header with N, build profile and thread count.

use htlc_harness::*;
use noid_tx::OwnerAuthorizationVersion::{self, V3, V4};
use std::time::Instant;

/// Same shape as `auth_versions.rs`: the deadline is far after the activation so
/// that heights 279,369 (V3) and 279,370 (V4) are both in the claim branch.
const D_REAL: u64 = V2_1_ACTIVATION_HEIGHT + 500;

/// 32 fresh bytes from the OS CSPRNG. Linux only (the bench runs in WSL); a
/// deterministic fallback keeps the bench usable elsewhere (timing does not
/// depend on the secret's value, freshness only avoids reusing a statement).
fn fresh_secret(counter: u64) -> [u8; 32] {
    use std::io::Read;
    let mut b = [0u8; 32];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut b).is_ok() {
            return b;
        }
    }
    b = seq_bytes(counter as u8);
    b[..8].copy_from_slice(&counter.to_le_bytes());
    b
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    // nearest rank: ceil(p * n), 1-based
    let n = sorted.len();
    let rank = ((p * n as f64).ceil() as usize).clamp(1, n);
    sorted[rank - 1]
}

fn load_avg() -> String {
    std::fs::read_to_string("/proc/loadavg").unwrap_or_default().trim().to_string()
}

struct Stats {
    prove_total: Vec<f64>,
    prove_only: Vec<f64>,
}

/// One timed authorization. Returns (end_to_end_seconds, prove_call_seconds).
fn one_auth(version: OwnerAuthorizationVersion, stock: bool, i: u64) -> (f64, f64) {
    let c = Cast::new();
    let m = fresh_secret(i);
    // Hashlock authority and the witness Bob will use, per variant.
    let (authority, witness_bytes_fn): (_, Box<dyn Fn() -> [u8; 32]>) = if stock {
        (addr_derived(m, 0), Box::new(move || derive_bytes(m, 0)))
    } else {
        (addr(m), Box::new(move || m))
    };
    let opening = compile_htlc(authority, c.bob, c.alice, D_REAL, MAX_FEE);
    let h = match version {
        V3 => V2_1_ACTIVATION_HEIGHT - 1,
        V4 => V2_1_ACTIVATION_HEIGHT,
    };
    assert_eq!(auth_version_at(h), version);

    let t0 = Instant::now();
    let page = close_page(&opening, FEE, h).expect("close page");
    let t1 = Instant::now();
    let w = witness_bytes_fn(); // includes Derive(m,0) for the stock variant
    let bundle = prove_v(&page, &opening, h, w, version).expect("prove");
    let t2 = Instant::now();

    // Outside the timed region: the proof must really verify.
    verify_v(&page, &opening, h, &bundle, version).expect("proof verifies");
    ((t2 - t0).as_secs_f64(), (t2 - t1).as_secs_f64())
}

fn run_case(version: OwnerAuthorizationVersion, stock: bool, n: usize) -> Stats {
    let mut prove_total = Vec::with_capacity(n);
    let mut prove_only = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = one_auth(version, stock, i as u64);
        prove_total.push(a);
        prove_only.push(b);
    }
    Stats { prove_total, prove_only }
}

fn summarize(label: &str, mut v: Vec<f64>) -> String {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    format!(
        "{label} N={} min={:.3} p50={:.3} p90={:.3} p99={:.3} max={:.3} mean={:.3}",
        v.len(),
        v[0],
        percentile(&v, 0.50),
        percentile(&v, 0.90),
        percentile(&v, 0.99),
        v[v.len() - 1],
        mean
    )
}

#[test]
#[ignore = "benchmark: set PAUTH_BENCH_N and run with --ignored --nocapture (TASKS M0.5)"]
fn pauth_benchmark() {
    let n: usize = match std::env::var("PAUTH_BENCH_N").ok().and_then(|s| s.parse().ok()) {
        Some(n) if n > 0 => n,
        _ => {
            eprintln!("PAUTH_BENCH_N not set (or not a positive integer): benchmark skipped");
            return;
        }
    };
    let profile = if cfg!(debug_assertions) { "debug-assertions-on(test profile)" } else { "release(no debug-assertions)" };
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    println!(
        "PAUTH_ENV N={n} profile={profile} available_parallelism={threads} RAYON_NUM_THREADS={} load_before=\"{}\"",
        std::env::var("RAYON_NUM_THREADS").unwrap_or_else(|_| "unset".into()),
        load_avg()
    );

    // Cold start: the first proof of the process (lazy tables, page faults). Not in the stats.
    let (cold, _) = one_auth(V4, false, 9_999);
    println!("PAUTH_COLD first proof in process (raw, V4): {cold:.3} s (excluded from the statistics)");

    for (version, vname) in [(V3, "V3"), (V4, "V4")] {
        for (stock, variant) in [(false, "raw"), (true, "stock")] {
            let s = run_case(version, stock, n);
            println!("PAUTH version={vname} variant={variant} {}", summarize("end_to_end", s.prove_total));
            println!("PAUTH version={vname} variant={variant} {}", summarize("prove_call_only", s.prove_only));
        }
    }
    println!("PAUTH_ENV load_after=\"{}\"", load_avg());
}
