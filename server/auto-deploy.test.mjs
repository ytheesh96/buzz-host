import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_DEPLOY = path.join(REPO_ROOT, "server", "auto-deploy.sh");
const DEPLOY_SH = path.join(REPO_ROOT, "deploy.sh");

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...extraEnv,
    },
  }).trim();
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-autodeploy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const deployRepo = path.join(root, "deploy-repo");
  const stateDir = path.join(root, "state");
  const libDir = path.join(root, "lib");
  const systemdDir = path.join(root, "systemd");
  const hermesDir = path.join(root, "hermes");
  const geminiDir = path.join(root, "gemini");
  const restartLog = path.join(root, "restarts.log");
  const testLog = path.join(root, "tests.log");

  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, work]);
  git(work, ["checkout", "-B", "main"]);

  // Populate minimal buzz-host tree matching deploy.sh expectations.
  fs.mkdirSync(path.join(work, "server", "desktop"), { recursive: true });
  fs.mkdirSync(path.join(work, "server", "shims"), { recursive: true });
  fs.mkdirSync(path.join(work, "server", "agent-bin"), { recursive: true });
  fs.mkdirSync(path.join(work, "hermes-plugin", "buzz-host-session-env"), { recursive: true });
  fs.mkdirSync(path.join(work, "agy-plugin", "buzz-host-guards"), { recursive: true });
  fs.mkdirSync(path.join(work, "plugin"), { recursive: true });

  fs.copyFileSync(DEPLOY_SH, path.join(work, "deploy.sh"));
  fs.chmodSync(path.join(work, "deploy.sh"), 0o755);
  fs.copyFileSync(AUTO_DEPLOY, path.join(work, "server", "auto-deploy.sh"));
  fs.chmodSync(path.join(work, "server", "auto-deploy.sh"), 0o755);

  const serverFiles = [
    "buzz-host.mjs",
    "agent-run",
    "auth.mjs",
    "attention.mjs",
    "attention-core.mjs",
    "buzz-mcp.mjs",
    "mcp-server.mjs",
    "memory.mjs",
    "nip44.mjs",
    "attention-relay.mjs",
    "noble.mjs",
    "workspace.mjs",
    "catalog.mjs",
    "orchestrator.mjs",
    "control.mjs",
    "file-lock.mjs",
    "ws-security.mjs",
  ];
  for (const f of serverFiles) {
    const p = path.join(work, "server", f);
    fs.writeFileSync(p, `// ${f} v1\n`);
    if (f === "buzz-host.mjs" || f === "agent-run") fs.chmodSync(p, 0o755);
  }
  fs.writeFileSync(path.join(work, "server", "acp-proxy"), "#!/bin/sh\necho v1\n");
  fs.chmodSync(path.join(work, "server", "acp-proxy"), 0o755);
  fs.writeFileSync(path.join(work, "server", "buzz-host-tokens"), "#!/bin/sh\necho v1\n");
  fs.chmodSync(path.join(work, "server", "buzz-host-tokens"), 0o755);
  fs.writeFileSync(path.join(work, "server", "desktop", "desktop.mjs"), "// desktop v1\n");
  fs.writeFileSync(path.join(work, "server", "desktop", "desktop.test.mjs"), "// should not deploy\n");
  fs.writeFileSync(path.join(work, "server", "desktop", "launcher.sh"), "#!/bin/sh\n");
  fs.chmodSync(path.join(work, "server", "desktop", "launcher.sh"), 0o755);
  fs.writeFileSync(path.join(work, "server", "desktop", "wallpaper.png"), "PNG");
  fs.writeFileSync(path.join(work, "server", "shims", "claude-agent-acp"), "#!/bin/sh\n");
  fs.chmodSync(path.join(work, "server", "shims", "claude-agent-acp"), 0o755);
  fs.writeFileSync(path.join(work, "server", "agent-bin", "buzz"), "#!/bin/sh\n");
  fs.chmodSync(path.join(work, "server", "agent-bin", "buzz"), 0o755);
  fs.writeFileSync(path.join(work, "server", "buzz-host.service"), "[Unit]\nDescription=v1\n");
  fs.writeFileSync(path.join(work, "server", "buzz-agent@.service"), "[Unit]\nDescription=agent v1\n");
  fs.writeFileSync(path.join(work, "hermes-plugin", "buzz-host-session-env", "plugin.py"), "# v1\n");
  fs.writeFileSync(path.join(work, "agy-plugin", "buzz-host-guards", "plugin.json"), '{"name":"buzz-host-guards"}\n');
  fs.writeFileSync(path.join(work, "agy-plugin", "buzz-host-guards", "deny-schedule.sh"), "#!/bin/sh\n");
  fs.chmodSync(path.join(work, "agy-plugin", "buzz-host-guards", "deny-schedule.sh"), 0o755);
  fs.writeFileSync(path.join(work, "plugin", "plugin.js"), "// plugin v1\n");
  fs.writeFileSync(path.join(work, "README.md"), "# v1\n");

  git(work, ["add", "."]);
  git(work, ["commit", "-m", "initial v1"]);
  git(work, ["push", "-u", "origin", "main"]);

  // Pre-seed unmanaged binaries in lib/bin and hermes plugins dir.
  fs.mkdirSync(path.join(libDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(libDir, "npm"), { recursive: true });
  fs.writeFileSync(path.join(libDir, "bin", "buzz-acp"), "UNMANAGED_BINARY");
  fs.writeFileSync(path.join(libDir, "npm", "keep.txt"), "KEEP");
  fs.mkdirSync(path.join(hermesDir, "plugins"), { recursive: true });

  const baseEnv = {
    ...process.env,
    BUZZ_HOST_REPO_URL: origin,
    BUZZ_HOST_BRANCH: "main",
    BUZZ_HOST_DEPLOY_REPO: deployRepo,
    BUZZ_HOST_DEPLOY_STATE: stateDir,
    BUZZ_HOST_LIB_DIR: libDir,
    BUZZ_HOST_SYSTEMD_DIR: systemdDir,
    BUZZ_HOST_HERMES_DIR: hermesDir,
    BUZZ_HOST_GEMINI_DIR: geminiDir,
    BUZZ_HOST_HEALTH_TIMEOUT: "2",
    BUZZ_HOST_TEST_CMD: `echo ran >> "${testLog}"`,
    BUZZ_HOST_RESTART_CMD: `echo restarted >> "${restartLog}"`,
    BUZZ_HOST_ACTIVE_CMD: "true",
    BUZZ_HOST_HEALTH_CMD: "true",
  };

  const runDeploy = (extraEnv = {}, args = []) => {
    try {
      const stdout = execFileSync(AUTO_DEPLOY, args, {
        encoding: "utf8",
        env: { ...baseEnv, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      return {
        code: e.status ?? 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? ""),
      };
    }
  };

  const countLines = (p) =>
    fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length : 0;

  return {
    root,
    origin,
    work,
    deployRepo,
    stateDir,
    libDir,
    systemdDir,
    hermesDir,
    restartLog,
    testLog,
    runDeploy,
    countLines,
  };
}

test("auto-deploy: initial deploy, no-op repeat, path-filtered skip, and server deploy", (t) => {
  const fx = makeFixture(t);
  const sha1 = git(fx.work, ["rev-parse", "HEAD"]);

  // 1. Initial deploy installs managed files, preserves unmanaged files, runs tests & restarts.
  const r1 = fx.runDeploy();
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stdout, /deployed:/);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), sha1);
  assert.equal(fs.readFileSync(path.join(fx.libDir, "buzz-host.mjs"), "utf8"), "// buzz-host.mjs v1\n");
  assert.equal(fs.existsSync(path.join(fx.libDir, "desktop", "desktop.test.mjs")), false);
  assert.equal(fs.readFileSync(path.join(fx.libDir, "bin", "buzz-acp"), "utf8"), "UNMANAGED_BINARY");
  assert.equal(fs.readFileSync(path.join(fx.libDir, "npm", "keep.txt"), "utf8"), "KEEP");
  assert.equal(
    fs.readFileSync(path.join(fx.hermesDir, "plugins", "buzz-host-session-env", "plugin.py"), "utf8"),
    "# v1\n",
  );
  assert.equal(fx.countLines(fx.testLog), 1);
  assert.equal(fx.countLines(fx.restartLog), 1);

  // 2. Second run with no new commits is a silent no-op.
  const r2 = fx.runDeploy();
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout, "");
  assert.equal(fx.countLines(fx.testLog), 1);
  assert.equal(fx.countLines(fx.restartLog), 1);

  // 3. Plugin/docs-only commit advances deployed-sha without running tests or restarting.
  fs.writeFileSync(path.join(fx.work, "plugin", "plugin.js"), "// plugin v2\n");
  fs.writeFileSync(path.join(fx.work, "README.md"), "# v2\n");
  git(fx.work, ["add", "."]);
  git(fx.work, ["commit", "-m", "plugin and docs only"]);
  git(fx.work, ["push", "origin", "main"]);
  const sha2 = git(fx.work, ["rev-parse", "HEAD"]);

  const r3 = fx.runDeploy();
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /skip \(no server\/hermes-plugin changes\)/);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), sha2);
  assert.equal(fx.countLines(fx.testLog), 1);
  assert.equal(fx.countLines(fx.restartLog), 1);

  // 4. Server change runs tests, installs atomically, and restarts.
  fs.writeFileSync(path.join(fx.work, "server", "catalog.mjs"), "// catalog.mjs v2\n");
  git(fx.work, ["add", "."]);
  git(fx.work, ["commit", "-m", "update catalog"]);
  git(fx.work, ["push", "origin", "main"]);
  const sha3 = git(fx.work, ["rev-parse", "HEAD"]);

  const r4 = fx.runDeploy();
  assert.equal(r4.code, 0, r4.stderr);
  assert.match(r4.stdout, /deployed:/);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), sha3);
  assert.equal(fs.readFileSync(path.join(fx.libDir, "catalog.mjs"), "utf8"), "// catalog.mjs v2\n");
  assert.equal(fx.countLines(fx.testLog), 2);
  assert.equal(fx.countLines(fx.restartLog), 2);
});

