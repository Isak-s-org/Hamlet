/** What the daemon streams to the UI. One bot per live Claude Code session. */
export type BotState = "working" | "needs_input" | "idle" | "errored";

export interface PendingPermission {
  id: number;
  toolName: string;
  toolInput: unknown;
  cwd: string;
}

export interface Bot {
  sessionId: string;
  repo: string;
  branch: string;
  cwd: string;
  state: BotState;
  /** ms epoch of the last state change; the waiting tray sorts on it. */
  since: number;
  permission?: PendingPermission;
  /** Where the session's terminal lives, from the hook headers. Absent when we can't focus it. */
  terminal?: { kind: "cmux"; surfaceId: string; workspaceId: string } | { kind: "wt"; session: string };
}

export interface WorldSnapshot {
  bots: Bot[];
}

export const API_PREFIX = "/api";
