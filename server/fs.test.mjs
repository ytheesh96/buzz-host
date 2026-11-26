// node --test server/fs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDirectory,
  deletePath,
  fsOptionsForSession,
  listDirectory,
  MAX_WRITE_BYTES,
  readFile,
  renamePath,
  resolveHostPath,
  resolveJailedPath,
  toDisplayPath,
  writeFile,
} from "./fs.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n';
const BIG_TEXT = "a".repeat(4096);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-fs-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const work = path.join(home, "Work");
  const projectA = path.join(work, "project-a");
  await fs.mkdir(path.join(projectA, ".git"), { recursive: true });
  await fs.writeFile(path.join(projectA, "a.txt"), "one\n");
  await fs.mkdir(path.join(work, "project-b"), { recursive: true });
  await fs.writeFile(path.join(work, "readme.md"), "# Work\n");
  await fs.mkdir(path.join(home, ".hidden-dir"), { recursive: true });
  await fs.writeFile(path.join(home, ".hidden-file"), "secret\n");
  await fs.writeFile(path.join(home, "notes.txt"), "hello\n");
  await fs.writeFile(path.join(home, "big.txt"), BIG_TEXT);
  await fs.writeFile(path.join(home, "binary.dat"), Buffer.from([0x41, 0x00, 0x42]));
  await fs.writeFile(path.join(home, "photo.png"), PNG_BYTES);
  await fs.writeFile(path.join(home, "vector.svg"), SVG_TEXT);
  await fs.writeFile(path.join(home, "huge.png"), Buffer.alloc(2048, 0x7f));
  await fs.symlink(projectA, path.join(home, "dir-link"));
  await fs.symlink(path.join(home, "missing-target"), path.join(home, "broken-link"));
  return { root, home, work, projectA };
}

test("resolveHostPath expands ~, rejects unsafe input, and normalizes", () => {
  const home = "/home/tester";
  assert.equal(resolveHostPath(undefined, { homeDir: home }), home);
  assert.equal(resolveHostPath("", { homeDir: home }), home);
  assert.equal(resolveHostPath("   ", { homeDir: home }), home);
  assert.equal(resolveHostPath("~", { homeDir: home }), home);
  assert.equal(resolveHostPath("~/Work/app", { homeDir: home }), "/home/tester/Work/app");
  assert.equal(resolveHostPath("/etc/hosts", { homeDir: home }), "/etc/hosts");
  assert.equal(resolveHostPath("Work/../Work/app", { homeDir: home }), path.resolve("Work/app"));

  assert.throws(() => resolveHostPath("~/bad\u0000path", { homeDir: home }), /NUL/);
  assert.throws(() => resolveHostPath(42, { homeDir: home }), /must be a string/);
  assert.throws(() => resolveHostPath({ path: "~" }, { homeDir: home }), /must be a string/);
});

test("resolveHostPath maps another machine's home only when the literal path is absent", async (t) => {
  const { root, home } = await fixture(t);

  // A literal path that exists here always wins.
  assert.equal(resolveHostPath(path.join(home, "notes.txt"), { homeDir: home }), path.join(home, "notes.txt"));

  // /Users/... and /home/... map under this host's home when the mapped path exists.
  assert.equal(resolveHostPath("/Users/buzz-test-stranger/Work", { homeDir: home }), path.join(home, "Work"));
  assert.equal(
    resolveHostPath("/home/buzz-test-stranger/Work/project-a", { homeDir: home }),
    path.join(home, "Work/project-a"),
  );
  // Exact home path maps to this host's home.
  assert.equal(resolveHostPath("/Users/buzz-test-stranger", { homeDir: home }), home);

  // While browsing, a missing leaf still maps when its parent exists.
  assert.equal(
    resolveHostPath("/Users/buzz-test-stranger/Work/new-folder", { homeDir: home, browsing: true }),
    path.join(home, "Work/new-folder"),
  );
  // Reading a file does not invent a missing leaf.
  assert.equal(
    resolveHostPath("/Users/buzz-test-stranger/Work/new-folder", { homeDir: home }),
    "/Users/buzz-test-stranger/Work/new-folder",
  );

  // Nothing under the mapped home: leave the literal path alone.
  assert.equal(
    resolveHostPath("/Users/buzz-test-stranger/nope/child", { homeDir: home, browsing: true }),
    "/Users/buzz-test-stranger/nope/child",
  );

  // The fixture root is a real path; keep it independent of the mapping rule.
  assert.ok(root.startsWith(os.tmpdir()));
});

