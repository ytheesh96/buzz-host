// Cross-process advisory file lock + atomic private JSON read-modify-write.
// Matches server/acp-proxy's lock protocol (<file>.lock via O_CREAT|O_EXCL
// containing the holder PID, inode-verified unlock, and serialized stale-lock
// reaping via <file>.lock.reap) so Node (buzz-host / orchestrator) and
// multiple Python acp-proxy worker processes can safely share per-agent JSON
// files like chat-settings.json.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_MS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function isStaleLock(lockPath, staleMs) {
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function tryReapStaleLock(lockPath, staleMs) {
  const reapPath = `${lockPath}.reap`;
  let reapHandle = null;
  try {
    reapHandle = await fs.open(reapPath, "wx", 0o600);
    await reapHandle.writeFile(`${process.pid}\n`, "utf8");
    await reapHandle.close();
    reapHandle = null;
  } catch (error) {
    if (reapHandle) await reapHandle.close().catch(() => {});
    if (error?.code === "EEXIST" && (await isStaleLock(reapPath, staleMs))) {
      await fs.unlink(reapPath).catch(() => {});
    }
    return;
  }
  try {
    if (await isStaleLock(lockPath, staleMs)) {
      await fs.unlink(lockPath).catch(() => {});
    }
  } finally {
    await fs.unlink(reapPath).catch(() => {});
  }
}

/** Acquire `<filePath>.lock` exclusively, run `fn`, and release (inode-verified). */
export async function withFileLock(
  filePath,
  fn,
  { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {},
) {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let ourIno = null;

  while (ourIno === null) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      const st = await handle.stat();
      ourIno = st.ino;
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath, staleMs)) {
        await tryReapStaleLock(lockPath, staleMs);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${path.basename(filePath)}`);
      }
      await sleep(RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const cur = await fs.stat(lockPath);
      if (cur.ino === ourIno) {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch {}
  }
}

/** Read, mutate, and atomically replace a private (0600) JSON object under lock. */
export async function updateJsonLocked(filePath, mutator, options = {}) {
  return withFileLock(
    filePath,
    async () => {
      let current = {};
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      const next = await mutator(current);
      if (next === undefined) return current;
      const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, filePath);
      return next;
    },
    options,
  );
}
