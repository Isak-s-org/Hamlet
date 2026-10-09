import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4747;

export interface AgentCivConfig {
  port: number;
  /** Shared secret Claude Code sends in hook headers and the UI sends on connect. */
  token: string;
}

export function appDataDir(): string {
  if (process.env.AGENT_CIV_HOME) return process.env.AGENT_CIV_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "agent-civ");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agent-civ");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-civ");
}

/** Reads config.json from the app data dir, creating it with a fresh token on first run. */
export function loadOrCreateConfig(): AgentCivConfig {
  const dir = appDataDir();
  const file = join(dir, "config.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as AgentCivConfig;
  } catch {
    const config: AgentCivConfig = { port: DEFAULT_PORT, token: randomBytes(24).toString("hex") };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    return config;
  }
}
