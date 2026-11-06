use equiv_ref::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 1 || args[0] == "-h" || args[0] == "--help" {
        eprintln!("usage: equiv-ref <32-byte secret m as 64 hex chars>");
        eprintln!("prints H=sha256(m) and A for the raw and stock variants");
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
