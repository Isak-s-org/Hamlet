import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "@hamlet/shared";
import { BATCH, ChatFeed, Feeds } from "./feed.js";

const prompt = (n: number) => JSON.stringify({ type: "user", uuid: `p${n}`, timestamp: "t", message: { content: `prompt ${n}` } }) + "\n";
const session = () => {
  const dir = mkdtempSync(join(tmpdir(), "hamlet-feed-"));
  return { dir, path: join(dir, "s1.jsonl") };
};
const kinds = (events: ChatEvent[]) => events.map((e) => ("entries" in e ? e.entries.length : "reset" in e ? "reset" : e.error));

test("a feed sends its backlog in batches, then what each poll appends", async () => {
  const { path } = session();
  writeFileSync(path, Array.from({ length: 1200 }, (_, i) => prompt(i)).join(""));
  const feed = new ChatFeed(path);
  const first: ChatEvent[] = [];
  feed.subscribe((e) => first.push(e));
  await feed.poll();
  assert.deepEqual(kinds(first), [BATCH, BATCH, 200]);
  const second: ChatEvent[] = [];
  const unsubscribe = feed.subscribe((e) => second.push(e));
  assert.deepEqual(kinds(second), [BATCH, BATCH, 200]);
  appendFileSync(path, prompt(1200));
  await feed.poll();
  assert.deepEqual(kinds(second), [BATCH, BATCH, 200, 1]);
  unsubscribe();
  assert.equal(feed.viewers, 1);
});

test("subagent entries arrive with their parent once the meta file exists", async () => {
  const { dir, path } = session();
  const call = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "t", message: { content: [{ type: "tool_use", id: "toolu_P", name: "Agent", input: {} }] } });
  writeFileSync(path, call + "\n");
  const subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-x.jsonl"), prompt(1));
  const feed = new ChatFeed(path);
  await feed.poll();
  assert.deepEqual(feed.entries.map((e) => e.kind), ["tool"]);
  writeFileSync(join(subs, "agent-x.meta.json"), "{ broken");
  await feed.poll();
  assert.equal(feed.entries.length, 1);
  writeFileSync(join(subs, "agent-x.meta.json"), JSON.stringify({ toolUseId: "toolu_P" }));
  await feed.poll();
  assert.deepEqual(feed.entries.map((e) => [e.kind, e.parent]), [["tool", undefined], ["prompt", "toolu_P"]]);
});

test("a rewritten transcript resets the feed", async () => {
  const { path } = session();
  writeFileSync(path, prompt(1) + prompt(2));
  const feed = new ChatFeed(path);
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  writeFileSync(path, prompt(3));
  await feed.poll();
  assert.deepEqual(kinds(events), [2, "reset", 1]);
  assert.deepEqual(feed.entries.map((e) => e.uuid), ["p3:0"]);
});

test("an unreadable transcript reports once and recovers", async () => {
  const { path } = session();
  const errors: unknown[] = [];
  const feed = new ChatFeed(path, (e) => errors.push(e));
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  await feed.poll();
  assert.deepEqual(kinds(events), ["unreadable"]);
  assert.equal(errors.length, 1);
  writeFileSync(path, prompt(1));
  await feed.poll();
  assert.deepEqual(kinds(events), ["unreadable", 1]);
});

test("feeds poll while watched and are dropped after the grace period", async () => {
  const { path } = session();
  writeFileSync(path, prompt(1));
  const feeds = new Feeds(() => {}, 10, 50);
  const events: ChatEvent[] = [];
  const unsubscribe = feeds.subscribe("s1", path, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(kinds(events), [1]);
  unsubscribe();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(feeds.size, 0);
});
