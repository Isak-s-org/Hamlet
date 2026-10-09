// Pure merge logic for Agent Civ's hooks in a Claude Code settings object.
import {
  HOOK_ENV_VARS,
  HOOK_EVENTS,
  HOOK_TIMEOUT_SECONDS,
  PERMISSION_TIMEOUT_SECONDS,
  TERMINAL_HEADERS,
  TOKEN_HEADER,
} from "@agent-civ/shared";

export interface HookHandler {
  type: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}
export interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type Settings = { hooks?: Record<string, MatcherGroup[]>; [key: string]: unknown };

/** Ours = carries our token header, so entries are still found after a port change. */
export function isOurs(handler: HookHandler): boolean {
  return handler.type === "http" && Object.keys(handler.headers ?? {}).some((k) => k.toLowerCase() === TOKEN_HEADER);
}

/** Returns settings with all Agent Civ handlers removed, dropping groups and events left empty. */
export function withoutOurs(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export function withOurs(settings: Settings, hookUrl: string, token: string): Settings {
  const base = withoutOurs(settings);
  const hooks = { ...base.hooks };
  for (const event of HOOK_EVENTS) {
    const handler: HookHandler = {
      type: "http",
      url: hookUrl,
      timeout: event === "PermissionRequest" ? PERMISSION_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS,
      headers: { [TOKEN_HEADER]: token, ...TERMINAL_HEADERS },
      allowedEnvVars: [...HOOK_ENV_VARS],
    };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return { ...base, hooks };
}
