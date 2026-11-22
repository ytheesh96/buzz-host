// Settings → Plugins → Omarchy agents: server address and connection check card.
import { DEFAULT_URL, URL_KEY, storedUrl } from "./config.js";

export function createServerCard({ React, client, uiKit }) {
  const { h, Row, Text, Note } = uiKit;

  return function ServerCard() {
    const state = React.useSyncExternalStore(client.subscribe, client.snapshot);
    const [url, setUrl] = React.useState(storedUrl());
    const [info, setInfo] = React.useState();
    const [error, setError] = React.useState("");
    const check = async () => {
      setError("");
      setInfo(undefined);
      try {
        try {
          localStorage.setItem(URL_KEY, url.trim() || DEFAULT_URL);
        } catch {}
        await client.reconnect();
        const [hello, list] = await Promise.all([client.call("hello"), client.call("list")]);
        setInfo({ hello, list });
      } catch (e) {
        setError(String(e.message ?? e));
      }
    };
    React.useEffect(() => {
      void check();
      // biome-ignore lint: check once on open
    }, []);
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3)" } },
      h(
        Note,
        null,
        "Agents of type Omarchy run on your server with buzz-host. Create them in Agents → New agent → Harness → Remote → Omarchy. In a chat, tag the agent with /model, /effort, /runtime, /new, /stop, /status or /help to control that chat (or thread). The composer's model picker also lists other runtimes' models; picking one moves the chat to that runtime.",
      ),
      h(
        Row,
        { label: "Server", hint: "A wss:// address published with tailscale serve." },
        h(Text, { value: url, onChange: (e) => setUrl(e.target.value) }),
      ),
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)" } },
        h("button", { type: "button", onClick: () => void check() }, "Save and check"),
      ),
      h(Note, { tone: error ? "error" : undefined }, error || `Connection: ${state.status}`),
      info &&
        h(
          Note,
          null,
          `Host ${info.hello.host} · runtimes: ${info.hello.runtimes
            .map((r) => `${r.title}${r.available ? "" : " (missing)"}`)
            .join(", ")}\n` +
            (info.list.agents.length
              ? info.list.agents
                  .map((a) => `• ${a.name} — ${a.runtime}${a.model ? `/${a.model}` : ""} — ${a.status}`)
                  .join("\n")
              : "No agents yet."),
        ),
    );
  };
}
