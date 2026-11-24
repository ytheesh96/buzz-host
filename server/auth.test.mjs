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
  findIdleGuestDesktops,
  isValidDesktopTicket,
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

test("auth rate limiter caps buckets so rotating IPs cannot grow it unboundedly", () => {
  let clock = 1_000_000;
  const rl = createAuthRateLimiter({
    maxFailures: 1,
    windowMs: 60_000,
    maxKeys: 4,
    now: () => clock,
    sweepEvery: 1,
  });

  for (let i = 0; i < 50; i += 1) {
    clock += 10;
    rl.recordFailure(`10.0.0.${i}`);
    assert.ok(rl.size() <= 4, `buckets stay capped (saw ${rl.size()})`);
  }
  // The newest offender is tracked; the oldest ones were evicted.
  assert.equal(rl.isLimited("10.0.0.49"), true);
  assert.equal(rl.isLimited("10.0.0.0"), false);
});

test("auth rate limiter prunes buckets once their window has passed", () => {
  let clock = 1_000_000;
  const rl = createAuthRateLimiter({
    maxFailures: 2,
    windowMs: 60_000,
    maxKeys: 10_000,
    now: () => clock,
    sweepEvery: 1,
  });

  rl.recordFailure("1.2.3.4");
  rl.recordFailure("5.6.7.8");
  assert.equal(rl.size(), 2);

  // One window later both buckets are empty and get swept away.
  clock += 60_001;
  rl.sweep();
  assert.equal(rl.size(), 0);
  assert.equal(rl.isLimited("1.2.3.4"), false);
});

test("auth rate limiter evicts the least-recently-failed bucket at the cap", () => {
  let clock = 1_000_000;
  const rl = createAuthRateLimiter({
    maxFailures: 3,
    windowMs: 60_000,
    maxKeys: 2,
    now: () => clock,
    sweepEvery: 1,
  });

  for (let i = 0; i < 3; i += 1) {
    clock += 1;
    rl.recordFailure("9.9.9.9");
  }
  assert.equal(rl.isLimited("9.9.9.9"), true);

  // New keys evict the oldest bucket once two are already tracked.
  clock += 1;
  rl.recordFailure("8.8.8.8");
  clock += 1;
  rl.recordFailure("7.7.7.7");
  assert.equal(rl.size(), 2);
  assert.equal(rl.isLimited("9.9.9.9"), false, "oldest bucket evicted");
  assert.equal(rl.isLimited("8.8.8.8"), false, "one failure is below maxFailures");
  assert.equal(rl.isLimited("7.7.7.7"), false);
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

  // --allow-host-desktop (and --trusted) opt-in flag
  const trusted = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "create", "--file", file, "--label", "Partner", "--allow-host-desktop", "--json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(trusted.record.allowHostDesktop, true);
  assert.equal(created.record.allowHostDesktop, false);
});

