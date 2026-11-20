//! `HttpJsonRpc`: a JSON-RPC client over plain HTTP/1.1, written on
//! `std::net::TcpStream` (this crate has no HTTP dependency and may not add one).
//!
//! Plain words. A JSON-RPC call is one HTTP `POST` whose body says
//! `{"method": ..., "params": [...]}`; the node answers with a body holding
//! `result` or `error`. This client opens one connection per call, sends the
//! request with `Connection: close`, and reads the reply. Only `http://host:port/path`
//! is supported: no TLS (for `https://` use `exec::ExecJsonRpc`, which spawns `curl`),
//! no redirects, no proxies, no keep-alive.
//!
//! The reply body is read by `Content-Length`, by `Transfer-Encoding: chunked`,
//! or to end of stream, in that order of preference. One deadline covers the whole
//! call (connect, write and read), so a node that drips bytes cannot hold the tool
//! forever.
//!
//! Error mapping: unreachable / reset / timeout / bad HTTP framing / HTTP status
//! other than 200 is `RpcError::Transport` (a message starting `transport: connect`
//! means nothing was sent); a JSON-RPC `error` object is `RpcError::Remote`, also
//! when a server carries it on a non-200 status; an unparsable body is `Decode`.

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{parse_rpc_batch_response, parse_rpc_response, rpc_batch_request, rpc_request, snippet, JsonRpc, RpcError};

/// Default for connect, write and read together.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// A parsed `http://host[:port][/path]` URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpUrl {
    pub host: String,
    pub port: u16,
    /// Path and query, always starting with `/`.
    pub path: String,
}

impl HttpUrl {
    pub fn parse(url: &str) -> Result<Self, RpcError> {
        let bad = |why: &str| RpcError::Transport(format!("unsupported url {url:?}: {why}"));
        let url = url.trim();
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("https://") {
            return Err(bad("https is not supported by the built-in client; use --transport curl"));
        }
        if !lower.starts_with("http://") {
            return Err(bad("expected http://host:port/path"));
        }
        let rest = &url["http://".len()..];
        let cut = rest.find(['/', '?']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(cut);
        let path = if tail.is_empty() {
            "/".to_string()
        } else if tail.starts_with('?') {
            format!("/{tail}")
        } else {
            tail.to_string()
        };
        if authority.contains('@') {
            return Err(bad("credentials in the url are not supported"));
        }
        let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
            let (host, after) = inner.split_once(']').ok_or_else(|| bad("unterminated [ipv6]"))?;
            let port = match after.strip_prefix(':') {
                Some(p) => p.parse::<u16>().map_err(|_| bad("bad port"))?,
                None if after.is_empty() => 80,
                None => return Err(bad("junk after [ipv6]")),
            };
            (host.to_string(), port)
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| bad("bad port"))?),
                None => (authority.to_string(), 80),
            }
        };
        if host.is_empty() {
            return Err(bad("empty host"));
        }
        Ok(Self { host, port, path })
    }

    /// The `Host:` header value.
    pub fn host_header(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == 80 {
            host
        } else {
            format!("{host}:{}", self.port)
        }
    }

    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// REVIEW-2 F5: is this `http://` URL's host the local machine (`127.0.0.1`, `localhost` or `[::1]`, any port)? Plain
