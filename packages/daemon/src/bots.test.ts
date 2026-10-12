import assert from "node:assert/strict";
import { test } from "node:test";
import { bots, describe, hold, promptTitle, release, retitle, sweep, track } from "./bots.js";

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

test("the first real prompt titles a session until Claude Code's own title arrives", () => {
  send("t1", "UserPromptSubmit", { prompt: "<agent-message>a subagent report</agent-message>" });
  assert.equal(bots.get("t1")!.title, undefined);
  send("t1", "UserPromptSubmit", { prompt: "Fix   the\nlogin bug" });
  send("t1", "UserPromptSubmit", { prompt: "now add tests" });
  assert.equal(bots.get("t1")!.title, "Fix the login bug");
  assert.equal(retitle("t1", "Login bug fix", "ai"), true);
  assert.equal(retitle("t1", "Renamed by me", "custom"), true);
  // An AI title written later must not replace the user's /rename.
  assert.equal(retitle("t1", "Login bug fix and tests", "ai"), false);
  assert.equal(bots.get("t1")!.title, "Renamed by me");
  assert.equal(promptTitle("x".repeat(100))!.length, 60);
  send("t1", "SessionEnd");
});

test("activity follows the running tool and clears when the session stops", () => {
  send("t2", "PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/src/hamlet/bots.ts" }, tool_use_id: "u1" });
  assert.equal(bots.get("t2")!.activity, "Editing bots.ts");
  // A parallel tool finishing doesn't clear the newer one.
  send("t2", "PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm test", description: "Run tests" }, tool_use_id: "u2" });
  send("t2", "PostToolUse", { tool_use_id: "u1" });
  assert.equal(bots.get("t2")!.activity, "Run tests");
  send("t2", "PostToolUse", { tool_use_id: "u2" });
  assert.equal(bots.get("t2")!.activity, undefined);
  send("t2", "PreToolUse", { tool_name: "Grep", tool_input: { pattern: "todo" }, tool_use_id: "u3" });
  send("t2", "Stop");
  assert.equal(bots.get("t2")!.activity, undefined);
  send("t2", "SessionEnd");
});

// Claude Code keeps the PermissionRequest hook open after its own dialog is answered, so later events must settle it.
const question = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }], multiSelect: false }] };
const askFor = (sessionId: string, id: number, toolName: string, toolInput: unknown, agent_id?: string) => {
  send(sessionId, "PreToolUse", { tool_name: toolName, tool_input: toolInput, tool_use_id: `u${id}`, agent_id });
  send(sessionId, "PermissionRequest", { tool_name: toolName, tool_input: toolInput, agent_id });
  hold(sessionId, { id, toolName, toolInput, cwd: "/src/hamlet" }, agent_id);
};

test("a request answered in the terminal clears when its tool runs", () => {
  askFor("p1", 10, "AskUserQuestion", question);
  askFor("p1", 11, "Bash", { command: "ls" });
  // The answers come back in tool_input, so only the tool_use_id ties the event to the request.
  const { settled } = send("p1", "PostToolUse", { tool_name: "AskUserQuestion", tool_input: { ...question, answers: { "Which?": "A" } }, tool_use_id: "u10" });
  assert.deepEqual(settled, [10]);
  assert.equal(bots.get("p1")!.permission!.id, 11);
  assert.deepEqual(send("p1", "PostToolUseFailure", { tool_name: "Bash", tool_use_id: "u11" }).settled, [11]);
  assert.equal(bots.get("p1")!.permission, undefined);
  assert.equal(bots.get("p1")!.state, "working");
  send("p1", "SessionEnd");
});

test("a request denied in the terminal clears when the main turn ends", () => {
  askFor("p2", 12, "Bash", { command: "rm -rf build" });
  assert.deepEqual(send("p2", "Stop").settled, [12]);
  assert.equal(bots.get("p2")!.permission, undefined);
  assert.equal(bots.get("p2")!.state, "idle");
  askFor("p2", 13, "Bash", { command: "rm -rf build" });
  assert.deepEqual(send("p2", "Notification", { notification_type: "idle_prompt" }).settled, [13]);
  askFor("p2", 14, "Bash", { command: "rm -rf build" });
  assert.deepEqual(send("p2", "UserPromptSubmit", { prompt: "no, keep build" }).settled, [14]);
  send("p2", "SessionEnd");
});

test("a subagent's request only clears on its own agent's events", () => {
  askFor("p3", 15, "Bash", { command: "pnpm test" }, "a");
  assert.deepEqual(send("p3", "Stop").settled, []);
  assert.deepEqual(send("p3", "SubagentStop", { agent_id: "b" }).settled, []);
  assert.deepEqual(send("p3", "PostToolUse", { tool_name: "Bash", tool_use_id: "other" }).settled, []);
  assert.equal(bots.get("p3")!.permission!.id, 15);
  assert.deepEqual(send("p3", "SubagentStop", { agent_id: "a" }).settled, [15]);
  assert.equal(bots.get("p3")!.permission, undefined);
  send("p3", "SessionEnd");
});

test("describe names common tools", () => {
  assert.equal(describe("Bash", { command: "git status\ngit diff" }), "Running git status");
  assert.equal(describe("WebFetch", { url: "https://example.com/a" }), "Reading example.com");
  assert.equal(describe("mcp__github__create_issue"), "Using github");
  assert.equal(describe("Frobnicate"), "Using Frobnicate");
});
