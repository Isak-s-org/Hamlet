// Reaches a session's terminal: raises it, or types a message into it (cmux only).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SEND_CAP, type Bot } from "@hamlet/shared";

const run = promisify(execFile);
type Terminal = NonNullable<Bot["terminal"]>;
export type CmuxTerminal = Extract<Terminal, { kind: "cmux" }>;

/** C0 controls other than tab and newline, DEL and C1: an ESC that reached the TUI could drive it. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Text as it may reach the terminal, or why not. */
export function cleanText(text: string): { text: string } | { error: "empty" | "too-long" } {
  const clean = text.replace(/\r\n?/g, "\n").replace(CONTROL, "").trimEnd();
  if (!clean.trim()) return { error: "empty" };
  if (Buffer.byteLength(clean) > SEND_CAP) return { error: "too-long" };
  return { text: clean };
}

/** One paste call: cmux brackets the text, so newlines stay inside the message, and `submit_key` presses Enter after it. */
export const pasteArgs = (t: CmuxTerminal, text: string): string[] => [
  "rpc",
  "terminal.paste",
  JSON.stringify({ workspace_id: t.workspaceId, surface_id: t.surfaceId, text, submit_key: "return" }),
];

/**
 * Where a message for this bot goes, or the status that refuses it. A bot that is waiting counts
 * as having a dialog open even with no request held (found waiting after a daemon restart, say):
 * the paste's Enter would answer that dialog.
 */
export function target(bot: Bot | undefined): { terminal: CmuxTerminal } | { refuse: 404 | 409 | 422 } {
  if (!bot) return { refuse: 404 };
  if (bot.permission || bot.state === "needs_input") return { refuse: 409 };
  if (bot.terminal?.kind !== "cmux") return { refuse: 422 };
  return { terminal: bot.terminal };
}

/** What to tell the user about a failed cmux call. Its message holds the command line, and so the text: never shown. */
export function cmuxError(e: { killed?: boolean; stderr?: string; message?: string }): string {
  if (e.killed) return "cmux timed out; check the terminal before sending again";
  return String(e.stderr ?? "").trim().split("\n")[0] || "cmux failed";
}

export async function sendText(t: CmuxTerminal, text: string): Promise<void> {
  await run("cmux", pasteArgs(t, text), { timeout: 5000 });
}

/** Keys the chat may press in a session's terminal: Esc interrupts the turn, ctrl+enter sends the queued messages now. */
export const KEYS = { stop: "escape", "send-now": "ctrl+enter" } as const;

export async function sendKey(t: CmuxTerminal, key: (typeof KEYS)[keyof typeof KEYS]): Promise<void> {
  await run("cmux", ["send-key", "--workspace", t.workspaceId, "--surface", t.surfaceId, key], { timeout: 5000 });
}

export async function focusTerminal(t: Terminal): Promise<void> {
  if (t.kind === "cmux") {
    await run("cmux", ["focus-panel", "--panel", t.surfaceId, "--workspace", t.workspaceId]);
    if (process.platform === "darwin") await run("open", ["-b", "com.cmuxterm.app"]);
    return;
  }
  // shortcut: WT has no focus-tab-by-session API, so this only raises the window; upgrade if WT adds one.
  await run("powershell", [
    "-NoProfile",
    "-Command",
    "$p = Get-Process WindowsTerminal -ErrorAction Stop | Select-Object -First 1; (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null",
  ]);
}

/**
 * Starts a new Claude Code session as a tab in `workspaceId`, or in its own cmux workspace without one;
 * its hooks then bring it into the village.
 */
export async function newAgent(cwd: string, name: string, workspaceId?: string): Promise<void> {
  if (workspaceId) {
    // cmux's new-surface takes no command, so `claude` is typed into the tab's shell. It prints "OK <surface> <pane> <workspace>".
    const { stdout } = await run("cmux", ["new-surface", "--workspace", workspaceId, "--working-directory", cwd, "--id-format", "uuids"], { timeout: 5000 });
    const surfaceId = stdout.split(" ")[1]?.trim();
    if (!surfaceId) throw { stderr: "cmux opened no tab" };
    await run("cmux", ["send", "--workspace", workspaceId, "--surface", surfaceId, "claude\\n"], { timeout: 5000 });
    return focusTerminal({ kind: "cmux", surfaceId, workspaceId });
  }
  await run("cmux", ["new-workspace", "--cwd", cwd, "--name", name, "--command", "claude", "--focus", "true"], { timeout: 5000 });
  if (process.platform === "darwin") await run("open", ["-b", "com.cmuxterm.app"]);
}
