// install.sh end to end against tiny fake bundles in a temporary HOME.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../install.sh");
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const ASSET = `buzz-host-${TARGET}.tar.gz`;

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bh-install-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal bundle tarball whose bin/buzz-host records its arguments. */
async function makeTarball(dir, version, { target = TARGET, build = "a" } = {}) {
  const top = `buzz-host-${version}-${target}`;
  const stage = path.join(dir, `stage-${version}-${build}`, top);
  await fs.mkdir(path.join(stage, "bin"), { recursive: true });
  await fs.writeFile(path.join(stage, "VERSION"), `${version}\n`);
  await fs.writeFile(path.join(stage, "TARGET"), `${target}\n`);
  await fs.writeFile(path.join(stage, "BUNDLE_ID"), `${version} ${target} ${build}\n`);
  await fs.writeFile(
    path.join(stage, "bin/buzz-host"),
    `#!/bin/sh\nprintf '%s\\n' "${version}" "$@" > "$HOME/up-args"\n`,
    { mode: 0o755 },
  );
  const out = path.join(dir, `out-${version}-${build}`);
  await fs.mkdir(out, { recursive: true });
  const file = path.join(out, ASSET);
  await run("tar", ["-czf", file, "-C", path.dirname(stage), top]);
  const sha = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  await fs.writeFile(path.join(out, "SHA256SUMS"), `${sha}  ${ASSET}\n`);
  return { file, sha, out };
}

function install(home, args) {
  return run("sh", [INSTALL, ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" },
  });
}

const runtime = (home) => path.join(home, ".local/share/buzz-host/runtime");

test("installs a bundle, links current and ~/.local/bin/buzz-host, and is idempotent", { skip: !["linux-x64", "linux-arm64", "darwin-arm64"].includes(TARGET) }, async (t) => {
  const dir = await tmp(t);
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const v1 = await makeTarball(dir, "1.0.0");
  await install(home, ["--bundle", v1.file]);
  assert.equal(await fs.readlink(path.join(runtime(home), "current")), "1.0.0");
  assert.equal(await fs.readlink(path.join(home, ".local/bin/buzz-host")), path.join(runtime(home), "current/bin/buzz-host"));
  await fs.access(path.join(runtime(home), "1.0.0/VERSION"));

  const again = await install(home, ["--bundle", v1.file]);
  assert.match(again.stderr, /1\.0\.0 is already installed/);
  // No leftover temp dirs.
  assert.deepEqual((await fs.readdir(runtime(home))).sort(), ["1.0.0", "current"]);
});

test("upgrades keep the previous version and prune older ones", { skip: !["linux-x64", "linux-arm64", "darwin-arm64"].includes(TARGET) }, async (t) => {
  const dir = await tmp(t);
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) await install(home, ["--bundle", (await makeTarball(dir, v)).file]);
  assert.deepEqual((await fs.readdir(runtime(home))).sort(), ["1.1.0", "1.2.0", "current"]);
  assert.equal(await fs.readlink(path.join(runtime(home), "current")), "1.2.0");

  // Same version, different build: replaced.
  const rebuilt = await makeTarball(dir, "1.2.0", { build: "b" });
  await install(home, ["--bundle", rebuilt.file]);
  assert.match(await fs.readFile(path.join(runtime(home), "1.2.0/BUNDLE_ID"), "utf8"), / b$/m);
});

test("refuses a checksum mismatch or another machine's bundle, leaving current alone", { skip: !["linux-x64", "linux-arm64", "darwin-arm64"].includes(TARGET) }, async (t) => {
  const dir = await tmp(t);
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  await install(home, ["--bundle", (await makeTarball(dir, "1.0.0")).file]);

  const v2 = await makeTarball(dir, "2.0.0");
  await assert.rejects(install(home, ["--bundle", v2.file, "--sha256", "0".repeat(64)]), (error) => {
    assert.match(error.stderr, /checksum mismatch/);
    return true;
  });
  const other = TARGET === "linux-x64" ? "linux-arm64" : "linux-x64";
  const wrong = await makeTarball(dir, "3.0.0", { target: other });
  await assert.rejects(install(home, ["--bundle", wrong.file]), (error) => {
    assert.match(error.stderr, new RegExp(`bundle is for ${other}`));
    return true;
  });
  await assert.rejects(install(path.join(dir, "home"), ["--bundle", path.join(dir, "nope.tar.gz")]), /no such bundle/);
  assert.equal(await fs.readlink(path.join(runtime(home), "current")), "1.0.0");
  assert.deepEqual((await fs.readdir(runtime(home))).sort(), ["1.0.0", "current"]);
});

test("downloads from --base-url, checks SHA256SUMS, and hands --up arguments to buzz-host up", { skip: !["linux-x64", "linux-arm64", "darwin-arm64"].includes(TARGET) }, async (t) => {
  const dir = await tmp(t);
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const v1 = await makeTarball(dir, "1.0.0");
  await install(home, ["--base-url", `file://${v1.out}`, "--up", "--json", "--guest-port", "9467"]);
  assert.equal(await fs.readFile(path.join(home, "up-args"), "utf8"), "1.0.0\nup\n--json\n--guest-port\n9467\n");

  // A tampered asset fails against the published sums.
  await fs.writeFile(path.join(v1.out, "SHA256SUMS"), `${"1".repeat(64)}  ${ASSET}\n`);
  await assert.rejects(install(home, ["--base-url", `file://${v1.out}`]), /checksum mismatch/);
});
