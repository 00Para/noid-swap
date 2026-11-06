//! Parity tests: equiv-portable (dependency-free) vs the vendor Parano1d crates,
//! plus the documented known vectors.

use equiv_portable as p;
use equiv_ref as r;
use noid_core::{hardware, Block128};
use noid_poseidon2b::native::permutation as vperm;
use noid_poseidon2b::native::permutation::Poseidon2bPermutation;
use rand::{rngs::StdRng, Rng, RngCore, SeedableRng};

const KNOWN_SHA: &str = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const KNOWN_ADDR_RAW: &str = "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf";
const KNOWN_O1_RAW: &str = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const KNOWN_O1_STOCK: &str = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";

fn known_m() -> [u8; 32] {
    let mut m = [0u8; 32];
    for (i, b) in m.iter_mut().enumerate() {
        *b = i as u8;
    }
    m
}

fn rng() -> StdRng {
    StdRng::seed_from_u64(0x4e4f_4944_5f45_5156) // "NOID_EQV"
}

fn rand32(r: &mut StdRng) -> [u8; 32] {
    let mut m = [0u8; 32];
    r.fill_bytes(&mut m);
    m
}

#[test]
fn known_vector_reference() {
    let m = known_m();
    let (h, a) = r::statement_raw(&m);
    assert_eq!(hex::encode(h), KNOWN_SHA);
    assert_eq!(hex::encode(a), KNOWN_ADDR_RAW);
    assert_eq!(r::to_o1(&a), KNOWN_O1_RAW);
}

#[test]
fn known_vector_stock_o1_address_from_report() {
    let m = known_m();
    let (h, a) = r::statement_stock(&m);
    assert_eq!(hex::encode(h), KNOWN_SHA);
    // decode the o1 bech32m string with the vendor parser and compare BYTES
    let expect = r::from_o1(KNOWN_O1_STOCK).expect("report address parses");
    assert_eq!(a, expect);
    assert_eq!(r::to_o1(&a), KNOWN_O1_STOCK);
    // and the raw-variant address decodes to the documented hex
    assert_eq!(hex::encode(r::from_o1(KNOWN_O1_RAW).unwrap()), KNOWN_ADDR_RAW);
}

#[test]
fn known_vector_portable() {
    let m = known_m();
    let (h, a) = p::statement_raw(&m);
    assert_eq!(hex::encode(h), KNOWN_SHA);
    assert_eq!(hex::encode(a), KNOWN_ADDR_RAW);
    let (h, a) = p::statement_stock(&m);
    assert_eq!(hex::encode(h), KNOWN_SHA);
    assert_eq!(a, r::from_o1(KNOWN_O1_STOCK).unwrap());
}

#[test]
fn raw_and_stock_addresses_differ() {
    let (_, a) = r::statement_raw(&known_m());
    let (_, b) = r::statement_stock(&known_m());
    assert_ne!(a, b);
}

#[test]
fn vendor_constants_match_portable_copy() {
    // The portable crate keeps a verbatim copy of the tower-basis constants and
    // derives the flat ones at compile time; check the whole pipeline via the
    // vendor's own flat-conversion helpers on every constant.
    for i in 0..4 {
        for rd in 0..vperm::N_ROUNDS {
            let v = vperm::ROUND_CONSTANTS[i][rd];
            assert_eq!(p::tower_to_flat(v), hardware::tower_to_flat_u128(v));
        }
        for j in 0..4 {
            for t in [vperm::MDS_FULL[i][j], vperm::MDS_PARTIAL[i][j]] {
                assert_eq!(p::tower_to_flat(t), hardware::tower_to_flat_u128(t));
            }
        }
    }
    assert_eq!((p::F_ROUNDS, p::P_ROUNDS, p::STATE_SIZE), (vperm::F_ROUNDS, vperm::P_ROUNDS, vperm::STATE_SIZE));
}

#[test]
fn basis_and_field_ops_match_vendor_1000() {
    let mut g = rng();
    for _ in 0..1000 {
        let a: u128 = g.gen();
        let b: u128 = g.gen();
        assert_eq!(p::tower_to_flat(a), hardware::tower_to_flat_u128(a));
        assert_eq!(p::flat_to_tower(a), hardware::flat_to_tower_u128(a));
        assert_eq!(p::gf_mul(a, b), hardware::clmul_gcm(a, b));
    }
}

#[test]
fn permutation_matches_vendor_1000() {
    let mut g = rng();
    for _ in 0..1000 {
        let s: [u128; 4] = [g.gen(), g.gen(), g.gen(), g.gen()];
        let mut mine = s;
        p::permute(&mut mine);
        let mut v = s.map(Block128);
        Poseidon2bPermutation.permute_mut(&mut v);
        assert_eq!(mine, v.map(|b| b.0));
    }
}

