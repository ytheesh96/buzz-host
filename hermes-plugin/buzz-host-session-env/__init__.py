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


def agent_for_cwd(cwd: Optional[str], agents: Path = _AGENTS) -> Optional[str]:
    """The buzz-host agent whose workspace is ``cwd``, if that agent exists."""
    match = _WORKSPACE.match(cwd or "")
    if match and (agents / match.group(1) / "key").is_file():
        return match.group(1)
    return None


def resolve(session_id: str):
    """Session env for ``session_id``: the agent's pubkey, or None (unset)."""
    try:
        agent = agent_for_cwd(_session_cwd(session_id))
    except Exception:
        return None  # contributes nothing; Hermes logs nothing for a non-map
    return {NAME: agent}


def register(ctx):
    ctx.register_session_env([NAME], resolve)
