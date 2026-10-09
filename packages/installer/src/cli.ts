#!/usr/bin/env -S npx tsx
// `agent-civ install-hooks` / `uninstall-hooks`: merges Agent Civ's HTTP hooks into
// ~/.claude/settings.json, leaving every other hook untouched.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { HOOK_ENV_VARS, HOOK_PATH, loadOrCreateConfig } from "@agent-civ/shared";
import { isOurs, type Settings, withOurs, withoutOurs } from "./settings.js";

const args = process.argv.slice(2);
const command = args[0];
const yes = args.includes("--yes");
const settingsArg = args.indexOf("--settings");
const settingsPath = settingsArg >= 0 ? args[settingsArg + 1]! : join(homedir(), ".claude", "settings.json");

const config = loadOrCreateConfig();
const hookUrl = `http://127.0.0.1:${config.port}${HOOK_PATH}`;

function readSettings(): Settings {
  return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
}

function apply(settings: Settings): Settings {
  return command === "install" ? withOurs(settings, hookUrl, config.token) : withoutOurs(settings);
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

  const before = readSettings();
  const after = apply(before);

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

  // Re-read: Claude Code may have changed the file while we waited for the answer.
  const current = readSettings();
  const backedUp = existsSync(settingsPath);
  if (backedUp) copyFileSync(settingsPath, `${settingsPath}.agent-civ-backup`);
  writeFileSync(settingsPath, JSON.stringify(apply(current), null, 2) + "\n");
  console.log(`Wrote ${settingsPath}${backedUp ? " (backup: .agent-civ-backup)" : ""}`);
}

await main();
