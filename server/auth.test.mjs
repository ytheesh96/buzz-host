// node --test server/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_ONLY_METHODS,
  DELEGATE_ALLOWED_METHODS,
  assertAgentAccess,
  assertGuestDesktop,
  assertMethodAllowed,
  buildInviteUrl,
  canAccessAgent,
  createAuthRateLimiter,
  createTokenStore,
  desktopTicketTokenAllowed,
  enforceGuestSettings,
  findIdleGuestDesktops,
  hashToken,
  isTokenExpired,
  isValidDesktopTicket,
  parseExpiresAt,
  parseListenerConfig,
  sandboxDesktopAllowed,
  tokenRole,
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
  const invite = buildInviteUrl("wss://buzz.example.ts.net/_buzz-host", token);
  assert.equal(invite, `wss://buzz.example.ts.net/_buzz-host#token=${token}`);

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

test("admin tokens: bha_ secret, hashed at rest, verify as admin, no guest caps, revoke blocks", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-admin-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const filePath = path.join(tmp, "tokens.json");
  const store = createTokenStore({ filePath });

  const { token, record } = await store.createAdmin({ label: "My laptop", ownerPubkey: OWNER_A.toUpperCase() });
  assert.match(token, /^bha_[0-9a-f]{48}$/);
  assert.equal(record.role, "admin");
  assert.equal(record.ownerPubkey, OWNER_A);
  for (const key of ["maxAgents", "maxConcurrency", "allowedRuntimes", "allowHostDesktop"]) {
    assert.ok(!(key in record), `admin view has no ${key}`);
  }

  // Hashed at rest, mode 0600, never the plaintext.
  const raw = await fs.readFile(filePath, "utf8");
  assert.ok(!raw.includes(token));
  assert.ok(raw.includes(hashToken(token)));
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  const verified = await store.verify(token);
  assert.equal(verified.role, "admin");
  assert.equal(verified.id, record.id);
  assert.ok(verified.lastUsedAt === null || typeof verified.lastUsedAt === "string");
  assert.equal(await store.verify(`bha_${"0".repeat(48)}`), null);
  assert.equal((await store.getById(record.id)).role, "admin");

  // Admin tokens never bind like guest tokens do.
  await assert.rejects(() => store.bindOwner(record.id, OWNER_B), /Only guest tokens/);

  // Listing shows each token's role.
  await store.create({ label: "Guest" });
  const roles = (await store.list()).map((t) => t.role).sort();
  assert.deepEqual(roles, ["admin", "guest"]);

  const revoked = await store.revoke(record.id);
  assert.equal(revoked.role, "admin");
  assert.ok(revoked.revokedAt);
  assert.equal(await store.verify(token), null);
  assert.equal((await store.getById(record.id)).revokedAt, revoked.revokedAt);

  await assert.rejects(() => store.createAdmin({ label: "" }), /label/);
  await assert.rejects(() => store.createAdmin({ label: "x", ownerPubkey: "short" }), /ownerPubkey/);
});

test("guest tokens can never escalate to admin", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-escalate-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const filePath = path.join(tmp, "tokens.json");
  const store = createTokenStore({ filePath });

  const guest = await store.create({ label: "Friend", allowHostDesktop: true });
  const guestView = await store.verify(guest.token);
  assert.equal(guestView.role, "guest");
  // create() takes no role: passing one is ignored.
  const sneaky = await store.create({ label: "Sneaky", role: "admin" });
  assert.equal(sneaky.record.role, "guest");
  assert.match(sneaky.token, /^bhg_/);

  // A guest secret relabelled as bha_ hashes differently: no match.
  assert.equal(await store.verify(guest.token.replace(/^bhg_/, "bha_")), null);

  // Even a tampered record (role flipped to admin) refuses the bhg_ secret,
  // because the secret's prefix must match the stored role.
  const disk = JSON.parse(await fs.readFile(filePath, "utf8"));
  disk.tokens.find((r) => r.id === guest.record.id).role = "admin";
  await fs.writeFile(filePath, JSON.stringify(disk));
  assert.equal(await store.verify(guest.token), null);

  // Records from before admin tokens (no role) are guests; unknown roles are refused.
  assert.equal(tokenRole({}), "guest");
  assert.equal(tokenRole({ role: "weird" }), null);
  assert.equal(tokenRole({ role: "admin" }), "admin");

  // Guest sessions keep every guest restriction whatever the token's flags.
  const session = { authenticated: true, role: "guest", tokenId: guest.record.id, limits: guestView };
  for (const m of ["tokens.create", "tokens.list", "tokens.revoke", "orchestrator.set", "hermes.profiles"]) {
    assert.throws(() => assertMethodAllowed(session, m), /not permitted for guest/);
  }
  assert.equal(canAccessAgent(session, { owner: OWNER_B, activated: true }), false);
  // An admin-token session gets full access.
  const admin = { authenticated: true, role: "admin", tokenId: "tok_aaaaaaaaaaaa", limits: null };
  assert.doesNotThrow(() => assertMethodAllowed(admin, "tokens.create"));
  assert.doesNotThrow(() => assertMethodAllowed(admin, "desktop.view"));
  assert.equal(canAccessAgent(admin, { owner: OWNER_B, activated: true }), true);
  const settings = { runtime: "codex", runner: "host", concurrency: 16, profile: "work" };
  assert.deepEqual(enforceGuestSettings(admin, settings), settings);
});

