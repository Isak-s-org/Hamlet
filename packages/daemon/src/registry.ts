// Finds Claude Code sessions that are already running, so they show up before their first hook
// event (after a daemon restart, or when the session started before Hamlet's hooks were installed).
// Claude Code keeps one `<pid>.json` per live session in ~/.claude/sessions. The format is
// internal, so anything unexpected is skipped rather than trusted.
import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "busy" or "idle" as seen so far. */
  status: string;
}

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** EPERM still means the process exists, just under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function liveSessions(dir = join(claudeDir(), "sessions"), alive = isAlive): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const e = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!Number.isInteger(e.pid) || typeof e.sessionId !== "string" || !e.sessionId || typeof e.cwd !== "string") continue;
      if (!alive(e.pid)) continue;
      sessions.push({ pid: e.pid, sessionId: e.sessionId, cwd: e.cwd, status: String(e.status ?? "") });
    } catch {}
  }
  return sessions;
}

/** The session's transcript, found by its id since the project folder name encodes the cwd. */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  const projects = join(claudeDir(), "projects");
  for (const dir of await readdir(projects).catch(() => [])) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (await access(path).then(() => true, () => false)) return path;
  }
}

/** The cmux ids in a process environment dump, as the hook headers would carry them. Nothing else is kept. */
export function cmuxIn(env: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, header] of [["CMUX_SURFACE_ID", "x-cmux-surface-id"], ["CMUX_WORKSPACE_ID", "x-cmux-workspace-id"]] as const) {
    const m = new RegExp(`(?:^|[\\s\\0])${name}=([^\\s\\0]+)`).exec(env);
    if (m) ids[header] = m[1]!;
  }
  return ids;
}

const run = promisify(execFile);

/** Where a session's terminal lives, read from the claude process environment. macOS and Linux only. */
export async function terminalHeaders(pid: number): Promise<Record<string, string>> {
  try {
    if (process.platform === "darwin") return cmuxIn((await run("ps", ["-E", "-p", String(pid), "-o", "command="])).stdout);
    if (process.platform === "linux") return cmuxIn(await readFile(`/proc/${pid}/environ`, "utf8"));
  } catch {}
  return {};
}
