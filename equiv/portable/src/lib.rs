//! equiv-portable: everything the NOID<->BTC/ETH equivalence-proof guest computes,
//! with zero dependencies, `no_std`, no SIMD/clmul intrinsics, no `alloc`.
//!
//! Statement (variant RAW):   exists m: sha256(m) = H  and  Addr(m) = A
//! Statement (variant STOCK): exists m: sha256(m) = H  and  Addr(Derive(m, 0)) = A
//!
//! Definitions follow docs/parano1d-capabilities.md section 10 and the vendor code:
//!  * Poseidon2b permutation: vendor/parano1d/noid_poseidon2b/src/native/permutation.rs
//!  * ADDRFIX_ sponge:        vendor/parano1d/noid_poseidon2b/src/primitives.rs:L298-L305
//!  * Derive:                 vendor/parano1d/noid_node/src/wallet/keystore.rs:L69-L93
//!  * Domain IV:              vendor/parano1d/noid_poseidon2b/src/native/domain.rs:L27-L40
//!
//! Representation: the vendor keeps field elements as raw `u128` in the *tower*
//! basis, and runs the round function in the *flat* (GCM polynomial) basis,
//! GF(2)[x]/(x^128 + x^7 + x^2 + x + 1), bit i = coefficient of x^i. We do the
//! same: convert the 4 input lanes tower->flat, run all 66 rounds flat, convert
//! the 2 output lanes flat->tower. All round constants and MDS entries are
//! converted to the flat basis at COMPILE time (const fn), so the guest pays
//! nothing for them.
#![no_std]
#![forbid(unsafe_code)]

#[cfg(feature = "std")]
extern crate std;

mod basis_tables;
mod constants;
pub mod sha256;

use basis_tables::{FLAT_TO_TOWER, TOWER_TO_FLAT};
pub use constants::{F_ROUNDS, N_ROUNDS, P_ROUNDS, STATE_SIZE};
use constants::{MDS_FULL, MDS_PARTIAL, ROUND_CONSTANTS};

// ------------------------------------------------------------------ basis change

/// Apply a 128x128 GF(2) matrix: XOR of `m[i]` over the set bits `i` of `v`.
/// Equivalent to vendor `apply_matrix` (noid_core/src/hardware.rs:L299-L310).
const fn apply_matrix(m: &[u128; 128], v: u128) -> u128 {
    let mut res = 0u128;
    let mut i = 0;
    while i < 128 {
        if (v >> i) & 1 == 1 {
            res ^= m[i];
        }
        i += 1;
    }
    res
}

pub const fn tower_to_flat(v: u128) -> u128 {
    apply_matrix(&TOWER_TO_FLAT, v)
}

pub const fn flat_to_tower(v: u128) -> u128 {
    apply_matrix(&FLAT_TO_TOWER, v)
}

// ------------------------------------------------------------------ GF(2^128), flat basis

/// Multiplication in GF(2)[x]/(x^128 + x^7 + x^2 + x + 1) (GCM polynomial, bit i =
/// x^i). Plain shift-and-add; equals vendor `clmul_gcm` (hardware.rs:L458).
pub const fn gf_mul(a: u128, b: u128) -> u128 {
    let mut a = a;
    let mut b = b;
    let mut r = 0u128;
    while b != 0 {
        if b & 1 == 1 {
            r ^= a;
        }
        b >>= 1;
        let carry = a >> 127;
        a <<= 1;
        if carry == 1 {
            a ^= 0x87; // x^128 = x^7 + x^2 + x + 1
        }
    }
    r
}

/// Spread the 64 bits of `v` to the even bit positions of a u128 (insert a zero between bits).
const fn spread(v: u64) -> u128 {
    let mut x = v as u128;
    x = (x | (x << 32)) & 0x00000000FFFFFFFF00000000FFFFFFFF;
    x = (x | (x << 16)) & 0x0000FFFF0000FFFF0000FFFF0000FFFF;
    x = (x | (x << 8)) & 0x00FF00FF00FF00FF00FF00FF00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333333333333333333333333333;
    x = (x | (x << 1)) & 0x55555555555555555555555555555555;
    x
}