test("admin desktop tickets on the token listener need a live admin token", () => {
  const now = 1_000_000;
  const adminTokenTicket = { pubkey: OWNER_A, viewer: "v", expires: now + 30_000, role: "admin", tokenId: "tok_aaaaaaaaaaaa" };
  const tailnetTicket = { ...adminTokenTicket, tokenId: null };
  const guestTicket = { ...adminTokenTicket, role: "guest", tokenId: "tok_bbbbbbbbbbbb" };

  // Token listener: token-minted tickets only (a tailnet ticket has no token).
  assert.equal(isValidDesktopTicket(adminTokenTicket, "guest", now), true);
  assert.equal(isValidDesktopTicket(tailnetTicket, "guest", now), false);
  // …and the tailnet listener refuses token-minted tickets (re-checked on the token listener only).
  assert.equal(isValidDesktopTicket(adminTokenTicket, "admin", now), false);
  assert.equal(isValidDesktopTicket(tailnetTicket, "admin", now), true);
  assert.equal(isValidDesktopTicket({ ...adminTokenTicket, expires: now - 1 }, "guest", now), false);
  assert.equal(isValidDesktopTicket({ ...adminTokenTicket, role: "root" }, "guest", now), false);

  const adminRecord = { id: "tok_aaaaaaaaaaaa", role: "admin", revokedAt: null };
  const guestRecord = { id: "tok_bbbbbbbbbbbb", role: "guest", allowHostDesktop: false, revokedAt: null };
  // Admin token: allowed without allowHostDesktop; not once revoked.
  assert.equal(desktopTicketTokenAllowed(adminTokenTicket, adminRecord), true);
  assert.equal(desktopTicketTokenAllowed(adminTokenTicket, { ...adminRecord, revokedAt: "2026-01-01" }), false);
  assert.equal(desktopTicketTokenAllowed(adminTokenTicket, null), false);
  // Role must match the token: an "admin" ticket backed by a guest token is refused.
  assert.equal(
    desktopTicketTokenAllowed({ ...adminTokenTicket, tokenId: guestRecord.id }, { ...guestRecord, allowHostDesktop: true }),
    false,
  );
  // Ticket and record must be the same token.
  assert.equal(desktopTicketTokenAllowed(adminTokenTicket, { ...adminRecord, id: "tok_cccccccccccc" }), false);
  // Guest tickets: a desktop flag is required. Sandboxed desktops are on by
  // default (also for records made before the flag); explicit false is off.
  assert.equal(desktopTicketTokenAllowed(guestTicket, guestRecord), guestRecord.allowSandboxDesktop !== false);
  assert.equal(desktopTicketTokenAllowed(guestTicket, { ...guestRecord, allowSandboxDesktop: false }), false);
  assert.equal(desktopTicketTokenAllowed(guestTicket, { ...guestRecord, allowHostDesktop: true }), true);
  assert.equal(desktopTicketTokenAllowed(guestTicket, { ...guestRecord, allowHostDesktop: true, revokedAt: "x" }), false);
  // Legacy guest record without a role.
  assert.equal(desktopTicketTokenAllowed(guestTicket, { id: guestRecord.id, allowHostDesktop: true }), true);
  // A sandboxed-desktop guest may view too (desktop.view already limited it to sandboxed agents).
  assert.equal(desktopTicketTokenAllowed(guestTicket, { ...guestRecord, allowSandboxDesktop: true }), true);
  assert.equal(
    desktopTicketTokenAllowed(guestTicket, { ...guestRecord, allowSandboxDesktop: true, revokedAt: "x" }),
    false,
  );
});