/// HTTP to anything else can be read and rewritten in transit. Anything that is not an `http://` URL, has credentials in
/// the authority (`http://127.0.0.1@evil.example/` has the host `evil.example`) or has no host is not loopback.
pub fn is_loopback_http(url: &str) -> bool {
    let url = url.trim();
    if !url.to_ascii_lowercase().starts_with("http://") {
        return false;
    }
    let rest = &url["http://".len()..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return false;
    }
    let host = match authority.strip_prefix('[') {
        Some(inner) => match inner.split_once(']') {
            Some((h, after)) if after.is_empty() || after.starts_with(':') => format!("[{h}]"),
            _ => return false,
        },
        None => authority.split(':').next().unwrap_or("").to_string(),
    };
    matches!(host.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

/// REVIEW-3 G3: where a node URL points, for telling two `--noid-rpc` / `--eth-rpc` values apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `scheme://host:port`: scheme and host in lower case, the default port (80 / 443) made explicit, the loopback
    /// spellings (`127.0.0.1`, `localhost`, `[::1]`) written as `localhost`, a trailing dot of the host dropped.
    /// Credentials, path and query are not part of it: a provider's API key in the path does not make a second node.
    pub origin: String,
    /// The host alone, normalized as above (what "the same machine" means).
    pub host: String,
}

/// REVIEW-3 G3: the normalized [`Endpoint`] of an `http(s)://` URL (surrounding spaces trimmed), `None` if it is not one.
pub fn normalize_endpoint(url: &str) -> Option<Endpoint> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80u16,
        "https" => 443,
        _ => return None,
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let (host, port) = match authority.strip_prefix('[') {
        Some(inner) => {
            let (h, after) = inner.split_once(']')?;
            let port = match after.strip_prefix(':') {
                Some(p) => p.parse::<u16>().ok()?,
                None if after.is_empty() => default_port,
                None => return None,
            };
            (format!("[{h}]"), port)
        }
        None => match authority.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
            None => (authority.to_string(), default_port),
        },
    };
    let host = host.to_ascii_lowercase();
    let host = host.trim_end_matches('.').to_string();
    if host.is_empty() {
        return None;
    }
    let host = if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") { "localhost".to_string() } else { host };
    Some(Endpoint { origin: format!("{scheme}://{host}:{port}"), host })
}

pub struct HttpJsonRpc {
    url: HttpUrl,
    timeout: Duration,
    bearer: Option<String>,
    next_id: AtomicU64,
}

impl HttpJsonRpc {
    pub fn new(url: &str) -> Result<Self, RpcError> {
        Ok(Self { url: HttpUrl::parse(url)?, timeout: DEFAULT_TIMEOUT, bearer: None, next_id: AtomicU64::new(1) })
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Send `Authorization: Bearer <token>` (a node with credentials configured needs it off-box).
    pub fn with_bearer(mut self, token: impl Into<String>) -> Self {
        self.bearer = Some(token.into());
        self
    }

    pub fn url(&self) -> &HttpUrl {
        &self.url
    }

    fn connect(&self, deadline: Instant) -> Result<TcpStream, RpcError> {
        let authority = self.url.authority();
        let addrs: Vec<SocketAddr> = (self.url.host.as_str(), self.url.port)
            .to_socket_addrs()
            .map_err(|e| RpcError::Transport(format!("connect {authority}: cannot resolve: {e}")))?
            .collect();
        let mut last = format!("connect {authority}: no address");
        for addr in addrs {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                last = format!("connect {authority}: timed out");
                break;
            }
            match TcpStream::connect_timeout(&addr, left) {
                Ok(s) => return Ok(s),
                Err(e) => last = format!("connect {authority} ({addr}): {e}"),
            }
        }
        Err(RpcError::Transport(last))
    }
}

/// The bytes read after the headers, with the deadline-aware reader.
struct Conn {
    stream: TcpStream,
    deadline: Instant,
    buf: Vec<u8>,
}

impl Conn {
    /// Read more bytes into `buf`; `Ok(0)` is end of stream.
    fn fill(&mut self) -> Result<usize, RpcError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(RpcError::Transport("timed out waiting for the reply".into()));
        }
        self.stream.set_read_timeout(Some(left)).map_err(|e| RpcError::Transport(format!("set timeout: {e}")))?;
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match self.stream.read(&mut chunk) {
                Ok(n) => {
                    self.buf.extend_from_slice(&chunk[..n]);
                    return Ok(n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    return Err(RpcError::Transport("timed out waiting for the reply".into()))
                }
                Err(e) => return Err(RpcError::Transport(format!("read: {e}"))),
            }
        }
    }
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if hay.len() < needle.len() || from > hay.len() - needle.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

struct Head {
    status: u16,
    reason: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

fn parse_head(raw: &[u8]) -> Result<Head, RpcError> {
    let bad = |m: &str| RpcError::Transport(format!("bad HTTP reply: {m}"));
    let text = std::str::from_utf8(raw).map_err(|_| bad("headers are not text"))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().ok_or_else(|| bad("empty"))?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(bad(&format!("status line {status_line:?}")));
    }
    let status = parts.next().and_then(|s| s.parse::<u16>().ok()).ok_or_else(|| bad(&format!("status line {status_line:?}")))?;
    let reason = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        let (k, v) = line.split_once(':').ok_or_else(|| bad(&format!("header line {line:?}")))?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    Ok(Head { status, reason, headers })
}

