// Remote files for Buzz Desktop over buzz-host's RPC socket.
//
//   fs.list    listDirectory()    a folder's entries, for the remote folder picker
//   fs.read    readFile()         a file preview (text, or a base64 raster image)
//   fs.write   writeFile()        save a text file (atomic; conflict-checked)
//   fs.mkdir   createDirectory()  new folder
//   fs.rename  renamePath()       rename or move a file or folder
//   fs.delete  deletePath()       delete a file, link or folder
//
// Every call takes `{ homeDir, jailRoot }` (buzz-host's fsOptionsFor):
//
// Admin (jailRoot null): paths are this host's. They arrive from another
// machine's client, so `~` expands here, and a laptop-shaped path
// (`/Users/<name>/x`, `/home/<name>/x`) that does not exist here maps to `~/x`
// when that does. The literal path always wins when it exists, so a real
// `/Users/...` tree on a Mac host is browsable as itself.
//
// Guest (jailRoot = ~/buzz-sandboxes/<tokenId>): the guest's one shared
// folder, which its sandboxed agents see as /workspace. Every path is read
// relative to it (`~`, `/`, `/workspace`, laptop homes, any `/x`), must stay
// inside it lexically and after resolving symlinks (an agent in the container
// can plant any link), and is reported back as `/workspace/...` / `~/...`:
// no answer or error names a host path. On Linux each operation also runs on
// an opened directory (/proc/self/fd/N/<name>) whose real location is checked
// after opening, so swapping a folder for a symlink mid-call cannot redirect a
// write, rename or delete outside the jail.
import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 2000;
const DEFAULT_MAX_BYTES = 524288; // 512 KiB
const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const VIRTUAL_HOME = "/workspace";
const ESCAPE = "Path escapes sandbox workspace";
const ANCHORED = process.platform === "linux" && existsSync("/proc/self/fd");

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Raster images are sent whole as base64 for a thumbnail; SVG stays text so a
// preview can inspect it without rendering markup from the remote host.
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);

export const GUEST_TOKEN_ID = /^tok_[0-9a-f]{12}$/;

/** A guest token's shared personal "computer": the one folder its owner-only
 *  sandboxed agents work in (/workspace) and its fs.* calls are jailed to. */
export function guestSandboxDir(tokenId, homeDir = os.homedir()) {
  if (typeof tokenId !== "string" || !GUEST_TOKEN_ID.test(tokenId)) throw new Error("Invalid guest token id");
  return path.join(homeDir, "buzz-sandboxes", tokenId);
}

/** Where a session's fs.* calls may reach: an admin works in this host's
 *  home; a guest only inside its token's sandbox folder (created 0700). */
export async function fsOptionsForSession(session, { homeDir = os.homedir() } = {}) {
  if (session?.authenticated === true && session.role === "guest") {
    if (typeof session.tokenId !== "string" || !GUEST_TOKEN_ID.test(session.tokenId)) {
      throw new Error("This guest session has no sandbox folder");
    }
    const jailRoot = guestSandboxDir(session.tokenId, homeDir);
    await fs.mkdir(path.dirname(jailRoot), { recursive: true, mode: 0o700 });
    await fs.mkdir(jailRoot, { recursive: true, mode: 0o700 });
    return { homeDir: jailRoot, jailRoot };
  }
  if (session?.authenticated === true && session.role === "admin") return { homeDir, jailRoot: null };
  throw new Error("Authentication required");
}

/** Throws on input this module must never hand to the filesystem (NUL bytes,
 *  non-strings). */
function checkRawPath(rawPath, name = "path") {
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (typeof rawPath === "string" && rawPath.includes("\0")) {
    throw new Error(`${name} must not contain NUL bytes`);
  }
}

/** A raw path from the client as this host would mean it (admin sessions). */
export function resolveHostPath(rawPath, { homeDir = os.homedir(), browsing = false } = {}) {
  checkRawPath(rawPath);
  const home = path.resolve(homeDir);
  const raw = (rawPath ?? "").trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return path.resolve(home, raw.slice(2));

  const abs = path.resolve(raw);
  // Cross-machine home: a client on a laptop sends its own home path. Only used
  // when the literal path is absent here; the mapped path must exist, or (while
  // browsing) its parent must, so the user gets a real folder back.
  const remote = /^\/(?:home|Users)\/[^/]+(?:\/(.*))?$/.exec(abs);
  if (remote && !existsSync(abs)) {
    const mapped = path.resolve(home, remote[1] ?? "");
    if (existsSync(mapped)) return mapped;
    if (browsing && existsSync(path.dirname(mapped))) return mapped;
  }
  return abs;
}