test("trusted guest tokens allow host runner (owner-only) and desktop.* methods, while keeping admin-only and shared-agent invariants", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-desktop-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const store = createTokenStore({ filePath: path.join(tmp, "tokens.json") });

  const std = await store.create({ label: "Standard" });
  const trusted = await store.create({ label: "Trusted", allowHostDesktop: true });
  assert.equal(std.record.allowHostDesktop, false);
  assert.equal(trusted.record.allowHostDesktop, true);
  assert.equal((await store.verify(trusted.token)).allowHostDesktop, true);

  const trustedSession = {
    authenticated: true,
    role: "guest",
    tokenId: trusted.record.id,
    ownerPubkey: OWNER_A,
    limits: {
      maxAgents: 2,
      maxConcurrency: 2,
      allowedRuntimes: ["hermes", "claude"],
      allowHostDesktop: true,
    },
  };
  const stdSession = {
    ...trustedSession,
    tokenId: std.record.id,
    limits: { ...trustedSession.limits, allowHostDesktop: false },
  };

  // Trusted guest can call desktop.* methods, still blocked from admin-only methods.
  for (const m of ["desktop.status", "desktop.set", "desktop.start", "desktop.stop", "desktop.snapshot", "desktop.view", "desktop.lease"]) {
    assert.doesNotThrow(() => assertMethodAllowed(trustedSession, m));
    assert.throws(() => assertMethodAllowed(stdSession, m), /not permitted for guest/);
  }
  for (const m of ["orchestrator.set", "hermes.profiles", "tokens.create", "tokens.list", "tokens.revoke"]) {
    assert.throws(() => assertMethodAllowed(trustedSession, m), /not permitted for guest/);
  }

  // Trusted guest: owner-only allows host or docker; shared forces docker; profile always cleared.
  const hostOwnerOnly = enforceGuestSettings(trustedSession, {
    runtime: "claude",
    model: "",
    profile: "work",
    concurrency: 4,
    runner: "host",
    respondTo: "owner-only",
    respondToAllowlist: [],
  });
  assert.equal(hostOwnerOnly.runner, "host");
  assert.equal(hostOwnerOnly.profile, "");
  assert.equal(hostOwnerOnly.concurrency, 2);

  const dockerOwnerOnly = enforceGuestSettings(trustedSession, {
    runtime: "claude",
    model: "",
    profile: "",
    concurrency: 1,
    runner: "docker",
    respondTo: "owner-only",
    respondToAllowlist: [],
  });
  assert.equal(dockerOwnerOnly.runner, "docker");

  // Shared agent on host runner MUST still be rejected even for trusted guests.
  assert.throws(
    () =>
      enforceGuestSettings(trustedSession, {
        runtime: "claude",
        runner: "host",
        respondTo: "anyone",
        concurrency: 2,
      }),
    /sandboxed runner/,
  );
  const sharedDocker = enforceGuestSettings(trustedSession, {
    runtime: "claude",
    runner: "docker",
    respondTo: "anyone",
    concurrency: 2,
  });
  assert.equal(sharedDocker.runner, "docker");
});

test("desktop ticket validation isolates admin and guest listeners, and idle sweep targets only idle guest desktops", () => {
  const now = 1_000_000;
  const adminTicket = { pubkey: OWNER_A, viewer: "v1", expires: now + 30_000, role: "admin", tokenId: null };
  const guestTicket = { pubkey: OWNER_A, viewer: "v2", expires: now + 30_000, role: "guest", tokenId: "tok_123456789abc" };
  const expiredGuest = { ...guestTicket, expires: now - 1 };

  assert.equal(isValidDesktopTicket(adminTicket, "admin", now), true);
  assert.equal(isValidDesktopTicket(adminTicket, "guest", now), false);
  assert.equal(isValidDesktopTicket(guestTicket, "guest", now), true);
  assert.equal(isValidDesktopTicket(guestTicket, "admin", now), false);
  assert.equal(isValidDesktopTicket(expiredGuest, "guest", now), false);
  assert.equal(isValidDesktopTicket(null, "guest", now), false);

  const metas = [
    { pubkey: "1".repeat(64) }, // admin agent — never auto-stopped
    { pubkey: "2".repeat(64), createdByTokenId: "tok_a" }, // running guest, active viewer -> keep
    { pubkey: "3".repeat(64), createdByTokenId: "tok_b" }, // running guest, recent activity -> keep
    { pubkey: "4".repeat(64), createdByTokenId: "tok_c" }, // running guest, idle past threshold -> stop
    { pubkey: "5".repeat(64), createdByTokenId: "tok_d" }, // stopped guest -> skip
  ];
  const running = new Set(["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)]);
  const viewers = new Map([["2".repeat(64), 1]]);
  const lastAt = new Map([
    ["1".repeat(64), now - 999_999],
    ["2".repeat(64), now - 999_999],
    ["3".repeat(64), now - 5 * 60_000],
    ["4".repeat(64), now - 16 * 60_000],
  ]);

  const idle = findIdleGuestDesktops({
    metas,
    isRunning: (p) => running.has(p),
    activeViewers: (p) => viewers.get(p) ?? 0,
    lastActivityAt: (p) => lastAt.get(p) ?? 0,
    now,
    idleMs: 15 * 60_000,
  });
  assert.deepEqual(idle, ["4".repeat(64)]);
});
