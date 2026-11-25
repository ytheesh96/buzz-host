use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use buzz_host_iroh::{
    decode_endpoint_addr, encode_endpoint_addr, load_or_create_key, parse_args, parse_target,
    relay_mode_from, write_addr_file, AddrRecord, Bridge, BridgeConfig, ALPN, DEFAULT_MAX_STREAMS,
};
use iroh::{endpoint::presets, Endpoint, RelayMode, SecretKey};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "buzz-host-iroh-test-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn parse_args_valid_and_defaults() {
    let args = parse_args([
        "--target",
        "127.0.0.1:8458",
        "--key-file",
        "/tmp/iroh.key",
        "--addr-file=/tmp/iroh-addr.json",
    ])
    .expect("valid args")
    .expect("some args");
    assert_eq!(args.target, "127.0.0.1:8458".parse::<SocketAddr>().unwrap());
    assert_eq!(args.key_file, PathBuf::from("/tmp/iroh.key"));
    assert_eq!(args.addr_file, PathBuf::from("/tmp/iroh-addr.json"));
    assert_eq!(args.max_streams, DEFAULT_MAX_STREAMS);

    let custom = parse_args([
        "--target=[::1]:9000",
        "--key-file",
        "/tmp/k",
        "--addr-file",
        "/tmp/a",
        "--max-streams",
        "32",
    ])
    .expect("valid ipv6 args")
    .expect("some args");
    assert_eq!(custom.target, "[::1]:9000".parse::<SocketAddr>().unwrap());
    assert_eq!(custom.max_streams, 32);

    assert_eq!(parse_args(["--help"]).expect("help"), None);
    assert_eq!(parse_args(["-h"]).expect("short help"), None);
}

#[test]
fn parse_args_rejects_invalid_inputs() {
    assert!(parse_args(["--target", "127.0.0.1:8458"]).is_err());
    assert!(parse_args([
        "--target",
        "127.0.0.1:8458",
        "--key-file",
        "/tmp/k",
        "--addr-file",
        "/tmp/a",
        "--max-streams",
        "0",
    ])
    .is_err());
    assert!(parse_args([
        "--target",
        "127.0.0.1:8458",
        "--key-file",
        "/tmp/k",
        "--addr-file",
        "/tmp/a",
        "--unknown",
    ])
    .is_err());
}

#[test]
fn parse_target_enforces_loopback_only() {
    assert!(parse_target("127.0.0.1:8458").is_ok());
    assert!(parse_target("[::1]:8458").is_ok());

    for bad in [
        "0.0.0.0:8458",
        "192.168.1.10:8458",
        "10.0.0.1:8458",
        "127.0.0.2:8458",
        "[::]:8458",
        "127.0.0.1:0",
        "[::1]:0",
        "localhost:8458",
        "not-an-addr",
    ] {
        assert!(parse_target(bad).is_err(), "expected {bad:?} to be rejected");
    }
}

#[test]
fn relay_mode_policy_matches_contract() {
    assert!(matches!(relay_mode_from(Some("0")).unwrap(), RelayMode::Disabled));
    assert!(matches!(relay_mode_from(Some(" 0 ")).unwrap(), RelayMode::Disabled));
    assert!(matches!(relay_mode_from(None).unwrap(), RelayMode::Default));
    assert!(matches!(relay_mode_from(Some("")).unwrap(), RelayMode::Default));
    assert!(matches!(relay_mode_from(Some("1")).unwrap(), RelayMode::Default));
    assert!(matches!(relay_mode_from(Some("default")).unwrap(), RelayMode::Default));

    let custom = relay_mode_from(Some("https://relay-a.example.com, https://relay-b.example.com/"))
        .expect("valid custom https relays");
    assert!(matches!(custom, RelayMode::Custom(_)));

    let local_http = relay_mode_from(Some("http://127.0.0.1:3340")).expect("loopback http allowed");
    assert!(matches!(local_http, RelayMode::Custom(_)));

    for bad in [
        "http://relay.example.com",
        "https://user:pass@relay.example.com",
        "https://relay.example.com/path",
        "https://relay.example.com/?q=1",
        "https://relay.example.com/#frag",
        " , ",
    ] {
        assert!(relay_mode_from(Some(bad)).is_err(), "expected {bad:?} to be rejected");
    }
}

#[test]
fn load_or_create_key_persists_with_0600_and_rejects_bad_perms() {
    let dir = TempDir::new("key");
    let key_path = dir.path().join("nested").join("iroh.key");

    let first = load_or_create_key(&key_path).expect("generate key");
    let second = load_or_create_key(&key_path).expect("reload key");
    assert_eq!(first.to_bytes(), second.to_bytes());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_or_create_key(&key_path).is_err());
    }

    let short_path = dir.path().join("short.key");
    fs::write(&short_path, b"too-short").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&short_path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(load_or_create_key(&short_path).is_err());
}

