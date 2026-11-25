// Settings → Plugins → Remote Agents: server address, access token, connection check, and admin guest invites.
import {
  DEFAULT_URL,
  parseInviteInput,
  setStoredToken,
  setStoredUrl,
  storedToken,
  storedUrl,
} from "./config.js";
import { formatInviteMessage, sendInviteDm } from "./invite.js";

export function createServerCard({ React, client, uiKit, Btn, relay }) {
  const { h, Row, Text, Note } = uiKit;

  function GuestInvites({ publicGuestUrl }) {
    const relaySnap = React.useSyncExternalStore(
      (onStoreChange) => (relay?.subscribe ? relay.subscribe(onStoreChange) : () => {}),
      () => relay?.snapshot?.() ?? { status: "disconnected" },
    );
    const session = relaySnap?.status === "ready" ? relaySnap.session : undefined;
    const dmAvailable = Boolean(session?.directMessages?.available && session?.messages?.send);

    const [tokens, setTokens] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [memberQuery, setMemberQuery] = React.useState("");
    const [members, setMembers] = React.useState([]);
    const [searchingMembers, setSearchingMembers] = React.useState(false);
    const [selectedMember, setSelectedMember] = React.useState(null);
    const [label, setLabel] = React.useState("");
    const [ownerPubkey, setOwnerPubkey] = React.useState("");
    const [maxAgents, setMaxAgents] = React.useState("2");
    const [maxConcurrency, setMaxConcurrency] = React.useState("2");
    const [allowHostDesktop, setAllowHostDesktop] = React.useState(false);
    const [allowSandboxDesktop, setAllowSandboxDesktop] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [created, setCreated] = React.useState(null);
    const [dmSentTo, setDmSentTo] = React.useState("");
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

    // Load/search human community members for 1-click DM invites.
    React.useEffect(() => {
      if (!dmAvailable || !session?.directMessages?.people) {
        setMembers([]);
        return undefined;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        setSearchingMembers(true);
        session.directMessages
          .people(memberQuery.trim(), 1, controller.signal)
          .then((res) => {
            if (controller.signal.aborted) return;
            const humans = (Array.isArray(res?.people) ? res.people : []).filter((p) => p?.pubkey && !p.isAgent);
            setMembers(humans);
          })
          .catch(() => {
            if (!controller.signal.aborted) setMembers([]);
          })
          .finally(() => {
            if (!controller.signal.aborted) setSearchingMembers(false);
          });
      }, memberQuery.trim() ? 180 : 0);
      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    }, [dmAvailable, session, memberQuery]);

    const selectMember = (person) => {
      setSelectedMember(person);
      setLabel(person.name || person.username || person.pubkey.slice(0, 8));
      setOwnerPubkey(person.pubkey);
      setError("");
    };

    const clearMember = () => {
      setSelectedMember(null);
      setOwnerPubkey("");
    };

    const createInvite = async ({ sendDm = false } = {}) => {
      const cleanLabel = label.trim();
      if (!cleanLabel) {
        setError("Enter a friend's name or pick a Buzz member first.");
        return;
      }
      if (sendDm && !selectedMember?.pubkey) {
        setError("Pick a Buzz member first to send an in-app invite.");
        return;
      }
      if (sendDm && !publicGuestUrl) {
        setError("Guest endpoint (publicGuestUrl) is not configured on this buzz-host server.");
        return;
      }
      setBusy(true);
      setError("");
      setCreated(null);
      setDmSentTo("");
      setCopied(false);
      try {
        const cleanPubkey = (selectedMember?.pubkey || ownerPubkey).trim();
        const res = await client.call("tokens.create", {
          label: cleanLabel,
          ...(cleanPubkey ? { ownerPubkey: cleanPubkey } : {}),
          maxAgents: Number(maxAgents) || 2,
          maxConcurrency: Number(maxConcurrency) || 2,
          allowHostDesktop,
          allowSandboxDesktop,
        });
        setCreated(res);
        if (sendDm && session) {
          const inviteMsg = formatInviteMessage({
            url: publicGuestUrl,
            token: res.token,
            label: res.record?.label || cleanLabel,
            ownerPubkey: selectedMember.pubkey,
          });
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20000);
          try {
            await sendInviteDm(session, selectedMember.pubkey, inviteMsg, controller.signal);
            setDmSentTo(selectedMember.name || selectedMember.username || cleanLabel);
          } catch (dmErr) {
            setError(
              `Invite token was created, but DM delivery failed (${String(dmErr?.message ?? dmErr)}). Copy the invite link below to share manually.`,
            );
          } finally {
            clearTimeout(timeout);
          }
        }
        setLabel("");
        setOwnerPubkey("");
        setSelectedMember(null);
        setMemberQuery("");
        setAllowHostDesktop(false);
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
        `Send a one-click Buzz invite or create a personal invite link so a friend can host sandboxed agents on this server.${
          publicGuestUrl ? ` Guest endpoint: ${publicGuestUrl}` : ""
        }`,
      ),
      dmAvailable &&
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
            Row,
            {
              label: "Send directly to a Buzz member",
              hint: "They'll get an automatic Accept & Connect popup right in Buzz — no copy-paste needed.",
            },
            selectedMember
              ? h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "var(--space-2)",
                      padding: "var(--space-2)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--surface-panel, var(--surface-elevated, transparent))",
                      border: "1px solid var(--border-standard)",
                    },
                  },
                  h(
                    "div",
                    { style: { display: "grid", gap: "2px", minWidth: 0 } },
                    h("strong", null, selectedMember.name || selectedMember.username || selectedMember.pubkey.slice(0, 10)),
                    h(
                      Note,
                      null,
                      `${selectedMember.username ? `@${selectedMember.username} · ` : ""}${selectedMember.pubkey.slice(0, 12)}… (token pre-bound to this account)`,
                    ),
                  ),
                  h(
                    "button",
                    { type: "button", disabled: busy, onClick: clearMember },
                    "Change",
                  ),
                )
              : h(
                  "div",
                  { style: { display: "grid", gap: "var(--space-2)" } },
                  h(Text, {
                    value: memberQuery,
                    disabled: busy,
                    placeholder: "Search community members (e.g. Anu)…",
                    onChange: (e) => setMemberQuery(e.target.value),
                  }),
                  searchingMembers
                    ? h(Note, null, "Searching members…")
                    : members.length === 0
                      ? h(Note, null, memberQuery.trim() ? "No matching members found." : "No other community members loaded yet.")
                      : h(
                          "div",
                          {
                            style: {
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "var(--space-1, 6px)",
                              maxHeight: "120px",
                              overflowY: "auto",
                            },
                          },
                          ...members.slice(0, 12).map((person) =>
                            h(
                              "button",
                              {
                                key: person.pubkey,
                                type: "button",
                                disabled: busy,
                                onClick: () => selectMember(person),
                                style: {
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  padding: "4px 10px",
                                  borderRadius: "999px",
                                  border: "1px solid var(--border-standard)",
                                  background: "var(--surface-panel, transparent)",
                                  color: "var(--text-standard)",
                                  cursor: busy ? "default" : "pointer",
                                  font: "inherit",
                                  fontSize: "0.85rem",
                                },
                              },
                              person.name || person.username || `${person.pubkey.slice(0, 8)}…`,
                              person.username && person.name && person.username !== person.name
                                ? h("span", { className: "text-secondary" }, `@${person.username}`)
                                : null,
                            ),
                          ),
                        ),
                ),
          ),
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
          {
            label: "Owner pubkey (optional)",
            hint: selectedMember
              ? "Auto-filled from selected Buzz member."
              : "Leave blank to bind automatically on their first agent.",
          },
          h(Text, {
            value: ownerPubkey,
            disabled: busy || Boolean(selectedMember),
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
        "label",
        {
          style: {
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "flex-start",
            cursor: busy ? "default" : "pointer",
          },
        },
        h("input", {
          type: "checkbox",
          checked: allowSandboxDesktop,
          disabled: busy,
          onChange: (e) => setAllowSandboxDesktop(e.target.checked),
          style: { marginTop: "3px" },
        }),
        h(
          "div",
          { style: { display: "grid", gap: "2px" } },
          h("span", { style: { fontWeight: 500 } }, "Allow a sandboxed desktop"),
          h(
            Note,
            null,
            "Their agents can have their own desktop (Viewport, computer tools) inside a separate container with internet only. Nothing runs on the host as you. Uses about 2 GB of RAM per running desktop.",
          ),
        ),
      ),
      h(
        "label",
        {
          style: {
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "flex-start",
            cursor: busy ? "default" : "pointer",
          },
        },
        h("input", {
          type: "checkbox",
          checked: allowHostDesktop,
          disabled: busy,
          onChange: (e) => setAllowHostDesktop(e.target.checked),
          style: { marginTop: "3px" },
        }),
        h(
          "div",
          { style: { display: "grid", gap: "2px" } },
          h("span", { style: { fontWeight: 500 } }, "Allow remote desktop (trusted — runs on host)"),
          h(
            Note,
            null,
            "Only for people you trust on this machine. Lets them run owner-only agents on the host and open Viewport Remote Desktop.",
          ),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
        selectedMember && dmAvailable &&
          (Btn
            ? h(
                Btn,
                { variant: "primary", disabled: busy, onClick: () => void createInvite({ sendDm: true }) },
                busy ? "Sending…" : `Send invite to ${selectedMember.name || selectedMember.username || label || "member"}`,
              )
            : h(
                "button",
                { type: "button", disabled: busy, onClick: () => void createInvite({ sendDm: true }) },
                busy ? "Sending…" : `Send invite to ${selectedMember.name || selectedMember.username || label || "member"}`,
              )),
        h(
          "button",
          { type: "button", disabled: busy, onClick: () => void createInvite({ sendDm: false }) },
          busy ? "Working…" : selectedMember ? "Create link only" : "Create guest invite",
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
            dmSentTo
              ? `Invite sent to ${dmSentTo} in Buzz! An Accept & Connect popup will appear on their Buzz app (and the DM also has an Accept button). Fallback link below if needed:`
              : `Invite created for ${created.record.label}. Copy and send it now — the secret token is shown only once.`,
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
                      t.role === "admin"
                        ? `Admin access token · full access to this host${
                            t.ownerPubkey ? ` · owner ${t.ownerPubkey.slice(0, 10)}…` : ""
                          }`
                        : `${t.agentCount ?? 0}/${t.maxAgents} agents · max ${t.maxConcurrency} parallel · ${(t.allowedRuntimes ?? []).join(", ")}${
                            t.allowHostDesktop ? " · host desktop (trusted)" : ""
                          }${t.role !== "admin" && t.allowSandboxDesktop !== false && !t.allowHostDesktop ? " · sandboxed desktop" : ""} · ${
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
      if (!cleanUrl) {
        setNotice("Paste your server URL or invite link above, then click Save and check.");
        return;
      }
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
        "Agents of type Self-hosted run on a buzz-host server. Create one in Agents → New agent by picking a machine under Run on. In a chat, tag the agent with /model, /effort, /runtime, /new, /stop, /status or /help to control that chat (or thread).",
      ),
      h(
        Row,
        {
          label: "Server (or paste invite link)",
          hint: "Admin: your wss:// tailscale serve address, or an admin link (#token=bha_…) for any wss:// tunnel. Guest: paste the invite link from your host.",
        },
        h(Text, {
          value: url,
          placeholder: "wss://host.example/_buzz-host#token=bhg_…",
          onChange: (e) => handleUrlChange(e.target.value),
        }),
      ),
      h(
        Row,
        {
          label: "Access token",
          hint: "Leave blank on your own tailnet admin connection. Guests use a bhg_ invite token; an admin access token (bha_, from buzz-host-tokens create-admin) connects without Tailscale. Filled automatically when pasting an invite link.",
        },
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)" } },
          h(Text, {
            type: showToken ? "text" : "password",
            value: token,
            placeholder: "bhg_… or bha_… (optional)",
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
            ? `Guest account: ${info.hello.label} · ${info.list.agents.length}/${info.hello.limits?.maxAgents ?? 2} agents · max ${info.hello.limits?.maxConcurrency ?? 2} parallel chats${
                info.hello.limits?.allowHostDesktop
                  ? " · remote desktop enabled"
                  : info.hello.limits?.allowSandboxDesktop
                    ? " · sandboxed desktop enabled"
                    : ""
              }\n`
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
