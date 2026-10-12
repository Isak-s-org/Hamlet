import assert from "node:assert/strict";
import { test } from "node:test";
import { SEND_CAP } from "@hamlet/shared";
import { cleanText, pasteArgs } from "./terminal.js";

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
