import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4747;

export interface HamletConfig {
  port: number;
  /** Shared secret Claude Code sends in hook headers and the UI sends on connect. */
  token: string;
}

export function appDataDir(): string {
  if (process.env.HAMLET_HOME) return process.env.HAMLET_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "hamlet");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "hamlet");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hamlet");
}

/** Reads config.json from the app data dir, creating it with a fresh token on first run. */
export function loadOrCreateConfig(): HamletConfig {
  const dir = appDataDir();
  const file = join(dir, "config.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HamletConfig;
  } catch (err) {
    // Only a missing file gets a fresh token; a broken one must fail loudly, not rotate the token.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const config: HamletConfig = { port: DEFAULT_PORT, token: randomBytes(24).toString("hex") };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    // Another process created it first; use its token.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateConfig();
    throw err;
  }
  return config;
}
