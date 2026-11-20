// Usage: node call.mjs <method> [json-params]   (talks to buzz-host over the tailnet)
const url = process.env.BUZZ_HOST_URL ?? "wss://omarchy.tail65c5a9.ts.net:8447";
const [method, params = "{}"] = process.argv.slice(2);
const ws = new WebSocket(url);
const timer = setTimeout(() => { console.error("timeout"); process.exit(2); }, 120000);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: JSON.parse(params) }));
ws.onmessage = (e) => { console.log(JSON.stringify(JSON.parse(e.data), null, 1)); clearTimeout(timer); ws.close(); };
ws.onerror = (e) => { console.error("ws error", e.message ?? e); process.exit(1); };