test("sandboxed-desktop guests: desktop methods only for their sandboxed agents, never a host desktop", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-sbxdesk-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const store = createTokenStore({ filePath: path.join(tmp, "tokens.json") });
  const { record } = await store.create({ label: "Anu", ownerPubkey: OWNER_A, allowSandboxDesktop: true });
  assert.equal(record.allowSandboxDesktop, true);
  assert.equal(record.allowHostDesktop, false);
  const listed = (await store.list()).find((r) => r.id === record.id);
  assert.equal(listed.allowSandboxDesktop, true);
  // On by default; only an explicit false turns it off.
  const plain = await store.create({ label: "Bo", ownerPubkey: OWNER_B });
  assert.equal(plain.record.allowSandboxDesktop, true);
  const off = await store.create({ label: "Cy", ownerPubkey: OWNER_B, allowSandboxDesktop: false });
  assert.equal(off.record.allowSandboxDesktop, false);
  assert.equal(sandboxDesktopAllowed({}), true);
  assert.equal(sandboxDesktopAllowed({ allowSandboxDesktop: false }), false);

  const guest = {
    authenticated: true,
    role: "guest",
    tokenId: record.id,
    ownerPubkey: OWNER_A,
    limits: { maxAgents: 2, maxConcurrency: 2, allowedRuntimes: ["claude"], allowSandboxDesktop: true },
  };
  for (const m of ["desktop.status", "desktop.set", "desktop.start", "desktop.view", "desktop.lease"])
    assert.doesNotThrow(() => assertMethodAllowed(guest, m));
  assert.throws(() => assertMethodAllowed(guest, "orchestrator.set"), /not permitted for guest/);
  // Their agents are still forced into Docker.
  const s = enforceGuestSettings(guest, {
    runtime: "claude",
    model: "",
    profile: "",
    concurrency: 1,
    runner: "",
    respondTo: "owner-only",
    respondToAllowlist: [],
  });
  assert.equal(s.runner, "docker");
  assert.throws(
    () => enforceGuestSettings(guest, { runtime: "claude", concurrency: 1, runner: "host", respondTo: "owner-only" }),
    /sandboxed runner/,
  );
  assert.doesNotThrow(() => assertGuestDesktop(guest, { runner: "docker" }));
  assert.throws(() => assertGuestDesktop(guest, { runner: "host" }), /not enabled/);
  assert.throws(() => assertGuestDesktop(guest, {}), /not enabled/);
  const noDesk = { ...guest, limits: { ...guest.limits, allowSandboxDesktop: false } };
  assert.throws(() => assertGuestDesktop(noDesk, { runner: "docker" }), /not enabled/);
  const trusted = { ...guest, limits: { ...guest.limits, allowHostDesktop: true } };
  assert.doesNotThrow(() => assertGuestDesktop(trusted, { runner: "host" }));
  assert.doesNotThrow(() => assertGuestDesktop({ role: "admin" }, { runner: "host" }));
  assert.doesNotThrow(() => assertGuestDesktop(undefined, { runner: "host" }));
});

test("allowLogins is optional for token-only hosts and unchanged when populated", () => {
  const populated = parseListenerConfig({ allowLogins: ["me@example.com", "you@example.com"] });
  assert.deepEqual([...populated.allowLogins], ["me@example.com", "you@example.com"]);
  assert.equal(populated.guestPort, 8467);

  for (const raw of [{}, { allowLogins: [] }, { allowLogins: null }]) {
    const cfg = parseListenerConfig(raw);
    assert.equal(cfg.allowLogins.size, 0);
    assert.equal(cfg.guestPort, 8467);
  }
  assert.equal(parseListenerConfig({ guestPort: 9000 }).guestPort, 9000);
  // Populated allowLogins may still turn the token listener off.
  assert.equal(parseListenerConfig({ allowLogins: ["me@example.com"], guestPort: 0 }).guestPort, 0);

  assert.throws(() => parseListenerConfig({ allowLogins: "me@example.com" }, "cfg.json"), /cfg\.json: allowLogins must list/);
  // No tailnet logins AND no token listener: nothing could ever connect.
  assert.throws(() => parseListenerConfig({ allowLogins: [], guestPort: 0 }), /guestPort must be set/);
  assert.throws(() => parseListenerConfig({ guestPort: "8467" }), /guestPort must be set/);
});