test("toDisplayPath uses ~ for this host's home and abs paths elsewhere", () => {
  assert.equal(toDisplayPath("/home/tester", "/home/tester"), "~");
  assert.equal(toDisplayPath("/home/tester/Work/app", "/home/tester"), "~/Work/app");
  assert.equal(toDisplayPath("/home/tester2/Work", "/home/tester"), "/home/tester2/Work");
  assert.equal(toDisplayPath("/etc/hosts", "/home/tester"), "/etc/hosts");
});

test("listDirectory defaults to home, directories first, hidden entries hidden", async (t) => {
  const { home } = await fixture(t);
  const listing = await listDirectory({}, { homeDir: home });

  assert.equal(listing.path, home);
  assert.equal(listing.displayPath, "~");
  assert.equal(listing.home, home);
  assert.equal(listing.parent, path.dirname(home));
  assert.equal(listing.parentDisplay, path.dirname(home));
  assert.equal(listing.truncated, false);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["dir-link", "Work", "big.txt", "binary.dat", "broken-link", "huge.png", "notes.txt", "photo.png", "vector.svg"],
  );

  const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.Work.kind, "dir");
  assert.equal(byName.Work.targetKind, null);
  assert.equal(byName.Work.isGitRepo, false);
  assert.equal(byName.Work.displayPath, "~/Work");
  assert.equal(byName["dir-link"].kind, "symlink");
  assert.equal(byName["dir-link"].targetKind, "dir");
  assert.equal(byName["dir-link"].isGitRepo, true);
  assert.equal(byName["broken-link"].kind, "symlink");
  assert.equal(byName["broken-link"].targetKind, null);
  assert.equal(byName["broken-link"].isGitRepo, false);
  assert.equal(byName["notes.txt"].kind, "file");
  assert.equal(byName["notes.txt"].size, 6);
  assert.equal(typeof byName["notes.txt"].mtimeMs, "number");
  assert.equal(byName["notes.txt"].hidden, false);
  assert.equal(byName["notes.txt"].isGitRepo, false);
  assert.equal(byName["notes.txt"].displayPath, "~/notes.txt");
});

test("listDirectory showHidden surfaces dot entries; dirsOnly keeps dirs and dir symlinks", async (t) => {
  const { home } = await fixture(t);

  const withHidden = await listDirectory({ showHidden: true }, { homeDir: home });
  const hiddenNames = withHidden.entries.map((entry) => entry.name);
  assert.ok(hiddenNames.includes(".hidden-file"));
  assert.ok(hiddenNames.includes(".hidden-dir"));
  assert.equal(withHidden.entries.find((entry) => entry.name === ".hidden-file").hidden, true);
  assert.equal(withHidden.entries.find((entry) => entry.name === ".hidden-dir").kind, "dir");

  const dirsOnly = await listDirectory({ dirsOnly: true }, { homeDir: home });
  assert.deepEqual(dirsOnly.entries.map((entry) => entry.name), ["dir-link", "Work"]);
  assert.ok(dirsOnly.entries.every((entry) => entry.kind === "dir" || entry.targetKind === "dir"));
});

test("listDirectory limit clamps, truncates, and reports parent links", async (t) => {
  const { home, work } = await fixture(t);

  const page = await listDirectory({ limit: 2 }, { homeDir: home });
  assert.deepEqual(page.entries.map((entry) => entry.name), ["dir-link", "Work"]);
  assert.equal(page.truncated, true);

  const one = await listDirectory({ limit: 0 }, { homeDir: home });
  assert.equal(one.entries.length, 1);
  assert.equal(one.truncated, true);

  const everything = await listDirectory({ limit: 99_999 }, { homeDir: home });
  assert.equal(everything.entries.length, page.entries.length + 7);
  assert.equal(everything.truncated, false);

  const sub = await listDirectory({ path: "~/Work" }, { homeDir: home });
  assert.equal(sub.path, work);
  assert.equal(sub.displayPath, "~/Work");
  assert.equal(sub.parent, home);
  assert.equal(sub.parentDisplay, "~");
  assert.equal(sub.entries.find((entry) => entry.name === "project-a").isGitRepo, true);
  assert.equal(sub.entries.find((entry) => entry.name === "project-b").isGitRepo, false);
});