/// Squaring is GF(2)-linear: (sum a_i x^i)^2 = sum a_i x^(2i). Spread the bits into a
/// 256-bit polynomial, then reduce modulo x^128 + x^7 + x^2 + x + 1.
/// Same function as vendor `square_flat_u128` (hardware.rs:L430), written independently.
#[inline(always)]
pub const fn gf_sqr(a: u128) -> u128 {
    let lo = spread(a as u64);
    let hi = spread((a >> 64) as u64);
    // hi * x^128 = hi * (x^7 + x^2 + x + 1); bits shifted out of 128 bits re-enter at x^128 once more.
    let t = hi ^ (hi << 1) ^ (hi << 2) ^ (hi << 7);
    let o = (hi >> 127) ^ (hi >> 126) ^ (hi >> 121); // degree <= 6
    lo ^ t ^ o ^ (o << 1) ^ (o << 2) ^ (o << 7)
}

/// x^7 = (x * x^2) * x^4, as in vendor `sbox_x7_flat_u128` (permutation.rs:L158-L164).
#[inline(always)]
const fn sbox_x7(x: u128) -> u128 {
    let x2 = gf_sqr(x);
    let x4 = gf_sqr(x2);
    let x6 = gf_mul(x, x2);
    gf_mul(x6, x4)
}

// ------------------------------------------------------------------ flat-basis tables (compile time)

const fn flat_rc() -> [[u128; N_ROUNDS]; STATE_SIZE] {
    let mut t = [[0u128; N_ROUNDS]; STATE_SIZE];
    let mut i = 0;
    while i < STATE_SIZE {
        let mut r = 0;
        while r < N_ROUNDS {
            t[i][r] = tower_to_flat(ROUND_CONSTANTS[i][r]);
            r += 1;
        }
        i += 1;
    }
    t
}

const fn flat_mat(m: &[[u128; STATE_SIZE]; STATE_SIZE]) -> [[u128; STATE_SIZE]; STATE_SIZE] {
    let mut t = [[0u128; STATE_SIZE]; STATE_SIZE];
    let mut i = 0;
    while i < STATE_SIZE {
        let mut j = 0;
        while j < STATE_SIZE {
            t[i][j] = tower_to_flat(m[i][j]);
            j += 1;
        }
        i += 1;
    }
    t
}

static RC_FLAT: [[u128; N_ROUNDS]; STATE_SIZE] = flat_rc();
static MDS_FULL_FLAT: [[u128; STATE_SIZE]; STATE_SIZE] = flat_mat(&MDS_FULL);
static MDS_PARTIAL_FLAT: [[u128; STATE_SIZE]; STATE_SIZE] = flat_mat(&MDS_PARTIAL);

// ------------------------------------------------------------------ permutation

fn apply_mds(state: &mut [u128; STATE_SIZE], m: &[[u128; STATE_SIZE]; STATE_SIZE]) {
    let input = *state;
    for i in 0..STATE_SIZE {
        let mut out = 0u128;
        for j in 0..STATE_SIZE {
            // flat(1) == tower(1) == 1 (TOWER_TO_FLAT[0] == 1): multiplication by one is skipped.
            if m[i][j] == 1 {
                out ^= input[j];
            } else {
                out ^= gf_mul(input[j], m[i][j]);
            }
        }
        state[i] = out;
    }
}

/// Poseidon2b round schedule on a flat-basis state
/// (vendor `permute_flat_u128`, permutation.rs:L56-L90).
pub fn permute_flat(s: &mut [u128; STATE_SIZE]) {
    apply_mds(s, &MDS_FULL_FLAT);
    for r in 0..N_ROUNDS {
        if r < F_ROUNDS / 2 || r >= F_ROUNDS / 2 + P_ROUNDS {
            for i in 0..STATE_SIZE {
                s[i] = sbox_x7(s[i] ^ RC_FLAT[i][r]);
            }
            apply_mds(s, &MDS_FULL_FLAT);
        } else {
            s[0] = sbox_x7(s[0] ^ RC_FLAT[0][r]);
            apply_mds(s, &MDS_PARTIAL_FLAT);
        }
    }
}

/// Poseidon2b permutation on a tower-basis state (vendor `Poseidon2bPermutation::permute_mut`).
pub fn permute(state: &mut [u128; STATE_SIZE]) {
    let mut f = [0u128; STATE_SIZE];
    for i in 0..STATE_SIZE {
        f[i] = tower_to_flat(state[i]);
    }
    permute_flat(&mut f);
    for i in 0..STATE_SIZE {
        state[i] = flat_to_tower(f[i]);
    }
}

// ------------------------------------------------------------------ cost model

