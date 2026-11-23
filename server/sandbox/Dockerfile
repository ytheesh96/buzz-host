# Hardened sandbox image for buzz-host guest and shared agents.
# Supports Hermes (OpenCode Go), Claude Code, and Antigravity (mounted ro at /opt/antigravity/agy).
# Host binaries (buzz-acp, buzz, acp-proxy) and sandbox scripts are bind-mounted ro at /opt/buzz-host.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI + ACP adapter globally.
RUN npm install -g --no-audit --no-fund \
    @anthropic-ai/claude-code \
    @agentclientprotocol/claude-agent-acp \
  && npm cache clean --force

# Install Hermes Agent (with ACP support) into /opt/hermes venv.
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_REF=main
RUN python3 -m venv /opt/hermes/venv \
  && /opt/hermes/venv/bin/pip install --no-cache-dir --upgrade pip \
  && git clone --depth 1 --branch "${HERMES_REF}" "${HERMES_REPO}" /opt/hermes/src \
  && /opt/hermes/venv/bin/pip install --no-cache-dir "/opt/hermes/src[acp]" \
  && printf '#!/bin/sh\nexec /opt/hermes/venv/bin/hermes "$@"\n' > /usr/local/bin/hermes \
  && printf '#!/bin/sh\nexec /opt/hermes/venv/bin/hermes-acp "$@"\n' > /usr/local/bin/hermes-acp \
  && chmod 0755 /usr/local/bin/hermes /usr/local/bin/hermes-acp

# Create standard mount points (actual runtime user is passed via --user uid:gid).
RUN mkdir -p /workspace /home/agent /run/buzz-sandbox /opt/buzz-host /opt/antigravity \
  && chmod 0755 /workspace /home/agent /run/buzz-sandbox /opt/buzz-host /opt/antigravity

WORKDIR /workspace
