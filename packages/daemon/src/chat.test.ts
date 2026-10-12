import assert from "node:assert/strict";
import { test } from "node:test";
import { commandsIn, duration, TEXT_CAP, toEntries } from "./chat.js";

const AT = "2026-10-12T10:00:00.000Z";
const line = (o: Record<string, unknown>) => JSON.stringify({ uuid: "u1", timestamp: AT, isSidechain: false, ...o });
const user = (content: unknown, extra = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content } });

test("a typed prompt becomes a prompt entry", () => {
  assert.deepEqual(toEntries(user("fix the tests")), [{ uuid: "u1:0", at: AT, kind: "prompt", text: "fix the tests" }]);
  assert.deepEqual(toEntries(user([{ type: "text", text: "with an image" }, { type: "image" }])), [
    { uuid: "u1:0", at: AT, kind: "prompt", text: "with an image" },
  ]);
});

test("text Claude Code injects as a user turn is not a prompt", () => {
  assert.deepEqual(toEntries(user("<command-name>/clear</command-name>")), []);
  assert.deepEqual(toEntries(user("  <system-reminder>x</system-reminder>")), []);
  assert.deepEqual(toEntries(user("Caveat: …", { isMeta: true })), []);
  assert.deepEqual(toEntries(user("This session is being continued…", { isCompactSummary: true })), []);
  assert.deepEqual(toEntries(user([{ type: "text", text: "[Request interrupted by user]" }])), [
    { uuid: "u1:0", at: AT, kind: "notice", text: "Interrupted", level: "info" },
  ]);
});

test("assistant blocks become text, thinking and tool entries; empty thinking is skipped", () => {
  const entries = toEntries(
    assistant([
      { type: "text", text: "Looking at it." },
      { type: "thinking", thinking: "", signature: "x" },
      { type: "thinking", thinking: "Maybe the cache." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } },
    ]),
  );
  assert.deepEqual(entries, [
    { uuid: "u1:0", at: AT, kind: "text", text: "Looking at it." },
    { uuid: "u1:2", at: AT, kind: "thinking", text: "Maybe the cache." },
    { uuid: "u1:3", at: AT, kind: "tool", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } },
  ]);
});

