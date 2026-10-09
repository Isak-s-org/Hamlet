#!/usr/bin/env -S npx tsx
// `agent-civ install-hooks` / `uninstall-hooks`: merges Agent Civ's HTTP hooks into
// ~/.claude/settings.json, leaving every other hook untouched.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HOOK_ENV_VARS,
  HOOK_EVENTS,
  HOOK_PATH,
  HOOK_TIMEOUT_SECONDS,
  loadOrCreateConfig,
  PERMISSION_TIMEOUT_SECONDS,
  TERMINAL_HEADERS,
} from "@agent-civ/shared";

interface HookHandler {
  type: string;
  url?: string;
  [key: string]: unknown;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type Settings = { hooks?: Record<string, MatcherGroup[]>; [key: string]: unknown };

const args = process.argv.slice(2);
const command = args[0];
const yes = args.includes("--yes");
const settingsArg = args.indexOf("--settings");
const settingsPath = settingsArg >= 0 ? args[settingsArg + 1]! : join(homedir(), ".claude", "settings.json");

const config = loadOrCreateConfig();
const hookUrl = `http://127.0.0.1:${config.port}${HOOK_PATH}`;

function isOurs(handler: HookHandler): boolean {
  return handler.type === "http" && typeof handler.url === "string" && handler.url.startsWith(hookUrl);
}

/** Returns settings with all Agent Civ handlers removed, dropping groups and events left empty. */
function withoutOurs(settings: Settings): Settings {
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

function withOurs(settings: Settings): Settings {
  const base = withoutOurs(settings);
  const hooks = { ...base.hooks };
  for (const event of HOOK_EVENTS) {
    const handler: HookHandler = {
      type: "http",
      url: hookUrl,
      timeout: event === "PermissionRequest" ? PERMISSION_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS,
      headers: { "X-Agent-Civ-Token": config.token, ...TERMINAL_HEADERS },
      allowedEnvVars: [...HOOK_ENV_VARS],
    };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return { ...base, hooks };
}

function describeChange(before: Settings, after: Settings): string[] {
  const count = (s: Settings, event: string) =>
    (s.hooks?.[event] ?? []).flatMap((g) => g.hooks).filter(isOurs).length;
  const events = new Set([...Object.keys(before.hooks ?? {}), ...Object.keys(after.hooks ?? {})]);
  const lines: string[] = [];
  for (const event of events) {
    const delta = count(after, event) - count(before, event);
    if (delta > 0) lines.push(`  + ${event} → POST ${hookUrl}`);
    if (delta < 0) lines.push(`  - ${event} → POST ${hookUrl}`);
  }
  return lines;
}

async function main(): Promise<void> {
  if (command !== "install" && command !== "uninstall") {
    console.log("usage: agent-civ <install|uninstall> [--yes] [--settings <path>]");
    process.exit(1);
  }

  const before: Settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const after = command === "install" ? withOurs(before) : withoutOurs(before);

  if (JSON.stringify(before) === JSON.stringify(after)) {
    console.log(`${settingsPath} is already up to date.`);
    return;
  }

  const lines = describeChange(before, after);
  console.log(`Changes to ${settingsPath}:`);
  console.log(lines.length > 0 ? lines.join("\n") : "  (hook settings refreshed)");
  if (command === "install") {
    console.log(`\nEach hook sends the event JSON plus a secret token and the terminal env vars ${HOOK_ENV_VARS.join(", ")}.`);
    console.log("If the daemon isn't running, Claude Code treats the hook as a non-blocking error and carries on.");
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\nApply? [y/N] ");
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Nothing changed.");
      return;
    }
  }

  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.agent-civ-backup`);
  writeFileSync(settingsPath, JSON.stringify(after, null, 2) + "\n");
  console.log(`Wrote ${settingsPath}${existsSync(`${settingsPath}.agent-civ-backup`) ? " (backup: .agent-civ-backup)" : ""}`);
}

await main();