/// Read one complete response: `(head, body)`.
fn read_response(conn: &mut Conn) -> Result<(Head, Vec<u8>), RpcError> {
    // Headers. A `100 Continue` interim reply is skipped.
    let (head, mut pos) = loop {
        let mut scanned = 0;
        let end = loop {
            if let Some(i) = find(&conn.buf, b"\r\n\r\n", scanned) {
                break i;
            }
            scanned = conn.buf.len().saturating_sub(3);
            if conn.buf.len() > MAX_HEADER_BYTES {
                return Err(RpcError::Transport("reply headers exceed 64 KiB".into()));
            }
            if conn.fill()? == 0 {
                return Err(RpcError::Transport(if conn.buf.is_empty() {
                    "connection closed before any reply".into()
                } else {
                    "connection closed inside the reply headers".into()
                }));
            }
        };
        let head = parse_head(&conn.buf[..end])?;
        conn.buf.drain(..end + 4);
        if head.status == 100 {
            continue;
        }
        break (head, 0usize);
    };

    let chunked = head.header("transfer-encoding").map_or(false, |v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        let mut body = Vec::new();
        loop {
            // Size line.
            let eol = loop {
                if let Some(i) = find(&conn.buf, b"\r\n", pos) {
                    break i;
                }
                if conn.fill()? == 0 {
                    return Err(RpcError::Transport("connection closed inside a chunked body".into()));
                }
            };
            let line = std::str::from_utf8(&conn.buf[pos..eol]).map_err(|_| RpcError::Transport("bad chunk size line".into()))?;
            let size_text = line.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size_text, 16).map_err(|_| RpcError::Transport(format!("bad chunk size {size_text:?}")))?;
            pos = eol + 2;
            if size == 0 {
                break; // trailers, if any, are ignored: the connection is closed after this call.
            }
            if body.len() + size > MAX_BODY_BYTES {
                return Err(RpcError::Transport("reply body exceeds 32 MiB".into()));
            }
            while conn.buf.len() < pos + size + 2 {
                if conn.fill()? == 0 {
                    return Err(RpcError::Transport("connection closed inside a chunk".into()));
                }
            }
            body.extend_from_slice(&conn.buf[pos..pos + size]);
            if &conn.buf[pos + size..pos + size + 2] != b"\r\n" {
                return Err(RpcError::Transport("chunk is not followed by CRLF".into()));
            }
            pos += size + 2;
        }
        return Ok((head, body));
    }

    if let Some(len) = head.header("content-length") {
        let len: usize = len.parse().map_err(|_| RpcError::Transport(format!("bad Content-Length {len:?}")))?;
        if len > MAX_BODY_BYTES {
            return Err(RpcError::Transport("reply body exceeds 32 MiB".into()));
        }
        while conn.buf.len() < len {
            if conn.fill()? == 0 {
                return Err(RpcError::Transport(format!("connection closed after {} of {len} body bytes", conn.buf.len())));
            }
        }
        conn.buf.truncate(len);
        return Ok((head, std::mem::take(&mut conn.buf)));
    }

    // No length: the body runs to the end of the stream.
    loop {
        if conn.buf.len() > MAX_BODY_BYTES {
            return Err(RpcError::Transport("reply body exceeds 32 MiB".into()));
        }
        if conn.fill()? == 0 {
            break;
        }
    }
    Ok((head, std::mem::take(&mut conn.buf)))
}

impl HttpJsonRpc {
    /// One HTTP exchange: send `body`, read the whole reply.
    fn exchange(&self, body: &[u8]) -> Result<(Head, Vec<u8>), RpcError> {
        let deadline = Instant::now() + self.timeout;
        let mut stream = self.connect(deadline)?;
        let _ = stream.set_nodelay(true);
        let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        stream.set_write_timeout(Some(left)).map_err(|e| RpcError::Transport(format!("set timeout: {e}")))?;

        let mut request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
            self.url.path,
            self.url.host_header(),
            body.len()
        );
        if let Some(token) = &self.bearer {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        request.push_str("\r\n");
        let mut bytes = request.into_bytes();
        bytes.extend_from_slice(body);
        stream.write_all(&bytes).map_err(|e| {
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) {
                RpcError::Transport("timed out sending the request".into())
            } else {
                RpcError::Transport(format!("write: {e}"))
            }
        })?;

