//! Native timing of the portable code (NOT zkVM numbers): `cargo run --release -p equiv-portable --example bench`
use std::time::Instant;

fn main() {
    let mut m = [0u8; 32];
    for (i, b) in m.iter_mut().enumerate() {
        *b = i as u8;
    }
    let n = 2000;
    let t = Instant::now();
    let mut acc = 0u8;
    for i in 0..n {
        m[0] = i as u8;
        acc ^= equiv_portable::statement_raw(&m).1[0];
    }
    let raw = t.elapsed() / n;
    let t = Instant::now();
    for i in 0..n {
        m[0] = i as u8;
        acc ^= equiv_portable::statement_stock(&m).1[0];
    }
    let stock = t.elapsed() / n;
    println!("raw   statement: {raw:?}   stock statement: {stock:?}   (acc {acc})");
    println!(
        "gf_mul per permutation = {}, squarings = {}",
        equiv_portable::MULS_PER_PERMUTATION,
        equiv_portable::SQRS_PER_PERMUTATION
    );
}
