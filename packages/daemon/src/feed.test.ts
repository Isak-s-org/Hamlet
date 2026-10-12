import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const kinds = (events: ChatEvent[]) => events.map((e) => ("entries" in e ? e.entries.length : "reset" in e ? "reset" : "commands" in e ? "commands" : e.error));

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

test("a missing transcript waits once without an error, then entries flow", async () => {
  const { path } = session();
  const errors: unknown[] = [];
  const feed = new ChatFeed(path, (e) => errors.push(e));
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  await feed.poll();
  assert.deepEqual(kinds(events), ["no-transcript"]);
  const late: ChatEvent[] = [];
  feed.subscribe((e) => late.push(e));
  assert.deepEqual(kinds(late), ["no-transcript"]);
  assert.equal(errors.length, 0);
  writeFileSync(path, prompt(1));
  await feed.poll();
  assert.deepEqual(kinds(events), ["no-transcript", 1]);
});

test("an unreadable transcript reports once and recovers", async () => {
  const { path } = session();
  mkdirSync(path); // a directory at the path fails with EISDIR
  const errors: unknown[] = [];
  const feed = new ChatFeed(path, (e) => errors.push(e));
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  await feed.poll();
  assert.deepEqual(kinds(events), ["unreadable"]);
  assert.equal(errors.length, 1);
  rmSync(path, { recursive: true });
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

test("a throwing listener is reported and doesn't stop the others", async () => {
  const { path } = session();
  writeFileSync(path, prompt(1));
  const errors: unknown[] = [];
  const feed = new ChatFeed(path, (e) => errors.push(e));
  feed.subscribe(() => {
    throw new Error("boom");
  });
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  assert.deepEqual(kinds(events), [1]);
  assert.equal(errors.length, 1);
});

test("a path change moves the viewers to the new feed", async () => {
  const one = session();
  const two = session();
  writeFileSync(one.path, prompt(1));
  writeFileSync(two.path, prompt(2) + prompt(3));
  const feeds = new Feeds(() => {}, 10, 100);
  const a: ChatEvent[] = [];
  const leaveA = feeds.subscribe("s1", one.path, (e) => a.push(e));
  await new Promise((r) => setTimeout(r, 40));
  const b: ChatEvent[] = [];
  const leaveB = feeds.subscribe("s1", two.path, (e) => b.push(e));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(kinds(a), [1, "reset", 2]);
  assert.deepEqual(kinds(b), [2]);
  assert.equal(feeds.size, 1);
  // Both viewers leave through the functions they were given, so the new feed must be dropped.
  leaveA();
  leaveB();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(feeds.size, 0);
});

const skills = (names: string[], isInitial = true) =>
  JSON.stringify({ type: "attachment", uuid: `l-${names.join()}`, timestamp: "t", attachment: { type: "skill_listing", isInitial, names, content: names.map((n) => `- ${n}: about ${n}`).join("\n") } }) + "\n";
const commandEvents = (events: ChatEvent[]) => events.flatMap((e) => ("commands" in e ? [e.commands.map((c) => c.name)] : []));

test("a feed sends the session's commands after the backlog, and each change", async () => {
  const { path } = session();
  writeFileSync(path, prompt(1) + skills(["init", "review"]));
  const feed = new ChatFeed(path);
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  assert.deepEqual(commandEvents(events), [["init", "review"]]);
  assert.ok("entries" in events[0]!);
  appendFileSync(path, skills(["deploy"], false));
  await feed.poll();
  assert.deepEqual(commandEvents(events).at(-1), ["init", "review", "deploy"]);
  const late: ChatEvent[] = [];
  feed.subscribe((e) => late.push(e));
  assert.deepEqual(commandEvents(late), [["init", "review", "deploy"]]);
  appendFileSync(path, skills(["only"]));
  await feed.poll();
  assert.deepEqual(commandEvents(late).at(-1), ["only"]);
});

test("a subagent's skill listing is not the session's", async () => {
  const { dir, path } = session();
  writeFileSync(path, prompt(1));
  const subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-x.jsonl"), skills(["sub-only"]));
  writeFileSync(join(subs, "agent-x.meta.json"), JSON.stringify({ toolUseId: "toolu_P" }));
  const feed = new ChatFeed(path);
  const events: ChatEvent[] = [];
  feed.subscribe((e) => events.push(e));
  await feed.poll();
  assert.deepEqual(commandEvents(events), []);
});