test("buzz-host-tokens CLI creates admin tokens and lists roles", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-tokens-admin-cli-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "tokens.json");
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "buzz-host-tokens");
  const runCli = (...args) =>
    execFileSync(process.execPath, [cli, ...args, "--file", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const admin = JSON.parse(
    runCli("create-admin", "--label", "Laptop", "--owner", OWNER_A, "--url", "wss://tunnel.example/_buzz-host", "--json"),
  );
  assert.match(admin.token, /^bha_[0-9a-f]{48}$/);
  assert.equal(admin.record.role, "admin");
  assert.equal(admin.record.ownerPubkey, OWNER_A);
  assert.equal(admin.pairingUrl, `wss://tunnel.example/_buzz-host#token=${admin.token}`);

  const viaRole = JSON.parse(runCli("create", "--role", "admin", "--label", "Desktop", "--url", "wss://x.example", "--json"));
  assert.match(viaRole.token, /^bha_/);
  const guest = JSON.parse(runCli("create", "--label", "Friend", "--url", "wss://x.example", "--json"));
  assert.match(guest.token, /^bhg_/);

  // Guest caps make no sense on an admin token; bad roles are refused.
  assert.throws(() => runCli("create-admin", "--label", "X", "--max-agents", "3"), /no guest caps/);
  assert.throws(() => runCli("create", "--role", "root", "--label", "X"), /--role must be/);

  const listed = JSON.parse(runCli("list", "--json")).tokens;
  assert.deepEqual(listed.map((t) => t.role), ["admin", "admin", "guest"]);
  const text = runCli("list");
  assert.match(text, new RegExp(`${admin.record.id}  admin  Laptop  \\[active\\].*full access`));
  assert.match(text, new RegExp(`${guest.record.id}  guest  Friend  \\[active\\].*caps=2a/2c`));

  const revoked = JSON.parse(runCli("revoke", admin.record.id, "--json")).record;
  assert.equal(revoked.role, "admin");
  assert.ok(revoked.revokedAt);
  assert.match(runCli("list"), /admin  Laptop  \[REVOKED/);
});

test("fs.* RPCs need a signed-in session but are open to guests (jailed in buzz-host)", () => {
  const admin = { authenticated: true, role: "admin" };
  const guest = {
    authenticated: true,
    role: "guest",
    tokenId: "tok_cccccccccccc",
    ownerPubkey: OWNER_A,
    limits: {
      maxAgents: 2,
      maxConcurrency: 2,
      allowedRuntimes: ["hermes"],
      allowHostDesktop: false,
      allowSandboxDesktop: false,
    },
  };
  for (const method of ["fs.list", "fs.read", "fs.write", "fs.mkdir", "fs.rename", "fs.delete"]) {
    assert.ok(!ADMIN_ONLY_METHODS.has(method), method);
    assert.doesNotThrow(() => assertMethodAllowed(admin, method));
    assert.doesNotThrow(() => assertMethodAllowed(guest, method));
    assert.throws(() => assertMethodAllowed({ authenticated: false, role: "guest" }, method), /Authentication required/);
    assert.throws(() => assertMethodAllowed(undefined, method), /Authentication required/);
  }
});

test("delegate tokens: bhd_ prefix, required owner & expiry, defaults, expiry check, and no escalation", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-auth-delegate-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const filePath = path.join(tmp, "tokens.json");
  const store = createTokenStore({ filePath });

  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  // Owner is required (never TOFU-bound).
  await assert.rejects(() => store.createDelegate({ label: "from omarchy", now }), /ownerPubkey is required/);
  await assert.rejects(
    () => store.createDelegate({ label: "bad access", ownerPubkey: OWNER_A, access: "root", now }),
    /access must be/,
  );
  await assert.rejects(
    () => store.createDelegate({ label: "too long", ownerPubkey: OWNER_A, expiresAt: "366d", now }),
    /cannot exceed 365 days/,
  );
  await assert.rejects(
    () => store.createDelegate({ label: "in past", ownerPubkey: OWNER_A, expiresAt: new Date(now - 1000).toISOString(), now }),
    /must be in the future/,
  );
  await assert.rejects(
    () => store.createDelegate({ label: "rel ws", ownerPubkey: OWNER_A, workspaces: ["relative/path"], now }),
    /absolute or ~\/ path/,
  );

  // Defaults: 90d expiry, sandboxed access, maxConcurrency 2, agents "all".
  const { token, record } = await store.createDelegate({
    label: "from omarchy",
    ownerPubkey: OWNER_A,
    peerMachineId: "11111111-2222-3333-4444-555555555555",
    workspaces: ["~/Work", "/srv/repos"],
    now,
  });
  assert.match(token, /^bhd_[0-9a-f]{48}$/);
  assert.equal(record.role, "delegate");
  assert.equal(record.ownerPubkey, OWNER_A);
  assert.equal(record.access, "sandboxed");
  assert.equal(record.agents, "all");
  assert.equal(record.maxConcurrency, 2);
  assert.equal(record.maxTaskMs, 7_200_000);
  assert.deepEqual(record.workspaces, ["~/Work", "/srv/repos"]);
  assert.equal(Date.parse(record.expiresAt) - now, 90 * 86_400_000);

  // Plaintext token never written to disk.
  const rawDisk = await fs.readFile(filePath, "utf8");
  assert.ok(!rawDisk.includes(token));

  // Verify works before expiry and fails at/after expiry.
  const ok = await store.verify(token, { now: now + 1_000 });
  assert.equal(ok.id, record.id);
  assert.equal(ok.role, "delegate");
  assert.equal(isTokenExpired(ok, now + 1_000), false);
  assert.equal(isTokenExpired(ok, Date.parse(record.expiresAt)), true);
  assert.equal(await store.verify(token, { now: Date.parse(record.expiresAt) }), null);

  // Cannot bindOwner on delegate token.
  await assert.rejects(() => store.bindOwner(record.id, OWNER_B), /Only guest tokens/);

  // Explicit tokenRole refuses unknown roles; edited role on disk cannot escalate.
  assert.equal(tokenRole({ role: "admin" }), "admin");
  assert.equal(tokenRole({ role: "guest" }), "guest");
  assert.equal(tokenRole({ role: "delegate" }), "delegate");
  assert.equal(tokenRole({}), "guest"); // legacy pre-role record
  assert.equal(tokenRole({ role: "superuser" }), null);

  const tampered = JSON.parse(await fs.readFile(filePath, "utf8"));
  tampered.tokens[0].role = "admin";
  await fs.writeFile(filePath, JSON.stringify(tampered));
  assert.equal(await store.verify(token, { now: now + 1_000 }), null, "bhd_ prefix refuses admin role");

  tampered.tokens[0].role = "unknown";
  await fs.writeFile(filePath, JSON.stringify(tampered));
  assert.equal(await store.verify(token, { now: now + 1_000 }), null, "unknown role refused");
});

