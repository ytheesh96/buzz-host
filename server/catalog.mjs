// The models and effort levels a runtime offers, for Buzz's composer picker
// (the owner's patched Buzz asks a hosted type's `models(agent)`).
//
// An ACP adapter lists its models as the `model` config option of a session,
// but lists effort levels (`thought_level`) only for the session's current
// model. So the probe opens one session, never prompts it, and sets each
// model in turn to read that model's levels. buzz-host caches the result per
// runtime and Hermes profile (catalogs()).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const EFFORT = new Set(["thought_level", "effort", "reasoning_effort", "reasoning", "thinking"]);
// Buzz refuses a pick tag whose model id doesn't match this (relay/messages.ts).
const PICKABLE = /^[\w.:/[\]-]{1,64}$/;
const LEVEL = /^[a-z0-9-]{1,32}$/;

const isModel = (o) => o?.category === "model" || o?.id === "model";
const isEffort = (o) => EFFORT.has(o?.category) || EFFORT.has(o?.id);
const flat = (option) =>
  (option?.options ?? []).flatMap((v) => (Array.isArray(v?.options) ? v.options : [v])).filter((v) => v && typeof v.value === "string");

/** One ACP session on `command`: its model option, and each model's effort
 * option (`perModel`; Hermes has one set of levels for every model). A model
 * the runtime refuses to switch to (Claude: "Usage credits are required for
 * this model") is `unavailable`. Stops switching after `budgetMs`; the rest
 * get the levels the session started with. Never sends a prompt. */