/// Number of random cases for the Addr / Derive / statement differential tests.
/// Default 1,000 (quick). Set `EQUIV_PARITY_N=100000` (and use `--release`) for the big run;
/// add `-- --nocapture` to see the summary lines.
fn parity_n() -> usize {
    match std::env::var("EQUIV_PARITY_N") {
        Ok(s) => s.trim().replace('_', "").parse::<usize>().expect("EQUIV_PARITY_N must be a positive integer"),
        Err(_) => 1000,
    }
}

fn report(name: &str, n: usize, mismatches: usize, t: std::time::Instant) {
    println!("PARITY {name}: N={n} mismatches={mismatches} elapsed={:.2?}", t.elapsed());
    assert_eq!(mismatches, 0, "{name}: {mismatches} mismatches out of {n}");
}

#[test]
fn addr_matches_vendor() {
    let n = parity_n();
    let t = std::time::Instant::now();
    let mut g = rng();
    let mut bad = 0;
    for _ in 0..n {
        let m = rand32(&mut g);
        if p::addr(&m) != r::addr(&m) {
            bad += 1;
        }
    }
    report("addr", n, bad, t);
}

#[test]
fn derive_matches_vendor_sponge() {
    let n = parity_n();
    let t = std::time::Instant::now();
    let mut g = rng();
    let mut bad = 0;
    for _ in 0..n {
        let m = rand32(&mut g);
        if p::derive0(&m) != r::derive0(&m) {
            bad += 1;
        }
        let idx: u32 = g.gen();
        if p::derive(&m, idx) != r::derive(&m, idx) {
            bad += 1;
        }
    }
    report("derive (index 0 and random index)", n, bad, t);
}

#[test]
fn statements_match_vendor() {
    let n = parity_n();
    let t = std::time::Instant::now();
    let mut g = rng();
    let mut bad = 0;
    for _ in 0..n {
        let m = rand32(&mut g);
        if p::statement_raw(&m) != r::statement_raw(&m) {
            bad += 1;
        }
        if p::statement_stock(&m) != r::statement_stock(&m) {
            bad += 1;
        }
    }
    report("statements (raw + stock)", n, bad, t);
}

#[test]
fn sha256_matches_sha2_crate() {
    let mut g = rng();
    for len in 0..300usize {
        let mut v = vec![0u8; len];
        g.fill_bytes(&mut v);
        assert_eq!(p::sha256::sha256(&v), r::sha256(&v), "len {len}");
    }
}

#[test]
fn edge_case_secrets() {
    let cases: Vec<[u8; 32]> = vec![
        [0u8; 32],
        [0xffu8; 32],
        {
            let mut m = [0u8; 32];
            m[0] = 1;
            m
        },
        {
            let mut m = [0u8; 32];
            m[31] = 0x80;
            m
        },
        {
            let mut m = [0u8; 32];
            m[15] = 0x80;
            m[16] = 1;
            m
        },
    ];
    for m in cases {
        assert_eq!(p::statement_raw(&m), r::statement_raw(&m));
        assert_eq!(p::statement_stock(&m), r::statement_stock(&m));
        assert_eq!(p::derive(&m, u32::MAX), r::derive(&m, u32::MAX));
    }
}

#[test]
fn derive_index_and_domain_separation() {
    let m = known_m();
    assert_ne!(r::derive(&m, 0), r::derive(&m, 1));
    assert_ne!(r::derive(&m, 0), m);
    // Addr is a one-permutation truncation: Addr(m) is NOT sha256-like; sanity: injective-looking
    let mut g = rng();
    let a = rand32(&mut g);
    let mut b = a;
    b[7] ^= 1;
    assert_ne!(r::addr(&a), r::addr(&b));
}

#[test]
fn hex_parsing() {
    assert!(r::parse_hex32("00").is_err());
    assert!(r::parse_hex32("zz").is_err());
    let m = r::parse_hex32(&format!("0x{}", hex::encode(known_m()))).unwrap();
    assert_eq!(m, known_m());
}

#[test]
fn public_encoding_roundtrip() {
    let m = known_m();
    let (h, a) = r::statement_stock(&m);
    let e = p::encode_public(p::VARIANT_STOCK, &h, &a);
    assert_eq!(e.len(), p::PUBLIC_LEN);
    assert_eq!(e[0], 1);
    assert_eq!(&e[1..33], &h[..]);
    assert_eq!(&e[33..], &a[..]);
    let _ = rng().gen::<u8>();
}
