#!/usr/bin/env python3
"""Read-only inventory of what a Buzz identity authored / belongs to.
Run on the server with the identity's BUZZ_* env loaded. Writes JSON to argv[1]."""
import json, subprocess, sys, os

B = os.path.expanduser("~/.local/lib/buzz-host/bin/buzz")

def buzz(*args):
    r = subprocess.run([B, *args], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return {"_error": (r.stderr or r.stdout).strip()[:400]}
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_raw": r.stdout[:2000]}

def items(d, *keys):
    if isinstance(d, list):
        return d
    for k in keys:
        if isinstance(d, dict) and isinstance(d.get(k), list):
            return d[k]
    return []

me = sys.argv[2]
out = {"pubkey": me}

msgs, seen, before, before_id = [], set(), None, None
for _ in range(200):
    args = ["messages", "search", "--author", me, "--limit", "100"]
    if before:
        args += ["--before", str(before), "--before-id", before_id]
    page = items(buzz(*args), "results", "messages", "events")
    new = [m.get("event", m) for m in page if m.get("event", m).get("id") not in seen]
    if not new:
        break
    for e in new:
        seen.add(e["id"])
        msgs.append({"id": e["id"], "kind": e.get("kind"), "created_at": e.get("created_at"),
                     "channel": next((t[1] for t in e.get("tags", []) if t and t[0] == "h"), None),
                     "preview": (e.get("content") or "")[:60]})
    last = new[-1]
    before, before_id = last.get("created_at"), last["id"]
out["messages"] = msgs
out["channels_member"] = [{"id": c.get("id") or c.get("channel_id"), "name": c.get("name"), "type": c.get("channel_type") or c.get("type")}
                          for c in items(buzz("channels", "list", "--member"), "channels")]
out["dms"] = buzz("dms", "list", "--limit", "200")
out["mem"] = buzz("mem", "ls")
json.dump(out, open(sys.argv[1], "w"), indent=1)
by_channel = {}
for m in msgs:
    by_channel[m["channel"]] = by_channel.get(m["channel"], 0) + 1
print(f"messages: {len(msgs)} by channel: {by_channel}")
print(f"kinds: { {k: sum(1 for m in msgs if m['kind']==k) for k in {m['kind'] for m in msgs}} }")
print(f"channels (member): {[(c['name'], c['type']) for c in out['channels_member']]}")
print(f"dms: {json.dumps(out['dms'])[:300]}")
print(f"mem: {json.dumps(out['mem'])[:300]}")
