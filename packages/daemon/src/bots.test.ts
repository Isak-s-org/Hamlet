import assert from "node:assert/strict";
import { test } from "node:test";
import { bots, hold, release, sweep, track } from "./bots.js";

const place = { repo: "hamlet", branch: "main" };
const send = (sessionId: string, hook_event_name: string, extra: Record<string, unknown> = {}) =>
  track({ session_id: sessionId, hook_event_name, cwd: "/src/hamlet", ...extra }, {}, place);
const ask = (sessionId: string, id: number) =>
  hold(sessionId, { id, toolName: "Bash", toolInput: {}, cwd: "/src/hamlet" });

test("parallel permission requests stay visible until each is settled", () => {
  send("s1", "PermissionRequest", { agent_id: "a" });
  ask("s1", 1);
  send("s1", "PermissionRequest", { agent_id: "b" });
  ask("s1", 2);
  // Other work in the session must not hide a held request.
  send("s1", "PostToolUse");
  assert.equal(bots.get("s1")!.state, "needs_input");
  assert.equal(bots.get("s1")!.permission!.id, 1);

  release(1);
  assert.equal(bots.get("s1")!.permission!.id, 2);
  release(2);
  assert.equal(bots.get("s1")!.permission, undefined);
  assert.equal(bots.get("s1")!.state, "working");
});

test("subagent events don't move the bot, Stop and idle_prompt do", () => {
  send("s2", "UserPromptSubmit");
  send("s2", "Stop");
  send("s2", "PreToolUse", { agent_id: "a" });
  assert.equal(bots.get("s2")!.state, "idle");
  send("s2", "UserPromptSubmit");
  send("s2", "Notification", { notification_type: "idle_prompt" });
  assert.equal(bots.get("s2")!.state, "idle");
  send("s2", "SessionEnd");
  assert.equal(bots.has("s2"), false);
});

test("an unanswered PermissionRequest (auto-reply) leaves the bot working", () => {
  send("s3", "PermissionRequest");
  assert.equal(bots.get("s3")!.state, "working");
});

test("sweep drops silent sessions but keeps ones holding a request", () => {
  send("s4", "UserPromptSubmit");
  send("s5", "PermissionRequest");
  ask("s5", 3);
  sweep(1000, Date.now() + 2000);
  assert.equal(bots.has("s4"), false);
  assert.equal(bots.has("s5"), true);
  release(3);
});
