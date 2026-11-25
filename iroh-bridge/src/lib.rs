//! buzz-host-iroh: an Iroh QUIC endpoint that proxies each bi-stream on ALPN
//! `buzz-host/ws/1` raw and bidirectionally to buzz-host's token listener
//! (`127.0.0.1:<guestPort>`).
//!
//! The bridge adds no authentication of its own: the guest listener already
//! requires an access token (`bha_` / `bhg_`) or a single-use desktop ticket on
//! every socket, never trusts Tailscale headers, and enforces idle timeouts and
//! fragment caps. The bridge only bounds its own resource use (`--max-streams`).

use std::{
    fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey, Watcher,
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, sync::Semaphore};

/// ALPN every buzz-host tunnel client must offer.
pub const ALPN: &[u8] = b"buzz-host/ws/1";
/// Relay policy, shared with buzz-app's mesh transport.
pub const RELAYS_ENV: &str = "BUZZ_MESH_IROH_RELAYS";
pub const DEFAULT_MAX_STREAMS: usize = 128;
/// How long to wait for a home relay before publishing the first address.
pub const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// QUIC application error codes the bridge uses when it refuses a stream.
const ERR_BUSY: u32 = 1;
const ERR_TARGET: u32 = 2;

pub const USAGE: &str = "\
usage: buzz-host-iroh --target <127.0.0.1:port|[::1]:port> --key-file <path> --addr-file <path> [--max-streams <n>]

Proxies every Iroh QUIC bi-stream on ALPN buzz-host/ws/1 to the loopback target.
Relays: BUZZ_MESH_IROH_RELAYS=0 (direct only) | unset/1/default (n0 relays) | https://a,https://b (custom)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub target: SocketAddr,
    pub key_file: PathBuf,
    pub addr_file: PathBuf,
    pub max_streams: usize,
}

/// Parse argv (without the program name). `Ok(None)` means `--help`.
pub fn parse_args<I, S>(args: I) -> Result<Option<Args>>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut target = None;
    let mut key_file = None;
    let mut addr_file = None;
    let mut max_streams = DEFAULT_MAX_STREAMS;
    let mut it = args.into_iter().map(Into::into);
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        if flag == "-h" || flag == "--help" {
            return Ok(None);
        }
        let mut value = || -> Result<String> {
            match inline.clone() {
                Some(v) => Ok(v),
                None => it.next().ok_or_else(|| anyhow!("{flag} needs a value")),
            }
        };
        match flag.as_str() {
            "--target" => target = Some(parse_target(&value()?)?),
            "--key-file" => key_file = Some(non_empty_path(&flag, value()?)?),
            "--addr-file" => addr_file = Some(non_empty_path(&flag, value()?)?),
            "--max-streams" => {
                let raw = value()?;
                max_streams = raw
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=65_536).contains(n))
                    .ok_or_else(|| anyhow!("--max-streams must be 1..=65536, got {raw:?}"))?;
            }
            other => bail!("unknown argument {other:?}"),
        }
    }
    Ok(Some(Args {
        target: target.ok_or_else(|| anyhow!("--target is required"))?,
        key_file: key_file.ok_or_else(|| anyhow!("--key-file is required"))?,
        addr_file: addr_file.ok_or_else(|| anyhow!("--addr-file is required"))?,
        max_streams,
    }))
}

fn non_empty_path(flag: &str, raw: String) -> Result<PathBuf> {
    if raw.trim().is_empty() {
        bail!("{flag} must not be empty");
    }
    Ok(PathBuf::from(raw))
}

/// Only `127.0.0.1:<port>` or `[::1]:<port>`: the bridge must never become an
/// open proxy to other hosts or to non-loopback interfaces.
pub fn parse_target(raw: &str) -> Result<SocketAddr> {
    let addr: SocketAddr = raw
        .trim()
        .parse()
        .map_err(|_| anyhow!("--target must be 127.0.0.1:<port> or [::1]:<port>, got {raw:?}"))?;
    let loopback = match addr {
        SocketAddr::V4(v4) => v4.ip().octets() == [127, 0, 0, 1],
        SocketAddr::V6(v6) => v6.ip().is_loopback() && v6.scope_id() == 0,
    };
    if !loopback {
        bail!("--target must be 127.0.0.1:<port> or [::1]:<port>, got {raw:?}");
    }
    if addr.port() == 0 {
        bail!("--target port must not be 0");
    }
    Ok(addr)
}