const fn non_one(m: &[[u128; STATE_SIZE]; STATE_SIZE]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i < STATE_SIZE {
        let mut j = 0;
        while j < STATE_SIZE {
            if m[i][j] != 1 {
                n += 1;
            }
            j += 1;
        }
        i += 1;
    }
    n
}

/// General GF(2^128) multiplications per permutation (squarings are linear and counted
/// separately): 2 per S-box (x^2*x -> x^3 ... see `sbox_x7`), plus the non-trivial MDS entries.
/// Full rounds: 1 initial MDS + F_ROUNDS MDS_FULL applications; partial rounds: P_ROUNDS MDS_PARTIAL.
pub const MULS_PER_PERMUTATION: usize = sbox_count() * 2
    + (1 + F_ROUNDS) * non_one(&MDS_FULL)
    + P_ROUNDS * non_one(&MDS_PARTIAL);
/// Squarings per permutation (2 per S-box).
pub const SQRS_PER_PERMUTATION: usize = sbox_count() * 2;
/// S-boxes per permutation: STATE_SIZE per full round, 1 per partial round.
pub const fn sbox_count() -> usize {
    F_ROUNDS * STATE_SIZE + P_ROUNDS
}
/// Permutations: RAW = 1 (Addr), STOCK = 3 (Derive) + 1 (Addr).
pub const PERMUTATIONS_RAW: usize = 1;
pub const PERMUTATIONS_STOCK: usize = 4;

// ------------------------------------------------------------------ sponge users

/// `u64::from_be_bytes(b"ADDRFIX_")` (domain.rs:L27-L32, L56).
pub const ADDRFIX_LABEL: u64 = u64::from_be_bytes(*b"ADDRFIX_");
/// "noid-deri" as a big-endian integer (keystore.rs:L84).
pub const DERIVE_TAG: u128 = 0x6E6F69642D64657269;

#[inline]
fn limbs(b: &[u8; 32]) -> (u128, u128) {
    let mut lo = [0u8; 16];
    let mut hi = [0u8; 16];
    lo.copy_from_slice(&b[..16]);
    hi.copy_from_slice(&b[16..]);
    (u128::from_le_bytes(lo), u128::from_le_bytes(hi))
}

#[inline]
fn unlimbs(lo: u128, hi: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&lo.to_le_bytes());
    out[16..].copy_from_slice(&hi.to_le_bytes());
    out
}

/// `Addr(s)`: one permutation of `[s_lo, s_hi, L<<64, L]`, output lanes 0 and 1
/// (primitives.rs:L298-L305; the sponge starts with rate lanes zero, absorb = XOR).
pub fn addr(s: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = limbs(s);
    let l = ADDRFIX_LABEL as u128;
    let mut st = [lo, hi, l << 64, l];
    permute(&mut st);
    unlimbs(st[0], st[1])
}

/// `Derive(m, index)`: spend secret `i` of master secret `m`
/// (keystore.rs:L69-L93): sponge with IV 0, absorb m_lo, m_hi (permute),
/// index, "noid-deri" (permute), then the pad block 0x80 .. 0x01 (permute),
/// digest = lanes 0 and 1 (compression.rs:L98-L103, L198-L216, L293-L298).
pub fn derive(m: &[u8; 32], index: u32) -> [u8; 32] {
    let (lo, hi) = limbs(m);
    let mut st = [0u128; STATE_SIZE];
    st[0] ^= lo;
    st[1] ^= hi;
    permute(&mut st);
    st[0] ^= index as u128;
    st[1] ^= DERIVE_TAG;
    permute(&mut st);
    // padding block: byte 0 = 0x80, byte 31 = 0x01, rest zero; lane 1 = bytes 16..32 LE
    st[0] ^= 0x80;
    st[1] ^= 1u128 << 120;
    permute(&mut st);
    unlimbs(st[0], st[1])
}

/// `Derive(m, 0)` -- the first address of the stock wallet.
pub fn derive0(m: &[u8; 32]) -> [u8; 32] {
    derive(m, 0)
}

// ------------------------------------------------------------------ statements

pub const VARIANT_RAW: u8 = 0;
pub const VARIANT_STOCK: u8 = 1;
/// variant (1) || H (32) || A (32)
pub const PUBLIC_LEN: usize = 65;

/// (H, A) for the RAW variant: H = sha256(m), A = Addr(m).
pub fn statement_raw(m: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (sha256::sha256(m), addr(m))
}

