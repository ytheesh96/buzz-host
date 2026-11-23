// Settings → Plugins → Remote Agents: server address, access token, connection check, and admin guest invites.
import {
  DEFAULT_URL,
  parseInviteInput,
  setStoredToken,
  setStoredUrl,
  storedToken,
  storedUrl,
} from "./config.js";

export function createServerCard({ React, client, uiKit }) {
  const { h, Row, Text, Note } = uiKit;

  function GuestInvites({ publicGuestUrl }) {
    const [tokens, setTokens] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [label, setLabel] = React.useState("");
    const [ownerPubkey, setOwnerPubkey] = React.useState("");
    const [maxAgents, setMaxAgents] = React.useState("2");
    const [maxConcurrency, setMaxConcurrency] = React.useState("2");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [created, setCreated] = React.useState(null);
    const [copied, setCopied] = React.useState(false);

    const refresh = async () => {
      setLoading(true);
      try {
        const res = await client.call("tokens.list");
        setTokens(Array.isArray(res?.tokens) ? res.tokens : []);
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setLoading(false);
      }
    };

    React.useEffect(() => {
      void refresh();
    }, []);

    const createInvite = async () => {
      const cleanLabel = label.trim();
      if (!cleanLabel) {
        setError("Enter a friend's name or label first.");
        return;
      }
      setBusy(true);
      setError("");
      setCreated(null);
      setCopied(false);
      try {
        const res = await client.call("tokens.create", {
          label: cleanLabel,
          ...(ownerPubkey.trim() ? { ownerPubkey: ownerPubkey.trim() } : {}),
          maxAgents: Number(maxAgents) || 2,
          maxConcurrency: Number(maxConcurrency) || 2,
        });
        setCreated(res);
        setLabel("");
        setOwnerPubkey("");
        await refresh();
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const revoke = async (id) => {
      setBusy(true);
      setError("");
      try {
        await client.call("tokens.revoke", { id });
        await refresh();
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        setError("Could not copy automatically — select and copy the link above.");
      }
    };

    const activeTokens = tokens.filter((t) => !t.revokedAt);
    const revokedTokens = tokens.filter((t) => t.revokedAt);

    return h(
      "div",
      {
        style: {
          display: "grid",
          gap: "var(--space-3)",
          paddingTop: "var(--space-3)",
          borderTop: "1px solid var(--border-standard)",
        },
      },
      h("strong", null, "Guest invites (friends)"),
      h(
        Note,
        null,
        `Create a personal invite link so a friend can host sandboxed agents on this server.${
          publicGuestUrl ? ` Guest endpoint: ${publicGuestUrl}` : ""
        }`,
      ),
      h(
        "div",
        { style: { display: "grid", gap: "var(--space-2)", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" } },
        h(
          Row,
          { label: "Friend label", hint: "Shown in your invite list (e.g. Alex)." },
          h(Text, {
            value: label,
            disabled: busy,
            placeholder: "Alex",
            onChange: (e) => setLabel(e.target.value),
          }),
        ),
        h(
          Row,
          { label: "Owner pubkey (optional)", hint: "Leave blank to bind automatically on their first agent." },
          h(Text, {
            value: ownerPubkey,
            disabled: busy,
            placeholder: "64-char hex pubkey (optional)",
            onChange: (e) => setOwnerPubkey(e.target.value),
          }),
        ),
      ),
      h(
        "div",
        { style: { display: "grid", gap: "var(--space-2)", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" } },
        h(
          Row,
          { label: "Max agents" },
          h(Text, {
            type: "number",
            min: 1,
            max: 20,
            value: maxAgents,
            disabled: busy,
            onChange: (e) => setMaxAgents(e.target.value),
          }),
        ),
        h(
          Row,
          { label: "Max parallel chats" },
          h(Text, {
            type: "number",
            min: 1,
            max: 8,
            value: maxConcurrency,
            disabled: busy,
            onChange: (e) => setMaxConcurrency(e.target.value),
          }),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)" } },
        h(
          "button",
          { type: "button", disabled: busy, onClick: () => void createInvite() },
          busy ? "Working…" : "Create guest invite",
        ),
      ),
      error && h(Note, { tone: "error" }, error),
      created &&
        h(
          "div",
          {
            style: {
              display: "grid",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-control)",
              background: "var(--surface-inset)",
              border: "1px solid var(--border-standard)",
            },
          },
          h(
            Note,
            null,
            `Invite created for ${created.record.label}. Copy and send it now — the secret token is shown only once.`,
          ),
          h(Text, {
            readOnly: true,
            value: created.inviteUrl || created.token,
            onFocus: (e) => e.target.select(),
          }),
          h(
            "div",
            { style: { display: "flex", gap: "var(--space-2)", alignItems: "center" } },
            h(
              "button",
              {
                type: "button",
                onClick: () => void copyText(created.inviteUrl || created.token),
              },
              copied ? "Copied!" : "Copy invite link",
            ),
            created.inviteUrl &&
              h(
                "button",
                { type: "button", onClick: () => void copyText(created.token) },
                "Copy token only",
              ),
          ),
        ),
      loading
        ? h(Note, null, "Loading guest invites…")
        : activeTokens.length === 0
          ? h(Note, null, "No active guest invites.")
          : h(
              "div",
              { style: { display: "grid", gap: "var(--space-2)" } },
              ...activeTokens.map((t) =>
                h(
                  "div",
                  {
                    key: t.id,
                    style: {
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-2)",
                      borderRadius: "var(--radius-control)",
                      border: "1px solid var(--border-standard)",
                    },
                  },
                  h(
                    "div",
                    { style: { display: "grid", gap: "2px", minWidth: 0 } },
                    h("strong", null, `${t.label} (${t.id})`),
                    h(
                      Note,
                      null,
                      `${t.agentCount ?? 0}/${t.maxAgents} agents · max ${t.maxConcurrency} parallel · ${t.allowedRuntimes.join(", ")} · ${
                        t.ownerPubkey ? `bound ${t.ownerPubkey.slice(0, 10)}…` : "unbound (binds on first agent)"
                      }`,
                    ),
                  ),
                  h(
                    "button",
                    { type: "button", disabled: busy, onClick: () => void revoke(t.id) },
                    "Revoke",
                  ),
                ),
              ),
            ),
      revokedTokens.length > 0 &&
        h(Note, null, `${revokedTokens.length} revoked invite${revokedTokens.length === 1 ? "" : "s"}.`),
    );
  }

  return function ServerCard() {
    const state = React.useSyncExternalStore(client.subscribe, client.snapshot);
    const [url, setUrl] = React.useState(storedUrl());
    const [token, setToken] = React.useState(storedToken());
    const [showToken, setShowToken] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const [info, setInfo] = React.useState();
    const [error, setError] = React.useState("");

    const handleUrlChange = (raw) => {
      const parsed = parseInviteInput(raw);
      if (parsed.token) {
        setUrl(parsed.url);
        setToken(parsed.token);
        setNotice("Invite link parsed into Server URL and Access token. Click Save and check to connect.");
      } else {
        setUrl(raw);
        setNotice("");
      }
    };

    const check = async (overrideUrl, overrideToken) => {
      setError("");
      setInfo(undefined);
      const rawUrl = overrideUrl ?? url;
      const parsed = parseInviteInput(rawUrl);
      const cleanUrl = (parsed.url || DEFAULT_URL).trim();
      const cleanToken = (parsed.token ?? overrideToken ?? token).trim();
      if (parsed.token) {
        setUrl(cleanUrl);
        setToken(cleanToken);
      }
      try {
        setStoredUrl(cleanUrl);
        setStoredToken(cleanToken);
        await client.reconnect();
        const [hello, list] = await Promise.all([client.call("hello"), client.call("list")]);
        setInfo({ hello, list });
        setNotice("");
      } catch (e) {
        setError(String(e.message ?? e));
      }
    };
    React.useEffect(() => {
      void check();
      // biome-ignore lint: check once on open
    }, []);
    const isGuest = info?.hello?.role === "guest";
    const isAdmin = info?.hello?.role === "admin";
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3)" } },
      h(
        Note,
        null,
        "Agents of type Self-hosted run on a buzz-host server. Create them in Agents → New agent → Harness → Remote → Self-hosted. In a chat, tag the agent with /model, /effort, /runtime, /new, /stop, /status or /help to control that chat (or thread).",
      ),
      h(
        Row,
        {
          label: "Server (or paste invite link)",
          hint: "Admin: your wss:// tailscale serve address. Guest: paste the invite link from your host.",
        },
        h(Text, { value: url, onChange: (e) => handleUrlChange(e.target.value) }),
      ),
      h(
        Row,
        {
          label: "Access token (guests only)",
          hint: "Leave blank on your own tailnet admin connection. Filled automatically when pasting an invite link.",
        },
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)" } },
          h(Text, {
            type: showToken ? "text" : "password",
            value: token,
            placeholder: "bhg_… (optional)",
            style: { flex: 1 },
            onChange: (e) => setToken(e.target.value),
          }),
          h(
            "button",
            { type: "button", onClick: () => setShowToken((v) => !v) },
            showToken ? "Hide" : "Show",
          ),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)" } },
        h("button", { type: "button", onClick: () => void check() }, "Save and check"),
        token &&
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                setToken("");
                setStoredToken("");
                setNotice("Access token cleared. Click Save and check to reconnect.");
              },
            },
            "Clear token",
          ),
      ),
      notice && h(Note, null, notice),
      h(Note, { tone: error ? "error" : undefined }, error || `Connection: ${state.status}`),
      info &&
        h(
          Note,
          null,
          (isGuest
            ? `Guest account: ${info.hello.label} · ${info.list.agents.length}/${info.hello.limits?.maxAgents ?? 2} agents · max ${info.hello.limits?.maxConcurrency ?? 2} parallel chats\n`
            : "") +
            `Host ${info.hello.host}${info.hello.role ? ` (${info.hello.role})` : ""} · runtimes: ${info.hello.runtimes
              .map((r) => `${r.title}${r.available ? "" : " (missing)"}`)
              .join(", ")}` +
            (Array.isArray(info.hello.runners)
              ? `\nRunners: ${info.hello.runners
                  .map((r) => `${r.title}${r.available ? "" : " (unavailable)"}`)
                  .join(", ")}`
              : "") +
            "\n" +
            (info.list.agents.length
              ? info.list.agents
                  .map((a) => {
                    const extra = [
                      a.runner && a.runner !== "host" ? a.runner : "",
                      a.respondTo && a.respondTo !== "owner-only" ? a.respondTo : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return `• ${a.name} — ${a.runtime}${a.model ? `/${a.model}` : ""}${extra ? ` [${extra}]` : ""} — ${a.status}`;
                  })
                  .join("\n")
              : "No agents yet."),
        ),
      isAdmin && h(GuestInvites, { publicGuestUrl: info.hello.publicGuestUrl }),
    );
  };
}