export async function probe({ command, args = [], env, cwd, perModel = true, budgetMs = 120_000, stepMs = 30_000 }) {
  const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  let buffer = "";
  let next = 0;
  let exited = null;
  child.on("exit", (code) => {
    exited = new Error(`the runtime exited (${code})`);
    for (const [, w] of waiting) w.reject(exited);
    waiting.clear();
  });
  child.on("error", (error) => {
    exited = error;
    for (const [, w] of waiting) w.reject(error);
    waiting.clear();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // It asks the client something (permission, files): no client here.
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } })}\n`);
      } else if (!msg.method && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(Object.assign(new Error(msg.error.data?.details ?? msg.error.message ?? "ACP error"), { refused: true }));
        else w.resolve(msg.result ?? {});
      }
    }
  });
  const call = (method, params, ms = stepMs) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(exited);
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, ms);
      waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const started = Date.now();
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} }, 60_000);
    const session = await call("session/new", { cwd, mcpServers: [] }, 60_000);
    const opts = session.configOptions ?? [];
    const modelOption = opts.find(isModel);
    const effortOption = opts.find(isEffort);
    const result = {
      model: modelOption
        ? { id: modelOption.id ?? "model", current: modelOption.currentValue, options: flat(modelOption) }
        : null,
      effort: effortOption ? { current: effortOption.currentValue, options: flat(effortOption) } : null,
      // Without a model option, the session's own list (ACP's unstable models).
      available: (session.models?.availableModels ?? []).map((m) => ({ value: m.modelId, name: m.name, description: m.description })),
      current: session.models?.currentModelId,
      efforts: {},
      unavailable: [],
      partial: false,
    };
    if (modelOption && perModel) {
      for (const { value } of result.model.options) {
        if (Date.now() - started > budgetMs) {
          result.partial = true;
          break;
        }
        try {
          const answer = await call("session/set_config_option", {
            sessionId: session.sessionId,
            configId: result.model.id,
            value,
          });
          const effort = (answer.configOptions ?? []).find(isEffort);
          result.efforts[value] = effort ? { current: effort.currentValue, options: flat(effort) } : null;
        } catch (error) {
          if (error.refused) result.unavailable.push(value);
          else result.partial = true;
        }
      }
    }
    return result;
  } finally {
    child.kill();
  }
}

export const effortLabel = (id) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

const levels = (effort) =>
  (effort?.options ?? [])
    .map((o) => o.value)
    .filter((id) => id !== "default" && LEVEL.test(id))
    .map((id) => ({ id, label: effortLabel(id) }));

/** A probe as Buzz's `Models`: {current, models: [{id, label, efforts,
 * effort?, group?}]}. `configured` is the agent's own model, if set; else it
 * runs on the runtime's default. A `default` alias is offered only as the
 * agent's own (it repeats a listed model). Hermes names its models
 * "<provider> · <model>", which become a group per provider. */
export function toModels(probed, configured = "") {
  const base = probed.effort;
  const resting = (effort) => {
    const id = effort?.current;
    return id && id !== "default" && levels(effort).some((l) => l.id === id) ? { effort: id } : {};
  };
  const entry = ({ value, name, description }, effort) => {
    const label = value === "default" && description ? `Default (${description})` : name || value;
    const parts = String(label).split(" · ");
    return {
      id: value,
      label,
      efforts: levels(effort),
      ...resting(effort),
      ...(parts.length > 1 && value !== "default" ? { group: parts[0] } : {}),
    };
  };
  const options = probed.model?.options ?? probed.available ?? [];
  const runtimeDefault = probed.model?.current ?? probed.current ?? "";
  const current = configured || runtimeDefault;
  const refused = new Set(probed.unavailable ?? []);
  const models = options
    .filter((o) => PICKABLE.test(o.value) && !refused.has(o.value) && (o.value !== "default" || current === "default"))
    // A model the probe didn't reach takes the levels the session started with.
    .map((o) => entry(o, Object.hasOwn(probed.efforts ?? {}, o.value) ? probed.efforts[o.value] : base));
  if (current && PICKABLE.test(current) && !models.some((m) => m.id === current))
    // Its own model isn't listed: it still runs on it, at the levels the
    // session started with.
    models.unshift({ id: current, label: current, efforts: levels(base), ...resting(base) });
  return { current: PICKABLE.test(current) ? current : "", models };
}

/** A pick of another runtime's model names its runtime: "codex::gpt-5"
 * (acp-proxy's split_pick). */
export const RUNTIME_SEP = "::";

/** The agent's own runtime's models (`own`: toModels plus {runtime, title})
 * and other runtimes' (`others`, the same), as one `Models` for Buzz's
 * composer: each runtime a submenu (Hermes: one per provider), other
 * runtimes' ids prefixed with theirs. Without others, `own` as it is. */
export function withRuntimes(own, others = []) {
  const plain = { current: own.current, models: own.models };
  if (!others.length) return plain;
  const tag = (title, m) => ({
    ...m,
    label: `${title} · ${m.label}`,
    group: m.group ? `${title} · ${m.group}` : title,
  });
  return {
    current: own.current,
    models: [
      ...own.models.map((m) => tag(own.title, m)),
      ...others.flatMap((o) =>
        o.models
          .map((m) => ({ ...tag(o.title, m), id: `${o.runtime}${RUNTIME_SEP}${m.id}` }))
          .filter((m) => PICKABLE.test(m.id)),
      ),
    ],
  };
}

/** Probes cached per runtime and Hermes profile in `dir`: an answer comes
 * from the cache when there is one, refreshed in the background once older
 * than `maxAgeMs`; the first probe is awaited, unless `{wait: false}`: then
 * the answer is undefined while a background probe runs, and null for
 * `retryMs` after one failed (a runtime not signed in). */
export function catalogs({ dir, maxAgeMs = 6 * 3600_000, retryMs = 10 * 60_000, probeWith = probe }) {
  const live = new Map();
  const file = (key) => path.join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  const refresh = (key, options) => {
    if (live.get(key)?.pending) return live.get(key).pending;
    const pending = probeWith(options)
      .then(async (value) => {
        const record = { at: Date.now(), value };
        live.set(key, record);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file(key), JSON.stringify(record));
        return value;
      })
      .catch((error) => {
        const kept = live.get(key) ?? {};
        delete kept.pending;
        kept.failedAt = Date.now();
        live.set(key, kept);
        throw error;
      });
    live.set(key, { ...(live.get(key) ?? {}), pending });
    return pending;
  };
  return async function get(key, options, { wait = true } = {}) {
    let record = live.get(key);
    if (!record?.value) {
      const saved = await fs.readFile(file(key), "utf8").then(JSON.parse, () => undefined);
      if (saved?.value) live.set(key, (record = { ...saved, ...(record?.pending ? { pending: record.pending } : {}) }));
    }
    if (!record?.value && !wait) {
      if (record?.pending) return undefined;
      if (Date.now() - (record?.failedAt ?? 0) < retryMs) return null;
      refresh(key, options).catch(() => {});
      return undefined;
    }
    if (!record?.value) return refresh(key, options);
    if (Date.now() - record.at > maxAgeMs) refresh(key, options).catch(() => {});
    return record.value;
  };
}
