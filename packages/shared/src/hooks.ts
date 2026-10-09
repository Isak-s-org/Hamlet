/** Hook events the daemon subscribes to. Names per https://code.claude.com/docs/en/hooks.md */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "CwdChanged",
  "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Seconds Claude Code waits on our HTTP hook. PermissionRequest is held until the user answers. */
export const HOOK_TIMEOUT_SECONDS = 5;
export const PERMISSION_TIMEOUT_SECONDS = 1800;

export const HOOK_PATH = "/hooks";

/**
 * Terminal-locator headers the installer asks Claude Code to send with every hook. Values are
 * interpolated from the hook process environment, which is how the daemon learns
 * which terminal a session lives in.
 */
export const TERMINAL_HEADERS = {
  "X-Cmux-Surface-Id": "$CMUX_SURFACE_ID",
  "X-Cmux-Workspace-Id": "$CMUX_WORKSPACE_ID",
  "X-Wt-Session": "$WT_SESSION",
} as const;

export const HOOK_ENV_VARS = Object.values(TERMINAL_HEADERS).map((v) => v.slice(1));

export const TOKEN_HEADER = "x-hamlet-token";
