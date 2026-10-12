import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlTail, newTitles } from "./transcript.js";

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

test("a tail returns only complete new lines, across reads and split characters", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hamlet-")), "t.jsonl");
  writeFileSync(path, `{"a":1}\n{"b":`);
  const tail = new JsonlTail(path, 1000);
  assert.deepEqual(await tail.read(), { lines: [`{"a":1}`], reset: false });
  const snow = Buffer.from("❄"); // three bytes, split across two appends
  appendFileSync(path, Buffer.concat([Buffer.from(`"`), snow.subarray(0, 1)]));
  assert.deepEqual(await tail.read(), { lines: [], reset: false });
  appendFileSync(path, Buffer.concat([snow.subarray(1), Buffer.from(`"}\n`)]));
  assert.deepEqual(await tail.read(), { lines: [`{"b":"❄"}`], reset: false });
});

test("a tail rereads a file that shrank", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hamlet-")), "t.jsonl");
  writeFileSync(path, "one\ntwo\n");
  const tail = new JsonlTail(path, 1000);
  await tail.read();
  writeFileSync(path, "new\n");
  assert.deepEqual(await tail.read(), { lines: ["new"], reset: true });
});

test("an unfinished line over maxLine comes back as a stub that won't parse", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hamlet-")), "t.jsonl");
  writeFileSync(path, `{"big":"${"x".repeat(50)}`);
  const tail = new JsonlTail(path, 10);
  assert.deepEqual((await tail.read()).lines, []);
  appendFileSync(path, `"}\n{"ok":1}\n`);
  const { lines } = await tail.read();
  assert.equal(lines.length, 2);
  assert.throws(() => JSON.parse(lines[0]!));
  assert.equal(lines[1], `{"ok":1}`);
});
