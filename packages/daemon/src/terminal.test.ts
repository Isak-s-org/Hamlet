import assert from "node:assert/strict";
import { test } from "node:test";
import { SEND_CAP, type Bot } from "@hamlet/shared";
import { cleanText, cmuxError, pasteArgs, target } from "./terminal.js";

test("control characters never reach the terminal; tabs and newlines do", () => {
  assert.deepEqual(cleanText("red \x1b[31mtext\x1b[0m\x07\x7f\x9b"), { text: "red [31mtext[0m" });
  assert.deepEqual(cleanText("a\r\nb\rc\td\n"), { text: "a\nb\nc\td" });
  assert.deepEqual(cleanText("  indented\nkept  \n\n"), { text: "  indented\nkept" });
});

test("empty and over-long text is refused", () => {
  assert.deepEqual(cleanText(" \n\x1b\t"), { error: "empty" });
  assert.deepEqual(cleanText("x".repeat(SEND_CAP)), { text: "x".repeat(SEND_CAP) });
  assert.deepEqual(cleanText("é".repeat(SEND_CAP / 2 + 1)), { error: "too-long" });
});

test("one paste call submits the text to the session's surface", () => {
  const t = { kind: "cmux", surfaceId: "S", workspaceId: "W" } as const;
  const args = pasteArgs(t, "line 1\nline 2");
  assert.deepEqual(args.slice(0, 2), ["rpc", "terminal.paste"]);
  assert.deepEqual(JSON.parse(args[2]!), { workspace_id: "W", surface_id: "S", text: "line 1\nline 2", submit_key: "return" });
  assert.equal(args.length, 3);
});

const bot = (o: Partial<Bot> = {}): Bot => ({ sessionId: "s", repo: "r", branch: "b", cwd: "/", state: "idle", since: 0, terminal: { kind: "cmux", surfaceId: "S", workspaceId: "W" }, ...o });

test("only a cmux session that isn't waiting on a prompt can be sent to", () => {
  assert.deepEqual(target(bot()), { terminal: { kind: "cmux", surfaceId: "S", workspaceId: "W" } });
  assert.deepEqual(target(undefined), { refuse: 404 });
  assert.deepEqual(target(bot({ permission: { id: 1, toolName: "Bash", toolInput: {}, cwd: "/" } })), { refuse: 409 });
  // Found waiting in the session registry (say after a daemon restart): a dialog may be open with no request held.
  assert.deepEqual(target(bot({ state: "needs_input" })), { refuse: 409 });
  assert.deepEqual(target(bot({ terminal: undefined })), { refuse: 422 });
  assert.deepEqual(target(bot({ terminal: { kind: "wt", session: "x" } })), { refuse: 422 });
});

test("a cmux failure never echoes the message, and a timeout says it may have landed", () => {
  const argv = "Command failed: cmux rpc terminal.paste {\"text\":\"secret plan\"}";
  assert.equal(cmuxError({ stderr: "Error: surface not found\n", message: argv }), "Error: surface not found");
  assert.equal(cmuxError({ stderr: "", message: argv }), "cmux failed");
  assert.match(cmuxError({ killed: true, stderr: "", message: argv }), /timed out.*check the terminal/);
});
