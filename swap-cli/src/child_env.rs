//! REVIEW-3 F4: the environment a spawned child gets.
//!
//! Plain words. This tool starts two kinds of children: `curl` (the `curl` transport, `watch::exec`)
//! and `equiv-prove` (`equiv`). A child inherits the parent's environment unless told otherwise, and
//! the environment of a process can be read by the same user (`/proc/<pid>/environ`). Two variables
//! must never reach a child: `SWAP_PASSPHRASE` (the passphrase of the swap file, which seals the
//! secret `s`) and `RISC0_DEV_MODE` (which, in a RISC Zero verifier, makes a fake receipt pass: G1).
//! So both runners call [`apply`]: the environment is cleared and only the names in
//! [`CHILD_ENV_ALLOWLIST`] are passed on (what `curl` and a Windows or WSL process need to find
//! programs, certificates and a proxy).

use std::process::Command;

/// The only environment variables a child process receives (REVIEW-3 F4). Everything else is
/// dropped, in particular `SWAP_PASSPHRASE` and `RISC0_DEV_MODE`.
pub const CHILD_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "CURL_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

/// Clear `cmd`'s environment and pass on only the allow-listed variables that are set here.
pub fn apply(cmd: &mut Command) -> &mut Command {
    cmd.env_clear();
    for name in CHILD_ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allow_list_has_no_secret_bearing_names() {
        // REVIEW-3 F4 / G1: these must never be passed on.
        for banned in ["SWAP_PASSPHRASE", "RISC0_DEV_MODE"] {
            assert!(!CHILD_ENV_ALLOWLIST.contains(&banned), "{banned}");
        }
        for needed in ["PATH", "SYSTEMROOT", "SystemRoot", "HOME", "https_proxy", "SSL_CERT_FILE"] {
            assert!(CHILD_ENV_ALLOWLIST.contains(&needed), "{needed}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn apply_clears_everything_but_the_allow_list() {
        // A variable name unique to this test; a name outside the list is dropped, one on the list is kept.
        std::env::set_var("F4_CHILD_ENV_UNIQUE_TEST_VAR", "leak");
        let mut cmd = Command::new("sh");
        apply(&mut cmd).arg("-c").arg("printf '%s|%s' \"${F4_CHILD_ENV_UNIQUE_TEST_VAR:-unset}\" \"${PATH:+path}\"");
        let out = cmd.output().unwrap();
        std::env::remove_var("F4_CHILD_ENV_UNIQUE_TEST_VAR");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "unset|path");
    }
}
