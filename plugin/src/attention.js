// Attention tab: native attentionTab adapter and fallback UI.
// buzz-host runs Buzz's Attention for the agent. This tab renders the same
// markup and classes as Buzz's own Attention tab (bundled plugin
// buzz.watching, buzz-app src/bundled/watching), whose stylesheet the app
// loads globally, so a remote agent's tab looks and behaves like a local
// one's: Interest cards with a status menu, a Triggers / Sources / Responds
// in / Status table, rows that open to Watch details and Activity, and
// delete confirmations. buzz-host adds the on/off switch (a remote agent
// restarts to gain or lose its tools) and a list of recent wakes.
import { createMarkdown } from "./markdown.js";

export const relative = (at) => {
  if (!at) return "";
  const secs = Math.round(Date.now() / 1000 - at);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
};

export const titleOf = (id) => id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Buzz's presentation.ts: an id as words, and a heading's plain text. */
export const words = (id) => id.replace(/-(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32,64})$/i, "").replace(/[-_]+/g, " ");
export const plain = (value) => value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#+\s*/, "").replace(/\*\*|__|`/g, "").trim();

/** Buzz's timer line: "Once · today 4:16 AM (in 2m)" or "Every 1h · 3 runs". */
export function schedule(w) {
  if (w.maxOccurrences === 1 && w.nextDue) {
    const next = new Date(w.nextDue * 1000);
    const day = next.toDateString() === new Date().toDateString() ? "today" : next.toLocaleDateString();
    const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const minutes = Math.ceil(Math.abs(w.nextDue - Date.now() / 1000) / 60);
    return `Once · ${day} ${time} (${w.nextDue > Date.now() / 1000 ? `in ${minutes}m` : `${minutes}m ago`})`;
  }
  const s = w.interval;
  const every = s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
  return `Every ${every}${w.maxOccurrences ? ` · ${w.maxOccurrences} runs` : ""}`;
}

export const WAKE_OUTCOME = { ok: "done", error: "failed", cancelled: "stopped", timeout: "timed out", lost: "lost", dropped: "dropped (busy)" };