test("auto-deploy: failing tests abort without touching live files and deduplicate retries", (t) => {
  const fx = makeFixture(t);
  assert.equal(fx.runDeploy().code, 0);
  const goodSha = git(fx.work, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(fx.work, "server", "buzz-host.mjs"), "// broken v2\n");
  git(fx.work, ["add", "."]);
  git(fx.work, ["commit", "-m", "broken server"]);
  git(fx.work, ["push", "origin", "main"]);
  const badSha = git(fx.work, ["rev-parse", "HEAD"]);

  const failRes = fx.runDeploy({ BUZZ_HOST_TEST_CMD: `echo fail >> "${fx.testLog}"; exit 1` });
  assert.equal(failRes.code, 1);
  assert.match(failRes.stderr, /pre-deploy tests failed/);
  assert.equal(fs.readFileSync(path.join(fx.libDir, "buzz-host.mjs"), "utf8"), "// buzz-host.mjs v1\n");
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), goodSha);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "last-failed-sha"), "utf8").trim(), badSha);
  assert.equal(fx.countLines(fx.restartLog), 1);

  // Repeat run on the same broken SHA skips without re-running tests.
  const dedupRes = fx.runDeploy({ BUZZ_HOST_TEST_CMD: `echo fail >> "${fx.testLog}"; exit 1` });
  assert.equal(dedupRes.code, 0);
  assert.equal(fx.countLines(fx.testLog), 2);

  // New fix commit clears last-failed-sha and deploys cleanly.
  fs.writeFileSync(path.join(fx.work, "server", "buzz-host.mjs"), "// fixed v3\n");
  git(fx.work, ["add", "."]);
  git(fx.work, ["commit", "-m", "fix server"]);
  git(fx.work, ["push", "origin", "main"]);
  const fixedSha = git(fx.work, ["rev-parse", "HEAD"]);

  const okRes = fx.runDeploy();
  assert.equal(okRes.code, 0, okRes.stderr);
  assert.equal(fs.readFileSync(path.join(fx.libDir, "buzz-host.mjs"), "utf8"), "// fixed v3\n");
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), fixedSha);
  assert.equal(fs.existsSync(path.join(fx.stateDir, "last-failed-sha")), false);
});

