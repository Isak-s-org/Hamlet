// Bot state from hook events. No I/O, so the rules can be tested without a server.
import type { Bot, BotState, PendingPermission } from "@hamlet/shared";

export const bots = new Map<string, Bot>();
/** Held PermissionRequests by id. A session can hold several at once (parallel subagents). */
const held = new Map<number, PendingPermission & { sessionId: string; agent: string; toolUseId?: string }>();
/** Tool calls between PreToolUse and their result, per session. PermissionRequest has no tool_use_id, so a held request finds its call here. */
type Call = { agent: string; toolUseId: string; toolName: string; input: string };
const calls = new Map<string, Call[]>();
const MAX_CALLS = 100;
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
  calls.delete(sessionId);
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
    const { sessionId: _, agent: __, toolUseId: ___, ...permission } = next;
    bot.permission = permission;
    setState(bot, "needs_input");
  } else if (bot.permission) {
    delete bot.permission;
    // A Stop that settled the request leaves the bot idle, not working.
    if (bot.state === "needs_input") setState(bot, "working");
  }
}

export function cwdOf(body: Record<string, any>): string {
  return String(body.cwd ?? bots.get(String(body.session_id ?? ""))?.cwd ?? "");
}

const agentOf = (body: Record<string, any>) => String(body.agent_id ?? "");
/** Events after which the main agent can't still be showing a permission dialog. */
const MAIN_MOVED_ON = new Set(["UserPromptSubmit", "Stop", "StopFailure"]);

/**
 * Drops the held requests this event shows were answered in the terminal and returns their ids.
 * Claude Code runs the hook alongside its own dialog and keeps the hook open when the dialog wins.
 * Its tool's result settles an allowed request; a denied one only shows in its agent moving on.
 */
function settle(sessionId: string, event: string, body: Record<string, any>): number[] {
  const agent = agentOf(body);
  const ran = (event === "PostToolUse" || event === "PostToolUseFailure") && body.tool_use_id;
  const movedOn = agent
    ? event === "SubagentStop"
    : MAIN_MOVED_ON.has(event) || (event === "Notification" && body.notification_type === "idle_prompt");
  const settled = [...held]
    .filter(([, h]) => h.sessionId === sessionId && ((ran && h.toolUseId === body.tool_use_id) || (movedOn && h.agent === agent)))
    .map(([id]) => id);
  for (const id of settled) held.delete(id);
  return settled;
}

function remember(sessionId: string, event: string, body: Record<string, any>): void {
  const list = calls.get(sessionId) ?? [];
  calls.set(sessionId, list);
  const toolUseId = String(body.tool_use_id ?? "");
  if (event === "PreToolUse" && toolUseId) {
    list.push({ agent: agentOf(body), toolUseId, toolName: String(body.tool_name), input: JSON.stringify(body.tool_input ?? {}) });
    if (list.length > MAX_CALLS) list.shift();
  } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const i = list.findIndex((c) => c.toolUseId === toolUseId);
    if (i >= 0) list.splice(i, 1);
  }
}

/** Applies one hook event. `place` is the git repo/branch of the event's cwd. `settled` lists held requests it ended. */
export function track(
  body: Record<string, any>,
  headers: Record<string, unknown>,
  place: { repo: string; branch: string },
): { bot?: Bot; settled: number[] } {
  const event = String(body.hook_event_name);
  const sessionId = String(body.session_id ?? "");
  if (!sessionId) return { settled: [] };
  const settled = settle(sessionId, event, body);
  if (event === "SessionEnd") return forget(sessionId), { settled };
  remember(sessionId, event, body);
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
  return { bot, settled };
}

/** Holds a request from `agent` (the hook's agent_id, unset for the main thread), tied to its tool call if one matches. */
export function hold(sessionId: string, permission: PendingPermission, agent?: string): void {
  const input = JSON.stringify(permission.toolInput ?? {});
  const linked = new Set([...held.values()].map((h) => h.toolUseId));
  const call = (calls.get(sessionId) ?? []).findLast(
    (c) => c.agent === (agent ?? "") && c.toolName === permission.toolName && c.input === input && !linked.has(c.toolUseId),
  );
  held.set(permission.id, { ...permission, sessionId, agent: agent ?? "", toolUseId: call?.toolUseId });
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
