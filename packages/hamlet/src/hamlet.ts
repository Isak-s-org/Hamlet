#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const USAGE = `usage: hamlet                                  start Hamlet and serve the village
       hamlet install   [--yes] [--settings <path>]
       hamlet uninstall [--yes] [--settings <path>]`;

const command = process.argv[2];
if (command === undefined) {
  // The build copies the web UI next to this file.
  process.env.HAMLET_WEB_DIR = fileURLToPath(new URL("web", import.meta.url));
  await import("@hamlet/daemon");
} else if (command === "install" || command === "uninstall") {
  // The installer reads the same argv.
  await import("@hamlet/installer");
} else {
  console.log(USAGE);
  process.exitCode = command === "-h" || command === "--help" ? 0 : 1;
}