test("auto-deploy: failed health check automatically rolls back live files and systemd units", (t) => {
  const fx = makeFixture(t);
  assert.equal(fx.runDeploy().code, 0);
  const goodSha = git(fx.work, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(fx.work, "server", "buzz-host.mjs"), "// unhealthy v2\n");
  fs.writeFileSync(path.join(fx.work, "server", "buzz-host.service"), "[Unit]\nDescription=v2\n");
  git(fx.work, ["add", "."]);
  git(fx.work, ["commit", "-m", "unhealthy server"]);
  git(fx.work, ["push", "origin", "main"]);
  const badSha = git(fx.work, ["rev-parse", "HEAD"]);

  const res = fx.runDeploy({
    BUZZ_HOST_HEALTH_CMD: "false",
    BUZZ_HOST_HEALTH_TIMEOUT: "1",
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /rolling back/);
  // Live files and systemd unit restored to v1; unmanaged bin untouched.
  assert.equal(fs.readFileSync(path.join(fx.libDir, "buzz-host.mjs"), "utf8"), "// buzz-host.mjs v1\n");
  assert.equal(
    fs.readFileSync(path.join(fx.systemdDir, "buzz-host.service"), "utf8"),
    "[Unit]\nDescription=v1\n",
  );
  assert.equal(fs.readFileSync(path.join(fx.libDir, "bin", "buzz-acp"), "utf8"), "UNMANAGED_BINARY");
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), goodSha);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "last-failed-sha"), "utf8").trim(), badSha);
  // Restart called for initial deploy (1) + failed deploy (2) + rollback (3).
  assert.equal(fx.countLines(fx.restartLog), 3);
});

test("auto-deploy: --seed records current origin/main without restarting", (t) => {
  const fx = makeFixture(t);
  const sha1 = git(fx.work, ["rev-parse", "HEAD"]);

  const res = fx.runDeploy({}, ["--seed"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /seeded deployed-sha/);
  assert.equal(fs.readFileSync(path.join(fx.stateDir, "deployed-sha"), "utf8").trim(), sha1);
  assert.equal(fx.countLines(fx.restartLog), 0);
  assert.equal(fx.countLines(fx.testLog), 0);
});