test("listDirectory follows a remote-shaped path and still lists the mapped folder", async (t) => {
  const { home, work } = await fixture(t);
  const listing = await listDirectory({ path: "/Users/buzz-test-stranger/Work" }, { homeDir: home });
  assert.equal(listing.path, work);
  assert.equal(listing.displayPath, "~/Work");
  assert.ok(listing.entries.some((entry) => entry.name === "project-a"));
});

test("listDirectory rejects missing paths, non-directories, and NUL bytes", async (t) => {
  const { home } = await fixture(t);

  await assert.rejects(
    () => listDirectory({ path: "~/does-not-exist" }, { homeDir: home }),
    /Directory not found: ~\/does-not-exist/,
  );
  await assert.rejects(
    () => listDirectory({ path: "~/notes.txt" }, { homeDir: home }),
    /Not a directory: ~\/notes.txt/,
  );
  await assert.rejects(() => listDirectory({ path: "~/a\u0000b" }, { homeDir: home }), /NUL/);
});

test("readFile returns text previews and bounded truncation", async (t) => {
  const { home } = await fixture(t);

  const notes = await readFile({ path: "~/notes.txt" }, { homeDir: home });
  assert.equal(notes.path, path.join(home, "notes.txt"));
  assert.equal(notes.displayPath, "~/notes.txt");
  assert.equal(notes.name, "notes.txt");
  assert.equal(notes.size, 6);
  assert.equal(notes.mimeType, "text/plain");
  assert.equal(notes.encoding, "utf8");
  assert.equal(notes.isBinary, false);
  assert.equal(notes.isImage, false);
  assert.equal(notes.truncated, false);
  assert.equal(notes.content, "hello\n");

  // A large text file is read only up to maxBytes.
  const bounded = await readFile({ path: "~/big.txt", maxBytes: 1024 }, { homeDir: home });
  assert.equal(bounded.size, 4096);
  assert.equal(bounded.content.length, 1024);
  assert.equal(bounded.truncated, true);

  // Below the 1 KiB floor the preview is still 1 KiB.
  const clamped = await readFile({ path: "~/big.txt", maxBytes: 10 }, { homeDir: home });
  assert.equal(clamped.content.length, 1024);
  assert.equal(clamped.truncated, true);

  // Default budget covers a 4 KiB file whole.
  const whole = await readFile({ path: "~/big.txt" }, { homeDir: home });
  assert.equal(whole.content.length, 4096);
  assert.equal(whole.truncated, false);
});

test("readFile detects binary content and sends raster images as base64", async (t) => {
  const { home } = await fixture(t);

  const binary = await readFile({ path: "~/binary.dat" }, { homeDir: home });
  assert.equal(binary.mimeType, "application/octet-stream");
  assert.equal(binary.encoding, "binary");
  assert.equal(binary.isBinary, true);
  assert.equal(binary.isImage, false);
  assert.equal(binary.content, null);
  assert.equal(binary.truncated, false);

  const image = await readFile({ path: "~/photo.png" }, { homeDir: home });
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.encoding, "base64");
  assert.equal(image.isBinary, false);
  assert.equal(image.isImage, true);
  assert.equal(image.content, PNG_BYTES.toString("base64"));
  assert.equal(image.truncated, false);

  // An image over the byte budget is described, not sent.
  const oversized = await readFile({ path: "~/huge.png", maxBytes: 1024 }, { homeDir: home });
  assert.equal(oversized.mimeType, "image/png");
  assert.equal(oversized.size, 2048);
  assert.equal(oversized.encoding, "binary");
  assert.equal(oversized.isBinary, true);
  assert.equal(oversized.isImage, true);
  assert.equal(oversized.truncated, true);
  assert.equal(oversized.content, null);

  // SVG stays inspectable text even though it is an image type.
  const svg = await readFile({ path: "~/vector.svg" }, { homeDir: home });
  assert.equal(svg.mimeType, "image/svg+xml");
  assert.equal(svg.encoding, "utf8");
  assert.equal(svg.isImage, false);
  assert.equal(svg.isBinary, false);
  assert.equal(svg.content, SVG_TEXT);
});

