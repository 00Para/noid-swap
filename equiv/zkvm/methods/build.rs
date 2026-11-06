// Compiles methods/guest for the RISC-V zkVM with the RISC Zero toolchain (`rzup install`)
// and embeds EQUIV_GUEST_ELF / EQUIV_GUEST_ID.
//
//   default                 : local toolchain build (fast; ImageID depends on your toolchain)
//   EQUIV_REPRODUCIBLE=1    : build inside RISC Zero's pinned docker image, with equiv/ as the
//                             docker root (the guest path-depends on ../../core and ../../../portable).
//                             Bob should use this and compare the ImageID with other independent builders.
//   RISC0_SKIP_BUILD=1      : skip the guest build (host-side `cargo check` without any toolchain;
//                             the embedded ELF is then a stub).
use std::collections::HashMap;

use risc0_build::{embed_methods, embed_methods_with_options, DockerOptionsBuilder, GuestOptionsBuilder};

fn main() {
    if std::env::var_os("EQUIV_REPRODUCIBLE").is_some() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let docker = DockerOptionsBuilder::default().root_dir(root).build().unwrap();
        let guest = GuestOptionsBuilder::default().use_docker(docker).build().unwrap();
        embed_methods_with_options(HashMap::from([("equiv-guest", guest)]));
    } else {
        embed_methods();
    }
}