test("tool results join their text, mark errors and cap long output", () => {
  assert.deepEqual(toEntries(user([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }])), [
    { uuid: "u1:0", at: AT, kind: "result", toolUseId: "toolu_1", text: "ok", isError: false },
  ]);
  const [listed] = toEntries(user([{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a" }, { type: "image" }] }]));
  assert.equal(listed!.kind === "result" && listed!.text, "a\n[image]");
  const [failed] = toEntries(user([{ type: "tool_result", tool_use_id: "t", content: "Exit code 1", is_error: true }]));
  assert.equal(failed!.kind === "result" && failed!.isError, true);
  const big = "é".repeat(TEXT_CAP + 10);
  const [capped] = toEntries(user([{ type: "tool_result", tool_use_id: "t", content: big }]));
  assert.ok(capped!.kind === "result");
  assert.equal(capped.text.length, TEXT_CAP);
  assert.equal(capped.truncated, Buffer.byteLength(big));
});

test("huge tool inputs are capped at any depth", () => {
  const huge = "x".repeat(TEXT_CAP * 2);
  const [write] = toEntries(assistant([{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/a", content: huge } }]));
  const input = (write as { input: { content: string } }).input;
  assert.ok(input.content.length < huge.length && input.content.endsWith("… (truncated)"));
  const [multi] = toEntries(assistant([{ type: "tool_use", id: "t2", name: "MultiEdit", input: { edits: [{ old_string: huge, new_string: "y" }] } }]));
  const edits = (multi as { input: { edits: { old_string: string; new_string: string }[] } }).input.edits;
  assert.ok(edits[0]!.old_string.endsWith("… (truncated)"));
  assert.equal(edits[0]!.new_string, "y");
});

test("system lines become notices, noisy ones are skipped", () => {
  const sys = (o: Record<string, unknown>) => toEntries(line({ type: "system", ...o }));
  assert.deepEqual(sys({ subtype: "api_error", level: "error", error: { formatted: "Connection dropped (ECONNRESET)" } }), [
    { uuid: "u1:0", at: AT, kind: "notice", text: "API error: Connection dropped (ECONNRESET)", level: "error" },
  ]);
  assert.equal((sys({ subtype: "informational", content: "Remote Control is disabled." })[0] as { text: string }).text, "Remote Control is disabled.");
  assert.equal((sys({ subtype: "local_command", content: "<local-command-stdout>Done</local-command-stdout>" })[0] as { text: string }).text, "Done");
  assert.deepEqual(sys({ subtype: "local_command", content: "<local-command-stdout></local-command-stdout>" }), []);
  assert.equal((sys({ subtype: "turn_duration", durationMs: 436637 })[0] as { text: string }).text, "Turn took 7m 17s");
  assert.equal((sys({ subtype: "compact_boundary" })[0] as { text: string }).text, "Context compacted");
  assert.deepEqual(sys({ subtype: "stop_hook_summary" }), []);
  assert.deepEqual(sys({ subtype: "away_summary", content: "While you were away…" }), []);
});

test("subagent entries carry their parent and skip the fork's copy of the call that started it", () => {
  const entries = toEntries(
    assistant([
      { type: "tool_use", id: "toolu_P", name: "Agent", input: { description: "fork" } },
      { type: "text", text: "Working on it." },
    ]),
    "toolu_P",
  );
  assert.deepEqual(entries, [{ uuid: "u1:1", at: AT, parent: "toolu_P", kind: "text", text: "Working on it." }]);
});

test("unparsable, unknown and old sidechain lines give nothing", () => {
  assert.deepEqual(toEntries("{ not json"), []);
  assert.deepEqual(toEntries(line({ type: "attachment" })), []);
  assert.deepEqual(toEntries(JSON.stringify({ type: "user", message: { content: "no uuid" } })), []);
  assert.deepEqual(toEntries(user("from a subagent", { isSidechain: true })), []);
});

test("durations read like a clock", () => {
  assert.equal(duration(12_400), "12s");
  assert.equal(duration(436_637), "7m 17s");
  assert.equal(duration(3_720_000), "1h 2m");
});

test("toEntries never throws, even on a pathologically deep tool input", () => {
  // Built by hand: JSON.stringify itself overflows the stack on this.
  const deep = `${"[".repeat(20_000)}"x"${"]".repeat(20_000)}`;
  const out = toEntries(`{"uuid":"u1","type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"X","input":{"deep":${deep}}}]}}`);
  assert.ok(Array.isArray(out));
});

test("a fork's copy of the starting call's result is skipped", () => {
  const result = (id: string) => user([{ type: "tool_result", tool_use_id: id, content: "ok" }]);
  assert.deepEqual(toEntries(result("agent1"), "agent1"), []);
  assert.equal(toEntries(result("t9"), "agent1").length, 1);
  assert.equal(toEntries(result("agent1")).length, 1);
});

const listing = (names: unknown, content: string, isInitial = true) =>
  JSON.stringify({ type: "attachment", uuid: "l1", timestamp: "t", attachment: { type: "skill_listing", isInitial, names, content, skillCount: 2 } });

test("a skill listing gives each name with its description", () => {
  const line = listing(["init", "code-review:code-review", "bare"], "- init: Initialize a new CLAUDE.md file\n- code-review:code-review: Review a PR: bugs, style\n");
  assert.deepEqual(commandsIn(line), {
    initial: true,
    commands: [
      { name: "init", description: "Initialize a new CLAUDE.md file" },
      { name: "code-review:code-review", description: "Review a PR: bugs, style" },
      { name: "bare", description: "" },
    ],
  });
  assert.equal(commandsIn(listing(["x"], "- x: added", false))?.initial, false);
});

test("long descriptions are cut", () => {
  const d = commandsIn(listing(["x"], `- x: ${"a".repeat(500)}`))!.commands[0]!.description;
  assert.equal(d.length, 200);
  assert.ok(d.endsWith("…"));
});

test("anything but a well-formed skill listing gives nothing", () => {
  for (const line of [
    JSON.stringify({ type: "user", uuid: "u", message: { content: "skill_listing" } }),
    '{"type":"attachment","attachment":{"type":"skill_listing"',
    listing("init", "- init: x"),
    listing([1, 2], ""),
    "",
  ])
    assert.equal(commandsIn(line), undefined, line);
});
