//! `ExecJsonRpc`: a JSON-RPC client that spawns a program (normally `curl`) per call.
//!
//! Plain words. Inside WSL the Windows host's loopback (where the node listens) is
//! not reachable over TCP, and the built-in `HttpJsonRpc` has no TLS. But WSL can run
//! Windows programs, and `/mnt/c/Windows/System32/curl.exe` runs in the Windows
//! network: it reaches `http://127.0.0.1:9601` and any `https://` endpoint. This
//! transport hands the JSON-RPC request to such a program on its standard input and
//! reads the reply from its standard output. It adds no dependency and speaks to no
//! socket itself.
//!
//! The program is run as
//! `PROGRAM -s -S --fail-with-body -m <secs> -X POST <url> -H "content-type: application/json" --data-binary @-`
//! (`@-` means "the body is on stdin"). A non-zero exit, empty output, output that is
//! not JSON, and a JSON-RPC `error` object all become an `RpcError`; the program's
//! stderr text is included in the message. A hard watchdog (timeout + 5 s) kills a
//! program that hangs.
//!
//! Error mapping: exit codes 6 (cannot resolve) and 7 (cannot connect) mean the request was
//! never sent and read `transport: connect ...`; every other failure after the program
//! started is `RpcError::Transport` (outcome unknown for a write call); a JSON-RPC
//! `error` is `Remote`, also when `--fail-with-body` made curl exit 22 on a 4xx/5xx
//! carrying one; unparsable output is `Decode`.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{parse_rpc_batch_response, parse_rpc_response, rpc_batch_request, rpc_request, snippet, JsonRpc, RpcError};

/// The Windows `curl.exe` as seen from WSL, preferred when it exists.
pub const WSL_WINDOWS_CURL: &str = "/mnt/c/Windows/System32/curl.exe";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// `WSL_WINDOWS_CURL` when that file exists, else plain `curl` from `PATH`.
pub fn default_program() -> String {
    if Path::new(WSL_WINDOWS_CURL).exists() {
        WSL_WINDOWS_CURL.to_string()
    } else {
        "curl".to_string()
    }
}

pub struct ExecJsonRpc {
    program: String,
    url: String,
    timeout: Duration,
    next_id: AtomicU64,
}

impl ExecJsonRpc {
    /// `program = None` selects [`default_program`].
    pub fn new(url: &str, program: Option<&str>) -> Self {
        Self {
            program: program.map(str::to_string).unwrap_or_else(default_program),
            url: url.trim().to_string(),
            timeout: DEFAULT_TIMEOUT,
            next_id: AtomicU64::new(1),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// The argument list after the program name.
    pub fn args(&self) -> Vec<String> {
        let secs = self.timeout.as_secs().max(1);
        [
            "-s",
            "-S",
            "--fail-with-body",
            "-m",
            &secs.to_string(),
            "-X",
            "POST",
            &self.url,
            "-H",
            "content-type: application/json",
            "--data-binary",
            "@-",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    fn run(&self, request: Vec<u8>) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), RpcError> {
        // REVIEW-3 F4: only the allow-listed environment reaches curl (never SWAP_PASSPHRASE or RISC0_DEV_MODE).
        let mut command = Command::new(&self.program);
        crate::child_env::apply(&mut command);
        command.args(self.args()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = spawn_with_etxtbsy_retry(&mut command)
            .map_err(|e| RpcError::Transport(format!("connect: cannot start {:?}: {e}", self.program)))?;
        let mut stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        // Write the request and drain both outputs on their own threads: no pipe can fill up and stall us.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&request); // a program that exits early closes the pipe; its exit code tells why
        });
        let (tx_out, rx_out) = mpsc::channel();
        let (tx_err, rx_err) = mpsc::channel();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = stdout.read_to_end(&mut b);
            let _ = tx_out.send(b);
        });
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = stderr.read_to_end(&mut b);
            let _ = tx_err.send(b);
        });
        let deadline = Instant::now() + self.timeout + Duration::from_secs(5);
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RpcError::Transport(format!("{} did not finish within {} s; killed", self.program, self.timeout.as_secs() + 5)));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(e) => return Err(RpcError::Transport(format!("waiting for {}: {e}", self.program))),
            }
        };
        let _ = writer.join();
        let out = rx_out.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
        let err = rx_err.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
        Ok((status.code(), out, err))
    }
}

