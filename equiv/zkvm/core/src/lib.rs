//! The guest computation, factored out of the zkVM entrypoint so that it can be
//! unit-tested natively and `cargo check`ed without any zkVM toolchain.
//!
//! Private input : variant (u8, 0 = raw, 1 = stock wallet), m (32 bytes)
//! Public output : variant || H || A   (65 bytes), H = sha256(m),
//!                 A = Addr(m) if variant = 0, A = Addr(Derive(m, 0)) if variant = 1.
#![no_std]
#![forbid(unsafe_code)]

pub use equiv_portable::{PUBLIC_LEN, VARIANT_RAW, VARIANT_STOCK};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    UnknownVariant(u8),
}

/// Compute the public values for secret `m`. This is the guest's whole job.
pub fn run(variant: u8, m: &[u8; 32]) -> Result<[u8; PUBLIC_LEN], Error> {
    let (h, a) = equiv_portable::statement(variant, m).ok_or(Error::UnknownVariant(variant))?;
    Ok(equiv_portable::encode_public(variant, &h, &a))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known_m() -> [u8; 32] {
        let mut m = [0u8; 32];
        for (i, b) in m.iter_mut().enumerate() {
            *b = i as u8;
        }
        m
    }

    #[test]
    fn raw_public_values() {
        let p = run(VARIANT_RAW, &known_m()).unwrap();
        assert_eq!(p[0], 0);
        assert_eq!(&p[1..5], &[0x63, 0x0d, 0xcd, 0x29]); // sha256 prefix of the known vector
        assert_eq!(&p[33..37], &[0xf8, 0x18, 0x3d, 0xb2]); // Addr prefix of the known vector
    }

    #[test]
    fn stock_public_values() {
        let p = run(VARIANT_STOCK, &known_m()).unwrap();
        assert_eq!(p[0], 1);
        assert_eq!(&p[1..5], &[0x63, 0x0d, 0xcd, 0x29]);
        assert_eq!(&p[33..37], &[0x55, 0x01, 0xd2, 0x31]); // bytes of o125qayv...
    }

    #[test]
    fn bad_variant_rejected() {
        assert_eq!(run(2, &known_m()), Err(Error::UnknownVariant(2)));
    }
}
