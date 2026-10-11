import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newTitles } from "./transcript.js";

test("newTitles reads only what was appended, including a line split across writes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hamlet-")), "s.jsonl");
  writeFileSync(path, `{"type":"user","message":"hej på dig"}\n{"type":"ai-title","aiTitle":"Första"}\n`);
  assert.deepEqual(await newTitles(path), [{ title: "Första", source: "ai" }]);
  assert.deepEqual(await newTitles(path), []);
  appendFileSync(path, `{"type":"custom-title","custom`);
  assert.deepEqual(await newTitles(path), []);
  appendFileSync(path, `Title":"Mine"}\n`);
  assert.deepEqual(await newTitles(path), [{ title: "Mine", source: "custom" }]);
});

test("newTitles ignores paths that aren't transcripts", async () => {
  assert.deepEqual(await newTitles("relative.jsonl"), []);
  assert.deepEqual(await newTitles("/etc/passwd"), []);
});
