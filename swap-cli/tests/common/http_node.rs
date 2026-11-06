//! A loopback JSON-RPC-over-HTTP mock node for the CLI tests: it listens on
//! 127.0.0.1 on an ephemeral port, answers every POST with `handler(method, params)`
//! as `{"jsonrpc":"2.0","id":..,"result"|"error":..}` and logs each call.
//! It speaks only to the test process; no external network is involved.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use swap_cli::watch::RpcError;

type Handler = dyn Fn(&str, &Value) -> Result<Value, RpcError> + Send + Sync;

pub struct MockNode {
    pub url: String,
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl MockNode {
    pub fn spawn(handler: impl Fn(&str, &Value) -> Result<Value, RpcError> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<Handler> = Arc::new(handler);
        let (calls2, stop2) = (calls.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((s, _)) => {
                        let (h, c) = (handler.clone(), calls2.clone());
                        std::thread::spawn(move || serve(s, &*h, &c));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self { url, calls, stop, handle: Some(handle) }
    }

    /// Methods called so far, in order.
    pub fn methods(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
    }

    pub fn count(&self, method: &str) -> usize {
        self.methods().iter().filter(|m| *m == method).count()
    }
}

impl Drop for MockNode {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn serve(mut s: TcpStream, handler: &Handler, calls: &Mutex<Vec<(String, Value)>>) {
    s.set_nonblocking(false).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, len) = loop {
        let n = match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
            let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
            if buf.len() >= i + 4 + len {
                break (i + 4, len);
            }
        }
    };
    let req: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap();
    let method = req["method"].as_str().unwrap().to_string();
    let params = req["params"].clone();
    calls.lock().unwrap().push((method.clone(), params.clone()));
    let reply = match handler(&method, &params) {
        Ok(v) => json!({"jsonrpc": "2.0", "id": req["id"], "result": v}),
        Err(RpcError::Remote { code, message }) => json!({"jsonrpc": "2.0", "id": req["id"], "error": {"code": code, "message": message}}),
        Err(other) => json!({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32603, "message": other.to_string()}}),
    };
    let body = serde_json::to_vec(&reply).unwrap();
    let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(&body);
}