test("delegate allow-list refuses every non-delegate method, desktop tickets, and agent access", () => {
  const delegateSession = {
    authenticated: true,
    role: "delegate",
    tokenId: "tok_dddddddddddd",
    ownerPubkey: OWNER_A,
  };
  for (const method of DELEGATE_ALLOWED_METHODS) {
    assert.doesNotThrow(() => assertMethodAllowed(delegateSession, method));
  }
  for (const forbidden of [
    "hello",
    "list",
    "provision",
    "activate",
    "remove",
    "settings.get",
    "settings.set",
    "instructions.get",
    "instructions.set",
    "desktop.status",
    "desktop.view",
    "fs.read",
    "orchestrator.tasks",
    "tokens.create",
    "tokens.createDelegate",
    "tokens.list",
    "tokens.revoke",
    "links.add",
    "links.list",
    "some.future.method",
  ]) {
    assert.throws(() => assertMethodAllowed(delegateSession, forbidden), /not permitted for delegate/, forbidden);
  }

  // Admin and guest cannot call delegate.* directly.
  const admin = { authenticated: true, role: "admin" };
  const guest = { authenticated: true, role: "guest", tokenId: "tok_111111111111", ownerPubkey: OWNER_A };
  assert.throws(() => assertMethodAllowed(admin, "delegate.start"), /requires a delegate token/);
  assert.throws(() => assertMethodAllowed(guest, "delegate.hello"), /requires a delegate token/);

  // New admin-only RPCs are blocked for guests.
  for (const adminRpc of ["tokens.createDelegate", "links.add", "links.list", "links.update", "links.remove", "links.test"]) {
    assert.ok(ADMIN_ONLY_METHODS.has(adminRpc), adminRpc);
    assert.throws(() => assertMethodAllowed(guest, adminRpc), /not permitted for guest/, adminRpc);
    assert.doesNotThrow(() => assertMethodAllowed(admin, adminRpc));
  }

  // Delegate can never access agents via canAccessAgent or open desktop tickets.
  assert.equal(canAccessAgent(delegateSession, { pubkey: "1".repeat(64), owner: OWNER_A, activated: true }), false);
  const ticket = { pubkey: "1".repeat(64), viewer: "v".repeat(24), expires: Date.now() + 60_000, role: "delegate", tokenId: "tok_dddddddddddd" };
  assert.equal(isValidDesktopTicket(ticket, "guest"), false);
  assert.equal(isValidDesktopTicket(ticket, "admin"), false);
  assert.equal(
    desktopTicketTokenAllowed(ticket, { id: "tok_dddddddddddd", role: "delegate", revokedAt: null, expiresAt: parseExpiresAt("1d") }),
    false,
  );
});
