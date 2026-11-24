// Seamless 1:1 DM guest invites: structured invite formatting/parsing,
// recipient-side automatic Accept & Connect overlay modal, and inline DM card.

import {
  setStoredToken,
  setStoredUrl,
  storedToken,
  storedUrl,
} from "./config.js";

export const INVITE_FENCE = "buzz-host-invite";
export const INVITE_STATE_KEY = "local.buzz-host.invite-state.v1";
export const INVITE_MAX_AGE_SECS = 7 * 24 * 60 * 60;

const HEX64 = /^[0-9a-f]{64}$/i;
const TOKEN_RE = /^bhg_[0-9a-fA-F]{16,}$/;
const FENCE_RE = /```buzz-host-invite[ \t]*\r?\n([\s\S]*?)\r?\n```/;
const MAX_STORED_DECISIONS = 100;

const decisionListeners = new Set();

function notifyDecisionListeners() {
  for (const fn of [...decisionListeners]) {
    try {
      fn();
    } catch {}
  }
}

export function subscribeInviteDecisions(listener) {
  decisionListeners.add(listener);
  return () => decisionListeners.delete(listener);
}

function readDecisionMap() {
  try {
    const raw = localStorage.getItem(INVITE_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDecisionMap(map) {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, MAX_STORED_DECISIONS);
    localStorage.setItem(INVITE_STATE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

export function getInviteDecision(messageId) {
  if (!messageId) return undefined;
  const entry = readDecisionMap()[messageId];
  const status = typeof entry === "string" ? entry : entry?.status;
  return status === "accepted" || status === "declined" ? status : undefined;
}

export function setInviteDecision(messageId, status) {
  if (!messageId || (status !== "accepted" && status !== "declined")) return;
  const map = readDecisionMap();
  map[messageId] = { status, at: Date.now() };
  writeDecisionMap(map);
  notifyDecisionListeners();
}

export function extractHost(url) {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "wss:") return "";
    return parsed.host;
  } catch {
    return "";
  }
}

function normalizeWsUrl(raw) {
  const clean = String(raw ?? "").trim().replace(/#.*$/, "");
  if (!clean) return "";
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "wss:") return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function formatInviteMessage({ url, token, label, ownerPubkey }) {
  const cleanUrl = normalizeWsUrl(url);
  if (!cleanUrl) throw new Error("Guest invite requires a valid wss:// server URL.");
  const cleanToken = String(token ?? "").trim();
  if (!TOKEN_RE.test(cleanToken)) throw new Error("Guest invite requires a valid access token.");
  const host = extractHost(cleanUrl);
  const payload = { v: 1, url: cleanUrl, token: cleanToken, host };
  const cleanLabel = String(label ?? "").trim().slice(0, 80);
  if (cleanLabel) payload.label = cleanLabel;
  const cleanPubkey = String(ownerPubkey ?? "").trim().toLowerCase();
  if (cleanPubkey) {
    if (!HEX64.test(cleanPubkey)) throw new Error("ownerPubkey must be a 64-character hex pubkey.");
    payload.ownerPubkey = cleanPubkey;
  }
  return [
    `Remote Agents invite — connect to hosted agents on \`${host}\``,
    "",
    `\`\`\`${INVITE_FENCE}`,
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

export function parseInviteMessage(content) {
  if (typeof content !== "string" || !content.includes(INVITE_FENCE)) return null;
  const match = FENCE_RE.exec(content);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.v !== 1) return null;
  const url = normalizeWsUrl(data.url);
  if (!url) return null;
  const token = typeof data.token === "string" ? data.token.trim() : "";
  if (!TOKEN_RE.test(token)) return null;
  let ownerPubkey;
  if (data.ownerPubkey !== undefined && data.ownerPubkey !== null && data.ownerPubkey !== "") {
    if (typeof data.ownerPubkey !== "string" || !HEX64.test(data.ownerPubkey.trim())) return null;
    ownerPubkey = data.ownerPubkey.trim().toLowerCase();
  }
  const label = typeof data.label === "string" ? data.label.trim().slice(0, 80) : "";
  const host = extractHost(url);
  return {
    v: 1,
    url,
    token,
    host,
    ...(label ? { label } : {}),
    ...(ownerPubkey ? { ownerPubkey } : {}),
  };
}

export function isOneToOneDm(channel) {
  return Boolean(
    channel &&
      channel.channelType === "dm" &&
      !channel.archived &&
      Array.isArray(channel.participants) &&
      channel.participants.length === 1,
  );
}

export function isInviteForViewer(invite, viewer, authorId) {
  if (!invite || typeof viewer !== "string" || !viewer) return false;
  const me = viewer.toLowerCase();
  if (typeof authorId === "string" && authorId.toLowerCase() === me) return false;
  if (invite.ownerPubkey && invite.ownerPubkey.toLowerCase() !== me) return false;
  return true;
}

export function isAlreadyConfigured(invite, currentUrl = storedUrl(), currentToken = storedToken()) {
  if (!invite) return false;
  return normalizeWsUrl(currentUrl) === normalizeWsUrl(invite.url) && String(currentToken ?? "").trim() === invite.token;
}

export async function sendInviteDm(session, recipientPubkey, inviteMessage, signal) {
  const cleanKey = String(recipientPubkey ?? "").trim().toLowerCase();
  if (!HEX64.test(cleanKey)) throw new Error("Choose a valid community member.");
  if (!session?.directMessages?.open || !session?.messages?.send) {
    throw new Error("Direct messages are unavailable on this connection.");
  }
  const activeSignal = signal ?? new AbortController().signal;
  const channelId = await session.directMessages.open([cleanKey], activeSignal);
  const eventId = session.messages.send(channelId, inviteMessage);
  if (eventId && typeof session.directMessages.delivered === "function") {
    await session.directMessages.delivered(eventId, channelId, activeSignal);
  }
  return { channelId, eventId };
}

export async function acceptInvite(client, invite, messageId) {
  if (!invite) throw new Error("Invalid invite.");
  const prevUrl = storedUrl();
  const prevToken = storedToken();
  setStoredUrl(invite.url);
  setStoredToken(invite.token);
  try {
    await client.reconnect();
    const hello = await client.call("hello");
    if (messageId) setInviteDecision(messageId, "accepted");
    return { hello };
  } catch (error) {
    setStoredUrl(prevUrl);
    setStoredToken(prevToken);
    void client.reconnect().catch(() => {});
    throw error;
  }
}

function findChannel(session, channelId) {
  if (!session?.channels || !channelId) return undefined;
  const listed = session.channels.list?.()?.channels;
  if (Array.isArray(listed)) {
    const found = listed.find((c) => c.id === channelId);
    if (found) return found;
  }
  return session.channels.get?.(channelId);
}

function senderDisplayName(session, pubkey) {
  if (!pubkey) return "A community member";
  const profile = session?.profiles?.snapshot?.()?.get(pubkey);
  if (profile?.name) return profile.name;
  if (profile?.username) return profile.username;
  return `${pubkey.slice(0, 8)}…`;
}

export function createInviteFeature({ React, client, relay, uiKit, Btn }) {
  const { h, Note } = uiKit;

  function useRelaySnapshot() {
    return React.useSyncExternalStore(
      (onStoreChange) => (relay?.subscribe ? relay.subscribe(onStoreChange) : () => {}),
      () => relay?.snapshot?.() ?? { status: "disconnected" },
    );
  }

  function useDecision(messageId) {
    return React.useSyncExternalStore(
      subscribeInviteDecisions,
      () => getInviteDecision(messageId),
    );
  }

  function useProfileName(session, pubkey) {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      if (!session?.profiles || !pubkey) return undefined;
      void session.profiles.ensure?.([pubkey], "background")?.catch?.(() => {});
      return session.profiles.subscribe?.(() => setTick((t) => t + 1));
    }, [session, pubkey]);
    return senderDisplayName(session, pubkey);
  }

  function InviteOverlay() {
    const relaySnap = useRelaySnapshot();
    const session = relaySnap?.status === "ready" ? relaySnap.session : undefined;
    const viewer = relaySnap?.status === "ready" ? relaySnap.viewer : undefined;
    const [queue, setQueue] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [connected, setConnected] = React.useState(null);
    const dismissedThisRunRef = React.useRef(new Set());

    const enqueue = React.useCallback((entry) => {
      if (!entry?.messageId || dismissedThisRunRef.current.has(entry.messageId)) return;
      if (getInviteDecision(entry.messageId)) return;
      if (isAlreadyConfigured(entry.invite)) return;
      setQueue((prev) => {
        if (prev.some((item) => item.messageId === entry.messageId)) return prev;
        return [entry, ...prev].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      });
    }, []);

    // Drop queued entries if accepted/declined elsewhere (e.g. via the inline DM card).
    React.useEffect(
      () =>
        subscribeInviteDecisions(() => {
          setQueue((prev) => prev.filter((item) => !getInviteDecision(item.messageId)));
        }),
      [],
    );

    // Live incoming 1:1 DM listener + startup scan of recent/unread 1:1 DMs.
    React.useEffect(() => {
      if (!session || !viewer) return undefined;
      let disposed = false;
      const awaitingChannel = new Map();
      const windowStops = new Set();

      const tryAdmit = (channelId, messageId, authorId, content, createdAt) => {
        const invite = parseInviteMessage(content);
        if (!invite || !isInviteForViewer(invite, viewer, authorId)) return;
        if (getInviteDecision(messageId) || isAlreadyConfigured(invite)) return;
        const ch = findChannel(session, channelId);
        if (ch) {
          if (isOneToOneDm(ch)) {
            enqueue({ channelId, messageId, authorId, invite, createdAt: createdAt || 0 });
          }
          return;
        }
        // Brand-new DM: wait for the channel roster entry to land.
        awaitingChannel.set(messageId, { channelId, messageId, authorId, invite, createdAt: createdAt || 0 });
        session.channels?.ensureList?.();
      };

      const flushAwaiting = () => {
        if (disposed || awaitingChannel.size === 0) return;
        for (const [id, item] of [...awaitingChannel.entries()]) {
          const ch = findChannel(session, item.channelId);
          if (!ch) continue;
          awaitingChannel.delete(id);
          if (isOneToOneDm(ch)) enqueue(item);
        }
      };

      const stopIncoming = session.subscribeIncoming?.((messages) => {
        if (disposed || !Array.isArray(messages)) return;
        for (const msg of messages) {
          if (!msg?.channelId || !msg?.messageId) continue;
          tryAdmit(msg.channelId, msg.messageId, msg.authorId, msg.previewContent, msg.createdAt);
        }
      });

      const scannedDms = new Set();
      const scanDmWindow = (channelId) => {
        if (disposed || scannedDms.has(channelId) || !session.channels?.window) return;
        scannedDms.add(channelId);
        const nowSecs = Math.floor(Date.now() / 1000);
        const inspect = () => {
          if (disposed) return true;
          const win = session.channels.window(channelId);
          if (!win || win.status === "idle" || win.status === "loading") return false;
          if (win.status === "ready" && Array.isArray(win.rows)) {
            const recentInvites = [];
            for (const row of win.rows) {
              if (!row?.id || !row?.content) continue;
              if (row.createdAt && nowSecs - row.createdAt > INVITE_MAX_AGE_SECS) continue;
              const invite = parseInviteMessage(row.content);
              if (!invite || !isInviteForViewer(invite, viewer, row.authorId)) continue;
              recentInvites.push({
                channelId,
                messageId: row.id,
                authorId: row.authorId,
                invite,
                createdAt: row.createdAt || 0,
              });
            }
            recentInvites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const newest = recentInvites[0];
            if (newest && !getInviteDecision(newest.messageId) && !isAlreadyConfigured(newest.invite)) {
              enqueue(newest);
            }
          }
          return true;
        };
        session.channels.ensure?.(channelId);
        if (inspect()) return;
        let stopWin;
        const timer = setTimeout(() => {
          stopWin?.();
          windowStops.delete(cleanup);
        }, 10000);
        const cleanup = () => {
          clearTimeout(timer);
          stopWin?.();
          windowStops.delete(cleanup);
        };
        stopWin = session.channels.subscribeWindow?.(channelId, () => {
          if (inspect()) cleanup();
        });
        windowStops.add(cleanup);
      };

      const scanDms = () => {
        if (disposed || !session.channels?.list) return;
        flushAwaiting();
        const list = session.channels.list();
        if (list?.status !== "ready" || !Array.isArray(list.channels)) return;
        const nowSecs = Math.floor(Date.now() / 1000);
        const hasConfiguredServer = Boolean(storedUrl().trim());
        const dms = list.channels
          .filter((ch) => isOneToOneDm(ch))
          .filter((ch) => {
            const unreadCount = session.unread?.snapshot?.({ kind: "channel", channelId: ch.id })?.observedCount ?? 0;
            if (unreadCount > 0) return true;
            if (hasConfiguredServer) return false;
            return !ch.lastActivityAt || nowSecs - ch.lastActivityAt <= INVITE_MAX_AGE_SECS;
          })
          .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
          .slice(0, 5);
        for (const dm of dms) scanDmWindow(dm.id);
      };

      const stopList = session.channels?.subscribeList?.(scanDms);
      session.channels?.ensureList?.();
      scanDms();

      return () => {
        disposed = true;
        stopIncoming?.();
        stopList?.();
        for (const cleanup of [...windowStops]) cleanup();
        windowStops.clear();
      };
    }, [session, viewer, enqueue]);

    const active = queue[0];
    const senderName = useProfileName(session, active?.authorId);

    const dismissForNow = React.useCallback(() => {
      if (busy) return;
      if (connected) {
        setConnected(null);
        setError("");
        return;
      }
      if (!active) return;
      dismissedThisRunRef.current.add(active.messageId);
      setError("");
      setQueue((prev) => prev.filter((item) => item.messageId !== active.messageId));
    }, [active, busy, connected]);

    React.useEffect(() => {
      if (!active && !connected) return undefined;
      const onKey = (e) => {
        if (e.key === "Escape") dismissForNow();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [active, connected, dismissForNow]);

    if (!active && !connected) return null;

    const handleAccept = async () => {
      if (!active || busy) return;
      setBusy(true);
      setError("");
      try {
        const { hello } = await acceptInvite(client, active.invite, active.messageId);
        setQueue((prev) => prev.filter((item) => item.messageId !== active.messageId));
        setConnected({ host: active.invite.host, label: hello?.label || active.invite.label || "" });
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const handleDecline = () => {
      if (!active || busy) return;
      setInviteDecision(active.messageId, "declined");
      setError("");
      setQueue((prev) => prev.filter((item) => item.messageId !== active.messageId));
    };

    const existingUrl = storedUrl().trim();
    const replacingExisting = Boolean(
      active && existingUrl && normalizeWsUrl(existingUrl) !== normalizeWsUrl(active.invite.url),
    );

    return h(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Remote Agents invite",
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-4, 16px)",
          background: "rgba(0, 0, 0, 0.52)",
          backdropFilter: "blur(2px)",
        },
        onClick: (e) => {
          if (e.target === e.currentTarget) dismissForNow();
        },
      },
      h(
        "div",
        {
          style: {
            width: "min(440px, 100%)",
            display: "grid",
            gap: "var(--space-3, 12px)",
            padding: "var(--space-5, 20px)",
            borderRadius: "var(--radius-modal, 14px)",
            background: "var(--surface-elevated, var(--surface-panel, #1e1e22))",
            color: "var(--text-standard)",
            border: "1px solid var(--border-standard)",
            boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" } },
          h("strong", { style: { fontSize: "1.05rem" } }, connected ? "Connected to Remote Agents" : "Remote Agents invite"),
          h(
            "button",
            {
              type: "button",
              "aria-label": "Close",
              disabled: busy,
              onClick: dismissForNow,
              style: {
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: busy ? "default" : "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
                padding: "4px 6px",
              },
            },
            "×",
          ),
        ),
        connected
          ? h(
              React.Fragment,
              null,
              h(
                Note,
                null,
                `Connected to ${connected.host}${connected.label ? ` as ${connected.label}` : ""}. You can now create hosted agents in Agents → New agent.`,
              ),
              h(
                "div",
                { style: { display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" } },
                h(Btn, { variant: "primary", onClick: dismissForNow }, "Done"),
              ),
            )
          : h(
              React.Fragment,
              null,
              h(
                "p",
                { style: { margin: 0, lineHeight: 1.5 } },
                h("strong", null, senderName),
                " invited you to host agents on ",
                h("code", null, active.invite.host),
                ".",
              ),
              h(
                Note,
                null,
                "Clicking Accept & Connect configures Remote Agents automatically so you can create agents in Agents → New agent.",
              ),
              replacingExisting &&
                h(
                  Note,
                  null,
                  `Note: this will replace your current Remote Agents server (${extractHost(existingUrl) || existingUrl}).`,
                ),
              error && h(Note, { tone: "error" }, error),
              h(
                "div",
                { style: { display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-1)" } },
                h(Btn, { variant: "subtle", disabled: busy, onClick: handleDecline }, "Decline"),
                h(
                  Btn,
                  { variant: "primary", disabled: busy, onClick: () => void handleAccept() },
                  busy ? "Connecting…" : "Accept & Connect",
                ),
              ),
            ),
      ),
    );
  }

  function InviteMessageCard({ message }) {
    const relaySnap = useRelaySnapshot();
    const session = relaySnap?.status === "ready" ? relaySnap.session : undefined;
    const viewer = relaySnap?.status === "ready" ? relaySnap.viewer : undefined;
    const clientSnap = React.useSyncExternalStore(client.subscribe, client.snapshot);
    const decision = useDecision(message?.id);
    const [, setListTick] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [okNote, setOkNote] = React.useState("");
    const senderName = useProfileName(session, message?.authorId);

    React.useEffect(() => {
      if (!session?.channels?.subscribeList) return undefined;
      return session.channels.subscribeList(() => setListTick((t) => t + 1));
    }, [session]);

    const invite = parseInviteMessage(message?.content);
    if (!invite) return null;

    const channel = findChannel(session, message?.channelId);
    const channelKnown = Boolean(channel);
    const isDm = isOneToOneDm(channel);
    const isOwn = Boolean(viewer && message?.authorId && message.authorId.toLowerCase() === viewer.toLowerCase());
    const wrongRecipient = Boolean(
      !isOwn && invite.ownerPubkey && viewer && invite.ownerPubkey.toLowerCase() !== viewer.toLowerCase(),
    );
    const configuredNow = isAlreadyConfigured(invite, clientSnap?.url || storedUrl(), storedToken());

    const handleAccept = async () => {
      if (busy) return;
      setBusy(true);
      setError("");
      setOkNote("");
      try {
        const { hello } = await acceptInvite(client, invite, message.id);
        setOkNote(
          `Connected to ${invite.host}${hello?.label ? ` as ${hello.label}` : ""}. Create agents in Agents → New agent.`,
        );
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const handleDecline = () => {
      if (busy) return;
      setInviteDecision(message.id, "declined");
      setError("");
      setOkNote("");
    };

    const statusBadge = isOwn
      ? "Sent"
      : configuredNow || decision === "accepted"
        ? "Connected ✓"
        : decision === "declined"
          ? "Declined"
          : "";

    return h(
      "div",
      {
        style: {
          maxWidth: "420px",
          display: "grid",
          gap: "var(--space-2, 8px)",
          padding: "var(--space-3, 12px)",
          borderRadius: "var(--radius-control, 10px)",
          background: "var(--surface-inset)",
          border: "1px solid var(--border-standard)",
        },
      },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" } },
        h("strong", null, isOwn ? "Remote Agents invite sent" : "Remote Agents invite"),
        statusBadge &&
          h(
            "span",
            {
              className: "text-body-sm text-secondary",
              style: { fontWeight: 600 },
            },
            statusBadge,
          ),
      ),
      isOwn
        ? h(
            Note,
            null,
            `Server: ${invite.host}${invite.label ? ` · For ${invite.label}` : ""}. Their Buzz app will prompt them to accept & connect.`,
          )
        : !channelKnown
          ? h(Note, null, `Server: ${invite.host} — loading conversation…`)
          : !isDm
            ? h(
                Note,
                { tone: "error" },
                "For safety, Remote Agents invites can only be accepted in a 1:1 direct message.",
              )
          : wrongRecipient
            ? h(Note, null, "This invite is bound to a different Buzz account.")
            : h(
                React.Fragment,
                null,
                h(
                  Note,
                  null,
                  configuredNow
                    ? `Connected to ${invite.host}.`
                    : `${senderName} invited you to host agents on ${invite.host}.`,
                ),
                okNote && h(Note, null, okNote),
                error && h(Note, { tone: "error" }, error),
                h(
                  "div",
                  { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
                  configuredNow
                    ? h(
                        Btn,
                        { variant: "subtle", size: "sm", disabled: busy, onClick: () => void handleAccept() },
                        busy ? "Reconnecting…" : "Reconnect",
                      )
                    : h(
                        React.Fragment,
                        null,
                        h(
                          Btn,
                          { variant: "primary", size: "sm", disabled: busy, onClick: () => void handleAccept() },
                          busy ? "Connecting…" : "Accept & Connect",
                        ),
                        decision !== "declined" &&
                          h(
                            Btn,
                            { variant: "subtle", size: "sm", disabled: busy, onClick: handleDecline },
                            "Decline",
                          ),
                      ),
                ),
              ),
    );
  }

  return {
    InviteOverlay,
    InviteMessageCard,
    matchesInviteMessage: (message) => Boolean(parseInviteMessage(message?.content)),
  };
}
