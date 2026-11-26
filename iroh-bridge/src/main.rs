use std::{io::Write, process::ExitCode};

use buzz_host_iroh::{
    decode_endpoint_addr, load_or_create_key, parse_command, relay_mode_from, Bridge, BridgeConfig,
    Command, Dialer, DialerConfig, RELAYS_ENV, USAGE,
};

#[tokio::main]
async fn main() -> ExitCode {
    let cmd = match parse_command(std::env::args().skip(1)) {
        Ok(Some(cmd)) => cmd,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("buzz-host-iroh: {e:#}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let result = match cmd {
        Command::Serve(args) => run_serve(args).await,
        Command::Connect(args) => run_connect(args).await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("buzz-host-iroh: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run_serve(args: buzz_host_iroh::Args) -> anyhow::Result<()> {
    let relay_mode = relay_mode_from(std::env::var(RELAYS_ENV).ok().as_deref())?;
    let secret_key = load_or_create_key(&args.key_file)?;
    let bridge = Bridge::bind(BridgeConfig {
        target: args.target,
        secret_key,
        relay_mode,
        max_streams: args.max_streams,
        addr_file: args.addr_file,
    })
    .await?;
    eprintln!(
        "buzz-host-iroh: endpoint {} -> {} (max {} streams)",
        bridge.endpoint().id(),
        args.target,
        args.max_streams
    );
    bridge.run(shutdown_signal()).await?;
    eprintln!("buzz-host-iroh: stopped");
    Ok(())
}

async fn run_connect(args: buzz_host_iroh::ConnectArgs) -> anyhow::Result<()> {
    let relay_mode = relay_mode_from(std::env::var(RELAYS_ENV).ok().as_deref())?;
    let endpoint_addr = decode_endpoint_addr(&args.addr)?;
    let dialer = Dialer::bind(DialerConfig {
        endpoint_addr,
        expected_node_id: args.node_id,
        listen: args.listen,
        relay_mode,
        max_streams: args.max_streams,
    })
    .await?;
    let ready = serde_json::json!({
        "listen": dialer.local_addr().to_string(),
        "nodeId": dialer.node_id(),
    });
    println!("{ready}");
    let _ = std::io::stdout().flush();
    eprintln!(
        "buzz-host-iroh connect: listening on {} -> {} (max {} streams)",
        dialer.local_addr(),
        dialer.node_id(),
        args.max_streams
    );
    dialer.run(shutdown_signal()).await?;
    eprintln!("buzz-host-iroh connect: stopped");
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