/// Relay policy from `BUZZ_MESH_IROH_RELAYS`.
pub fn relay_mode_from(raw: Option<&str>) -> Result<RelayMode> {
    match raw.map(str::trim) {
        Some("0") => Ok(RelayMode::Disabled),
        None | Some("") | Some("1") | Some("default") => Ok(RelayMode::Default),
        Some(list) => {
            let urls = list
                .split(',')
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(parse_relay_url)
                .collect::<Result<Vec<_>>>()?;
            if urls.is_empty() {
                bail!("{RELAYS_ENV} must contain at least one relay URL");
            }
            Ok(RelayMode::custom(urls))
        }
    }
}

/// Same rules as buzz-app's mesh transport policy: https origins only (http is
/// allowed for loopback development), no credentials, path, query or fragment.
fn parse_relay_url(raw: &str) -> Result<RelayUrl> {
    let parsed = url::Url::parse(raw).map_err(|e| anyhow!("invalid relay URL {raw:?}: {e}"))?;
    let secure = parsed.scheme() == "https";
    let local_http = parsed.scheme() == "http"
        && parsed.host().is_some_and(|host| match host {
            url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
            url::Host::Ipv4(ip) => ip.is_loopback(),
            url::Host::Ipv6(ip) => ip.is_loopback(),
        });
    if !secure && !local_http {
        bail!("relay URL {raw:?} must use https (http is allowed only for loopback development)");
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        bail!("relay URL {raw:?} must be an origin without credentials, path, query, or fragment");
    }
    raw.parse::<RelayUrl>()
        .map_err(|e| anyhow!("invalid iroh relay URL {raw:?}: {e}"))
}

#[cfg(unix)]
fn create_private(path: &Path) -> Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("create {}", path.display()))
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))
}

fn ensure_parent(path: &Path) -> Result<()> {
    let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(());
    };
    if parent.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .with_context(|| format!("create {}", parent.display()))
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))
}

/// Write `bytes` to a private temp file next to `path`, then rename it over `path`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    ensure_parent(path)?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("{} has no file name", path.display()))?
        .to_string_lossy();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let tmp = path.with_file_name(format!(".{name}.tmp.{}.{nanos}", std::process::id()));
    let result = (|| {
        let mut file = create_private(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Load the persistent endpoint key, or generate one (mode 0600) if missing.
/// The file holds exactly the 32 raw Ed25519 secret key bytes.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    match fs::read(path) {
        Ok(bytes) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(path)?.permissions().mode();
                if mode & 0o077 != 0 {
                    bail!(
                        "{} is accessible by group/others (mode {:o}); chmod 600 it",
                        path.display(),
                        mode & 0o777
                    );
                }
            }
            let bytes: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
                anyhow!("{} must hold exactly 32 bytes, found {}", path.display(), bytes.len())
            })?;
            Ok(SecretKey::from_bytes(&bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = SecretKey::generate();
            write_atomic(path, &key.to_bytes())?;
            Ok(key)
        }
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// `URL_SAFE_NO_PAD(serde_json(EndpointAddr))`: the wire form clients dial.
pub fn encode_endpoint_addr(addr: &EndpointAddr) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(addr)?))
}

