// Settings → Plugins → Remote Agents: compact host status card and admin Shared access.
import { activeMachine, storedMachines, storedUrl } from "./config.js";
import { formatInviteMessage, sendInviteDm } from "./invite.js";

/** A short description of an invite's state for the Shared access list. */
export function inviteState(t) {
  if ((t.agentCount ?? 0) > 0) return "In use";
  return t.ownerPubkey ? "Invited via Buzz DM" : "Not used yet";
}

export function inviteAccessLabel(t) {
  if (t.allowHostDesktop) return "Trusted host access";
  return t.allowSandboxDesktop === false ? "Sandboxed · no desktop" : "Sandboxed";
}

const RELAY_DISCONNECTED = { status: "disconnected" };

export function createServerCard({ React, client, uiKit, Btn, relay, navigation }) {
  const { h, Row, Text, Note } = uiKit;

  const rowBox = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-control)",
    border: "1px solid var(--border-standard)",
  };
  const panelBox = {
    display: "grid",
    gap: "var(--space-3)",
    padding: "var(--space-3)",
    borderRadius: "var(--radius-control)",
    background: "var(--surface-inset)",
    border: "1px solid var(--border-standard)",
  };
  const Button = ({ variant, ...props }) =>
    Btn
      ? h(Btn, { variant, ...props })
      : h("button", { type: "button", ...props });

  const openMachines = () =>
    navigation?.open?.({
      version: 1,
      kind: "settings",
      section: "agents",
      provider: "local.buzz-host/omarchy",
    });

  function Check({ checked, disabled, onChange, title, hint }) {
    return h(
      "label",
      {
        style: {
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "flex-start",
          cursor: disabled ? "default" : "pointer",
        },
      },
      h("input", {
        type: "checkbox",
        checked,
        disabled,
        onChange: (e) => onChange(e.target.checked),
        style: { marginTop: "3px" },
      }),
      h(
        "div",
        { style: { display: "grid", gap: "2px" } },
        h("span", { style: { fontWeight: 500 } }, title),
        hint && h(Note, null, hint),
      ),
    );
  }

  function SharedAccess({ publicGuestUrl }) {
    const relaySnap = React.useSyncExternalStore(
      (onStoreChange) => (relay?.subscribe ? relay.subscribe(onStoreChange) : () => {}),
      () => relay?.snapshot?.() ?? RELAY_DISCONNECTED,
    );
    const session = relaySnap?.status === "ready" ? relaySnap.session : undefined;
    const dmAvailable = Boolean(session?.directMessages?.available && session?.messages?.send);

    const [tokens, setTokens] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [composing, setComposing] = React.useState(false);
    const [linkMode, setLinkMode] = React.useState(false);
    const [showRevoked, setShowRevoked] = React.useState(false);
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

    // Load/search human community members only while the Buzz-member picker is open.
    const pickingMember = composing && !linkMode && dmAvailable;
    React.useEffect(() => {
      if (!pickingMember || !session?.directMessages?.people) {
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
    }, [pickingMember, session, memberQuery]);

    const memberName = (p) => p.name || p.username || p.pubkey.slice(0, 8);

    const selectMember = (person) => {
      setSelectedMember(person);
      setLabel(memberName(person));
      setOwnerPubkey(person.pubkey);
      setError("");
    };

    const clearMember = () => {
      setSelectedMember(null);
      setLabel("");
      setOwnerPubkey("");
    };

    const closeComposer = () => {
      setComposing(false);
      setLinkMode(false);
      setSelectedMember(null);
      setMemberQuery("");
      setLabel("");
      setOwnerPubkey("");
      setAllowHostDesktop(false);
      setError("");
    };

    const createInvite = async ({ sendDm = false } = {}) => {
      const cleanLabel = label.trim();
      if (!cleanLabel) {
        setError(sendDm ? "Pick a Buzz member first." : "Enter your friend's name first.");
        return;
      }
      if (sendDm && !selectedMember?.pubkey) {
        setError("Pick a Buzz member first.");
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
        const cleanPubkey = (sendDm ? selectedMember.pubkey : ownerPubkey).trim();
        const res = await client.call("tokens.create", {
          label: cleanLabel,
          ...(cleanPubkey ? { ownerPubkey: cleanPubkey } : {}),
          maxAgents: Number(maxAgents) || 2,
          maxConcurrency: Number(maxConcurrency) || 2,
          allowHostDesktop,
          allowSandboxDesktop,
        });
        setCreated(res);
        let dmError = "";
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
            setDmSentTo(memberName(selectedMember));
          } catch (dmErr) {
            dmError = `The invite was created, but sending it failed (${String(dmErr?.message ?? dmErr)}). Copy the link below to share it yourself.`;
          } finally {
            clearTimeout(timeout);
          }
        }
        closeComposer();
        if (dmError) setError(dmError);
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

    // Admin access tokens are connection details, not shared access.
    const guestTokens = tokens.filter((t) => t.role !== "admin");
    const activeTokens = guestTokens.filter((t) => !t.revokedAt);
    const revokedTokens = guestTokens.filter((t) => t.revokedAt);

    const limits = h(
      "details",
      null,
      h("summary", { style: { cursor: "pointer" } }, "Limits & permissions"),
      h(
        "div",
        { style: { display: "grid", gap: "var(--space-3)", paddingTop: "var(--space-3)" } },
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
        h(Check, {
          checked: allowSandboxDesktop,
          disabled: busy,
          onChange: setAllowSandboxDesktop,
          title: "Allow a sandboxed desktop",
          hint: "Their agents can have their own desktop in a separate container with internet only. Uses about 2 GB of RAM per running desktop.",
        }),
        h(Check, {
          checked: allowHostDesktop,
          disabled: busy,
          onChange: setAllowHostDesktop,
          title: "Allow host access & remote desktop (trusted)",
          hint: "Only for people you trust on this machine. Lets them run agents on the host as you.",
        }),
        linkMode &&
          h(
            Row,
            {
              label: "Nostr public key (optional)",
              hint: "Lock the link to one Buzz account. Leave blank to lock it to whoever connects first.",
            },
            h(Text, {
              value: ownerPubkey,
              disabled: busy,
              placeholder: "Only if you know it",
              onChange: (e) => setOwnerPubkey(e.target.value),
            }),
          ),
      ),
    );

    const memberPicker = selectedMember
      ? h(
          "div",
          { style: rowBox },
          h(
            "div",
            { style: { display: "grid", gap: "2px", minWidth: 0 } },
            h("strong", null, memberName(selectedMember)),
            selectedMember.username && h(Note, null, `@${selectedMember.username}`),
          ),
          h(Button, { disabled: busy, onClick: clearMember }, "Change"),
        )
      : h(
          "div",
          { style: { display: "grid", gap: "var(--space-2)" } },
          h(Text, {
            value: memberQuery,
            disabled: busy,
            "aria-label": "Search Buzz members",
            placeholder: "Search Buzz members…",
            onChange: (e) => setMemberQuery(e.target.value),
          }),
          searchingMembers
            ? h(Note, null, "Searching…")
            : members.length === 0
              ? h(Note, null, memberQuery.trim() ? "No matching members found." : "No other members loaded yet.")
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
                      memberName(person),
                      person.username && person.name && person.username !== person.name
                        ? h("span", { className: "text-secondary" }, `@${person.username}`)
                        : null,
                    ),
                  ),
                ),
        );

    const composer =
      composing &&
      h(
        "div",
        { role: "group", "aria-label": "Invite a friend", style: panelBox },
        linkMode || !dmAvailable
          ? h(
              Row,
              { label: "Friend's name", hint: "Shown in your invite list." },
              h(Text, {
                value: label,
                disabled: busy,
                placeholder: "Alex",
                onChange: (e) => setLabel(e.target.value),
              }),
            )
          : h(
              Row,
              {
                label: "Who are you inviting?",
                hint: "They get an Accept & Connect prompt in Buzz. Their agents run in a Docker sandbox.",
              },
              memberPicker,
            ),
        limits,
        error && h(Note, { tone: "error" }, error),
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" } },
          linkMode || !dmAvailable
            ? h(
                Button,
                {
                  variant: "primary",
                  disabled: busy || !label.trim(),
                  onClick: () => void createInvite({ sendDm: false }),
                },
                busy ? "Creating…" : "Create link",
              )
            : h(
                Button,
                {
                  variant: "primary",
                  disabled: busy || !selectedMember,
                  onClick: () => void createInvite({ sendDm: true }),
                },
                busy ? "Sending…" : "Send Invite",
              ),
          h(Button, { disabled: busy, onClick: closeComposer }, "Cancel"),
          dmAvailable &&
            h(
              "button",
              {
                type: "button",
                disabled: busy,
                onClick: () => {
                  setLinkMode((v) => !v);
                  setError("");
                },
                style: {
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--text-secondary)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  font: "inherit",
                },
              },
              linkMode ? "Send in Buzz instead" : "Create a shareable link instead",
            ),
        ),
      );

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
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)" } },
        h(
          "div",
          { style: { display: "grid", gap: "2px" } },
          h("strong", null, "Shared access"),
          h(Note, null, "Let friends run their own agents on this server."),
        ),
        !composing &&
          h(Button, { variant: "primary", onClick: () => setComposing(true) }, "+ Invite"),
      ),
      composer,
      error && !composing && h(Note, { tone: "error" }, error),
      created &&
        h(
          "div",
          { style: panelBox },
          h(
            Note,
            null,
            dmSentTo
              ? `Invite sent to ${dmSentTo} in Buzz. They'll get an Accept & Connect prompt. The link below is a fallback:`
              : `Invite created for ${created.record.label}. Copy and send it now — the secret is shown only once.`,
          ),
          h(Text, {
            readOnly: true,
            "aria-label": "Invite link",
            value: created.inviteUrl || created.token,
            onFocus: (e) => e.target.select(),
          }),
          h(
            "div",
            { style: { display: "flex", gap: "var(--space-2)", alignItems: "center" } },
            h(
              Button,
              { onClick: () => void copyText(created.inviteUrl || created.token) },
              copied ? "Copied!" : "Copy invite link",
            ),
          ),
        ),
      loading
        ? h(Note, null, "Loading shared access…")
        : activeTokens.length === 0
          ? h(Note, null, "No one has been invited yet.")
          : h(
              "div",
              { role: "list", style: { display: "grid", gap: "var(--space-2)" } },
              ...activeTokens.map((t) =>
                h(
                  "div",
                  { key: t.id, role: "listitem", style: rowBox },
                  h(
                    "div",
                    { style: { display: "grid", gap: "2px", minWidth: 0 } },
                    h("strong", null, t.label),
                    h(
                      Note,
                      null,
                      `${t.agentCount ?? 0}/${t.maxAgents} agents · ${inviteAccessLabel(t)} · ${inviteState(t)}`,
                    ),
                  ),
                  h(
                    Button,
                    { disabled: busy, onClick: () => void revoke(t.id), "aria-label": `Revoke ${t.label}` },
                    "Revoke",
                  ),
                ),
              ),
            ),
      revokedTokens.length > 0 &&
        h(
          "div",
          { style: { display: "grid", gap: "var(--space-2)" } },
          h(
            "button",
            {
              type: "button",
              "aria-expanded": showRevoked,
              onClick: () => setShowRevoked((v) => !v),
              style: {
                justifySelf: "start",
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--text-secondary)",
                cursor: "pointer",
                font: "inherit",
              },
            },
            `${showRevoked ? "Hide" : "Show"} revoked invites (${revokedTokens.length})`,
          ),
          showRevoked &&
            h(
              "div",
              { role: "list", style: { display: "grid", gap: "var(--space-1)" } },
              ...revokedTokens.map((t) =>
                h(
                  "div",
                  { key: t.id, role: "listitem" },
                  h(Note, null, `${t.label} · ${t.agentCount ?? 0}/${t.maxAgents} agents · revoked`),
                ),
              ),
            ),
        ),
    );
  }

  function StatusPill({ tone, children }) {
    const color =
      tone === "ok"
        ? "var(--text-success, #2f9e44)"
        : tone === "bad"
          ? "var(--text-danger, #e03131)"
          : "var(--text-secondary)";
    return h(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "2px 10px",
          borderRadius: "999px",
          border: "1px solid var(--border-standard)",
          fontSize: "0.8rem",
          color,
        },
      },
      h("span", {
        "aria-hidden": "true",
        style: { width: "7px", height: "7px", borderRadius: "50%", background: color },
      }),
      children,
    );
  }

  return function ServerCard() {
    const state = React.useSyncExternalStore(client.subscribe, client.snapshot);
    const [info, setInfo] = React.useState();
    const [error, setError] = React.useState("");
    const [checking, setChecking] = React.useState(false);

    const configured = Boolean(storedMachines().length || storedUrl());

    const check = async () => {
      if (!configured) return;
      setError("");
      setChecking(true);
      try {
        await client.reconnect();
        const [hello, list] = await Promise.all([client.call("hello"), client.call("list")]);
        setInfo({ hello, list });
      } catch (e) {
        setInfo(undefined);
        setError(String(e.message ?? e));
      } finally {
        setChecking(false);
      }
    };

    React.useEffect(() => {
      void check();
      // biome-ignore lint: check once on open
    }, []);

    const machine = activeMachine();
    const hello = info?.hello;
    const agents = info?.list?.agents ?? [];
    const isGuest = hello?.role === "guest";
    const isAdmin = hello?.role === "admin";
    const online = Boolean(hello);
    const runtimes = (hello?.runtimes ?? []).filter((r) => r.available !== false).map((r) => r.title);
    const hostName = hello?.host || machine?.name || "Remote machine";

    if (!configured) {
      return h(
        "div",
        { style: { ...panelBox, justifyItems: "start" } },
        h("strong", null, "No machine connected"),
        h(
          Note,
          null,
          "Connect a machine running buzz-host, or paste an invite link a friend sent you, to run agents on it.",
        ),
        h(Button, { variant: "primary", onClick: openMachines }, "Connect a machine"),
      );
    }

    const subtitle = !online
      ? error || (checking ? "Checking the connection…" : `Connection: ${state.status}`)
      : isGuest
        ? `Guest account${hello.label ? `: ${hello.label}` : ""} · ${agents.length}/${hello.limits?.maxAgents ?? 2} agents · max ${hello.limits?.maxConcurrency ?? 2} parallel chats${
            hello.limits?.allowHostDesktop
              ? " · remote desktop enabled"
              : hello.limits?.allowSandboxDesktop
                ? " · sandboxed desktop enabled"
                : ""
          }`
        : `${agents.length} agent${agents.length === 1 ? "" : "s"}${runtimes.length ? ` · ${runtimes.join(", ")}` : ""}`;

    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3)" } },
      h(
        "div",
        { role: "status", style: { ...panelBox, gap: "var(--space-2)" } },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 } },
            h("strong", null, hostName),
            h(
              StatusPill,
              { tone: online ? "ok" : checking ? undefined : "bad" },
              online ? "Online" : checking ? "Checking" : "Offline",
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: "var(--space-2)" } },
            !online && !checking && h(Button, { onClick: () => void check() }, "Retry"),
            h(Button, { onClick: openMachines }, "Manage machines"),
          ),
        ),
        h(Note, { tone: !online && error ? "error" : undefined }, subtitle),
      ),
      online &&
        h(
          "details",
          null,
          h("summary", { style: { cursor: "pointer" } }, "Connection details"),
          h(
            "div",
            { style: { display: "grid", gap: "var(--space-1)", paddingTop: "var(--space-2)" } },
            h(
              Note,
              null,
              `Host ${hello.host}${hello.role ? ` (${hello.role})` : ""} · ${state.routeType || "wss"} · ${state.status}`,
            ),
            state.url && h(Note, null, state.url.split("#")[0]),
            h(
              Note,
              null,
              `Runtimes: ${(hello.runtimes ?? [])
                .map((r) => `${r.title}${r.available ? "" : " (missing)"}`)
                .join(", ") || "none"}`,
            ),
            Array.isArray(hello.runners) &&
              h(
                Note,
                null,
                `Runners: ${hello.runners
                  .map((r) => `${r.title}${r.available ? "" : " (unavailable)"}`)
                  .join(", ")}`,
              ),
            agents.length > 0 &&
              h(
                Note,
                null,
                agents
                  .map((a) => {
                    const extra = [
                      a.runner && a.runner !== "host" ? a.runner : "",
                      a.respondTo && a.respondTo !== "owner-only" ? a.respondTo : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return `• ${a.name} — ${a.runtime}${a.model ? `/${a.model}` : ""}${extra ? ` [${extra}]` : ""} — ${a.status}`;
                  })
                  .join("\n"),
              ),
          ),
        ),
      isAdmin && h(SharedAccess, { publicGuestUrl: hello.publicGuestUrl }),
    );
  };
}
