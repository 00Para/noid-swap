//! `RecordingRpc`: wraps any `JsonRpc` and appends every answered call to a
//! fixture file in exactly the format `FixtureRpc` replays
//! (`{"description": ..., "calls": [{method, params, result | error}, ...]}`).
//!
//! Plain words. Run one live `tick` with `--record-noid FILE`, and the file holds
//! the node's real answers, in order, with the request parameters pinned. Feed it
//! back with `--noid-fixture FILE` and the watcher reproduces the same observation
//! with no node. The file is rewritten (temp file, fsync, rename) after every call,
//! so a crash mid-tick still leaves a replayable prefix.
//!
//! What is recorded: results and JSON-RPC error objects (they are the node's answer).
//! A transport failure or an undecodable reply is NOT recorded: it says nothing about
//! the node and would poison a replay. Note that an Ethereum fixture recorded after
//! Alice's reveal contains the preimage in the `Claimed` log / pending calldata; it is
//! public on chain by then, but treat the file accordingly.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use super::{Fixture, JsonRpc, RecordedCall, RpcError};

struct State {
    calls: Vec<RecordedCall>,
    /// The first chain height seen (`paranoid_blockCount` or `eth_blockNumber`), for the description.
    height: Option<u64>,
}

pub struct RecordingRpc<R: JsonRpc> {
    inner: R,
    path: PathBuf,
    label: String,
    started_at: u64,
    state: Mutex<State>,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl<R: JsonRpc> RecordingRpc<R> {
    /// `label` names the source in the description (a URL, without credentials).
    /// Refuses to start if `path` already exists: a real recording is never overwritten silently.
    pub fn create(inner: R, path: impl Into<PathBuf>, label: impl Into<String>) -> Result<Self, RpcError> {
        let path = path.into();
        if path.exists() {
            return Err(RpcError::Fixture(format!("{} already exists; refusing to overwrite a recording", path.display())));
        }
        Ok(Self {
            inner,
            path,
            label: label.into(),
            started_at: unix_now(),
            state: Mutex::new(State { calls: Vec::new(), height: None }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// How many calls are in the file so far.
    pub fn recorded(&self) -> usize {
        self.state.lock().unwrap().calls.len()
    }

    fn description(&self, height: Option<u64>) -> String {
        let at = match height {
            Some(h) => format!("chain height {h}"),
            None => "unknown chain height".into(),
        };
        format!(
            "RECORDED from {} at unix time {}, {at}. Every answer below is the node's real reply to the request pinned beside it (read-only calls; nothing was sent to a chain).",
            self.label, self.started_at
        )
    }

    fn flush(&self, st: &State) -> Result<(), RpcError> {
        let fixture = Fixture { description: self.description(st.height), calls: st.calls.clone() };
        let text = serde_json::to_vec_pretty(&fixture).map_err(|e| RpcError::Fixture(format!("cannot serialize recording: {e}")))?;
        let mut tmp = self.path.as_os_str().to_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let io = |e: std::io::Error| RpcError::Fixture(format!("cannot write {}: {e}", self.path.display()));
        {
            let mut f = std::fs::File::create(&tmp).map_err(io)?;
            f.write_all(&text).map_err(io)?;
            f.write_all(b"\n").map_err(io)?;
            f.sync_all().map_err(io)?;
        }
        std::fs::rename(&tmp, &self.path).map_err(io)
    }
}

fn height_of(method: &str, result: &Value) -> Option<u64> {
    match method {
        "paranoid_blockCount" => result.as_u64(),
        "eth_blockNumber" => result.as_str().and_then(|s| s.strip_prefix("0x")).and_then(|h| u64::from_str_radix(h, 16).ok()),
        _ => None,
    }
}

impl<R: JsonRpc> JsonRpc for RecordingRpc<R> {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let outcome = self.inner.call(method, params.clone());
        if let Some(rec) = RecordedCall::from_outcome(method, &params, &outcome) {
            let mut st = self.state.lock().unwrap();
            if st.height.is_none() {
                if let Ok(v) = &outcome {
                    st.height = height_of(method, v);
                }
            }
            st.calls.push(rec);
            self.flush(&st)?;
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::{FixtureRpc, ScriptedRpc};
    use serde_json::json;

    #[test]
    fn records_results_and_node_errors_but_not_transport_failures_and_replays_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rec.json");
        let live = ScriptedRpc(|m: &str, p: &Value| match m {
            "paranoid_blockCount" => Ok(json!(280_476)),
            "paranoid_getTx" => Ok(Value::Null),
            "paranoid_getObjectStatus" => Err(RpcError::Remote { code: -32000, message: "slot out of range".into() }),
            "eth_blockNumber" => Err(RpcError::Transport("transport: connect refused".into())),
            _ => Ok(p.clone()),
        });
        let rec = RecordingRpc::create(live, &path, "http://127.0.0.1:9601").unwrap();
        assert_eq!(rec.call("paranoid_blockCount", json!([])).unwrap(), json!(280_476));
        assert_eq!(rec.call("paranoid_getTx", json!(["ab"])).unwrap(), Value::Null);
        assert!(matches!(rec.call("paranoid_getObjectStatus", json!(["00", 0])), Err(RpcError::Remote { .. })));
        assert!(matches!(rec.call("eth_blockNumber", json!([])), Err(RpcError::Transport(_))));
        assert_eq!(rec.recorded(), 3);
        // The file is a fixture.
        let fx: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(fx.description.starts_with("RECORDED from http://127.0.0.1:9601"), "{}", fx.description);
        assert!(fx.description.contains("chain height 280476"));
        assert_eq!(fx.calls.len(), 3);
        // It replays the same answers, pins the same params, and keeps null results as results.
        let replay = FixtureRpc::from_file(&path).unwrap();
        assert_eq!(replay.call("paranoid_blockCount", json!([])).unwrap(), json!(280_476));
        assert!(matches!(replay.call("paranoid_getTx", json!(["cd"])), Err(RpcError::Fixture(_))));
        let replay = FixtureRpc::from_file(&path).unwrap();
        assert_eq!(replay.call("paranoid_getTx", json!(["ab"])).unwrap(), Value::Null);
        assert_eq!(
            replay.call("paranoid_getObjectStatus", json!(["00", 0])),
            Err(RpcError::Remote { code: -32000, message: "slot out of range".into() })
        );
        // A second recorder on the same path refuses to clobber it.
        let again = RecordingRpc::create(ScriptedRpc(|_: &str, _: &Value| Ok(json!(1))), &path, "x");
        assert!(matches!(again, Err(RpcError::Fixture(m)) if m.contains("already exists")));
        assert!(!dir.path().join("rec.json.tmp").exists());
    }
}
