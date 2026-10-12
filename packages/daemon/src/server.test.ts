import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ChatEvent } from "@hamlet/shared";

const home = mkdtempSync(join(tmpdir(), "hamlet-server-"));
const port = 47_000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const auth = { "x-hamlet-token": "t" };
writeFileSync(join(home, "config.json"), JSON.stringify({ port, token: "t" }));
// A fake cmux on PATH records its arguments; a cmux-fail file makes it fail like a closed surface.
const bin = join(home, "bin");
const cmuxLog = join(home, "cmux.log");
const cmuxFail = join(home, "cmux-fail");
mkdirSync(bin);
writeFileSync(join(bin, "cmux"), `#!/bin/sh\n[ -f "${cmuxFail}" ] && { echo "surface not found" >&2; exit 1; }\nprintf '%s\\n' "$@" >> "${cmuxLog}"\n`, { mode: 0o755 });
// An empty CLAUDE_CONFIG_DIR keeps the session registry scan away from the real ~/.claude.
const daemon = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  env: { ...process.env, HAMLET_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), PATH: `${bin}:${process.env.PATH}` },
  stdio: ["pipe", "pipe", "inherit"],
});

before(async () => {
  await new Promise<void>((resolve) => daemon.stdout!.on("data", (d: Buffer) => d.toString().includes("daemon on") && resolve()));
}, { timeout: 20_000 });
after(() => daemon.kill());

const hook = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/hooks`, { method: "POST", headers: { ...auth, "content-type": "application/json", ...headers }, body: JSON.stringify({ cwd: home, ...body }) });

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

const SURFACE = "11111111-2222-3333-4444-555555555555";
const WORKSPACE = "66666666-7777-8888-9999-000000000000";
const inCmux = { "x-cmux-surface-id": SURFACE, "x-cmux-workspace-id": WORKSPACE };
const send = (id: string, body: unknown) =>
  fetch(`${base}/api/sessions/${id}/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("a message is pasted into the session's cmux surface and submitted", async () => {
  await hook({ session_id: "c1", hook_event_name: "Stop" }, inCmux);
  assert.equal((await send("c1", { text: "two\nlines\x1b[31m" })).status, 204);
  const args = readFileSync(cmuxLog, "utf8").trimEnd().split("\n");
  assert.deepEqual(args.slice(0, 2), ["rpc", "terminal.paste"]);
  assert.deepEqual(JSON.parse(args.slice(2).join("\n")), { workspace_id: WORKSPACE, surface_id: SURFACE, text: "two\nlines[31m", submit_key: "return" });
});

test("sending refuses bad text, unknown sessions and sessions outside cmux", async () => {
  await hook({ session_id: "c2", hook_event_name: "Stop" });
  assert.equal((await send("c2", {})).status, 400);
  assert.equal((await send("c2", { text: " \n " })).status, 400);
  assert.equal((await send("c2", { text: "x".repeat(70_000) })).status, 413);
  assert.equal((await send("nope", { text: "hi" })).status, 404);
  assert.equal((await send("c2", { text: "hi" })).status, 422);
});

test("sending waits for a held permission prompt", { timeout: 10_000 }, async () => {
  await hook({ session_id: "c3", hook_event_name: "Stop" }, inCmux);
  const held = new AbortController();
  const request = fetch(`${base}/hooks`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...inCmux },
    body: JSON.stringify({ cwd: home, session_id: "c3", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }),
    signal: held.signal,
  }).catch(() => {});
  let status = 0;
  for (let i = 0; i < 50 && status !== 409; i++) {
    status = (await send("c3", { text: "hi" })).status;
    if (status !== 409) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(status, 409);
  held.abort();
  await request;
});

test("a cmux failure comes back as 502 with its message", async () => {
  await hook({ session_id: "c4", hook_event_name: "Stop" }, inCmux);
  writeFileSync(cmuxFail, "");
  try {
    const res = await send("c4", { text: "hi" });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /surface not found/);
  } finally {
    rmSync(cmuxFail);
  }
});
