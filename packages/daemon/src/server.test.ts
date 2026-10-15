import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import type { ChatEvent } from "@hamlet/shared";

const token = randomBytes(16).toString("hex");
const auth = { "x-hamlet-token": token };

/** Starts a daemon with its own home on a random port. */
function boot(webDir: string | undefined) {
  const home = mkdtempSync(join(tmpdir(), "hamlet-server-"));
  const port = 47_000 + Math.floor(Math.random() * 1000);
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, token }));
  // A fake cmux on PATH records its arguments; a cmux-fail file makes it fail like a closed surface.
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cmux"), `#!/bin/sh\n[ -f "${home}/cmux-fail" ] && { echo "surface not found" >&2; exit 1; }\n[ "$1" = new-surface ] && echo "OK S1 P1 W1"\nprintf '%s\\n' "$@" >> "${home}/cmux.log"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "open"), "#!/bin/sh\n", { mode: 0o755 });
  // An empty CLAUDE_CONFIG_DIR keeps the session registry scan away from the real ~/.claude.
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: { ...process.env, HAMLET_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), HAMLET_WEB_DIR: webDir, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  /** Resolves with the first match once the daemon has printed it. */
  const printed = (re: RegExp) =>
    new Promise<RegExpMatchArray>((resolve) => {
      const check = () => {
        const m = out.match(re);
        if (m) child.stdout!.off("data", check), resolve(m);
      };
      child.stdout!.on("data", check);
      check();
    });
  return { home, port, child, printed, out: () => out };
}

const webDir = mkdtempSync(join(tmpdir(), "hamlet-web-"));
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "index.html"), "<title>T</title>");
writeFileSync(join(webDir, "assets", "app.js"), "export {};");
const daemon = boot(webDir);
const { home, port } = daemon;
const base = `http://127.0.0.1:${port}`;
const cmuxLog = join(home, "cmux.log");
const cmuxFail = join(home, "cmux-fail");

before(() => daemon.printed(/one-time link/), { timeout: 20_000 });
after(() => daemon.child.kill());

/** Sends exactly these headers, Host and Fetch Metadata included, which fetch won't. Event streams resolve at their headers. */
function raw(path: string, headers: Record<string, string> = {}, method = "GET", to = port) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: to, path, method, headers: { host: `127.0.0.1:${to}`, ...headers } }, (res) => {
      let body = "";
      const done = () => resolve({ status: res.statusCode!, headers: res.headers, body });
      if (res.headers["content-type"] === "text/event-stream") return void (res.destroy(), done());
      res.on("data", (d: Buffer) => (body += d.toString())).on("end", done);
    });
    req.on("error", reject).end();
  });
}

const signInLink = (prefix: string) => daemon.printed(new RegExp(`${prefix}: http://127\\.0\\.0\\.1:${port}(/auth\\?code=[\\w-]+)`)).then((m) => m[1]!);
let cookie = "";

test("signing in trades the printed one-time link for a session cookie", async () => {
  const hint = await raw("/");
  assert.equal(hint.status, 401);
  assert.match(hint.body, /one-time link/);

  const wrong = await raw("/auth?code=wrong");
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers["set-cookie"], undefined);

  const first = await signInLink("Open Hamlet \\(one-time link\\)");
  const signedIn = await raw(first);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, "/");
  const setCookie = signedIn.headers["set-cookie"]![0]!;
  assert.match(setCookie, /^hamlet_session=[\w-]+; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax$/);
  cookie = setCookie.split(";")[0]!;
  assert.notEqual(cookie, `hamlet_session=${token}`);
  assert.equal((await raw(first)).headers["set-cookie"], undefined);

  const second = await signInLink("Next one-time link");
  assert.notEqual(second, first);
  assert.equal((await raw(second)).headers["set-cookie"]![0], setCookie);

  const page = await raw("/", { cookie });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.body, "<title>T</title>");
  assert.ok(!daemon.out().includes(token));
});