test("readFile follows symlinks and rejects directories, missing files, and missing path", async (t) => {
  const { home, projectA } = await fixture(t);
  await fs.symlink(path.join(projectA, "a.txt"), path.join(home, "a-link.txt"));

  const followed = await readFile({ path: "~/a-link.txt" }, { homeDir: home });
  assert.equal(followed.content, "one\n");
  assert.equal(followed.displayPath, "~/a-link.txt");

  await assert.rejects(() => readFile({ path: "~/Work" }, { homeDir: home }), /directory/i);
  await assert.rejects(
    () => readFile({ path: "~/does-not-exist.txt" }, { homeDir: home }),
    /File not found: ~\/does-not-exist\.txt/,
  );
  await assert.rejects(() => readFile({}, { homeDir: home }), /path is required/);
  await assert.rejects(() => readFile({ path: "~/a\u0000b" }, { homeDir: home }), /NUL/);
});

// ---------- jailed (guest) sessions and write RPCs ----------

/** A host home holding two guests' sandbox folders and an owner secret. */
async function jailFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-fs-jail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const jail = path.join(home, "buzz-sandboxes", "tok_aaaaaaaaaaaa");
  const other = path.join(home, "buzz-sandboxes", "tok_bbbbbbbbbbbb");
  await fs.mkdir(path.join(jail, "proj", ".git"), { recursive: true });
  await fs.writeFile(path.join(jail, "proj", "main.py"), "print('hi')\n");
  await fs.writeFile(path.join(jail, "notes.md"), "# notes\n");
  await fs.mkdir(path.join(other, "theirs"), { recursive: true });
  await fs.writeFile(path.join(other, "secret.txt"), "other guest\n");
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "OWNER KEY\n");
  // Links an agent in the container could plant.
  await fs.symlink(path.join(home, ".ssh"), path.join(jail, "escape-dir"));
  await fs.symlink(path.join(home, ".ssh", "id_ed25519"), path.join(jail, "escape-file"));
  await fs.symlink(other, path.join(jail, "other-guest"));
  await fs.symlink("proj", path.join(jail, "proj-link"));
  const opts = { homeDir: jail, jailRoot: jail };
  return { root, home, jail, other, opts };
}

const leaksHost = (value, root) => JSON.stringify(value).includes(root);

test("resolveJailedPath maps every spelling into the jail and rejects .. escapes", () => {
  const jail = "/srv/home/buzz-sandboxes/tok_aaaaaaaaaaaa";
  for (const raw of [undefined, "", "~", "/", "/workspace", "  /workspace  ", "/home/anu", "/Users/anu"]) {
    assert.equal(resolveJailedPath(raw, jail), jail, String(raw));
  }
  assert.equal(resolveJailedPath("~/a/b", jail), `${jail}/a/b`);
  assert.equal(resolveJailedPath("/workspace/a", jail), `${jail}/a`);
  assert.equal(resolveJailedPath("/home/anu/a", jail), `${jail}/a`);
  assert.equal(resolveJailedPath("/Users/anu/a/b", jail), `${jail}/a/b`);
  assert.equal(resolveJailedPath("/etc/passwd", jail), `${jail}/etc/passwd`);
  assert.equal(resolveJailedPath("/workspacefoo", jail), `${jail}/workspacefoo`);
  assert.equal(resolveJailedPath("a/../b", jail), `${jail}/b`);
  for (const raw of ["..", "~/..", "/workspace/..", "/workspace/../tok_bbbbbbbbbbbb", "../../.ssh", "/home/anu/../../x", "~/a/../../.."]) {
    assert.throws(() => resolveJailedPath(raw, jail), /Path escapes sandbox workspace/, raw);
  }
  assert.throws(() => resolveJailedPath("~/a\u0000b", jail), /NUL/);
});

