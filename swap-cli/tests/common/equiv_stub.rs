//! REVIEW-3 F2: since a typed attestation is accepted under the rehearsal profile only, the CLI tests that
//! run `new-bob` against a production or sepolia bundle go through a stand-in for `equiv-prove` (a shell
//! script that prints the verifier's OK output and the image id compiled into the tool). Include with
//! `#[path = "common/equiv_stub.rs"] mod equiv_stub;`. Unix only (it writes a `#!/bin/sh` script).

#![allow(dead_code)]

use std::path::Path;

use swap_cli::params::EQUIV_IMAGE_ID;

/// `["--receipt", FILE, "--equiv-prove", BIN]` with a stand-in `equiv-prove` (and a dummy receipt) in `dir`,
/// created once per directory. The stand-in answers `verify raw|stock ...` with the OK line and the pinned image id.
pub fn receipt_flags(dir: &Path) -> Vec<String> {
    let bin = dir.join("equiv-prove-stub");
    let receipt = dir.join("stub.receipt");
    if !bin.exists() {
        let script = format!(
            "#!/bin/sh\ncase \"$2\" in\n  raw) echo 'OK: exists m with sha256(m) = H and Addr(m) = A' ;;\n  stock) echo 'OK: exists m with sha256(m) = H and Addr(Derive(m,0)) = A' ;;\n  *) exit 9 ;;\nesac\necho 'image id: {}'\n",
            hex::encode(EQUIV_IMAGE_ID)
        );
        let tmp = dir.join("equiv-prove-stub.tmp");
        std::fs::write(&tmp, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::rename(&tmp, &bin).unwrap();
        std::fs::write(&receipt, b"not a real receipt: the verifier is a stand-in").unwrap();
    }
    vec!["--receipt".into(), receipt.to_str().unwrap().into(), "--equiv-prove".into(), bin.to_str().unwrap().into()]
}
