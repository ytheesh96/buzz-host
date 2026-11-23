"""buzz-host: give each Buzz agent's Hermes session its Buzz identity.

hermes-acp only views a session; the model and its tools run in the shared
gateway daemon, whose environment has none of the per-agent values agent-run
sets. buzz-host starts every agent with its workspace ~/buzz-agents/<pubkey>
as the session cwd, so a session maps to its agent through that cwd.

This plugin sets BUZZHOST_AGENT (not a secret: a public key) for the commands
of such a session, and unsets it for every other session. The `buzz` shell
function in ~/.bash_profile, which Hermes's login-shell snapshot carries into
every command, then runs ~/.local/lib/buzz-host/agent-bin/buzz, which loads
that agent's key from its own files.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Optional

NAME = "BUZZHOST_AGENT"
BLOCKED_CRON_TOOLS = frozenset({
    "cronjob",
    "cronjob_manage",
    "schedule_cronjob",
    "list_cronjobs",
    "remove_cronjob",
})
CRON_BLOCK_MESSAGE = (
    "Runtime scheduling (cronjob) is disabled for Buzz agents because it runs "
    "invisibly outside Buzz. Use Buzz Attention (interest_set + watch_add) "
    "instead so your owner has visibility in Buzz, or tell your owner if "
    "Attention is off."
)
_HOME = Path.home()
_WORKSPACE = re.compile(re.escape(str(_HOME / "buzz-agents")) + r"/([0-9a-f]{64})(?:/|$)")
_AGENTS = _HOME / ".local/share/buzz-host/agents"


def _state_db() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "state.db"
    except Exception:
        return _HOME / ".hermes" / "state.db"


def _session_cwd(session_id: str, db_path: Optional[Path] = None) -> Optional[str]:
    db = sqlite3.connect(f"file:{db_path or _state_db()}?mode=ro", uri=True, timeout=2)
    try:
        row = db.execute("select cwd from sessions where id = ?", (session_id,)).fetchone()
    finally:
        db.close()
    return row[0] if row and row[0] else None


def agent_for_cwd(cwd: Optional[str], agents: Optional[Path] = None) -> Optional[str]:
    """The buzz-host agent whose workspace is ``cwd``, if that agent exists."""
    base = _AGENTS if agents is None else agents
    match = _WORKSPACE.match(cwd or "")
    if match and (base / match.group(1) / "key").is_file():
        return match.group(1)
    return None


def resolve(session_id: str):
    """Session env for ``session_id``: the agent's pubkey, or None (unset)."""
    try:
        agent = agent_for_cwd(_session_cwd(session_id))
    except Exception:
        return None  # contributes nothing; Hermes logs nothing for a non-map
    return {NAME: agent}


def block_cronjob(tool_name: str = "", session_id: str = "", **_kwargs):
    """Block Hermes's built-in cronjob tools inside buzz-host agent sessions so
    scheduled wakes always go through Buzz Attention (visible to the owner)."""
    if tool_name not in BLOCKED_CRON_TOOLS or not session_id:
        return None
    try:
        agent = agent_for_cwd(_session_cwd(session_id))
    except Exception:
        return None
    if not agent:
        return None
    return {"action": "block", "message": CRON_BLOCK_MESSAGE}


def register(ctx):
    ctx.register_session_env([NAME], resolve)
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("pre_tool_call", block_cronjob)