test("jailed fs.list shows /workspace paths, never host paths, and never follows links out", async (t) => {
  const { root, opts } = await jailFixture(t);
  const top = await listDirectory({ showHidden: true }, opts);
  assert.equal(top.path, "/workspace");
  assert.equal(top.displayPath, "~");
  assert.equal(top.home, "/workspace");
  assert.equal(top.parent, null);
  assert.equal(top.parentDisplay, null);
  assert.ok(!leaksHost(top, root), "no host path in the listing");

  const byName = Object.fromEntries(top.entries.map((e) => [e.name, e]));
  assert.equal(byName.proj.path, "/workspace/proj");
  assert.equal(byName.proj.displayPath, "~/proj");
  assert.equal(byName.proj.isGitRepo, true);
  assert.equal(byName["proj-link"].targetKind, "dir", "a link inside the jail is followed");
  for (const name of ["escape-dir", "escape-file", "other-guest"]) {
    assert.equal(byName[name].kind, "symlink");
    assert.equal(byName[name].targetKind, null, `${name} is not followed out of the jail`);
    assert.equal(byName[name].isGitRepo, false);
  }

  // Same folder by its other names.
  for (const p of ["~", "/", "/workspace", "/home/anu", "/Users/anu"]) {
    assert.equal((await listDirectory({ path: p }, opts)).path, "/workspace", p);
  }
  const sub = await listDirectory({ path: "/workspace/proj", showHidden: true }, opts);
  assert.equal(sub.parent, "/workspace");
  assert.equal(sub.parentDisplay, "~");
  assert.deepEqual(sub.entries.map((e) => e.path), ["/workspace/proj/.git", "/workspace/proj/main.py"]);
  const viaLink = await listDirectory({ path: "~/proj-link" }, opts);
  assert.equal(viaLink.path, "/workspace/proj-link");
  assert.equal(viaLink.parent, "/workspace");

  // Escapes: lexical (..), through a link out, and into another guest's folder.
  for (const p of ["..", "~/escape-dir", "/workspace/other-guest", "/workspace/other-guest/theirs", "~/../tok_bbbbbbbbbbbb"]) {
    await assert.rejects(() => listDirectory({ path: p }, opts), /Path escapes sandbox workspace/, p);
  }
  // Errors name the virtual path only.
  await assert.rejects(() => listDirectory({ path: "~/nope" }, opts), (error) => {
    assert.equal(error.message, "Directory not found: ~/nope");
    return true;
  });
});

test("jailed fs.read reads inside the jail and refuses links to host or other guests' files", async (t) => {
  const { root, opts } = await jailFixture(t);
  const note = await readFile({ path: "/workspace/notes.md" }, opts);
  assert.equal(note.path, "/workspace/notes.md");
  assert.equal(note.displayPath, "~/notes.md");
  assert.equal(note.content, "# notes\n");
  assert.equal((await readFile({ path: "~/proj-link/main.py" }, opts)).path, "/workspace/proj-link/main.py");
  assert.equal((await readFile({ path: "/home/anu/notes.md" }, opts)).content, "# notes\n");
  assert.ok(!leaksHost(note, root));
  for (const p of ["~/escape-file", "~/escape-dir/id_ed25519", "~/other-guest/secret.txt", "../tok_bbbbbbbbbbbb/secret.txt", "/workspace/../../.ssh/id_ed25519"]) {
    await assert.rejects(() => readFile({ path: p }, opts), /Path escapes sandbox workspace/, p);
  }
  await assert.rejects(() => readFile({ path: "~/missing.txt" }, opts), (error) => {
    assert.equal(error.message, "File not found: ~/missing.txt");
    return true;
  });
});

test("two guests' jails are isolated from each other", async (t) => {
  const { home, jail, other } = await jailFixture(t);
  const a = { homeDir: jail, jailRoot: jail };
  const b = { homeDir: other, jailRoot: other };
  assert.deepEqual((await listDirectory({}, b)).entries.map((e) => e.name), ["theirs", "secret.txt"]);
  await assert.rejects(() => readFile({ path: "~/../tok_aaaaaaaaaaaa/notes.md" }, b), /escapes/);
  await writeFile({ path: "~/from-a.txt", content: "a" }, a);
  await assert.rejects(() => readFile({ path: "~/from-a.txt" }, b), /File not found: ~\/from-a.txt/);
  await assert.rejects(() => writeFile({ path: "~/other-guest/planted.txt", content: "x" }, a), /escapes/);
  await assert.rejects(() => fs.access(path.join(other, "planted.txt")));
  assert.equal(await fs.readFile(path.join(home, ".ssh", "id_ed25519"), "utf8"), "OWNER KEY\n");
});

