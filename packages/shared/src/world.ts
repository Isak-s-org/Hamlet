/** What the daemon streams to the UI. One bot per live Claude Code session. */
export type BotState = "working" | "needs_input" | "idle" | "errored";

export interface PendingPermission {
  id: number;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  /** The subagent asking, so the prompt shows on its helper. Unset for the main thread. */
  agentId?: string;
}

/** A subagent the session is running, shown as a small villager following its bot. */
export interface Helper {
  agentId: string;
  /** The subagent's type, such as "Explore". */
  type?: string;
  activity?: string;
}

export interface Bot {
  sessionId: string;
  repo: string;
  branch: string;
  cwd: string;
  state: BotState;
  /** What the session is about: Claude Code's title for it, or the first prompt until there is one. */
  title?: string;
  /** Short description of the tool the session is running, such as "Editing bots.ts". Cleared when it stops. */
  activity?: string;
  /** ms epoch of the last state change; the waiting tray sorts on it. */
  since: number;
  permission?: PendingPermission;
  /** Subagents running now, from SubagentStart until SubagentStop. */
  helpers?: Helper[];
  /** Where the session's terminal lives, from the hook headers. Absent when we can't focus it. */
  terminal?: { kind: "cmux"; surfaceId: string; workspaceId: string } | { kind: "wt"; session: string };
}

/** One question of an AskUserQuestion request, as Claude Code sends it in tool_input. */
export interface Question {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** Answer body for POST /api/decide. `answers` maps question text to the chosen label(s), comma-joined. */
export interface Decision {
  id: number;
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
}

export interface WorldSnapshot {
  bots: Bot[];
}

export const API_PREFIX = "/api";

/** One item of a session's conversation, read from its transcript. `parent` is the Agent/Task call a subagent's entry belongs to. */
export type ChatEntry = { uuid: string; at: string; parent?: string } & (
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  /** `truncated` is the full result's size in bytes when `text` was cut. */
  | { kind: "result"; toolUseId: string; text: string; isError: boolean; truncated?: number }
  | { kind: "notice"; text: string; level: "info" | "error" }
);

/** One entry of the chat's "/" menu. */
export interface Command {
  name: string;
  description: string;
}

/** One message of GET /api/sessions/:id/chat. */
export type ChatEvent = { entries: ChatEntry[] } | { reset: true } | { error: "no-transcript" | "unreadable" } | { commands: Command[] };

/** Longest message POST /api/sessions/:id/send takes, in UTF-8 bytes. */
export const SEND_CAP = 64 * 1024;

/** Built-ins that run without a picker in the terminal. The transcript's listing doesn't have built-ins. */
export const BUILTIN_COMMANDS: Command[] = [
  { name: "clear", description: "Clear the conversation and start fresh" },
  { name: "compact", description: "Summarize the conversation to free context; optional focus instructions" },
  { name: "context", description: "Show how the context window is used" },
  { name: "cost", description: "Show this session's cost and duration" },
];
