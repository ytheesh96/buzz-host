# Hardened sandbox image for buzz-host guest and shared agents.
# Supports Hermes (OpenCode Go), Claude Code, and Antigravity (mounted ro at /opt/antigravity/agy).
# Host binaries (buzz-acp, buzz, acp-proxy) and sandbox scripts are bind-mounted ro at /opt/buzz-host.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI + ACP adapter globally.
RUN npm install -g --no-audit --no-fund \
    @anthropic-ai/claude-code \
    @agentclientprotocol/claude-agent-acp \
  && npm cache clean --force

# Install uv + Python 3.14 + Hermes Agent (editable install with [acp] extra).
# Hermes pins its core dependencies under `python_version >= '3.14'` and rejects
# non-editable wheel builds in setup.py.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_REF=main
RUN uv python install 3.14 \
  && git clone --depth 1 --branch "${HERMES_REF}" "${HERMES_REPO}" /opt/hermes/src \
  && UV_PROJECT_ENVIRONMENT=/opt/hermes/venv uv sync --project /opt/hermes/src --python 3.14 --extra acp --frozen --no-dev --no-cache \
  && (/opt/hermes/venv/bin/python -m compileall -q /opt/hermes/src || true) \
  && test -x /opt/hermes/venv/bin/hermes-acp \
  && chmod -R a+rX /opt/uv /opt/hermes \
  && printf '#!/bin/sh\nexec /opt/hermes/venv/bin/hermes "$@"\n' > /usr/local/bin/hermes \
  && printf '#!/bin/sh\nexec /opt/hermes/venv/bin/hermes-acp "$@"\n' > /usr/local/bin/hermes-acp \
  && chmod 0755 /usr/local/bin/hermes /usr/local/bin/hermes-acp

# Point UID/GID 1000's /etc/passwd home at /home/agent (so Go/libc getpwuid matches $HOME)
# and create standard mount points.
RUN usermod -l agent -d /home/agent node \
  && groupmod -n agent node \
  && rm -rf /home/node \
  && mkdir -p /workspace /home/agent /run/buzz-sandbox /opt/buzz-host /opt/antigravity \
  && chmod 0755 /workspace /home/agent /run/buzz-sandbox /opt/buzz-host /opt/antigravity

WORKDIR /workspace