test("fs.write saves atomically, keeps the mode, and honors createOnly and expectedMtimeMs", async (t) => {
  const { root, jail, opts } = await jailFixture(t);
  const created = await writeFile({ path: "~/new.txt", content: "hello ✓", createOnly: true }, opts);
  assert.deepEqual(Object.keys(created).sort(), ["displayPath", "mtimeMs", "name", "path", "size"]);
  assert.equal(created.path, "/workspace/new.txt");
  assert.equal(created.displayPath, "~/new.txt");
  assert.equal(created.name, "new.txt");
  assert.equal(created.size, Buffer.byteLength("hello ✓"));
  assert.equal(await fs.readFile(path.join(jail, "new.txt"), "utf8"), "hello ✓");
  assert.ok(!leaksHost(created, root));

  await assert.rejects(() => writeFile({ path: "~/new.txt", content: "x", createOnly: true }, opts), /^Error: ALREADY_EXISTS: File already exists: ~\/new.txt$/);

  await fs.chmod(path.join(jail, "new.txt"), 0o750);
  const updated = await writeFile({ path: "/workspace/new.txt", content: "v2", expectedMtimeMs: created.mtimeMs }, opts);
  assert.equal(await fs.readFile(path.join(jail, "new.txt"), "utf8"), "v2");
  assert.equal((await fs.stat(path.join(jail, "new.txt"))).mode & 0o777, 0o750, "mode kept");
  await assert.rejects(
    () => writeFile({ path: "~/new.txt", content: "v3", expectedMtimeMs: updated.mtimeMs - 5000 }, opts),
    /^Error: CONFLICT: File was modified on disk since you opened it\.$/,
  );
  await assert.rejects(() => writeFile({ path: "~/absent.txt", content: "x", expectedMtimeMs: 1 }, opts), /CONFLICT/);
  assert.equal(await fs.readFile(path.join(jail, "new.txt"), "utf8"), "v2");
  // No temp files left behind.
  assert.deepEqual((await fs.readdir(jail)).filter((n) => n.includes("buzz-tmp")), []);

  // A link inside the jail is written through; links out are refused.
  await writeFile({ path: "~/proj-link/main.py", content: "print(2)\n" }, opts);
  assert.equal(await fs.readFile(path.join(jail, "proj", "main.py"), "utf8"), "print(2)\n");
  assert.ok((await fs.lstat(path.join(jail, "proj-link"))).isSymbolicLink());
  await assert.rejects(() => writeFile({ path: "~/escape-file", content: "pwned" }, opts), /escapes/);
  await assert.rejects(() => writeFile({ path: "~/escape-dir/authorized_keys", content: "pwned" }, opts), /escapes/);

  await assert.rejects(() => writeFile({ path: "~/proj", content: "x" }, opts), /Is a directory: ~\/proj/);
  await assert.rejects(() => writeFile({ path: "~/no-dir/x.txt", content: "x" }, opts), /^Error: Folder not found: ~\/no-dir$/);
  await assert.rejects(() => writeFile({ path: "~/x.txt" }, opts), /content must be a string/);
  await assert.rejects(() => writeFile({ content: "x" }, opts), /path is required/);
  await assert.rejects(() => writeFile({ path: "~", content: "x" }, opts), /Refusing/);
  await assert.rejects(() => writeFile({ path: "~/big.txt", content: "a".repeat(MAX_WRITE_BYTES + 1) }, opts), /too large/);
  await writeFile({ path: "~/max.txt", content: "a".repeat(MAX_WRITE_BYTES) }, opts);
});

test("fs.mkdir creates folders, recursive or not, and refuses the jail and escapes", async (t) => {
  const { jail, home, opts } = await jailFixture(t);
  const made = await createDirectory({ path: "~/docs" }, opts);
  assert.deepEqual(
    { path: made.path, displayPath: made.displayPath, name: made.name, kind: made.kind },
    { path: "/workspace/docs", displayPath: "~/docs", name: "docs", kind: "dir" },
  );
  assert.ok(Number.isFinite(made.mtimeMs));
  await assert.rejects(() => createDirectory({ path: "~/docs" }, opts), /^Error: ALREADY_EXISTS: /);
  assert.equal((await createDirectory({ path: "~/docs", recursive: true }, opts)).path, "/workspace/docs");
  await assert.rejects(() => createDirectory({ path: "~/a/b/c" }, opts), /Folder not found: ~\/a\/b/);
  assert.equal((await createDirectory({ path: "/workspace/a/b/c", recursive: true }, opts)).path, "/workspace/a/b/c");
  assert.ok((await fs.stat(path.join(jail, "a", "b", "c"))).isDirectory());
  for (const p of ["~", "/", "/workspace"]) await assert.rejects(() => createDirectory({ path: p }, opts), /Refusing/, p);
  await assert.rejects(() => createDirectory({ path: "~/escape-dir/x", recursive: true }, opts), /escapes/);
  await assert.rejects(() => createDirectory({ path: "~/../x" }, opts), /escapes/);
  await assert.rejects(() => fs.access(path.join(home, ".ssh", "x")));
  await assert.rejects(() => createDirectory({ path: "~/notes.md/x", recursive: true }, opts), /Not a folder/);
  await assert.rejects(() => createDirectory({}, opts), /path is required/);
});