pub fn decode_endpoint_addr(encoded: &str) -> Result<EndpointAddr> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded.trim())?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Contents of `iroh-addr.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddrRecord {
    pub node_id: String,
    pub endpoint_addr: String,
    pub updated_at: u64,
}

pub fn write_addr_file(path: &Path, addr: &EndpointAddr) -> Result<AddrRecord> {
    let record = AddrRecord {
        node_id: addr.id.to_string(),
        endpoint_addr: encode_endpoint_addr(addr)?,
        updated_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
    };
    let mut json = serde_json::to_vec_pretty(&record)?;
    json.push(b'\n');
    write_atomic(path, &json)?;
    Ok(record)
}

pub struct BridgeConfig {
    pub target: SocketAddr,
    pub secret_key: SecretKey,
    pub relay_mode: RelayMode,
    pub max_streams: usize,
    pub addr_file: PathBuf,
}

pub struct Bridge {
    endpoint: Endpoint,
    target: SocketAddr,
    relay_disabled: bool,
    addr_file: PathBuf,
    streams: Arc<Semaphore>,
    connections: Arc<Semaphore>,
}

impl Bridge {
    /// Bind the endpoint. No address lookup service is configured: the
    /// endpoint address travels to clients in `iroh-addr.json`, so nothing is
    /// published to third-party DNS.
    pub async fn bind(config: BridgeConfig) -> Result<Self> {
        let relay_disabled = matches!(config.relay_mode, RelayMode::Disabled);
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(config.secret_key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(config.relay_mode)
            .bind()
            .await
            .map_err(|e| anyhow!("bind iroh endpoint: {e}"))?;
        Ok(Self {
            endpoint,
            target: config.target,
            relay_disabled,
            addr_file: config.addr_file,
            streams: Arc::new(Semaphore::new(config.max_streams)),
            // Idle connections are cheap but not free: cap them like streams.
            connections: Arc::new(Semaphore::new(config.max_streams)),
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Serve until `shutdown` resolves, then remove the address file and close.
    pub async fn run(self, shutdown: impl std::future::Future<Output = ()>) -> Result<()> {
        let publisher = tokio::spawn(publish_addrs(
            self.endpoint.clone(),
            self.addr_file.clone(),
            self.relay_disabled,
        ));
        let accept = accept_loop(
            self.endpoint.clone(),
            self.target,
            self.streams.clone(),
            self.connections.clone(),
        );
        tokio::select! {
            _ = shutdown => {}
            _ = accept => eprintln!("buzz-host-iroh: endpoint stopped accepting"),
        }
        publisher.abort();
        let _ = publisher.await;
        match fs::remove_file(&self.addr_file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("buzz-host-iroh: remove {}: {e}", self.addr_file.display()),
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), self.endpoint.close()).await;
        Ok(())
    }
}

/// Write the address once the endpoint is online (or after a bounded wait, so
/// direct-only mode still publishes), then rewrite it on every change.
async fn publish_addrs(endpoint: Endpoint, addr_file: PathBuf, relay_disabled: bool) {
    if !relay_disabled && tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await.is_err() {
        eprintln!(
            "buzz-host-iroh: no home relay after {}s; publishing direct addresses for now",
            ONLINE_TIMEOUT.as_secs()
        );
    }
    let mut watcher = endpoint.watch_addr();
    let mut last: Option<EndpointAddr> = None;
    loop {
        let addr = endpoint.addr();
        if last.as_ref() != Some(&addr) {
            match write_addr_file(&addr_file, &addr) {
                Ok(record) => {
                    eprintln!(
                        "buzz-host-iroh: published {} ({} relay, {} direct)",
                        record.node_id,
                        addr.relay_urls().count(),
                        addr.ip_addrs().count()
                    );
                    last = Some(addr);
                }
                Err(e) => eprintln!("buzz-host-iroh: write {}: {e:#}", addr_file.display()),
            }
        }
        if watcher.updated().await.is_err() {
            return;
        }
    }
}

async fn accept_loop(
    endpoint: Endpoint,
    target: SocketAddr,
    streams: Arc<Semaphore>,
    connections: Arc<Semaphore>,
) {
    while let Some(incoming) = endpoint.accept().await {
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        let streams = streams.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(e) => {
                    eprintln!("buzz-host-iroh: handshake failed: {e}");
                    return;
                }
            };
            if conn.alpn() != ALPN {
                conn.close(0u32.into(), b"unsupported alpn");
                return;
            }
            serve_connection(conn, target, streams).await;
        });
    }
}

async fn serve_connection(conn: Connection, target: SocketAddr, streams: Arc<Semaphore>) {
    let peer = conn.remote_id().fmt_short();
    loop {
        let (mut send, mut recv) = match conn.accept_bi().await {
            Ok(pair) => pair,
            Err(_) => return, // connection closed
        };
        let Ok(permit) = streams.clone().try_acquire_owned() else {
            eprintln!("buzz-host-iroh: refusing stream from {peer}: max streams reached");
            let _ = send.reset(ERR_BUSY.into());
            let _ = recv.stop(ERR_BUSY.into());
            continue;
        };
        let peer = peer.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(e) = proxy_stream(send, recv, target).await {
                eprintln!("buzz-host-iroh: stream from {peer}: {e:#}");
            }
        });
    }
}

async fn proxy_stream(mut send: SendStream, mut recv: RecvStream, target: SocketAddr) -> Result<()> {
    let tcp = match tokio::time::timeout(TARGET_CONNECT_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => {
            let _ = send.reset(ERR_TARGET.into());
            let _ = recv.stop(ERR_TARGET.into());
            return Err(e).with_context(|| format!("connect {target}"));
        }
        Err(_) => {
            let _ = send.reset(ERR_TARGET.into());
            let _ = recv.stop(ERR_TARGET.into());
            bail!("connect {target}: timed out");
        }
    };
    let _ = tcp.set_nodelay(true);
    let mut tcp = tcp;
    let mut quic = tokio::io::join(recv, send);
    tokio::io::copy_bidirectional(&mut quic, &mut tcp).await?;
    Ok(())
}
