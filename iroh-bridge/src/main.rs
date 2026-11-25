use std::process::ExitCode;

use buzz_host_iroh::{
    load_or_create_key, parse_args, relay_mode_from, Bridge, BridgeConfig, RELAYS_ENV, USAGE,
};

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(Some(args)) => args,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("buzz-host-iroh: {e:#}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("buzz-host-iroh: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: buzz_host_iroh::Args) -> anyhow::Result<()> {
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
