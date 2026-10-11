// Bot state from hook events. No I/O, so the rules can be tested without a server.
import type { Bot, BotState, PendingPermission } from "@hamlet/shared";

export const bots = new Map<string, Bot>();
/** Held PermissionRequests by id. A session can hold several at once (parallel subagents). */
const held = new Map<number, PendingPermission & { sessionId: string }>();
const lastSeen = new Map<string, number>();
/** Where each bot's title came from; a better source replaces a worse one, never the other way. */
const titleRank = new Map<string, number>();
/** tool_use_id behind each bot's activity, so another agent's PostToolUse doesn't clear it. */
const activityOf = new Map<string, string>();

export type TitleSource = "prompt" | "ai" | "custom";
const RANK: Record<TitleSource, number> = { prompt: 0, ai: 1, custom: 2 };
const MAX_TEXT = 60;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TEXT) return flat;
  const cut = flat.slice(0, MAX_TEXT - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > MAX_TEXT / 2 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

const file = (p: unknown) => String(p ?? "").split(/[\\/]/).pop() || "a file";

/** A short line for the bot's thought bubble, such as "Editing bots.ts". */
export function describe(tool: string, input: Record<string, any> = {}): string {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  const text =
    tool === "Bash" ? (input.description ? String(input.description) : `Running ${String(input.command ?? "").split("\n")[0]}`)
    : tool === "Read" ? `Reading ${file(input.file_path)}`
    : tool === "Write" ? `Writing ${file(input.file_path)}`
    : tool === "Edit" || tool === "MultiEdit" ? `Editing ${file(input.file_path)}`
    : tool === "NotebookEdit" ? `Editing ${file(input.notebook_path)}`
    : tool === "Grep" ? `Searching for ${input.pattern}`
    : tool === "Glob" ? `Finding ${input.pattern}`
    : tool === "WebFetch" ? `Reading ${URL.canParse(input.url) ? new URL(input.url).host : "a web page"}`
    : tool === "WebSearch" ? `Searching the web`
    : tool === "Task" || tool === "Agent" ? `Delegating: ${input.description ?? "a task"}`
    : tool === "AskUserQuestion" ? "Asking you a question"
    : tool === "ExitPlanMode" ? "Proposing a plan"
    : tool === "TodoWrite" ? "Updating the to-do list"
    : tool === "Skill" ? (input.skill ? `Using the ${input.skill} skill` : "Using a skill")
    : mcp ? `Using ${mcp[1]}`
    : `Using ${tool}`;
  return clip(text);
}

/** The first real prompt, as a title until Claude Code names the session. Injected messages start with a tag. */
export function promptTitle(prompt: unknown): string | undefined {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return text && !text.startsWith("<") ? clip(text) : undefined;
}

/** Sets the bot's title unless it already has one from a better source. Returns whether it changed. */
export function retitle(sessionId: string, title: string, source: TitleSource): boolean {
  const bot = bots.get(sessionId);
  const text = clip(title);
  if (!bot || !text || RANK[source] < (titleRank.get(sessionId) ?? -1) || bot.title === text) return false;
  bot.title = text;
  titleRank.set(sessionId, RANK[source]);
  return true;
}

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

function forget(sessionId: string): void {
  bots.delete(sessionId);
  lastSeen.delete(sessionId);
  titleRank.delete(sessionId);
  activityOf.delete(sessionId);
}

function setState(bot: Bot, state: BotState): void {
  if (bot.state !== state) bot.since = Date.now();
  bot.state = state;
  if (state !== "working") clearActivity(bot);
}

function clearActivity(bot: Bot): void {
  delete bot.activity;
  activityOf.delete(bot.sessionId);
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
  if (event === "SessionEnd") return void forget(sessionId);
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
  if (event === "UserPromptSubmit" && !subagent && !bot.title) {
    const title = promptTitle(body.prompt);
    if (title) retitle(sessionId, title, "prompt");
  }
  if (event === "PreToolUse" && bot.state === "working") {
    bot.activity = describe(String(body.tool_name), body.tool_input);
    activityOf.set(sessionId, String(body.tool_use_id ?? ""));
  } else if ((event === "PostToolUse" || event === "PostToolUseFailure") && activityOf.get(sessionId) === String(body.tool_use_id ?? "")) {
    clearActivity(bot);
  }
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
    forget(id);
    removed = true;
  }
  return removed;
}
