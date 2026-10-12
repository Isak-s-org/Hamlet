import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cmuxIn, liveSessions } from "./registry.js";

test("live sessions come from registry files whose process is still running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hamlet-registry-"));
  const entry = (pid: number, extra = {}) =>
    JSON.stringify({ pid, sessionId: `s${pid}`, cwd: "/src/hamlet", status: "idle", kind: "interactive", ...extra });
  writeFileSync(join(dir, "10.json"), entry(10));
  writeFileSync(join(dir, "11.json"), entry(11)); // dead
  writeFileSync(join(dir, "12.json"), "{ not json");
  writeFileSync(join(dir, "13.json"), JSON.stringify({ pid: 13 })); // no session id
  writeFileSync(join(dir, "10.abc.key"), "secret");
  const sessions = await liveSessions(dir, (pid) => pid !== 11);
  assert.deepEqual(sessions, [{ pid: 10, sessionId: "s10", cwd: "/src/hamlet", status: "idle" }]);
  assert.deepEqual(await liveSessions(join(dir, "missing")), []);
});

test("only the two cmux ids are taken from a process environment", () => {
  const ps = "/usr/bin/claude --resume CMUX_SURFACE_ID=aa-1 HOME=/Users/me CMUX_WORKSPACE_ID=bb-2 SECRET=x";
  assert.deepEqual(cmuxIn(ps), { "x-cmux-surface-id": "aa-1", "x-cmux-workspace-id": "bb-2" });
  assert.deepEqual(cmuxIn("CMUX_SURFACE_ID=aa-1\0PATH=/bin\0CMUX_WORKSPACE_ID=bb-2\0"), { "x-cmux-surface-id": "aa-1", "x-cmux-workspace-id": "bb-2" });
  assert.deepEqual(cmuxIn("PATH=/bin"), {});
});
