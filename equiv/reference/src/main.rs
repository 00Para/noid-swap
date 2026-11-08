use equiv_ref::*;

const USAGE: &str = "usage:
  equiv-ref <32-byte secret m as 64 hex chars>
      prints H=sha256(m) and A for the raw and stock variants
  equiv-ref addr-vectors <out-file> [--random N] [--seed TEXT]
      writes the differential vectors for the EVM contract: for each secret 64 bytes =
      secret || Addr(secret), Addr from the VENDOR crate. Order: 299 structured secrets,
      then N seeded-random ones (default 12000, seed \"noid-swap/poseidon2b/addr-vectors/v1\"),
      random secret i = SHA-256(\"<seed>|<i>\")";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("addr-vectors") {
        return addr_vectors_cmd(&args[1..]);
    }
    if args.len() != 1 || args[0] == "-h" || args[0] == "--help" {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
    let m = match parse_hex32(&args[0]) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let (h, a_raw) = statement_raw(&m);
    let (h2, a_stock) = statement_stock(&m);
    assert_eq!(h, h2);
    println!("H            = {}", hex::encode(h));
    println!("variant 0 raw   : A = {}", hex::encode(a_raw));
    println!("                  o1 = {}", to_o1(&a_raw));
    println!("variant 1 stock : A = {}", hex::encode(a_stock));
    println!("                  o1 = {}", to_o1(&a_stock));
    println!("Derive(m,0)  = {}", hex::encode(derive0(&m)));
    println!(
        "public(raw)   = {}",
        hex::encode(equiv_portable::encode_public(VARIANT_RAW, &h, &a_raw))
    );
    println!(
        "public(stock) = {}",
        hex::encode(equiv_portable::encode_public(VARIANT_STOCK, &h, &a_stock))
    );
}

fn addr_vectors_cmd(args: &[String]) {
    let mut out: Option<&str> = None;
    let mut n = VECTOR_RANDOM;
    let mut seed = VECTOR_SEED.to_string();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--random" => n = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage_exit()),
            "--seed" => seed = it.next().cloned().unwrap_or_else(|| usage_exit()),
            s if !s.starts_with("--") && out.is_none() => out = Some(s),
            _ => usage_exit(),
        }
    }
    let out = out.unwrap_or_else(|| usage_exit());
    let bytes = addr_vectors_bytes(&seed, n);
    std::fs::write(out, &bytes).unwrap_or_else(|e| {
        eprintln!("error: cannot write {out}: {e}");
        std::process::exit(1);
    });
    eprintln!(
        "wrote {} vectors ({} structured + {} random, seed {:?}), {} bytes, to {}",
        bytes.len() / 64,
        VECTOR_STRUCTURED,
        n,
        seed,
        bytes.len(),
        out
    );
}

fn usage_exit<T>() -> T {
    eprintln!("{USAGE}");
    std::process::exit(2);
}