/// (H, A) for the STOCK variant: H = sha256(m), A = Addr(Derive(m, 0)).
pub fn statement_stock(m: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (sha256::sha256(m), addr(&derive0(m)))
}

/// Statement for either variant (any value other than VARIANT_STOCK is treated as an error by callers).
pub fn statement(variant: u8, m: &[u8; 32]) -> Option<([u8; 32], [u8; 32])> {
    match variant {
        VARIANT_RAW => Some(statement_raw(m)),
        VARIANT_STOCK => Some(statement_stock(m)),
        _ => None,
    }
}

/// Canonical public-values encoding committed by the guest.
pub fn encode_public(variant: u8, h: &[u8; 32], a: &[u8; 32]) -> [u8; PUBLIC_LEN] {
    let mut out = [0u8; PUBLIC_LEN];
    out[0] = variant;
    out[1..33].copy_from_slice(h);
    out[33..].copy_from_slice(a);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> [u8; 64] {
        const D: &[u8; 16] = b"0123456789abcdef";
        let mut o = [0u8; 64];
        for (i, x) in b.iter().enumerate() {
            o[2 * i] = D[(x >> 4) as usize];
            o[2 * i + 1] = D[(x & 15) as usize];
        }
        o
    }

    fn known_m() -> [u8; 32] {
        let mut m = [0u8; 32];
        for (i, b) in m.iter_mut().enumerate() {
            *b = i as u8;
        }
        m
    }

    #[test]
    fn basis_roundtrip_and_identity() {
        assert_eq!(tower_to_flat(1), 1);
        assert_eq!(flat_to_tower(1), 1);
        let mut x = 0x0123_4567_89ab_cdef_fedc_ba98_7654_3210u128;
        for _ in 0..200 {
            assert_eq!(flat_to_tower(tower_to_flat(x)), x);
            assert_eq!(tower_to_flat(flat_to_tower(x)), x);
            x = x.rotate_left(13).wrapping_mul(0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835) ^ 0x55;
        }
    }

    #[test]
    fn field_axioms_spot_check() {
        let a = 0xdead_beef_cafe_babe_0123_4567_89ab_cdefu128;
        let b = 0x1111_2222_3333_4444_5555_6666_7777_8888u128;
        let c = 0xffff_0000_ffff_0000_aaaa_5555_aaaa_5555u128;
        assert_eq!(gf_mul(a, b), gf_mul(b, a));
        assert_eq!(gf_mul(a, b ^ c), gf_mul(a, b) ^ gf_mul(a, c));
        assert_eq!(gf_mul(gf_mul(a, b), c), gf_mul(a, gf_mul(b, c)));
        assert_eq!(gf_mul(a, 1), a);
        // x * x^127 = x^128 = 0x87
        assert_eq!(gf_mul(2, 1u128 << 127), 0x87);
        for k in [a, b, c, 0, 1, u128::MAX, 1u128 << 127, 0x87] {
            assert_eq!(gf_sqr(k), gf_mul(k, k));
        }
    }

    #[test]
    fn permutation_changes_state_and_is_deterministic() {
        let mut a = [1u128, 0, 1, 0];
        let mut b = a;
        permute(&mut a);
        permute(&mut b);
        assert_eq!(a, b);
        assert_ne!(a, [1, 0, 1, 0]);
    }

    #[test]
    fn known_vector_sha_and_addr() {
        let m = known_m();
        let (h, a) = statement_raw(&m);
        assert_eq!(
            &hex(&h)[..],
            &b"630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"[..]
        );
        assert_eq!(
            &hex(&a)[..],
            &b"f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf"[..]
        );
    }

    #[test]
    fn cost_model_numbers() {
        assert_eq!(sbox_count(), 90);
        assert_eq!(SQRS_PER_PERMUTATION, 180);
        // 180 (S-box muls) + 9*10 (full MDS) + 58*4 (partial MDS diagonal) = 502
        assert_eq!(MULS_PER_PERMUTATION, 502);
    }

    #[test]
    fn public_encoding_layout() {
        let h = [1u8; 32];
        let a = [2u8; 32];
        let p = encode_public(VARIANT_STOCK, &h, &a);
        assert_eq!(p[0], 1);
        assert_eq!(&p[1..33], &h);
        assert_eq!(&p[33..], &a);
        assert!(statement(2, &h).is_none());
    }
}
