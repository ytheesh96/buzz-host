# Remote Agents

Run AI agents on your own Linux or macOS machines (`buzz-host`), so they keep
answering while this computer is off.

## Getting started

1. Run `buzz-host` on a Linux or macOS machine. Machines with an authorized
   agent on your relay are discovered automatically over Nostr and connect via
   Iroh (with `wss://` fallback).
2. Open **Settings → Agent setup → Harness defaults → Self-hosted** to manage
   connected machines or paste an invite/pairing link (`wss://...#token=...`).
3. In **Agents**, choose **New agent**, pick your machine under **Run on**,
   and select its **Harness** (Claude Code, Codex, Hermes, or Antigravity).

## What it adds

- **Multi-machine hosting:** connect one or more self-hosted Linux/macOS
  machines and pick where each agent runs.
- **Composer:** pick the runtime (Claude Code, Codex, Hermes, Antigravity),
  model, effort, and Hermes profile for each chat, and switch them mid-chat.
- **Activity** tab: live and recent work on the server.
- **Settings** tab: default runtime and model, parallel conversations,
  instructions, and Orchestrator.
- **Orchestrator:** an agent can hand self-contained tasks to Solo-chat
  workers on any of your self-hosted agents.

Pair it with **Viewport** (agent desktops) and **Hive Watch** (Attention).