        let mut conn = Conn { stream, deadline, buf: Vec::new() };
        read_response(&mut conn)
    }
}

impl JsonRpc for HttpJsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = rpc_request(id, method, &params);
        let (head, body) = self.exchange(&body)?;
        if head.status != 200 {
            // A JSON-RPC error object on a non-200 status is still the node's answer.
            if let Err(e @ RpcError::Remote { .. }) = parse_rpc_response(&body, id) {
                return Err(e);
            }
            return Err(RpcError::Transport(format!("HTTP {} {}: {}", head.status, head.reason, snippet(&body))));
        }
        parse_rpc_response(&body, id)
    }

    /// One `POST` with a JSON array body. Any reply that is not an array of the right length (a node that refuses batches answers with
    /// one error object, or a non-200 status) is an `Err`, and the caller goes back to single calls.
    fn call_batch(&self, method: &str, params: &[Value]) -> Result<Vec<Result<Value, RpcError>>, RpcError> {
        if params.is_empty() {
            return Ok(Vec::new());
        }
        let first = self.next_id.fetch_add(params.len() as u64, Ordering::Relaxed);
        let ids: Vec<u64> = (0..params.len() as u64).map(|i| first + i).collect();
        let (head, body) = self.exchange(&rpc_batch_request(&ids, method, params))?;
        if head.status != 200 {
            return Err(RpcError::Transport(format!("HTTP {} {}: {}", head.status, head.reason, snippet(&body))));
        }
        parse_rpc_batch_response(&body, &ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    #[test]
    fn normalize_endpoint_makes_the_same_node_look_the_same() {
        let key = |u: &str| normalize_endpoint(u).unwrap().origin;
        // Case of scheme and host, surrounding spaces, default ports, a trailing dot, path, query and credentials.
        let base = key("https://rpc.example.org");
        for same in [
            "https://rpc.example.org/",
            "  HTTPS://RPC.Example.ORG  ",
            "https://rpc.example.org:443",
            "https://rpc.example.org./v3/KEY",
            "https://rpc.example.org/?k=1#x",
            "https://user:pw@rpc.example.org/",
        ] {
            assert_eq!(key(same), base, "{same}");
        }
        assert_eq!(base, "https://rpc.example.org:443");
        assert_eq!(key("http://node.example.org"), "http://node.example.org:80");
        assert_eq!(key("http://node.example.org:80/"), "http://node.example.org:80");
        // The loopback spellings are one machine and, on one port, one node.
        assert_eq!(key("http://127.0.0.1:9601"), key("http://localhost:9601/rpc"));
        assert_eq!(key("http://[::1]:9601"), key("HTTP://LOCALHOST:9601"));
        // Different port, scheme or host: different.
        assert_ne!(key("http://127.0.0.1:9601"), key("http://127.0.0.1:9602"));
        assert_ne!(key("http://node.example.org"), key("https://node.example.org"));
        assert_ne!(key("https://a.example.org"), key("https://b.example.org"));
        // Same host, other port: the same host, another origin.
        let (a, b) = (normalize_endpoint("http://127.0.0.1:9601").unwrap(), normalize_endpoint("http://localhost:9602").unwrap());
        assert_eq!(a.host, b.host);
        assert_ne!(a.origin, b.origin);
        // Not a web URL, no host, a bad port.
        for bad in ["", "rpc.example.org", "ftp://x/", "file:///etc/passwd", "http://", "http://:80/", "http://h:notaport", "http://[::1"] {
            assert_eq!(normalize_endpoint(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn loopback_check_accepts_only_the_local_machine_over_http() {
        for ok in [
            "http://127.0.0.1",
            "http://127.0.0.1:9601",
            "http://127.0.0.1:9601/rpc?k=1",
            "http://localhost",
            "http://localhost:8545/",
            "HTTP://LocalHost:8545",
            "http://[::1]",
            "http://[::1]:9601/x",
            "  http://127.0.0.1:1  ",
        ] {
            assert!(is_loopback_http(ok), "{ok}");
        }
        for bad in [
            "http://10.0.0.5:9601",
            "http://192.168.1.2",
            "http://example.org",
            "http://example.org:8545/127.0.0.1",
            "http://127.0.0.1.example.org",
            "http://localhost.example.org",
            "http://127.0.0.2",
            "http://[::2]",
            "http://[::1]x",
            "http://127.0.0.1@evil.example/",
            "http://localhost:80@evil.example/",
            "http://",
            "http://:80",
            "https://127.0.0.1",
            "https://node.example",
            "file:///etc/passwd",
            "127.0.0.1:9601",
            "",
        ] {
            assert!(!is_loopback_http(bad), "{bad}");
        }
    }

    /// Accept one connection, read the whole request (headers + Content-Length body),
    /// then run `reply` on the stream. Returns the URL and the captured request text.
    fn serve(reply: impl FnOnce(&mut TcpStream) + Send + 'static) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/rpc/v1?k=1", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = find(&buf, b"\r\n\r\n", 0) {
                    let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break;
                    }
                }
                assert!(n > 0, "client closed early");
            }
            reply(&mut s);
            String::from_utf8_lossy(&buf).into_owned()
        });
        (url, handle)
    }

    fn ok_body(id: u64, result: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
    }

    #[test]
    fn url_parsing() {
        let u = HttpUrl::parse("http://127.0.0.1:9601").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.path.as_str()), ("127.0.0.1", 9601, "/"));
        assert_eq!(u.host_header(), "127.0.0.1:9601");
        let u = HttpUrl::parse("HTTP://node.example/rpc?key=a").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.path.as_str()), ("node.example", 80, "/rpc?key=a"));
        assert_eq!(u.host_header(), "node.example");
        let u = HttpUrl::parse("http://[::1]:8545/x").unwrap();
        assert_eq!((u.host.as_str(), u.port), ("::1", 8545));
        assert_eq!(u.host_header(), "[::1]:8545");
        let e = HttpUrl::parse("https://x.example/").unwrap_err().to_string();
        assert!(e.contains("--transport curl"), "{e}");
        for bad in ["ftp://x", "x:80", "http://", "http://h:99999", "http://u:p@h/", "http://[::1"] {
            assert!(HttpUrl::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn content_length_reply_and_request_shape() {
        let body = ok_body(1, "280476");
        let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        let (url, h) = serve(move |s| s.write_all(reply.as_bytes()).unwrap());
        let rpc = HttpJsonRpc::new(&url).unwrap();
        assert_eq!(rpc.call("paranoid_blockCount", json!([])).unwrap(), json!(280476));
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /rpc/v1?k=1 HTTP/1.1\r\n"), "{req}");
        let lower = req.to_ascii_lowercase();
        assert!(lower.contains("\r\nhost: 127.0.0.1:"));
        assert!(lower.contains("\r\ncontent-type: application/json\r\n"));
        assert!(lower.contains("\r\nconnection: close\r\n"));
        assert!(!lower.contains("authorization"));
        let json_body = &req[req.find("\r\n\r\n").unwrap() + 4..];
        let v: Value = serde_json::from_str(json_body).unwrap();
        assert_eq!(v, json!({"jsonrpc": "2.0", "id": 1, "method": "paranoid_blockCount", "params": []}));
        assert!(lower.contains(&format!("content-length: {}\r\n", json_body.len())));
    }

    #[test]
    fn chunked_reply_split_across_writes() {
        let body = ok_body(1, r#"{"fee_micronoid":5800,"pad":"xxxxxxxxxxxxxxxxxxxx"}"#);
        let (a, b) = body.split_at(17);
        let (url, h) = serve({
            let (a, b) = (a.to_string(), b.to_string());
            move |s| {
                s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
                s.write_all(format!("{:x};ext=1\r\n{a}\r\n", a.len()).as_bytes()).unwrap();
                s.flush().unwrap();
                std::thread::sleep(Duration::from_millis(30));
                s.write_all(format!("{:X}\r\n{b}\r\n0\r\nX-Trailer: 1\r\n\r\n", b.len()).as_bytes()).unwrap();
            }
        });
        let rpc = HttpJsonRpc::new(&url).unwrap();
        assert_eq!(rpc.call("paranoid_estimateFeeDetailed", json!([1, 1])).unwrap()["fee_micronoid"], json!(5800));
        h.join().unwrap();
    }

    #[test]
    fn reply_without_length_runs_to_end_of_stream() {
        let body = ok_body(1, r#""1c83d7d0""#);
        let (url, h) = serve(move |s| s.write_all(format!("HTTP/1.0 200 OK\r\n\r\n{body}").as_bytes()).unwrap());
        assert_eq!(HttpJsonRpc::new(&url).unwrap().call("m", json!([])).unwrap(), json!("1c83d7d0"));
        h.join().unwrap();
    }

    #[test]
    fn http_500_is_a_transport_error_with_the_body_text() {
        let (url, h) = serve(|s| {
            s.write_all(b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\n\r\nboom").unwrap();
        });
        let e = HttpJsonRpc::new(&url).unwrap().call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Transport(m) if m.contains("HTTP 500") && m.contains("boom")), "{e:?}");
        h.join().unwrap();
        // 401 from a node that wants a token is not "the node's answer to the method" either.
        let (url, h) = serve(|s| s.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n").unwrap());
        let e = HttpJsonRpc::new(&url).unwrap().call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Transport(m) if m.contains("HTTP 401")), "{e:?}");
        h.join().unwrap();
    }

    #[test]
    fn jsonrpc_error_object_maps_to_remote_even_on_a_500() {
        let body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        let (url, h) = serve(move |s| {
            s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap()
        });
        let e = HttpJsonRpc::new(&url).unwrap().call("nope", json!([])).unwrap_err();
        assert_eq!(e, RpcError::Remote { code: -32601, message: "Method not found".into() });
        h.join().unwrap();
        let (url, h) = serve(move |s| {
            s.write_all(format!("HTTP/1.1 500 Oops\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap()
        });
        let e = HttpJsonRpc::new(&url).unwrap().call("nope", json!([])).unwrap_err();
        assert!(matches!(e, RpcError::Remote { code: -32601, .. }), "{e:?}");
        h.join().unwrap();
    }

    #[test]
    fn malformed_replies_are_errors_not_panics() {
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("not json", b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\nabc".to_vec(), "not JSON"),
            ("wrong id", format!("HTTP/1.1 200 OK\r\n\r\n{}", ok_body(9, "1")).into_bytes(), "does not match"),
            ("no result", b"HTTP/1.1 200 OK\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1}".to_vec(), "neither result nor error"),
            ("truncated body", b"HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\n{\"id\"".to_vec(), "closed after"),
            ("garbage status", b"SMTP 200 OK\r\n\r\n".to_vec(), "bad HTTP reply"),
            ("closed early", Vec::new(), "closed before any reply"),
            ("bad chunk", b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n".to_vec(), "bad chunk size"),
        ];
        for (name, bytes, want) in cases {
            let (url, h) = serve(move |s| s.write_all(&bytes).unwrap());
            let e = HttpJsonRpc::new(&url).unwrap().call("m", json!([])).unwrap_err().to_string();
            assert!(e.contains(want), "{name}: {e}");
            h.join().unwrap();
        }
    }

    #[test]
    fn a_silent_node_times_out_and_a_closed_port_is_a_connect_error() {
        let (url, h) = serve(|_s| std::thread::sleep(Duration::from_millis(700)));
        let start = Instant::now();
        let e = HttpJsonRpc::new(&url).unwrap().with_timeout(Duration::from_millis(200)).call("m", json!([])).unwrap_err();
        assert!(matches!(&e, RpcError::Transport(m) if m.contains("timed out")), "{e:?}");
        assert!(start.elapsed() < Duration::from_millis(650));
        h.join().unwrap();
        // A port nobody listens on: "transport: connect ...", the marker that nothing was sent.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let e = HttpJsonRpc::new(&format!("http://127.0.0.1:{port}")).unwrap().call("m", json!([])).unwrap_err();
        assert!(e.to_string().starts_with("transport: connect "), "{e}");
    }

    #[test]
    fn bearer_token_and_request_ids_advance() {
        let (url, h) = serve(|s| {
            let b = ok_body(1, "1");
            s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{b}", b.len()).as_bytes()).unwrap()
        });
        let rpc = HttpJsonRpc::new(&url).unwrap().with_bearer("tok");
        rpc.call("m", json!([])).unwrap();
        assert!(h.join().unwrap().contains("Authorization: Bearer tok\r\n"));
        assert_eq!(rpc.next_id.load(Ordering::Relaxed), 2);
    }
}