test("fs.rename moves within the jail, refuses existing targets, self-nesting, roots and escapes", async (t) => {
  const { jail, home, opts } = await jailFixture(t);
  const moved = await renamePath({ from: "~/notes.md", to: "/workspace/proj/notes.md" }, opts);
  assert.deepEqual(moved, {
    from: "/workspace/notes.md",
    to: "/workspace/proj/notes.md",
    path: "/workspace/proj/notes.md",
    displayPath: "~/proj/notes.md",
    name: "notes.md",
  });
  assert.equal(await fs.readFile(path.join(jail, "proj", "notes.md"), "utf8"), "# notes\n");
  await assert.rejects(() => renamePath({ from: "~/notes.md", to: "~/n2.md" }, opts), /Not found: ~\/notes.md/);
  await fs.writeFile(path.join(jail, "x.txt"), "x");
  await assert.rejects(() => renamePath({ from: "~/x.txt", to: "~/proj/main.py" }, opts), /^Error: ALREADY_EXISTS: /);
  await assert.rejects(() => renamePath({ from: "~/proj", to: "~/proj/sub" }, opts), /into itself/);
  await assert.rejects(() => renamePath({ from: "~/proj", to: "~/proj-link/sub" }, opts), /into itself/);
  for (const [from, to] of [["~", "~/x"], ["/workspace", "~/y"], ["~/x.txt", "~"], ["~/x.txt", "/"]]) {
    await assert.rejects(() => renamePath({ from, to }, opts), /Refusing/, `${from} -> ${to}`);
  }
  await assert.rejects(() => renamePath({ from: "~/x.txt", to: "~/escape-dir/x.txt" }, opts), /escapes/);
  await assert.rejects(() => renamePath({ from: "~/escape-dir/id_ed25519", to: "~/stolen" }, opts), /escapes/);
  await assert.rejects(() => renamePath({ from: "~/x.txt", to: "~/../x.txt" }, opts), /escapes/);
  // A link moves as itself, not its target.
  await renamePath({ from: "~/escape-file", to: "~/renamed-link" }, opts);
  assert.ok((await fs.lstat(path.join(jail, "renamed-link"))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(home, ".ssh", "id_ed25519"), "utf8"), "OWNER KEY\n");
  await assert.rejects(() => renamePath({ from: "~/x.txt" }, opts), /to is required/);
});

test("fs.delete removes files, links (not their targets) and folders; never the jail", async (t) => {
  const { jail, home, other, opts } = await jailFixture(t);
  assert.deepEqual(await deletePath({ path: "~/notes.md" }, opts), {
    path: "/workspace/notes.md",
    displayPath: "~/notes.md",
    deleted: true,
  });
  await assert.rejects(() => fs.access(path.join(jail, "notes.md")));
  // Links out are unlinked themselves; their targets survive.
  await deletePath({ path: "~/escape-dir" }, opts);
  await deletePath({ path: "~/other-guest" }, opts);
  assert.equal(await fs.readFile(path.join(home, ".ssh", "id_ed25519"), "utf8"), "OWNER KEY\n");
  assert.equal(await fs.readFile(path.join(other, "secret.txt"), "utf8"), "other guest\n");
  // Folders: empty only unless recursive; a recursive delete never follows links.
  await fs.symlink(path.join(home, ".ssh"), path.join(jail, "proj", "inner-escape"));
  await assert.rejects(() => deletePath({ path: "~/proj" }, opts), /Folder is not empty: ~\/proj/);
  await deletePath({ path: "~/proj", recursive: true }, opts);
  await assert.rejects(() => fs.access(path.join(jail, "proj")));
  assert.equal(await fs.readFile(path.join(home, ".ssh", "id_ed25519"), "utf8"), "OWNER KEY\n");
  await fs.mkdir(path.join(jail, "empty"));
  await deletePath({ path: "~/empty" }, opts);
  for (const p of ["~", "/", "/workspace", "/home/anu", ""]) {
    await assert.rejects(() => deletePath({ path: p, recursive: true }, opts), /Refusing|path is required/, p);
  }
  await assert.rejects(() => deletePath({ path: "~/escape-file/../../.ssh" }, opts), /escapes/);
  await assert.rejects(() => deletePath({ path: "~/../tok_bbbbbbbbbbbb/secret.txt" }, opts), /escapes/);
  await assert.rejects(() => deletePath({ path: "~/gone" }, opts), /Not found: ~\/gone/);
  assert.ok((await fs.stat(jail)).isDirectory());
});

