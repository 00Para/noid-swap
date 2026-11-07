//! Small support types for `tests/chaos.rs`: a seeded PRNG (no external crate: the build is `--offline`), the failure
//! type and the event log. Included from `chaos.rs` with `#[path]`; it is not a test target of its own.

#![allow(dead_code)]

/// splitmix64: tiny, fast, and fully determined by its seed, which is all a replayable chaos run needs.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n > 0`).
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0);
        self.next_u64() % n
    }

    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        assert!(lo <= hi);
        lo + self.below(hi - lo + 1)
    }

    /// True with probability `per_mille / 1000`.
    pub fn chance(&mut self, per_mille: u64) -> bool {
        self.below(1000) < per_mille
    }

    pub fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }

    /// Log-uniform in `lo..=hi`: many short values, a tail of long ones.
    pub fn log_uniform(&mut self, lo: u64, hi: u64) -> u64 {
        let (a, b) = ((lo.max(1)) as f64, hi.max(lo.max(1)) as f64);
        let u = (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        let v = (a.ln() + u * (b.ln() - a.ln())).exp();
        (v as u64).clamp(lo, hi)
    }

    pub fn bytes32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        out
    }
}

/// One violated invariant: a stable id (what the test and CHAOS.md key on) and the details.
#[derive(Clone, Debug)]
pub struct Failure {
    pub id: &'static str,
    pub msg: String,
}

pub fn fail<T>(id: &'static str, msg: impl Into<String>) -> Result<T, Failure> {
    Err(Failure { id, msg: msg.into() })
}
