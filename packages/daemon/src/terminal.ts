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