test("admin fs.* write calls work in the host home and protect / and the home", async (t) => {
  const { home } = await fixture(t);
  const opts = { homeDir: home };
  const w = await writeFile({ path: "~/Work/new.txt", content: "x" }, opts);
  assert.equal(w.path, path.join(home, "Work", "new.txt"));
  assert.equal(w.displayPath, "~/Work/new.txt");
  await createDirectory({ path: "~/Work/dir/sub", recursive: true }, opts);
  await renamePath({ from: "~/Work/new.txt", to: "~/Work/dir/sub/new.txt" }, opts);
  assert.equal(await fs.readFile(path.join(home, "Work", "dir", "sub", "new.txt"), "utf8"), "x");
  await deletePath({ path: "~/Work/dir", recursive: true }, opts);
  await assert.rejects(() => fs.access(path.join(home, "Work", "dir")));
  // A laptop-shaped path maps to this host's home for writes too.
  const mapped = await writeFile({ path: "/Users/buzz-test-stranger/Work/laptop.txt", content: "y" }, opts);
  assert.equal(mapped.path, path.join(home, "Work", "laptop.txt"));
  for (const p of ["/", "~", home]) {
    await assert.rejects(() => deletePath({ path: p, recursive: true }, opts), /Refusing/, p);
    await assert.rejects(() => renamePath({ from: p, to: "~/moved" }, opts), /Refusing/, p);
    await assert.rejects(() => createDirectory({ path: p }, opts), /Refusing/, p);
  }
  // Deleting a link removes the link only.
  await deletePath({ path: "~/dir-link" }, opts);
  assert.ok((await fs.stat(path.join(home, "Work", "project-a"))).isDirectory());
});

test("fsOptionsForSession jails guests to their own 0700 sandbox folder and gives admins the home", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-fs-session-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.deepEqual(await fsOptionsForSession({ authenticated: true, role: "admin" }, { homeDir: home }), {
    homeDir: home,
    jailRoot: null,
  });
  const guest = await fsOptionsForSession(
    { authenticated: true, role: "guest", tokenId: "tok_0123456789ab" },
    { homeDir: home },
  );
  const jail = path.join(home, "buzz-sandboxes", "tok_0123456789ab");
  assert.deepEqual(guest, { homeDir: jail, jailRoot: jail });
  assert.equal((await fs.stat(jail)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(jail))).mode & 0o777, 0o700);
  for (const tokenId of [undefined, "", "tok_../../x", "tok_0123456789AB", "tok_0123456789abc"]) {
    await assert.rejects(
      () => fsOptionsForSession({ authenticated: true, role: "guest", tokenId }, { homeDir: home }),
      /no sandbox folder/,
      String(tokenId),
    );
  }
  for (const session of [undefined, {}, { role: "admin" }, { authenticated: false, role: "admin" }, { authenticated: true, role: "other" }]) {
    await assert.rejects(() => fsOptionsForSession(session, { homeDir: home }), /Authentication required/);
  }
  // A guest session lists its jail as /workspace.
  await fs.writeFile(path.join(jail, "hello.txt"), "hi");
  const listing = await listDirectory({}, guest);
  assert.equal(listing.path, "/workspace");
  assert.deepEqual(listing.entries.map((e) => e.path), ["/workspace/hello.txt"]);
});
