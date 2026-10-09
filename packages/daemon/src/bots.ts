// Bot state from hook events. No I/O, so the rules can be tested without a server.
import type { Bot, BotState, PendingPermission } from "@hamlet/shared";

export const bots = new Map<string, Bot>();
/** Held PermissionRequests by id. A session can hold several at once (parallel subagents). */
const held = new Map<number, PendingPermission & { sessionId: string }>();
const lastSeen = new Map<string, number>();

const STATE_FOR: Partial<Record<string, BotState>> = {
  Stop: "idle",
  StopFailure: "errored",
};

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Unset env vars arrive as empty headers; only well-formed ids ever reach a command line. */
function terminalFrom(headers: Record<string, unknown>): Bot["terminal"] {
  const [surfaceId, workspaceId, wt] = ["x-cmux-surface-id", "x-cmux-workspace-id", "x-wt-session"].map((h) => String(headers[h] ?? ""));
  if (UUID.test(surfaceId!) && UUID.test(workspaceId!)) return { kind: "cmux", surfaceId: surfaceId!, workspaceId: workspaceId! };
  if (UUID.test(wt!)) return { kind: "wt", session: wt! };
}

function setState(bot: Bot, state: BotState): void {
  if (bot.state !== state) bot.since = Date.now();
  bot.state = state;
}

/** Shows the session's oldest held request, or returns the bot to work once none is left. */
function refresh(sessionId: string): void {
  const bot = bots.get(sessionId);
  if (!bot) return;
  const next = [...held.values()].find((h) => h.sessionId === sessionId);
  if (next) {
    const { sessionId: _, ...permission } = next;
    bot.permission = permission;
    setState(bot, "needs_input");
  } else if (bot.permission) {
    delete bot.permission;
    setState(bot, "working");
  }
}

export function cwdOf(body: Record<string, any>): string {
  return String(body.cwd ?? bots.get(String(body.session_id ?? ""))?.cwd ?? "");
}

/** Applies one hook event. `place` is the git repo/branch of the event's cwd. */
export function track(
  body: Record<string, any>,
  headers: Record<string, unknown>,
  place: { repo: string; branch: string },
): Bot | undefined {
  const event = String(body.hook_event_name);
  const sessionId = String(body.session_id ?? "");
  if (!sessionId) return;
  if (event === "SessionEnd") {
    bots.delete(sessionId);
    lastSeen.delete(sessionId);
    return;
  }
  lastSeen.set(sessionId, Date.now());
  const cwd = cwdOf(body);
  // SessionStart can be missing (see SPIKE.md), so any event creates the bot.
  const bot = bots.get(sessionId) ?? { sessionId, cwd, ...place, state: "working", since: Date.now() };
  Object.assign(bot, { cwd, ...place });
  const terminal = terminalFrom(headers);
  if (terminal) bot.terminal = terminal;
  bots.set(sessionId, bot);
  // Subagent hooks (agent_id set) outlive the main thread's Stop, so only a subagent's permission
  // prompt says anything about the bot. idle_prompt also covers interrupts, which send no Stop.
  const subagent = body.agent_id !== undefined && event !== "PermissionRequest";
  const state =
    event === "Notification"
      ? body.notification_type === "idle_prompt" ? "idle" : undefined
      : subagent ? undefined : STATE_FOR[event] ?? "working";
  if (state) setState(bot, state);
  // A held request outranks whatever else the session is doing.
  refresh(sessionId);
  return bot;
}

export function hold(sessionId: string, permission: PendingPermission): void {
  held.set(permission.id, { ...permission, sessionId });
  refresh(sessionId);
}

export function release(id: number): void {
  const h = held.get(id);
  if (!h) return;
  held.delete(id);
  refresh(h.sessionId);
}

/** Drops bots that sent nothing for maxIdleMs: crashed or killed sessions never send SessionEnd. */
export function sweep(maxIdleMs: number, now = Date.now()): boolean {
  const waiting = new Set([...held.values()].map((h) => h.sessionId));
  let removed = false;
  for (const [id, at] of lastSeen) {
    if (now - at < maxIdleMs || waiting.has(id)) continue;
    bots.delete(id);
    lastSeen.delete(id);
    removed = true;
  }
  return removed;
}