export function createAttention({ React, client, ctx, Btn, Icon, relay = ctx.reflect?.get?.("relay") }) {
  const h = React.createElement;
  const { InstructionsMarkdown } = createMarkdown({ React });

  /** Closes on a click outside `ref` or Escape; `close` gets "outside" or "escape". */
  function useDismiss(open, ref, close) {
    React.useEffect(() => {
      if (!open) return undefined;
      const down = (event) => {
        if (ref.current && !ref.current.contains(event.target)) close("outside");
      };
      const key = (event) => event.key === "Escape" && close("escape");
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("keydown", key);
      return () => {
        document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("keydown", key);
      };
    }, [open, ref, close]);
  }

  /** Buzz's compact menu: a heading, then items; `items` are {label, onClick, tone, disabled} or "separator" / {note}. */
  function Menu({ trigger, label, heading, items }) {
    const [open, setOpen] = React.useState(false);
    const [hover, setHover] = React.useState(-1);
    const ref = React.useRef(null);
    const close = React.useCallback(() => setOpen(false), []);
    useDismiss(open, ref, close);
    return h(
      "span",
      { ref, style: { position: "relative", display: "inline-flex" } },
      trigger({ onClick: () => setOpen(!open), "aria-expanded": open, "aria-haspopup": "menu" }),
      open &&
        h(
          "div",
          { className: "buzz-menu-positioner", style: { position: "absolute", insetInlineEnd: 0, insetBlockStart: "calc(100% + var(--space-1))" } },
          h(
            "div",
            { "data-buzz-ui": "", "data-size": "compact", className: "buzz-menu-popup text-body-sm", role: "menu", "aria-label": label },
            h(
              "div",
              { role: "group" },
              h("div", { className: "buzz-menu-group-label" }, heading),
              ...items.map((item, i) =>
                item === "separator"
                  ? h("div", { key: i, role: "separator", className: "buzz-menu-separator" })
                  : item.note
                    ? h("p", { key: i, className: "buzz-menu-note text-body-sm" }, item.note)
                    : h(
                        "div",
                        {
                          key: i,
                          role: "menuitem",
                          tabIndex: -1,
                          className: "buzz-menu-item",
                          "data-tone": item.tone,
                          "data-disabled": item.disabled ? "" : undefined,
                          "aria-disabled": item.disabled || undefined,
                          "data-highlighted": hover === i ? "" : undefined,
                          onMouseEnter: () => setHover(i),
                          onMouseLeave: () => setHover(-1),
                          onClick: () => {
                            if (item.disabled) return;
                            setOpen(false);
                            item.onClick();
                          },
                        },
                        item.label,
                      ),
              ),
            ),
          ),
        ),
    );
  }

  /** Buzz's Popover (Base UI, side bottom, offset 8): opens from its trigger
   * aligned to `align`, shifts or flips to stay in the window, takes focus,
   * and closes on Escape (focus back to the trigger) or a click outside. Base
   * UI renders it in a portal, so the panel around the tab never clips it;
   * without one, it is `position: fixed` at the trigger, kept there on scroll. */
  function Popover({ trigger, label, align = "end", children }) {
    const [open, setOpen] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const [side, setSide] = React.useState("bottom");
    const ref = React.useRef(null);
    const positioner = React.useRef(null);
    const popup = React.useRef(null);
    const close = React.useCallback((reason) => {
      setOpen(false);
      if (reason === "escape") ref.current?.querySelector("button")?.focus();
    }, []);
    useDismiss(open, ref, close);
    const place = React.useCallback(() => {
      const box = positioner.current;
      if (!box || !ref.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const { width, height } = box.getBoundingClientRect();
      const margin = 8;
      const offset = 8;
      const x = Math.max(margin, Math.min(align === "end" ? anchor.right - width : anchor.left, window.innerWidth - margin - width));
      const below = anchor.bottom + offset;
      const flip = below + height > window.innerHeight - margin && anchor.top - offset - height >= margin;
      const y = flip ? anchor.top - offset - height : below;
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      // A transformed ancestor makes `fixed` relative to itself: correct by where it landed.
      const landed = box.getBoundingClientRect();
      if (landed.left !== x || landed.top !== y) {
        box.style.left = `${2 * x - landed.left}px`;
        box.style.top = `${2 * y - landed.top}px`;
      }
      setSide(flip ? "top" : "bottom");
    }, [align]);
    React.useLayoutEffect(() => {
      if (!open) return undefined;
      place();
      popup.current?.focus({ preventScroll: true });
      const frame = requestAnimationFrame(() => setStarting(false));
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("scroll", place, true);
        window.removeEventListener("resize", place);
      };
    }, [open, place]);
    const toggle = () => {
      if (open) return close();
      setSide("bottom");
      setStarting(true);
      setOpen(true);
    };
    return h(
      "span",
      { ref, style: { position: "relative", display: "inline-flex", minWidth: 0, maxWidth: "100%" } },
      trigger({ onClick: toggle, "aria-expanded": open, "aria-haspopup": "dialog" }),
      open &&
        h(
          "div",
          { ref: positioner, className: "buzz-popover-positioner", style: { position: "fixed", left: 0, top: 0 } },
          h(
            "div",
            {
              ref: popup,
              role: "dialog",
              "aria-label": label,
              tabIndex: -1,
              "data-buzz-ui": "",
              "data-size": "default",
              "data-padding": "content",
              "data-side": side,
              "data-align": align,
              "data-open": "",
              "data-starting-style": starting ? "" : undefined,
              className: "buzz-popover-popup text-body ",
              style: { "--available-width": "calc(100vw - 16px)", "--available-height": "70vh", outline: "none" },
              // Stop Escape here, so it closes the popover and not the panel around it.
              onKeyDown: (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close("escape");
              },
            },
            children,
          ),
        ),
    );
  }

  /** Buzz's AlertDialog, for deletes. */
  const Confirm = ({ title, description, pending, error, onCancel, onConfirm }) =>
    h(
      React.Fragment,
      null,
      h("div", { "data-buzz-ui": "", "data-alert-dialog": "", className: "buzz-dialog-backdrop", onClick: onCancel }),
      h(
        "div",
        { "data-buzz-ui": "", className: "buzz-dialog gap-0", "data-size": "compact", "data-height": "content", role: "alertdialog", "aria-label": title },
        h(
          "header",
          { className: "buzz-dialog-header" },
          h(
            "div",
            { className: "buzz-dialog-heading" },
            h("h2", { className: "text-label" }, title),
            h("p", { className: "buzz-dialog-description" }, description),
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": "Close",
              "data-buzz-ui": "",
              className: "buzz-button",
              "data-variant": "subtle",
              "data-size": "compact",
              "data-button-shape": "icon",
              "data-icon-variant": "subtle",
              "data-icon-size": "compact",
              "data-icon-shape": "control",
              disabled: pending,
              onClick: onCancel,
            },
            h("span", { className: "buzz-button-label" }, h(Icon, { name: "x" })),
          ),
        ),
        error && h("div", { className: "buzz-dialog-body buzz-dialog-content flex flex-col gap-4" }, h("p", { role: "alert", className: "text-body-sm text-danger" }, error)),
        h(
          "div",
          { className: "buzz-dialog-actions" },
          h(Btn, { disabled: pending, onClick: onCancel, autoFocus: true }, "Cancel"),
          h(Btn, { variant: "destructive", disabled: pending, onClick: onConfirm }, pending ? "Deleting…" : "Delete"),
        ),
      ),
    );

  /** The status pill: a citrus dot when active. */
  const StatusPill = ({ active, label, ...props }) =>
    h(
      Btn,
      { variant: "subtle", size: "xs", style: { paddingInlineStart: "var(--space-2)" }, "aria-label": label, ...props },
      h(
        "span",
        { className: "attention-pill-icon" },
        h(Icon, {
          name: "circle",
          size: 12,
          filled: true,
          className: active ? undefined : "text-subtle",
          style: active ? { color: "var(--affordance-accent-prominent)" } : undefined,
        }),
      ),
      h("span", null, active ? "Active" : "Paused"),
    );

  /** Buzz's sonar illustration: rings, sweep, signals and the agent's picture. */
  function Sonar({ picture, name, size = "small" }) {
    const s = size === "large"
      ? { size: 160, avatar: 48, rings: 6, dot: 6, neutral: 4 }
      : { size: 64, avatar: 32, rings: 4, dot: 4, neutral: 2 };
    const signals = React.useMemo(
      () =>
        Array.from({ length: 12 }, (_, slot) => {
          const angle = ((slot + 0.15 + Math.random() * 0.7) / 12) * Math.PI * 2;
          const radius = 0.28 + Math.random() * 0.15;
          return { slot, angle, radius };
        }),
      [],
    );
    return h(
      "div",
      {
        className: "attention-sonar",
        "data-size": size,
        "aria-hidden": "true",
        style: {
          inlineSize: s.size,
          blockSize: s.size,
          "--sonar-period": "8s",
          "--sonar-avatar-size": `${s.avatar}px`,
          "--sonar-beam": "300deg",
          "--sonar-sweep-opacity": 0.16,
          "--sonar-ring-opacity": 0.16,
          "--sonar-dot-size": `${s.dot}px`,
          "--sonar-neutral-size": `${s.neutral}px`,
          "--sonar-dot-opacity": 1,
          "--sonar-dot-scale": 0.15,
          "--sonar-dot-ease": "cubic-bezier(0.43, 1, 0.32, 2)",
        },
      },
      ...Array.from({ length: s.rings }, (_, i) => h("div", { key: `r${i}`, className: "attention-sonar-ring", style: { inset: `${(i / s.rings) * 50}%` } })),
      h("div", { key: "sweep", className: "attention-sonar-sweep", "data-accent": "citrus", "data-palette": "citrus" }),
      ...signals.map(({ slot, angle, radius }) =>
        h(
          "div",
          {
            key: `s${slot}`,
            className: "attention-sonar-signal",
            "data-accent": "citrus",
            "data-citrus": slot % 2 === 1 || undefined,
            style: { left: `${50 + Math.sin(angle) * radius * 100}%`, top: `${50 - Math.cos(angle) * radius * 100}%`, "--sonar-delay": `${(angle / (Math.PI * 2)) * 8}s` },
          },
          h("span", { className: "attention-sonar-dot" }),
        ),
      ),
      h(
        "div",
        { key: "agent", className: "attention-sonar-agent" },
        h(
          "span",
          { className: "attention-sonar-portrait" },
          picture
            ? h("img", { src: picture, alt: "", style: { inlineSize: "100%", blockSize: "100%", objectFit: "cover", borderRadius: "inherit" } })
            : h("span", { className: "text-label" }, (name || "?").slice(0, 1)),
        ),
      ),
    );
  }

  /** Buzz's channel list, for names and icons, from the relay session. */
  function useChannels() {
    const none = React.useCallback(() => () => {}, []);
    const snap = React.useSyncExternalStore(relay?.subscribe ?? none, relay?.snapshot ?? (() => undefined));
    const queries = snap?.status === "ready" ? snap.session?.channels : undefined;
    React.useEffect(() => {
      try {
        return queries?.ensureList?.();
      } catch {
        return undefined;
      }
    }, [queries]);
    const empty = React.useMemo(() => ({ channels: [] }), []);
    const list = React.useSyncExternalStore(
      queries?.subscribeList ?? none,
      queries?.list ?? (() => empty),
    );
    return list?.channels ?? [];
  }

  function WatchRow({ w, interestPaused, agentName, name, channelOf, openConversation, act, busy }) {
    const [open, setOpen] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [error, setError] = React.useState("");
    const timer = w.type === "timer";
    const spent = timer && w.status === "spent";
    const active = w.enabled && !interestPaused && !spent && w.status !== "completed";
    // A nameless watch is labelled by its Interest, as in Buzz.
    const label = timer ? schedule(w) : plain(w.name || words(w.interest));
    const type = w.type === "event" ? "Messages" : timer ? "Schedule" : "Function";
    const destination = w.channel
      ? h(
          Btn,
          {
            variant: "outline",
            size: "xs",
            title: `Delivers to ${name(w.channel)}`,
            "aria-label": `Open reference ${name(w.channel)}`,
            onClick: () => openConversation?.(w.channel),
          },
          h(
            "span",
            { className: "attention-destination-label" },
            h(Icon, { name: channelOf(w.channel) }),
            h("span", { className: "attention-channel-name" }, `${name(w.channel)}${w.root ? " thread" : ""}`),
          ),
        )
      : h("span", { className: "text-caption text-subtle" }, "Independent turn");
    const technical =
      w.type === "event" &&
      Boolean(w.authors?.length || w.excludeAuthors?.length || w.kinds?.length !== 1 || w.kinds[0] !== 9);
    const meta = (rows) =>
      h(
        "dl",
        { className: "attention-expanded-meta text-body-sm" },
        ...rows.filter(Boolean).map(([dt, dd]) => h("div", { key: dt }, h("dt", { className: "text-subtle" }, dt), h("dd", null, dd))),
      );
    const watched = w.type === "event" ? (w.channels === "all" ? "all joined channels" : w.channels.map(name).join(", ")) : "";
    return h(
      "li",
      {
        className: "attention-card",
        "data-expanded": open || undefined,
        "data-disabled": !w.enabled || undefined,
        "data-paused": spent || !w.enabled ? "" : undefined,
      },
      h(
        "div",
        { className: "attention-table-row" },
        h(
          "button",
          { className: "attention-heading", type: "button", "aria-label": `Details for ${label}`, "aria-expanded": open, onClick: () => setOpen(!open) },
          h(Icon, { name: timer ? "clock" : "chat" }),
          h("span", { className: "attention-title text-body-sm text-primary", title: label }, label),
        ),
        !timer &&
          h(
            "div",
            { className: "attention-reference" },
            h(
              "div",
              { className: "attention-reference-item" },
              h(
                Popover,
                {
                  label: `Source details for ${label}`,
                  trigger: (props) =>
                    h(
                      Btn,
                      {
                        variant: "outline",
                        size: "xs",
                        style: { paddingInlineStart: "var(--space-2)" },
                        "aria-label": `Source details for ${label}`,
                        ...props,
                      },
                      h("span", { className: "attention-pill-icon" }, h(Icon, { name: w.type === "event" ? "hash" : "bolt", size: 12 })),
                      h(
                        "span",
                        { className: "attention-reference-label" },
                        w.type !== "event"
                          ? type
                          : w.channels === "all"
                            ? "All channels"
                            : w.channels.length === 1
                              ? name(w.channels[0])
                              : `${w.channels.length} channels`,
                      ),
                    ),
                },
                h(
                  "div",
                  { className: "attention-popover-content" },
                  w.type === "event"
                    ? h(
                        "dl",
                        { className: "attention-expanded-meta attention-channel-table text-body-sm" },
                        h(
                          "div",
                          null,
                          h("dt", { className: "text-subtle" }, "Watches"),
                          h(
                            "dd",
                            null,
                            w.channels === "all"
                              ? "All joined channels"
                              : w.channels.map((channel) =>
                                  h("div", { key: channel, className: "attention-destination-label" }, h(Icon, { name: channelOf(channel) }), name(channel)),
                                ),
                          ),
                        ),
                        h(
                          "div",
                          null,
                          h("dt", { className: "text-subtle" }, "Delivers to"),
                          h("dd", null, w.channel ? `${name(w.channel)}${w.root ? " thread" : ""}` : "Independent turn"),
                        ),
                      )
                    : h(
                        "dl",
                        { className: "attention-expanded-meta attention-channel-table text-body-sm" },
                        h("div", null, h("dt", { className: "text-caption text-subtle" }, type), h("dd", null, w.summary)),
                      ),
                ),
              ),
            ),
          ),
        h("div", { className: "attention-destination" }, destination),
        h(
          "div",
          { className: "attention-status" },
          h(Menu, {
            label: `Watch status for ${label}`,
            heading: "Trigger",
            trigger: (props) => h(StatusPill, { active, label: `Watch status for ${label}`, ...props }),
            items: [
              {
                label: w.enabled ? "Pause" : "Resume",
                disabled: busy || (timer && !w.enabled),
                onClick: () => act(`we:${w.id}`, "attention.edit", { op: "enableWatch", id: w.id, enabled: !w.enabled }).catch((e) => setError(e.message)),
              },
              "separator",
              { label: "Delete", tone: "danger", disabled: busy, onClick: () => setConfirming(true) },
              interestPaused && { note: "This interest is paused. Resume it to run enabled watches." },
              timer && !w.enabled && { note: `Ask ${agentName} to set this timer’s next run.` },
            ].filter(Boolean),
          }),
        ),
      ),
      confirming &&
        h(Confirm, {
          title: timer ? "Delete this timer?" : "Delete this watch?",
          description: `This deletes the ${timer ? "timer" : "watch"}. The agent will stop watching for this trigger. This cannot be undone.`,
          pending: busy,
          error,
          onCancel: () => setConfirming(false),
          onConfirm: () =>
            act(`rw:${w.id}`, "attention.edit", { op: "removeWatch", id: w.id })
              .then(() => setConfirming(false))
              .catch((e) => setError(e.message)),
        }),
      !confirming && error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
      open &&
        h(
          "div",
          { className: "attention-expansion" },
          h(
            "div",
            { className: "attention-details" },
            h(
              "details",
              { className: "attention-watch-details" },
              h(
                "summary",
                { className: "attention-disclosure text-body-sm text-subtle", "aria-label": `Watch details for ${label}` },
                h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "gear" })),
                h("span", { className: "whitespace-nowrap" }, "Watch details"),
                h("span", { className: "attention-detail-preview" }, `${type} · ${w.type === "event" ? (w.classifier ? "Filtered messages" : "All messages") : timer ? label : w.summary}`),
                h(Icon, { name: "caret" }),
              ),
              h(
                "div",
                { className: "attention-configuration" },
                meta([
                  ["Source", type],
                  ["Runs in", w.channel ? `${name(w.channel)}${w.root ? " thread" : ""}` : "Independent turn"],
                  w.lastWokeAt && ["Last woke", relative(w.lastWokeAt)],
                ]),
                meta([
                  [
                    "Trigger",
                    w.type === "event"
                      ? `New messages in ${watched}${w.classifier ? ", filtered for relevance" : ""}.`
                      : timer
                        ? `${label}. ${w.prompt}`
                        : w.summary,
                  ],
                ]),
                w.type === "event" &&
                  (technical || w.classifier || w.isReply != null) &&
                  meta([
                    [
                      "Filters",
                      h(
                        "div",
                        { className: "text-body-sm" },
                        w.isReply != null && h("p", null, w.isReply ? "Replies only" : "Top-level messages only"),
                        w.classifier && h("p", null, "A relevance question (not run on this host: matching messages pass unchecked)"),
                        technical &&
                          h(
                            "details",
                            null,
                            h("summary", { className: "attention-disclosure text-body-sm text-subtle" }, "Technical filters", h(Icon, { name: "caret" })),
                            h(
                              "pre",
                              { className: "text-caption text-standard" },
                              JSON.stringify({ kinds: w.kinds?.length ? w.kinds : "all", authors: w.authors, exclude_authors: w.excludeAuthors }, null, 2),
                            ),
                          ),
                      ),
                    ],
                  ]),
                (w.catchingUp || w.waiting > 0) &&
                  meta([["On this host", [w.catchingUp && "catching up on missed messages", w.waiting > 0 && `${w.waiting} waiting`].filter(Boolean).join(" · ")]]),
              ),
            ),
            h(
              "details",
              { className: "attention-watch-activity" },
              h(
                "summary",
                { className: "attention-disclosure text-body-sm text-subtle", "aria-label": `Show activity for ${label}` },
                h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
                "Activity",
                h(
                  "span",
                  { className: "attention-detail-preview" },
                  w.activity?.length ? `${w.activity.length} event${w.activity.length === 1 ? "" : "s"}` : "No activity yet",
                ),
                h(Icon, { name: "caret" }),
              ),
              h(
                "ol",
                { className: "attention-timeline", "aria-label": `Activity for ${label}` },
                ...(w.activity ?? []).map((entry, i) =>
                  h(
                    "li",
                    { key: i, className: "attention-timeline-event" },
                    h(
                      "div",
                      { className: "attention-activity-row" },
                      h(Icon, { name: timer ? "clock" : "chat" }),
                      h(
                        "span",
                        { className: "attention-activity-summary text-body-sm text-secondary" },
                        (entry.type === "catch-up" ? `Caught up on ${entry.count} missed message${entry.count === 1 ? "" : "s"}${entry.skipped ? " (older skipped)" : ""} · ` : "") +
                          (entry.text || "Recorded event") +
                          (entry.outcome && entry.outcome !== "ok" ? ` · ${WAKE_OUTCOME[entry.outcome] ?? entry.outcome}` : !entry.outcome ? " · running…" : ""),
                      ),
                      h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(entry.at)),
                    ),
                  ),
                ),
                !w.activity?.length && h("li", null, h("p", { className: "text-body-sm text-subtle" }, "No activity yet")),
              ),
            ),
          ),
        ),
    );
  }

  function InterestCard({ interest, watches, agentName, name, channelOf, openConversation, act, busy }) {
    const [confirming, setConfirming] = React.useState(false);
    const [error, setError] = React.useState("");
    const label = interest.title || titleOf(interest.id);
    const remove = () =>
      act(`ri:${interest.id}`, "attention.edit", { op: "removeInterest", id: interest.id })
        .then(() => setConfirming(false))
        .catch((e) => setError(e.message));
    const firstLine = interest.instructions.split("\n").find((line) => line.trim() && !/^#+\s/.test(line)) || interest.instructions.split("\n").find((l) => l.trim()) || "";
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "cards" },
      h(
        "section",
        { className: "attention-interest", "aria-label": `Interest ${label}` },
        h(
          "div",
          { className: "attention-interest-head" },
          h("h4", { className: "text-label" }, label),
          h(
            "div",
            { className: "attention-actions" },
            h(Menu, {
              label: `Interest status for ${label}`,
              heading: "Interest",
              trigger: (props) => h(StatusPill, { active: !interest.paused, label: `Interest status for ${label}`, ...props }),
              items: [
                {
                  label: interest.paused ? "Resume" : "Pause",
                  disabled: busy,
                  onClick: () => act(`pause:${interest.id}`, "attention.edit", { op: "pause", id: interest.id, paused: !interest.paused }).catch((e) => setError(e.message)),
                },
                "separator",
                { label: "Delete", tone: "danger", disabled: busy, onClick: () => (watches.length ? setConfirming(true) : void remove()) },
              ],
            }),
          ),
        ),
        interest.summary && h("p", { className: "attention-interest-summary text-body-sm text-subtle" }, interest.summary),
        watches.length > 0
          ? h(
              "div",
              { className: "attention-column-headings text-caption text-subtle" },
              h("h5", { className: "text-caption" }, "Triggers"),
              h("span", null, "Sources"),
              h("span", null, "Responds in"),
              h("span", null, "Status"),
            )
          : h(
              React.Fragment,
              null,
              h("h5", { className: "attention-section-label text-caption text-subtle" }, "Triggers"),
              h("p", { className: "text-body-sm text-subtle" }, "No watches yet, so nothing wakes this interest."),
            ),
        h(
          "ul",
          { className: "attention-list", "aria-label": `${label} watches` },
          ...watches.map((w) =>
            h(WatchRow, { key: w.id, w, interestPaused: interest.paused, agentName, name, channelOf, openConversation, act, busy }),
          ),
        ),
        h("h5", { className: "attention-section-label text-caption text-subtle" }, "Instructions"),
        h(
          "details",
          { className: "attention-instructions" },
          h(
            "summary",
            { className: "attention-disclosure text-body-sm text-subtle" },
            h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "bolt" })),
            h("span", { className: "attention-instructions-preview" }, plain(firstLine)),
            h(Icon, { name: "caret" }),
          ),
          h(InstructionsMarkdown, { text: interest.instructions }),
        ),
        error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
      ),
      confirming &&
        h(Confirm, {
          title: `Delete ${label}?`,
          description: "This deletes the interest and all its watches. The agent will stop watching for these triggers. This cannot be undone.",
          pending: busy,
          error,
          onCancel: () => setConfirming(false),
          onConfirm: remove,
        }),
    );
  }

  // Buzz's own Attention tab (local Buzz patch 0005-attention-tab-for-hosted),
  // fed from buzz-host, which keeps the agent's attention in Buzz's record
  // format; this plugin's own tab otherwise.
  function AttentionTab(props) {
    let factory;
    try {
      const provided = ctx.reflect?.get?.("attentionTab");
      factory = provided?.version === 1 ? provided : undefined;
    } catch {}
    return factory ? h(NativeAttention, { ...props, factory }) : h(OwnAttentionTab, props);
  }

  /** buzz-host's view of one agent's Attention, as the source Buzz's tab
   * reads: snapshot (the agent in `running`, with its attention fields),
   * subscribe (polls while shown) and save (Buzz's AgentChange edits); and
   * `setting`, Buzz's Attention row for it: where it runs, and its switch. */
  function hostedAttention(pubkey) {
    let view;
    let agent;
    let error = "";
    let busy = false;
    let snapshot = Object.freeze({ status: "loading", classifier: "unavailable", running: [], agents: [] });
    let state = Object.freeze({ view, error });
    const listeners = new Set();
    let timer;
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const build = () => {
      state = Object.freeze({ view, error, busy });
      if (!view || !agent) return;
      const r = view.record;
      const shown = Object.freeze({
        ...agent,
        attention: r.attention,
        skipped: r.skipped ?? {},
        timers: r.timers ?? {},
        ...(r.attentionHistory ? { attentionHistory: r.attentionHistory } : {}),
        ...(r.sourceRuns ? { sourceRuns: r.sourceRuns } : {}),
      });
      // buzz-host runs no message filters yet (Buzz then says so above them).
      snapshot = Object.freeze({ status: "ready", classifier: "unavailable", running: [shown], agents: [shown] });
    };
    const changed = () => {
      build();
      emit();
    };
    const refresh = async () => {
      try {
        view = await client.call("attention.view", { pubkey }, { timeoutMs: 30000 });
        error = "";
      } catch (e) {
        error = String(e.message ?? e);
      }
      changed();
    };
    const subscribe = (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(refresh, 10000);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearInterval(timer);
      };
    };
    // Turning it on or off restarts the agent, so its sessions gain or lose the tools.
    const toggle = async () => {
      if (busy || !view) return;
      busy = true;
      error = "";
      changed();
      try {
        await client.call("attention.set", { pubkey, enabled: !view.enabled }, { timeoutMs: 90000 });
      } catch (e) {
        error = String(e.message ?? e);
      }
      busy = false;
      await refresh();
    };
    const setting = (shown) => {
      const name = shown.name || "the agent";
      const on = view?.enabled === true;
      const work = on && view && (view.queued > 0 || view.inFlight.length > 0) ? ` ${view.inFlight.length} running · ${view.queued} waiting.` : "";
      return {
        subtitle: error
          ? error
          : busy
            ? `Restarting ${name}…`
            : on
              ? `Let ${name} watch for updates and check in on a schedule. Runs on your server, also while this computer is off.${work}`
              : `Off: ${name} has no Attention tools, and its saved watches and timers wake nothing. Turning it on restarts ${name}.`,
        trailing: h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on,
            "aria-label": `Attention for ${name}`,
            "data-buzz-ui": "",
            className: "buzz-switch-control",
            "data-checked": on ? "" : undefined,
            "data-unchecked": on ? undefined : "",
            "data-disabled": busy ? "" : undefined,
            disabled: busy,
            onClick: () => void toggle(),
          },
          h("span", { className: "buzz-switch-thumb", "data-checked": on ? "" : undefined }),
        ),
      };
    };
    return {
      source: {
        snapshot: () => snapshot,
        subscribe,
        async save(_key, change) {
          view = await client.call("attention.change", { pubkey, change }, { timeoutMs: 60000 });
          changed();
        },
      },
      setting,
      state: () => state,
      subscribe,
      setAgent(next) {
        if (next === agent) return;
        agent = next;
        changed();
      },
    };
  }

  function NativeAttention({ agent, factory }) {
    const pubkey = agent.pubkey;
    const store = React.useMemo(() => hostedAttention(pubkey), [pubkey]);
    const Tab = React.useMemo(() => factory.create(store.source, store.setting), [factory, store]);
    React.useEffect(() => store.setAgent(agent), [store, agent]);
    const { view, error } = React.useSyncExternalStore(store.subscribe, store.state, store.state);
    const page = (children) =>
      h("section", { "data-buzz-ui": "", className: "attention-page", "aria-label": "Attention on your server" }, h("div", { className: "attention-content" }, children));
    return h(
      React.Fragment,
      null,
      !view && error && page(h("p", { role: "alert", className: "text-body-sm text-danger" }, error)),
      h(Tab, { agent: { key: agent.key } }),
      view?.history.length > 0 &&
        page(
          h(
            "details",
            { className: "attention-watch-activity" },
            h(
              "summary",
              { className: "attention-disclosure text-body-sm text-subtle" },
              h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
              "Recent wakes on your server",
              h("span", { className: "attention-detail-preview" }, `${view.history.length}`),
              h(Icon, { name: "caret" }),
            ),
            h(
              "ol",
              { className: "attention-timeline" },
              ...view.history.slice(0, 30).map((wake, i) =>
                h(
                  "li",
                  { key: wake.id ?? i, className: "attention-timeline-event" },
                  h(
                    "div",
                    { className: "attention-activity-row" },
                    h(Icon, { name: wake.type === "timer" ? "clock" : "chat" }),
                    h(
                      "span",
                      { className: "attention-activity-summary text-body-sm text-secondary" },
                      `${wake.type === "timer" ? "Timer" : wake.type === "catch-up" ? `Catch-up (${wake.count} missed)` : "Watch"} ${String(wake.slug).replace(/^watch\//, "")} · ${wake.outcome ? WAKE_OUTCOME[wake.outcome] ?? wake.outcome : "running…"}${wake.text ? ` · ${wake.text}` : ""}`,
                    ),
                    h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(wake.at)),
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  }

  function OwnAttentionTab({ agent, openConversation }) {
    const pubkey = agent.pubkey;
    const [state, setState] = React.useState();
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState("");
    const channels = useChannels();
    const load = React.useCallback(
      async (signal) => {
        try {
          setState(await client.call("attention.get", { pubkey }, { signal, timeoutMs: 30000 }));
          setError("");
        } catch (e) {
          if (!signal?.aborted) setError(e.message);
        }
      },
      [pubkey],
    );
    React.useEffect(() => {
      const controller = new AbortController();
      void load(controller.signal);
      const timer = setInterval(() => void load(controller.signal), 15000);
      return () => {
        controller.abort();
        clearInterval(timer);
      };
    }, [load]);
    /** Runs a buzz-host call; rejects with its error (callers show it in place). */
    const act = async (key, method, params) => {
      setBusy(key);
      try {
        setState(await client.call(method, { pubkey, ...params }, { timeoutMs: 90000 }));
        setError("");
      } finally {
        setBusy("");
      }
    };
    const find = (id) => channels.find((channel) => channel.id === id);
    const name = (id) => find(id)?.name ?? `Channel ${id.slice(0, 8)}`;
    const channelOf = (id) => {
      const c = find(id);
      return c?.channelType === "solo" || c?.channelType === "dm" ? "chat" : c?.private ? "lock" : "hash";
    };
    const agentName = agent.name || "the agent";
    const page = (children) =>
      h("section", { "data-buzz-ui": "", className: "attention-page", "aria-label": "Attention" }, h("div", { className: "attention-content" }, children));
    if (!state) return page(h("p", { className: "text-body-sm text-secondary", role: error ? "alert" : "status" }, error || "Loading watches…"));
    const byInterest = new Map(state.interests.map((i) => [i.id, []]));
    for (const w of state.watches) byInterest.get(w.interest)?.push(w);
    const empty = !state.interests.length && !state.orphans.length;
    const toggle = () =>
      act("enable", "attention.set", { enabled: !state.enabled }).catch((e) => setError(e.message));
    return page(
      h(
        "div",
        { className: "attention-agent" },
        h(
          "div",
          { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "cards" },
          h(
            "section",
            { className: "attention-setting", "aria-label": "Attention settings" },
            state.enabled && !empty && h(Sonar, { name: agentName, picture: agent.picture }),
            h(
              "div",
              { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" },
              h(
                "div",
                { className: "buzz-preference-row-content" },
                h("div", { className: "buzz-preference-row-label" }, "Attention"),
                h(
                  "span",
                  { className: "buzz-preference-row-description" },
                  busy === "enable"
                    ? `Restarting ${agentName}…`
                    : state.enabled
                      ? `Let ${agentName} watch for updates and check in on a schedule. Runs on your server, also while this computer is off.`
                      : `Off: ${agentName} has no Attention tools, and its saved watches and timers wake nothing. Turning it on restarts ${agentName}.`,
                ),
              ),
              h(
                "div",
                { className: "buzz-preference-row-trailing" },
                h(
                  "button",
                  {
                    type: "button",
                    role: "switch",
                    "aria-checked": state.enabled,
                    "aria-label": `Attention for ${agentName}`,
                    "data-buzz-ui": "",
                    className: "buzz-switch-control",
                    "data-checked": state.enabled ? "" : undefined,
                    "data-unchecked": state.enabled ? undefined : "",
                    "data-disabled": busy ? "" : undefined,
                    disabled: !!busy,
                    onClick: toggle,
                  },
                  h("span", { className: "buzz-switch-thumb", "data-checked": state.enabled ? "" : undefined }),
                ),
              ),
            ),
          ),
        ),
        error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
        state.enabled && (state.queued > 0 || state.inFlight.length > 0) &&
          h("p", { className: "text-body-sm text-secondary" }, `${state.inFlight.length} running · ${state.queued} waiting`),
        ...state.interests.map((interest) =>
          h(InterestCard, {
            key: interest.id,
            interest,
            watches: byInterest.get(interest.id) ?? [],
            agentName,
            name,
            channelOf,
            openConversation,
            act,
            busy: !!busy,
          }),
        ),
        state.orphans.length > 0 &&
          h(
            "section",
            { className: "attention-card" },
            h("h4", { className: "text-label" }, "Stray watches"),
            h("p", { className: "text-body-sm text-subtle" }, "These saved watches have no matching Interest. Remove them and create watches under an Interest."),
            ...state.orphans.map((id) =>
              h(
                "div",
                { key: id, className: "attention-agent-head" },
                h("span", { className: "text-body-sm" }, `watch/${id}`),
                h(Btn, { size: "sm", variant: "ghost", disabled: !!busy, onClick: () => act(`rw:${id}`, "attention.edit", { op: "removeWatch", id }).catch((e) => setError(e.message)) }, `Delete watch/${id}`),
              ),
            ),
          ),
        state.enabled && empty &&
          h(
            "section",
            { "aria-label": "Start watching" },
            h(
              "div",
              { "data-buzz-ui": "", className: "buzz-empty-state" },
              h(
                "div",
                { className: "buzz-empty-state-content" },
                h("span", { className: "buzz-empty-state-icon", "aria-hidden": "true" }, h(Sonar, { name: agentName, picture: agent.picture, size: "large" })),
                h(
                  "div",
                  { className: "buzz-empty-state-copy" },
                  h("h3", { className: "buzz-empty-state-title" }, "Attention"),
                  h(
                    "p",
                    { className: "buzz-empty-state-description" },
                    `Attention lets ${agentName} watch for messages and updates across Buzz, then act or notify you based on your instructions. Send ${agentName} a message to get started.`,
                  ),
                ),
              ),
            ),
          ),
        state.history.length > 0 &&
          h(
            "details",
            { className: "attention-watch-activity" },
            h(
              "summary",
              { className: "attention-disclosure text-body-sm text-subtle" },
              h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
              "Recent wakes on your server",
              h("span", { className: "attention-detail-preview" }, `${state.history.length}`),
              h(Icon, { name: "caret" }),
            ),
            h(
              "ol",
              { className: "attention-timeline" },
              ...state.history.slice(0, 30).map((wake, i) =>
                h(
                  "li",
                  { key: wake.id ?? i, className: "attention-timeline-event" },
                  h(
                    "div",
                    { className: "attention-activity-row" },
                    h(Icon, { name: wake.type === "timer" ? "clock" : "chat" }),
                    h(
                      "span",
                      { className: "attention-activity-summary text-body-sm text-secondary" },
                      `${wake.type === "timer" ? "Timer" : wake.type === "catch-up" ? `Catch-up (${wake.count} missed)` : "Watch"} ${String(wake.slug).replace(/^watch\//, "")} · ${wake.outcome ? WAKE_OUTCOME[wake.outcome] ?? wake.outcome : "running…"}${wake.text ? ` · ${wake.text}` : ""}`,
                    ),
                    h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(wake.at)),
                  ),
                ),
              ),
            ),
          ),
      ),
    );
  }

  return { AttentionTab, NativeAttention, OwnAttentionTab, hostedAttention };
}