/// `Command::spawn`, retried a few times when the program file is "busy" (`ETXTBSY`, "Text file busy"): the
/// executable is still held open for writing by another process. It happens in this crate's own test suite, where one
/// test thread writes a fake `curl` script while another forks a child that briefly inherits the open descriptor (the
/// `watch::exec` flake noted in REVIEW-3); a real `curl` binary never triggers it. Ten attempts, 10 ms apart; any other
/// error is returned at once, and so is the eleventh `ETXTBSY`.
fn spawn_with_etxtbsy_retry(command: &mut Command) -> std::io::Result<std::process::Child> {
    let mut attempt = 0;
    loop {
        match command.spawn() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy && attempt < 10 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            other => return other,
        }
    }
}

impl JsonRpc for ExecJsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (code, out, err) = self.run(rpc_request(id, method, &params))?;
        let err_text = String::from_utf8_lossy(&err).trim().to_string();
        match code {
            Some(0) => {
                if out.iter().all(u8::is_ascii_whitespace) {
                    return Err(RpcError::Transport(format!(
                        "{} produced no output{}",
                        self.program,
                        if err_text.is_empty() { String::new() } else { format!(": {err_text}") }
                    )));
                }
                parse_rpc_response(&out, id)
            }
            other => {
                // `--fail-with-body` keeps the body of a 4xx/5xx: a JSON-RPC error in it is the node's answer.
                if let Err(e @ RpcError::Remote { .. }) = parse_rpc_response(&out, id) {
                    return Err(e);
                }
                let label = match other {
                    Some(6) | Some(7) => "connect ".to_string(),
                    _ => String::new(),
                };
                let status = other.map_or("a signal".to_string(), |c| format!("exit code {c}"));
                Err(RpcError::Transport(format!(
                    "{label}{} failed with {status}{}{}",
                    self.program,
                    if err_text.is_empty() { String::new() } else { format!(": {err_text}") },
                    if out.is_empty() { String::new() } else { format!(" (body: {})", snippet(&out)) },
                )))
            }
        }
    }

    /// One curl run with a JSON array body. Anything but a successful exit with an array of the right length is an `Err`, and the caller
    /// goes back to single calls (a node that refuses batches answers with one error object, or curl exits non-zero on a 4xx/5xx).
    fn call_batch(&self, method: &str, params: &[Value]) -> Result<Vec<Result<Value, RpcError>>, RpcError> {
        if params.is_empty() {
            return Ok(Vec::new());
        }
        let first = self.next_id.fetch_add(params.len() as u64, Ordering::Relaxed);
        let ids: Vec<u64> = (0..params.len() as u64).map(|i| first + i).collect();
        let (code, out, err) = self.run(rpc_batch_request(&ids, method, params))?;
        let err_text = String::from_utf8_lossy(&err).trim().to_string();
        match code {
            Some(0) if !out.iter().all(u8::is_ascii_whitespace) => parse_rpc_batch_response(&out, &ids),
            Some(0) => Err(RpcError::Transport(format!("{} produced no output for a batch", self.program))),
            other => Err(RpcError::Transport(format!(
                "{} failed with {} on a batch{}",
                self.program,
                other.map_or("a signal".to_string(), |c| format!("exit code {c}")),
                if err_text.is_empty() { String::new() } else { format!(": {err_text}") },
            ))),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    /// A fake "curl": a shell script in `dir` that records its arguments and stdin, then runs `body`.
    fn fake(dir: &Path, name: &str, body: &str) -> String {
        let path = dir.join(name);
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{d}/{name}.args\"\ncat > \"{d}/{name}.stdin\"\n{body}\n",
            d = dir.display()
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn echoes_a_canned_result_and_passes_the_documented_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let prog = fake(dir.path(), "ok", r#"echo '{"jsonrpc":"2.0","id":1,"result":280476}'"#);
        let rpc = ExecJsonRpc::new("http://127.0.0.1:9601", Some(&prog)).with_timeout(Duration::from_secs(12));
        assert_eq!(rpc.call("paranoid_blockCount", json!([])).unwrap(), json!(280476));
        let args = std::fs::read_to_string(dir.path().join("ok.args")).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(
            args,
            ["-s", "-S", "--fail-with-body", "-m", "12", "-X", "POST", "http://127.0.0.1:9601", "-H", "content-type: application/json", "--data-binary", "@-"]
        );
        let stdin: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("ok.stdin")).unwrap()).unwrap();
        assert_eq!(stdin, json!({"jsonrpc": "2.0", "id": 1, "method": "paranoid_blockCount", "params": []}));
    }

    #[test]
    fn the_child_never_sees_the_passphrase_or_dev_mode_but_keeps_path() {
        // REVIEW-3 F4. Unique values, set and removed inside this test; asserts only on this test's own child.
        let dir = tempfile::tempdir().unwrap();
        let seen = dir.path().join("seen.txt");
        let body = format!(
            "printf 'pass=%s\ndev=%s\npath=%s\n' \"${{SWAP_PASSPHRASE:-unset}}\" \"${{RISC0_DEV_MODE:-unset}}\" \"${{PATH:+set}}\" > '{}'\necho '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}}'",
            seen.display()
        );
        let prog = fake(dir.path(), "env", &body);
        std::env::set_var("SWAP_PASSPHRASE", "f4-exec-test-passphrase-b1d3");
        std::env::set_var("RISC0_DEV_MODE", "f4-exec-test-1");
        let result = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([]));
        std::env::remove_var("SWAP_PASSPHRASE");
        std::env::remove_var("RISC0_DEV_MODE");
        assert_eq!(result.unwrap(), json!(1));
        let text = std::fs::read_to_string(&seen).unwrap();
        assert_eq!(text, "pass=unset\ndev=unset\npath=set\n", "{text}");
    }

    #[test]
    fn a_large_request_and_reply_do_not_deadlock() {
        let dir = tempfile::tempdir().unwrap();
        // Reply is ~300 KB, request is ~400 KB: both exceed a pipe buffer.
        let prog = fake(dir.path(), "big", r#"printf '{"jsonrpc":"2.0","id":1,"result":"'; head -c 300000 /dev/zero | tr '\0' 'a'; printf '"}'"#);
        let rpc = ExecJsonRpc::new("http://x", Some(&prog));
        let intent = "ab".repeat(200_000);
        let v = rpc.call("paranoid_submitTxIntent", json!([intent])).unwrap();
        assert_eq!(v.as_str().unwrap().len(), 300_000);
    }

    #[test]
    fn jsonrpc_error_object_maps_to_remote_also_after_a_curl_failure() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        let prog = fake(dir.path(), "err", &format!("echo '{body}'"));
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("nope", json!([])).unwrap_err();
        assert_eq!(e, RpcError::Remote { code: -32601, message: "Method not found".into() });
        // curl --fail-with-body: HTTP 400 gives exit 22 and still prints the body.
        let prog = fake(dir.path(), "err22", &format!("echo '{body}'; echo 'curl: (22) The requested URL returned error: 400' >&2; exit 22"));
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("nope", json!([])).unwrap_err();
        assert!(matches!(e, RpcError::Remote { code: -32601, .. }), "{e:?}");
    }

    #[test]
    fn nonzero_exit_includes_stderr_and_connect_failures_are_marked() {
        let dir = tempfile::tempdir().unwrap();
        let prog = fake(dir.path(), "fail", "echo 'curl: (22) The requested URL returned error: 500' >&2; echo 'upstream down'; exit 22");
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([])).unwrap_err().to_string();
        assert!(e.starts_with("transport: ") && !e.starts_with("transport: connect"), "{e}");
        assert!(e.contains("exit code 22") && e.contains("returned error: 500") && e.contains("upstream down"), "{e}");
        let prog = fake(dir.path(), "refused", "echo 'curl: (7) Failed to connect to 127.0.0.1 port 9601' >&2; exit 7");
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([])).unwrap_err().to_string();
        assert!(e.starts_with("transport: connect ") && e.contains("Failed to connect"), "{e}");
        // The program cannot even be started.
        let e = ExecJsonRpc::new("http://x", Some("/nonexistent/curl")).call("m", json!([])).unwrap_err().to_string();
        assert!(e.starts_with("transport: connect: cannot start"), "{e}");
    }

    #[test]
    fn empty_and_garbage_output_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let prog = fake(dir.path(), "empty", "exit 0");
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Transport(m) if m.contains("no output")), "{e:?}");
        let prog = fake(dir.path(), "junk", "echo '<html>502 Bad Gateway</html>'");
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Decode(m) if m.contains("not JSON") && m.contains("502")), "{e:?}");
        let prog = fake(dir.path(), "wrongid", r#"echo '{"jsonrpc":"2.0","id":77,"result":1}'"#);
        let e = ExecJsonRpc::new("http://x", Some(&prog)).call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Decode(m) if m.contains("does not match")), "{e:?}");
    }

    #[test]
    fn a_hanging_program_is_killed_by_the_watchdog() {
        let dir = tempfile::tempdir().unwrap();
        let prog = fake(dir.path(), "hang", "sleep 30");
        // timeout 0 s -> curl -m 1, watchdog at ~5 s is too slow for a unit test: shorten via a sub-second timeout.
        let mut rpc = ExecJsonRpc::new("http://x", Some(&prog));
        rpc.timeout = Duration::from_millis(0);
        let start = Instant::now();
        let e = rpc.call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Transport(m) if m.contains("killed")), "{e:?}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_batch_is_one_curl_run_with_an_array_body_and_a_refusal_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        // The fake curl answers an array in the other order: matched by id.
        let prog = fake(dir.path(), "batch", r#"echo '[{"jsonrpc":"2.0","id":2,"result":"b"},{"jsonrpc":"2.0","id":1,"result":"a"}]'"#);
        let rpc = ExecJsonRpc::new("http://x", Some(&prog));
        let out = rpc.call_batch("paranoid_getBlockHeader", &[json!([5]), json!([6])]).unwrap();
        assert_eq!(out, vec![Ok(json!("a")), Ok(json!("b"))]);
        let stdin: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("batch.stdin")).unwrap()).unwrap();
        assert_eq!(
            stdin,
            json!([{"jsonrpc": "2.0", "id": 1, "method": "paranoid_getBlockHeader", "params": [5]}, {"jsonrpc": "2.0", "id": 2, "method": "paranoid_getBlockHeader", "params": [6]}])
        );
        // A node without batch support answers one error object; a failing curl; no output: all errors, so the caller asks singly.
        let refuse = r#"echo '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"no batches"}}'"#;
        for (name, body) in [("obj", refuse), ("exit", "echo 'curl: (22)' >&2; exit 22"), ("empty", "exit 0")] {
            let prog = fake(dir.path(), name, body);
            let e = ExecJsonRpc::new("http://x", Some(&prog)).call_batch("m", &[json!([1]), json!([2])]);
            assert!(e.is_err(), "{name}: {e:?}");
        }
        // An empty batch needs no program.
        assert_eq!(ExecJsonRpc::new("http://x", Some("/nonexistent/curl")).call_batch("m", &[]).unwrap(), Vec::new());
    }

    #[test]
    fn default_program_prefers_the_wsl_windows_curl_when_present() {
        let p = default_program();
        if Path::new(WSL_WINDOWS_CURL).exists() {
            assert_eq!(p, WSL_WINDOWS_CURL);
        } else {
            assert_eq!(p, "curl");
        }
    }
}