/** `absPath` as the client should show it: `~` under this host's home. */
export function toDisplayPath(absPath, homeDir = os.homedir()) {
  const abs = path.resolve(absPath);
  const home = path.resolve(homeDir);
  if (abs === home) return "~";
  const rel = path.relative(home, abs);
  if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return abs;
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const escapeError = () => new Error(ESCAPE);
const isEscape = (error) => error?.message === ESCAPE;
// Only an errno code: a Node error message names the host path.
const reason = (error) => (typeof error?.code === "string" ? error.code : "failed");
const missing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

/** A raw path inside a jail (already realpath'd): `~`, `/`, `/workspace`,
 *  laptop homes and any other absolute path are read relative to the jail.
 *  Lexical only; callers also check where symlinks lead. */
export function resolveJailedPath(rawPath, jailRoot, name = "path") {
  checkRawPath(rawPath, name);
  const raw = (rawPath ?? "").trim();
  let rel;
  if (!raw || raw === "~" || raw === "/") rel = "";
  else if (raw.startsWith("~/")) rel = raw.slice(2);
  else if (raw.startsWith("/")) {
    const mapped = /^\/(?:workspace|(?:home|Users)\/[^/]+)(?:\/(.*))?$/.exec(raw);
    rel = mapped ? (mapped[1] ?? "") : raw.slice(1);
  } else rel = raw;
  const abs = path.resolve(jailRoot, rel);
  if (!within(jailRoot, abs)) throw escapeError();
  return abs;
}

/** Resolve the options buzz-host passes into a call context. */
async function context({ homeDir = os.homedir(), jailRoot = null } = {}) {
  if (!jailRoot) return { home: path.resolve(homeDir), jail: null };
  let real;
  try {
    real = await fs.realpath(jailRoot);
  } catch {
    throw new Error("Sandbox workspace is not available");
  }
  return { home: real, jail: real };
}

function resolveIn(ctx, rawPath, { name = "path", browsing = false } = {}) {
  return ctx.jail ? resolveJailedPath(rawPath, ctx.jail, name) : resolveHostPath(rawPath, { homeDir: ctx.home, browsing });
}

function requiredPath(ctx, rawPath, name = "path") {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error(`${name} is required`);
  return resolveIn(ctx, rawPath, { name, browsing: true });
}

/** `abs` as the client sees it: virtual `/workspace/...` inside a jail. */
function present(ctx, abs) {
  if (!ctx.jail) return { path: abs, displayPath: toDisplayPath(abs, ctx.home) };
  const rel = path.relative(ctx.jail, abs).split(path.sep).join("/");
  if (!within(ctx.jail, abs)) throw escapeError();
  return rel
    ? { path: `${VIRTUAL_HOME}/${rel}`, displayPath: `~/${rel}` }
    : { path: VIRTUAL_HOME, displayPath: "~" };
}

/** realpath(`abs`), which must stay inside the jail (when there is one). */
async function realInside(ctx, abs) {
  const real = await fs.realpath(abs);
  if (ctx.jail && !within(ctx.jail, real)) throw escapeError();
  return real;
}

/** Where an open fd really is; must be inside the jail. */
async function assertFdInside(ctx, fd) {
  if (!ctx.jail || !ANCHORED) return;
  const where = await fs.readlink(`/proc/self/fd/${fd}`);
  if (!within(ctx.jail, where)) throw escapeError();
}

/** Run `fn(ref)` with `ref` naming directory `dirAbs`, for operations on its
 *  children (`path.join(ref, name)`). Jailed on Linux, `ref` is an opened
 *  directory fd checked to be inside the jail; elsewhere a checked path.
 *  Only this function's own failures are turned into `notFound`-style errors. */
async function withDir(ctx, dirAbs, fn) {
  const shown = present(ctx, dirAbs).displayPath;
  let real = dirAbs;
  let handle = null;
  try {
    real = ctx.jail ? await realInside(ctx, dirAbs) : dirAbs;
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new Error(`Not a folder: ${shown}`);
    if (ctx.jail && ANCHORED) {
      handle = await fs.open(real, constants.O_RDONLY | constants.O_DIRECTORY);
      await assertFdInside(ctx, handle.fd);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (isEscape(error) || error?.message?.startsWith("Not a folder")) throw error;
    if (missing(error)) throw new Error(`Folder not found: ${shown}`);
    throw new Error(`Cannot open folder ${shown}: ${reason(error)}`);
  }
  try {
    return await fn(handle ? `/proc/self/fd/${handle.fd}` : real);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Never touch the filesystem root, the home, or the jail itself. */
function assertNotRoot(ctx, abs, verb) {
  if (abs === path.parse(abs).root || abs === ctx.home || (ctx.jail && abs === ctx.jail)) {
    throw new Error(`Refusing to ${verb} ${ctx.jail ? "the sandbox workspace" : present(ctx, abs).displayPath}`);
  }
}

function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isDirectoryEntry(entry) {
  return entry.kind === "dir" || (entry.kind === "symlink" && entry.targetKind === "dir");
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** What a directory entry is, following symlinks for their target kind. A
 *  broken symlink keeps the link's own lstat and `targetKind: null`; so does,
 *  in a jail, one that leads outside it (never followed). `ref` is the
 *  directory as opened (withDir), `dir` as the client named it. */
async function describeEntry(ctx, ref, dir, name, dirent) {
  const full = path.join(ref, name);
  const kind = dirent.isDirectory()
    ? "dir"
    : dirent.isFile()
      ? "file"
      : dirent.isSymbolicLink()
        ? "symlink"
        : "other";

  let stat = null;
  let targetKind = null;
  let gitBase = kind === "dir" ? full : null;
  if (kind === "symlink") {
    try {
      const real = ctx.jail ? await realInside(ctx, full) : full;
      stat = await fs.stat(real);
      targetKind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      if (targetKind === "dir") gitBase = real;
    } catch {
      stat = await fs.lstat(full).catch(() => null);
    }
  } else {
    stat = await fs.stat(full).catch(() => null);
  }

  return {
    entry: {
      name,
      ...present(ctx, path.join(dir, name)),
      kind,
      targetKind,
      size: Number.isFinite(stat?.size) ? stat.size : null,
      mtimeMs: Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : null,
      hidden: name.startsWith("."),
      isGitRepo: false,
    },
    gitBase,
  };
}

function compareEntries(a, b) {
  const dirA = isDirectoryEntry(a) ? 0 : 1;
  const dirB = isDirectoryEntry(b) ? 0 : 1;
  if (dirA !== dirB) return dirA - dirB;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `fs.list`: one directory, directories first, hidden entries optional. */
export async function listDirectory(params = {}, options = {}) {
  const ctx = await context(options);
  const dir = resolveIn(ctx, params.path, { browsing: true });
  const { path: shownPath, displayPath } = present(ctx, dir);
  const dirsOnly = params.dirsOnly === true;
  const showHidden = params.showHidden === true;
  const limit = clampInteger(params.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);

  let real = dir;
  try {
    if (ctx.jail) real = await realInside(ctx, dir);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${displayPath}`);
  } catch (error) {
    if (isEscape(error) || error?.message?.startsWith("Not a directory")) throw error;
    if (missing(error)) throw new Error(`Directory not found: ${displayPath}`);
    throw new Error(`Cannot read directory ${displayPath}: ${reason(error)}`);
  }

  const { matched, entries, withGitInfo } = await withDir(ctx, dir, async (ref) => {
    let dirents;
    try {
      dirents = await fs.readdir(ref, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read directory ${displayPath}: ${reason(error)}`);
    }
    const filtered = showHidden ? dirents : dirents.filter((dirent) => !dirent.name.startsWith("."));
    const described = await mapLimit(filtered, 32, (dirent) => describeEntry(ctx, ref, dir, dirent.name, dirent));
    const matched = (dirsOnly ? described.filter((d) => isDirectoryEntry(d.entry)) : described).sort((a, b) =>
      compareEntries(a.entry, b.entry),
    );
    const entries = matched.slice(0, limit);
    // Only the page the client sees pays for a `.git` probe; in a jail an
    // lstat, so a `.git` link out of it is never followed.
    const probe = ctx.jail ? fs.lstat : fs.access;
    const withGitInfo = await mapLimit(entries, 8, async ({ entry, gitBase }) => {
      if (!isDirectoryEntry(entry) || !gitBase) return entry;
      try {
        await probe(path.join(gitBase, ".git"));
        return { ...entry, isGitRepo: true };
      } catch {
        return entry;
      }
    });
    return { matched, entries, withGitInfo };
  });

  const atRoot = ctx.jail ? dir === ctx.jail : path.dirname(dir) === dir;
  const parent = atRoot ? null : present(ctx, path.dirname(dir));
  return {
    path: shownPath,
    displayPath,
    home: ctx.jail ? VIRTUAL_HOME : ctx.home,
    parent: parent ? parent.path : null,
    parentDisplay: parent ? parent.displayPath : null,
    truncated: matched.length > entries.length,
    entries: withGitInfo,
  };
}

/** `fs.read`: a text preview, or a whole-image base64 preview for raster
 *  formats small enough to send. Reads at most `maxBytes`, never a whole large
 *  file just to show its head. */
export async function readFile(params = {}, options = {}) {
  if (typeof params.path !== "string" || !params.path.trim()) {
    throw new Error("path is required");
  }
  const ctx = await context(options);
  const file = resolveIn(ctx, params.path);
  const { path: shownPath, displayPath } = present(ctx, file);
  const name = path.basename(file);
  const maxBytes = clampInteger(params.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);

  let handle;
  let stat;
  try {
    const real = ctx.jail ? await realInside(ctx, file) : file;
    const before = await fs.stat(real);
    if (before.isDirectory()) throw new Error(`Not a file (directory): ${displayPath}`);
    if (!before.isFile()) throw new Error(`Not a regular file: ${displayPath}`);
    // O_NONBLOCK: a FIFO swapped in after the stat must not hang the call.
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (ctx.jail ? constants.O_NOFOLLOW : 0);
    handle = await fs.open(real, flags);
    await assertFdInside(ctx, handle.fd);
    stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${displayPath}`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (isEscape(error) || /^Not a (file|regular)/.test(error?.message ?? "")) throw error;
    if (missing(error)) throw new Error(`File not found: ${displayPath}`);
    throw new Error(`Cannot read file ${displayPath}: ${reason(error)}`);
  }

  try {
    const extension = path.extname(file).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[extension] ?? "text/plain";
    const base = { path: shownPath, displayPath, name, size: stat.size, mtimeMs: stat.mtimeMs, mimeType };

    if (RASTER_EXTENSIONS.has(extension)) {
      if (stat.size > maxBytes) {
        return { ...base, encoding: "binary", isBinary: true, isImage: true, truncated: true, content: null };
      }
      const buffer = await handle.readFile();
      return {
        ...base,
        encoding: "base64",
        isBinary: false,
        isImage: true,
        truncated: false,
        content: buffer.toString("base64"),
      };
    }

    // Text, SVG, or a binary wearing a text extension: read only the preview
    // window, then sniff it for NUL bytes.
    const toRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    const slice = buffer.subarray(0, bytesRead);

    const probe = slice.subarray(0, Math.min(slice.length, BINARY_PROBE_BYTES));
    const truncated = stat.size > maxBytes;
    if (probe.includes(0)) {
      return {
        ...base,
        mimeType: "application/octet-stream",
        encoding: "binary",
        isBinary: true,
        isImage: false,
        truncated,
        content: null,
      };
    }
    return { ...base, encoding: "utf8", isBinary: false, isImage: false, truncated, content: slice.toString("utf8") };
  } finally {
    await handle.close();
  }
}

const tempName = (name) => `.${name.slice(0, 200)}.${randomBytes(6).toString("hex")}.buzz-tmp`;

/** `fs.write`: save `content` (UTF-8 text) atomically: a temp file in the same
 *  folder, renamed over the target, keeping an existing file's mode. A link is
 *  written through to its target (which, in a jail, must be inside it).
 *  `expectedMtimeMs`: refuse (CONFLICT) when the file changed since it was
 *  read. `createOnly`: refuse (ALREADY_EXISTS) when it exists. */
export async function writeFile(params = {}, options = {}) {
  const ctx = await context(options);
  const file = requiredPath(ctx, params.path);
  if (typeof params.content !== "string") throw new Error("content must be a string");
  if (Buffer.byteLength(params.content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("File is too large to save (2 MiB at most)");
  }
  assertNotRoot(ctx, file, "write");
  const shown = present(ctx, file);
  const createOnly = params.createOnly === true;
  const expectedMtimeMs = Number.isFinite(params.expectedMtimeMs) ? params.expectedMtimeMs : null;

  let dir = path.dirname(file);
  let name = path.basename(file);
  const link = await lstatOrNull(file).catch(() => null);
  if (link?.isSymbolicLink()) {
    if (createOnly) throw new Error(`ALREADY_EXISTS: File already exists: ${shown.displayPath}`);
    let real;
    try {
      real = await realInside(ctx, file);
    } catch (error) {
      if (isEscape(error)) throw error;
      throw new Error(`Cannot write ${shown.displayPath}: the link's target is missing`);
    }
    dir = path.dirname(real);
    name = path.basename(real);
  }

  return withDir(ctx, dir, async (ref) => {
    const target = path.join(ref, name);
    const existing = await lstatOrNull(target).catch((error) => {
      throw new Error(`Cannot write ${shown.displayPath}: ${reason(error)}`);
    });
    if (existing?.isDirectory()) throw new Error(`Is a directory: ${shown.displayPath}`);
    if (existing && !existing.isFile()) throw new Error(`Not a regular file: ${shown.displayPath}`);
    if (createOnly && existing) throw new Error(`ALREADY_EXISTS: File already exists: ${shown.displayPath}`);
    if (expectedMtimeMs !== null && (!existing || Math.abs(existing.mtimeMs - expectedMtimeMs) > 1)) {
      throw new Error("CONFLICT: File was modified on disk since you opened it.");
    }

    const tmp = path.join(ref, tempName(name));
    try {
      const handle = await fs.open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        existing ? 0o600 : 0o666,
      );
      try {
        await handle.writeFile(params.content, "utf8");
        if (existing) await handle.chmod(existing.mode & 0o7777);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (createOnly) {
        // link() fails if the name appeared meanwhile; rename() would replace it.
        try {
          await fs.link(tmp, target);
          await fs.unlink(tmp);
        } catch (error) {
          if (error?.code === "EEXIST") throw error;
          if (await lstatOrNull(target)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
          await fs.rename(tmp, target);
        }
      } else {
        await fs.rename(tmp, target);
      }
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      if (error?.code === "EEXIST") throw new Error(`ALREADY_EXISTS: File already exists: ${shown.displayPath}`);
      throw new Error(`Cannot write ${shown.displayPath}: ${reason(error)}`);
    }
    const stat = await fs.stat(target);
    return { ...shown, name: path.basename(file), size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

/** `fs.mkdir`: a new folder; `recursive` also makes missing parents and
 *  accepts one that already exists. */
export async function createDirectory(params = {}, options = {}) {
  const ctx = await context(options);
  const dir = requiredPath(ctx, params.path);
  assertNotRoot(ctx, dir, "create");
  const shown = present(ctx, dir);
  const name = path.basename(dir);

  const mkdirIn = (parent, child, { exists = "fail" } = {}) =>
    withDir(ctx, parent, async (ref) => {
      try {
        await fs.mkdir(path.join(ref, child));
      } catch (error) {
        if (error?.code === "EEXIST") {
          if (exists === "ok") return;
          throw new Error(`ALREADY_EXISTS: Folder already exists: ${shown.displayPath}`);
        }
        throw new Error(`Cannot create folder ${shown.displayPath}: ${reason(error)}`);
      }
    });

  if (params.recursive === true) {
    // From the nearest existing ancestor down, one checked level at a time.
    const chain = [];
    let cur = dir;
    while (!(await lstatOrNull(cur).catch(() => null))) {
      if (ctx.jail && cur === ctx.jail) break;
      chain.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    for (const part of chain) {
      await mkdirIn(cur, part, { exists: "ok" });
      cur = path.join(cur, part);
    }
  } else {
    await mkdirIn(path.dirname(dir), name);
  }

  return withDir(ctx, path.dirname(dir), async (ref) => {
    let stat;
    try {
      stat = await fs.stat(ctx.jail ? await realInside(ctx, path.join(ref, name)) : path.join(ref, name));
    } catch (error) {
      if (isEscape(error)) throw error;
      throw new Error(`Cannot create folder ${shown.displayPath}: ${reason(error)}`);
    }
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${shown.displayPath}`);
    return { ...shown, name, kind: "dir", mtimeMs: stat.mtimeMs };
  });
}

/** `fs.rename`: rename or move `from` to `to`, which must not exist. A link
 *  moves as itself. Never the root, the home or the jail; never into itself. */
export async function renamePath(params = {}, options = {}) {
  const ctx = await context(options);
  const from = requiredPath(ctx, params.from, "from");
  const to = requiredPath(ctx, params.to, "to");
  assertNotRoot(ctx, from, "rename");
  assertNotRoot(ctx, to, "replace");
  const src = present(ctx, from);
  const dst = present(ctx, to);
  if (to !== from && within(from, to)) throw new Error(`Cannot move ${src.displayPath} into itself`);

  await withDir(ctx, path.dirname(from), (fromRef) =>
    withDir(ctx, path.dirname(to), async (toRef) => {
      const source = path.join(fromRef, path.basename(from));
      const target = path.join(toRef, path.basename(to));
      const st = await lstatOrNull(source).catch(() => null);
      if (!st) throw new Error(`Not found: ${src.displayPath}`);
      if (await lstatOrNull(target).catch(() => null)) {
        throw new Error(`ALREADY_EXISTS: ${dst.displayPath} already exists`);
      }
      if (st.isDirectory()) {
        // Also after resolving links: the destination folder inside the source.
        const [sourceReal, targetDirReal] = await Promise.all([fs.realpath(source), fs.realpath(toRef)]);
        if (within(sourceReal, targetDirReal)) throw new Error(`Cannot move ${src.displayPath} into itself`);
      }
      try {
        await fs.rename(source, target);
      } catch (error) {
        throw new Error(`Cannot move ${src.displayPath} to ${dst.displayPath}: ${reason(error)}`);
      }
    }),
  );
  return { from: src.path, to: dst.path, path: dst.path, displayPath: dst.displayPath, name: path.basename(to) };
}

/** Remove a directory tree under an opened parent without following links:
 *  each level is opened O_NOFOLLOW and checked to be inside the jail. */
async function removeTree(ctx, dirRef) {
  if (!ctx.jail || !ANCHORED) {
    await fs.rm(dirRef, { recursive: true, force: false });
    return;
  }
  const handle = await fs.open(dirRef, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await assertFdInside(ctx, handle.fd);
    const ref = `/proc/self/fd/${handle.fd}`;
    for (const dirent of await fs.readdir(ref, { withFileTypes: true })) {
      const child = path.join(ref, dirent.name);
      const st = await fs.lstat(child);
      if (st.isDirectory()) await removeTree(ctx, child);
      else await fs.unlink(child);
    }
  } finally {
    await handle.close();
  }
  await fs.rmdir(dirRef);
}

/** `fs.delete`: a file or link (the link itself, never its target), or a
 *  folder: empty unless `recursive`. Never the root, the home or the jail. */
export async function deletePath(params = {}, options = {}) {
  const ctx = await context(options);
  const target = requiredPath(ctx, params.path);
  assertNotRoot(ctx, target, "delete");
  const shown = present(ctx, target);
  await withDir(ctx, path.dirname(target), async (ref) => {
    const entry = path.join(ref, path.basename(target));
    const st = await lstatOrNull(entry).catch(() => null);
    if (!st) throw new Error(`Not found: ${shown.displayPath}`);
    try {
      if (!st.isDirectory()) await fs.unlink(entry);
      else if (params.recursive === true) await removeTree(ctx, entry);
      else await fs.rmdir(entry);
    } catch (error) {
      if (isEscape(error)) throw error;
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
        throw new Error(`Folder is not empty: ${shown.displayPath}`);
      }
      throw new Error(`Cannot delete ${shown.displayPath}: ${reason(error)}`);
    }
  });
  return { ...shown, deleted: true };
}