#[tokio::test]
async fn addr_file_and_endpoint_addr_roundtrip() {
    let dir = TempDir::new("addr");
    let addr_file = dir.path().join("iroh-addr.json");
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .expect("bind endpoint");
    let addr = endpoint.addr();

    let encoded = encode_endpoint_addr(&addr).expect("encode addr");
    assert!(!encoded.contains('='));
    assert_eq!(decode_endpoint_addr(&encoded).expect("decode addr"), addr);

    let record = write_addr_file(&addr_file, &addr).expect("write addr file");
    assert_eq!(record.node_id, addr.id.to_string());
    assert_eq!(record.endpoint_addr, encoded);
    assert!(record.updated_at > 0);

    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(&addr_file).expect("read addr file")).expect("parse json");
    assert_eq!(raw["nodeId"], record.node_id);
    assert_eq!(raw["endpointAddr"], record.endpoint_addr);
    assert_eq!(raw["updatedAt"], record.updated_at);

    endpoint.close().await;
}

async fn wait_for_addr_file(path: &std::path::Path) -> AddrRecord {
    for _ in 0..100 {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(record) = serde_json::from_slice::<AddrRecord>(&bytes) {
                return record;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("addr file {} was not written in time", path.display());
}

#[tokio::test]
async fn bridge_proxies_bi_stream_to_loopback_tcp_and_cleans_up_addr_file() {
    let dir = TempDir::new("e2e");
    let addr_file = dir.path().join("iroh-addr.json");

    // Loopback echo TCP server (simulating buzz-host guestPort).
    let tcp_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind tcp");
    let tcp_addr = tcp_listener.local_addr().unwrap();
    let echo_task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = tcp_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    let bridge = Bridge::bind(BridgeConfig {
        target: tcp_addr,
        secret_key: SecretKey::generate(),
        relay_mode: RelayMode::Disabled,
        max_streams: 4,
        addr_file: addr_file.clone(),
    })
    .await
    .expect("bind bridge");

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let bridge_task = tokio::spawn(async move {
        bridge
            .run(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("bridge run");
    });

    let record = wait_for_addr_file(&addr_file).await;
    let endpoint_addr = decode_endpoint_addr(&record.endpoint_addr).expect("decode addr");

    let client = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .expect("bind client");

    // 1. Valid ALPN proxies bytes bidirectionally.
    let conn = tokio::time::timeout(
        Duration::from_secs(10),
        client.connect(endpoint_addr.clone(), ALPN),
    )
    .await
    .expect("connect timeout")
    .expect("connect");

    let (mut send, mut recv) = conn.open_bi().await.expect("open bi");
    let payload = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\nhello-iroh-bridge";
    send.write_all(payload).await.expect("write");
    send.finish().expect("finish");
    let echoed = recv.read_to_end(1024).await.expect("read");
    assert_eq!(echoed, payload);
    conn.close(0u32.into(), b"done");

    // 2. Wrong ALPN is rejected during handshake.
    let wrong_alpn = tokio::time::timeout(
        Duration::from_secs(5),
        client.connect(endpoint_addr, b"wrong/alpn/1"),
    )
    .await
    .expect("wrong alpn timeout");
    assert!(wrong_alpn.is_err(), "wrong ALPN should fail handshake");

    client.close().await;

    // 3. Shutdown removes addr_file cleanly.
    let _ = shutdown_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), bridge_task)
        .await
        .expect("bridge shutdown timeout")
        .expect("bridge join");
    assert!(!addr_file.exists(), "addr_file should be removed on shutdown");

    echo_task.abort();
}

#[tokio::test]
async fn bridge_enforces_max_streams_cap() {
    let dir = TempDir::new("cap");
    let addr_file = dir.path().join("iroh-addr.json");

    // TCP server that holds connections open until the client closes.
    let tcp_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind tcp");
    let tcp_addr = tcp_listener.local_addr().unwrap();
    let hold_task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = tcp_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    if n > 0 {
                        let _ = sock.write_all(&buf[..n]).await;
                        // Hold open until peer finishes.
                        let _ = sock.read(&mut buf).await;
                    }
                }
            });
        }
    });

    let bridge = Bridge::bind(BridgeConfig {
        target: tcp_addr,
        secret_key: SecretKey::generate(),
        relay_mode: RelayMode::Disabled,
        max_streams: 1,
        addr_file: addr_file.clone(),
    })
    .await
    .expect("bind bridge");

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let bridge_task = tokio::spawn(async move {
        bridge
            .run(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("bridge run");
    });

    let record = wait_for_addr_file(&addr_file).await;
    let endpoint_addr = decode_endpoint_addr(&record.endpoint_addr).expect("decode addr");

    let client = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .expect("bind client");

    let conn = client.connect(endpoint_addr, ALPN).await.expect("connect");

    // First stream occupies the single permit.
    let (mut s1, mut r1) = conn.open_bi().await.expect("open stream 1");
    s1.write_all(b"ping").await.expect("write s1");
    let mut reply = [0u8; 4];
    r1.read_exact(&mut reply).await.expect("read s1");
    assert_eq!(&reply, b"ping");

    // Second concurrent stream should be refused (reset/stopped).
    let (mut s2, mut r2) = conn.open_bi().await.expect("open stream 2");
    let _ = s2.write_all(b"over-cap").await;
    let mut buf = [0u8; 16];
    let second_res = tokio::time::timeout(Duration::from_secs(3), r2.read(&mut buf))
        .await
        .expect("second stream should terminate promptly");
    assert!(second_res.is_err(), "expected second stream to be reset/stopped when max_streams=1");

    let _ = s1.finish();
    conn.close(0u32.into(), b"done");
    client.close().await;
    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(5), bridge_task).await;
    hold_task.abort();
}
