// node --test server/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAgentAccess,
  assertMethodAllowed,
  buildInviteUrl,
  canAccessAgent,
  createAuthRateLimiter,
  createTokenStore,
  enforceGuestSettings,
} from "./auth.mjs";

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

test("tokenStore creates hashed tokens, verifies, binds owner once, and revokes cleanly", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const filePath = path.join(tmp, "tokens.json");
  const store = createTokenStore({ filePath });

  const { token, record } = await store.create({ label: "Alice" });
  assert.match(token, /^bhg_[0-9a-f]{48}$/);
  assert.match(record.id, /^tok_[0-9a-f]{12}$/);
  assert.equal(record.maxAgents, 2);
  assert.equal(record.maxConcurrency, 2);
  assert.deepEqual(record.allowedRuntimes, ["hermes", "claude", "antigravity"]);
  assert.equal(record.ownerPubkey, null);

  // Plaintext token MUST NOT appear on disk.
  const rawDisk = await fs.readFile(filePath, "utf8");
  assert.ok(!rawDisk.includes(token));

  // Verify works with valid token and rejects wrong tokens.
  const verified = await store.verify(token);
  assert.equal(verified.id, record.id);
  assert.equal(await store.verify("bhg_" + "0".repeat(48)), null);
  assert.equal(await store.verify("not-a-token"), null);

  // Bind-on-first-activate locks owner permanently.
  const bound = await store.bindOwner(record.id, OWNER_A);
  assert.equal(bound.ownerPubkey, OWNER_A);
  // Idempotent for same owner; rejects a second user trying to claim it.
  await assert.doesNotReject(() => store.bindOwner(record.id, OWNER_A));
  await assert.rejects(() => store.bindOwner(record.id, OWNER_B), /already bound to another user/);

  // Invite URL places token strictly in fragment (never query string).
  const invite = buildInviteUrl("wss://omarchy.tail65c5a9.ts.net/_buzz-host", token);
  assert.equal(invite, `wss://omarchy.tail65c5a9.ts.net/_buzz-host#token=${token}`);

  // Revocation blocks future verification.
  const revoked = await store.revoke(record.id);
  assert.ok(revoked.revokedAt);
  assert.equal(await store.verify(token), null);
});

test("access control enforces per-owner isolation, guest method restrictions, and guest caps", () => {
  const admin = { authenticated: true, role: "admin" };
  const guestA = {
    authenticated: true,
    role: "guest",
    tokenId: "tok_aaaaaaaaaaaa",
    ownerPubkey: OWNER_A,
    limits: { maxAgents: 2, maxConcurrency: 2, allowedRuntimes: ["hermes", "claude"] },
  };
  const unboundGuest = {
    authenticated: true,
    role: "guest",
    tokenId: "tok_bbbbbbbbbbbb",
    ownerPubkey: null,
    limits: { maxAgents: 2, maxConcurrency: 2, allowedRuntimes: ["hermes"] },
  };

  const agentA = { pubkey: "1".repeat(64), owner: OWNER_A, activated: true };
  const agentB = { pubkey: "2".repeat(64), owner: OWNER_B, activated: true };
  const provisionedUnbound = {
    pubkey: "3".repeat(64),
    owner: undefined,
    activated: false,
    createdByTokenId: "tok_bbbbbbbbbbbb",
  };

  assert.equal(canAccessAgent(admin, agentA), true);
  assert.equal(canAccessAgent(admin, agentB), true);
  assert.equal(canAccessAgent(guestA, agentA), true);
  assert.equal(canAccessAgent(guestA, agentB), false);
  assert.throws(() => assertAgentAccess(guestA, agentB), /Agent not found/);

  // Unbound guest can access its own provisioned-but-unactivated agent, not others.
  assert.equal(canAccessAgent(unboundGuest, provisionedUnbound), true);
  assert.equal(canAccessAgent(guestA, provisionedUnbound), false);

  // Method gating.
  assert.throws(() => assertMethodAllowed({ authenticated: false }, "list"), /Authentication required/);
  assert.doesNotThrow(() => assertMethodAllowed(admin, "desktop.status"));
  assert.doesNotThrow(() => assertMethodAllowed(admin, "tokens.create"));
  assert.doesNotThrow(() => assertMethodAllowed(guestA, "provision"));
  assert.throws(() => assertMethodAllowed(guestA, "desktop.status"), /not permitted for guest/);
  assert.throws(() => assertMethodAllowed(guestA, "orchestrator.set"), /not permitted for guest/);
  assert.throws(() => assertMethodAllowed(guestA, "tokens.create"), /not permitted for guest/);

  // Guest settings caps.
  const clamped = enforceGuestSettings(guestA, {
    runtime: "claude",
    model: "",
    profile: "work",
    concurrency: 8,
    runner: "docker",
    respondTo: "anyone",
    respondToAllowlist: [],
  });
  assert.equal(clamped.runner, "docker");
  assert.equal(clamped.profile, "");
  assert.equal(clamped.concurrency, 2);
  assert.equal(clamped.respondTo, "anyone");

  assert.throws(
    () =>
      enforceGuestSettings(guestA, {
        runtime: "codex",
        runner: "docker",
        concurrency: 2,
      }),
    /not enabled for this guest token/,
  );
  assert.throws(
    () =>
      enforceGuestSettings(guestA, {
        runtime: "claude",
        runner: "host",
        concurrency: 2,
      }),
    /sandboxed runner/,
  );
});

test("auth rate limiter blocks repeated failures and clears on success", () => {
  const rl = createAuthRateLimiter({ maxFailures: 2, windowMs: 60_000 });
  assert.equal(rl.isLimited("1.2.3.4"), false);
  rl.recordFailure("1.2.3.4");
  assert.equal(rl.isLimited("1.2.3.4"), false);
  rl.recordFailure("1.2.3.4");
  assert.equal(rl.isLimited("1.2.3.4"), true);
  rl.clear("1.2.3.4");
  assert.equal(rl.isLimited("1.2.3.4"), false);
});

test("buzz-host-tokens CLI creates, lists, and revokes tokens via --file", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-tokens-cli-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "tokens.json");
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "buzz-host-tokens");

  const created = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "create", "--file", file, "--label", "Bob", "--max-agents", "3", "--url", "wss://example.ts.net/_buzz-host", "--json"],
      { encoding: "utf8" },
    ),
  );
  assert.match(created.token, /^bhg_[0-9a-f]{48}$/);
  assert.equal(created.record.label, "Bob");
  assert.equal(created.record.maxAgents, 3);
  assert.equal(created.inviteUrl, `wss://example.ts.net/_buzz-host#token=${created.token}`);

  const listed = JSON.parse(execFileSync(process.execPath, [cli, "list", "--file", file, "--json"], { encoding: "utf8" })).tokens;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.record.id);
  assert.equal(listed[0].revokedAt, null);

  const revoked = JSON.parse(
    execFileSync(process.execPath, [cli, "revoke", "--file", file, created.record.id, "--json"], { encoding: "utf8" }),
  ).record;
  assert.ok(revoked.revokedAt);
});