test("static files come only from the build", async () => {
  const js = await raw("/assets/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  assert.equal(js.body, "export {};");
  for (const path of ["/index.html", "/assets/../../config.json", "/%2e%2e/config.json", "/assets/..%2f..%2fconfig.json", "/nope"]) {
    assert.equal((await raw(path)).status, 404, path);
  }
});

test("the served page reaches the API with its cookie from its own origin only", async () => {
  const stream = (headers: Record<string, string>) => raw("/api/stream", headers).then((r) => r.status);
  assert.equal((await raw("/api/stream", { cookie, "sec-fetch-site": "same-origin" })).headers["content-type"], "text/event-stream");
  assert.equal(await stream({ cookie, "sec-fetch-site": "same-origin" }), 200);
  assert.equal(await stream({ cookie, "sec-fetch-site": "same-site" }), 403);
  assert.equal(await stream({ cookie, "sec-fetch-site": "cross-site" }), 403);
  assert.equal(await stream({ cookie }), 401);
  assert.equal(await stream({ cookie: `hamlet_session=${token}`, "sec-fetch-site": "same-origin" }), 401);
  assert.equal(await stream({ cookie: `hamlet_session=junk; ${cookie}`, "sec-fetch-site": "same-origin" }), 200);
});

test("the dev proxy gets through, a cross-site request through it doesn't", async () => {
  assert.equal((await raw("/api/stream", { ...auth, host: "localhost:5173", "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await raw("/api/repos/x/new", { ...auth, "sec-fetch-site": "cross-site" }, "POST")).status, 403);
});

test("a rebound DNS name is refused on every route", async () => {
  const host = `evil.test:${port}`;
  assert.equal((await raw("/", { host, cookie })).status, 403);
  assert.equal((await raw("/api/stream", { ...auth, host })).status, 403);
  assert.equal((await raw("/hooks", { ...auth, host }, "POST")).status, 403);
});

test("an encoded path to the API still needs the token", async () => {
  assert.equal((await raw("/%61pi/stream")).status, 401);
  assert.equal((await raw("/%61pi/decide", {}, "POST")).status, 401);
});

test("other sites may link to the village but not frame it or post to it", async () => {
  const from = (dest: string) => ({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": dest });
  assert.equal((await raw("/", from("document"))).status, 401);
  assert.equal((await raw("/", from("iframe"))).status, 403);
  assert.equal((await raw("/", from("document"), "POST")).status, 403);
});

test("without a web dir the daemon serves only the API, behind the token", { timeout: 20_000 }, async () => {
  const dev = boot(undefined);
  try {
    await dev.printed(/daemon on/);
    assert.equal((await raw("/api/stream", auth, "GET", dev.port)).status, 200);
    assert.equal((await raw("/api/stream", {}, "GET", dev.port)).status, 401);
    assert.equal((await raw("/", {}, "GET", dev.port)).status, 404);
    assert.equal((await raw("/auth?code=x", {}, "GET", dev.port)).status, 404);
  } finally {
    dev.child.kill();
  }
  assert.doesNotMatch(dev.out(), /one-time link/);
});

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

test("stop presses Esc in the session's surface and marks it idle; other keys are refused", async () => {
  await hook({ session_id: "k1", hook_event_name: "UserPromptSubmit", prompt: "go" }, inCmux);
  const press = (key: string) => fetch(`${base}/api/sessions/k1/key/${key}`, { method: "POST", headers: auth });
  assert.equal((await press("enter")).status, 404);
  writeFileSync(cmuxLog, "");
  assert.equal((await press("stop")).status, 204);
  assert.deepEqual(readFileSync(cmuxLog, "utf8").trimEnd().split("\n"), ["send-key", "--workspace", WORKSPACE, "--surface", SURFACE, "escape"]);
  const [snapshot] = (await events("/api/stream", (seen) => seen.length > 0)) as unknown as { bots: { sessionId: string; state: string }[] }[];
  assert.equal(snapshot!.bots.find((b) => b.sessionId === "k1")?.state, "idle");
});

test("a new agent starts in a cmux workspace at the root of a repo with a live session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hamlet-repo-")));
  mkdirSync(join(root, "sub"));
  execFileSync("git", ["init", "-q", root]);
  await hook({ session_id: "n1", hook_event_name: "Stop", cwd: join(root, "sub") });
  const spawnIn = (repo: string) => fetch(`${base}/api/repos/${encodeURIComponent(repo)}/new`, { method: "POST", headers: auth });
  assert.equal((await spawnIn("nope")).status, 404);
  writeFileSync(cmuxLog, "");
  assert.equal((await spawnIn(basename(root))).status, 204);
  const args = readFileSync(cmuxLog, "utf8").trimEnd().split("\n");
  assert.deepEqual(args, ["new-workspace", "--cwd", root, "--name", basename(root), "--command", "claude", "--focus", "true"]);
  // With an agent of the repo in cmux, the new one opens as a tab in its workspace.
  await hook({ session_id: "n2", hook_event_name: "Stop", cwd: root }, inCmux);
  writeFileSync(cmuxLog, "");
  assert.equal((await spawnIn(basename(root))).status, 204);
  const tab = readFileSync(cmuxLog, "utf8").trimEnd().split("\n");
  assert.deepEqual(tab.slice(0, 18), [
    "new-surface", "--workspace", WORKSPACE, "--working-directory", root, "--id-format", "uuids",
    "send", "--workspace", WORKSPACE, "--surface", "S1", "claude\\n",
    "focus-panel", "--panel", "S1", "--workspace", WORKSPACE,
  ]);
  rmSync(root, { recursive: true });
});
