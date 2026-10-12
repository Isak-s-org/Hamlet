import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ChatEvent } from "@hamlet/shared";

const home = mkdtempSync(join(tmpdir(), "hamlet-server-"));
const port = 47_000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const auth = { "x-hamlet-token": "t" };
writeFileSync(join(home, "config.json"), JSON.stringify({ port, token: "t" }));
// An empty CLAUDE_CONFIG_DIR keeps the session registry scan away from the real ~/.claude.
const daemon = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  env: { ...process.env, HAMLET_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
  stdio: ["pipe", "pipe", "inherit"],
});

before(async () => {
  await new Promise<void>((resolve) => daemon.stdout!.on("data", (d: Buffer) => d.toString().includes("daemon on") && resolve()));
}, { timeout: 20_000 });
after(() => daemon.kill());

const hook = (body: Record<string, unknown>) =>
  fetch(`${base}/hooks`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ cwd: home, ...body }) });

/** Reads SSE messages until `done` says stop, then closes the stream. */
async function events(path: string, done: (seen: ChatEvent[]) => boolean, onEvent?: (e: ChatEvent) => void): Promise<ChatEvent[]> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}${path}`, { headers: auth, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const seen: ChatEvent[] = [];
  let buf = "";
  while (!done(seen)) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += Buffer.from(value).toString();
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const e = JSON.parse(buf.slice(0, i).replace(/^data: /, "")) as ChatEvent;
      buf = buf.slice(i + 2);
      seen.push(e);
      onEvent?.(e);
    }
  }
  ctrl.abort();
  return seen;
}

const line = (uuid: string, o: Record<string, unknown>) => JSON.stringify({ uuid, timestamp: "t", ...o }) + "\n";

test("the chat endpoint needs the token and a known session", async () => {
  assert.equal((await fetch(`${base}/api/sessions/nope/chat`)).status, 401);
  assert.equal((await fetch(`${base}/api/sessions/nope/chat`, { headers: auth })).status, 404);
});

test("the chat streams the backlog, then appended entries", { timeout: 10_000 }, async () => {
  const path = join(home, "s1.jsonl");
  writeFileSync(path, line("u1", { type: "user", message: { content: "hello" } }));
  await hook({ session_id: "s1", hook_event_name: "UserPromptSubmit", transcript_path: path, prompt: "hello" });
  const seen = await events(
    "/api/sessions/s1/chat",
    (s) => s.length >= 2,
    (e) => {
      if ("entries" in e && e.entries[0]?.kind === "prompt")
        appendFileSync(path, line("a1", { type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }));
    },
  );
  assert.deepEqual(
    seen.map((e) => ("entries" in e ? e.entries.map((x) => x.kind) : e)),
    [["prompt"], ["text"]],
  );
});

test("a session without a transcript waits for one", { timeout: 10_000 }, async () => {
  await hook({ session_id: "s2", hook_event_name: "UserPromptSubmit", prompt: "hi" });
  const path = join(home, "s2.jsonl");
  writeFileSync(path, line("u2", { type: "user", message: { content: "later" } }));
  const seen = await events(
    "/api/sessions/s2/chat",
    (s) => s.some((e) => "entries" in e),
    (e) => void ("error" in e && hook({ session_id: "s2", hook_event_name: "PreToolUse", transcript_path: path, tool_name: "Read", tool_use_id: "x" })),
  );
  assert.deepEqual(seen[0], { error: "no-transcript" });
  assert.ok(seen.some((e) => "entries" in e && e.entries[0]?.kind === "prompt"));
});
