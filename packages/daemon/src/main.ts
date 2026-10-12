// M0 hook spike, now also feeding the web slice: logs every hook event, holds PermissionRequests,
// and streams bot state to the UI over SSE.
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import Fastify from "fastify";
import {
  API_PREFIX,
  appDataDir,
  HOOK_PATH,
  loadOrCreateConfig,
  TOKEN_HEADER,
  type Bot,
  type Decision,
  type Question,
} from "@hamlet/shared";
import { bots, cwdOf, hold, release, retitle, sweep, track } from "./bots.js";
import { forgetTranscript, newTitles } from "./transcript.js";

type Behavior = "allow" | "deny";
type Answer = { behavior: Behavior; answers?: Record<string, string> };
/** How a held request ended without an answer from Hamlet: the hook connection closed, or a later event showed the terminal answered it. */
type Elsewhere = "cancelled" | "settled";

interface Pending {
  receivedAt: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (answer: Answer | Elsewhere) => void;
}

const config = loadOrCreateConfig();
const logDir = join(appDataDir(), "spike-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "hooks.jsonl");
// Full bodies hold file contents and command output, so they are opt-in and owner-only.
const logBodies = process.env.SPIKE_LOG === "1";
appendFileSync(logFile, "", { mode: 0o600 });
chmodSync(logFile, 0o600);

/** SPIKE_AUTO=allow|deny answers every PermissionRequest at once; default holds it for a manual answer. */
const autoReply = process.env.SPIKE_AUTO as Behavior | undefined;
if (autoReply && autoReply !== "allow" && autoReply !== "deny") {
  console.error(`SPIKE_AUTO must be "allow" or "deny", got "${autoReply}"`);
  process.exit(1);
}

const pending = new Map<number, Pending>();
let nextId = 1;

function log(entry: Record<string, unknown>): void {
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/** Answers go back as updatedInput, which replaces the whole input, so the questions are echoed with them. */
function permissionResponse({ behavior, answers }: Answer, toolInput?: Record<string, unknown>) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision:
        behavior === "deny" ? { behavior, message: "Denied from Hamlet" }
        : answers ? { behavior, updatedInput: { ...toolInput, answers } }
        : { behavior },
    },
  };
}

/** Answers must cover exactly the request's questions; anything else is a bad request. */
function validAnswers(p: Pending, answers: unknown): answers is Record<string, string> {
  if (p.toolName !== "AskUserQuestion" || !answers || typeof answers !== "object") return false;
  const asked = ((p.toolInput.questions ?? []) as Question[]).map((q) => q.question);
  const given = Object.entries(answers);
  return (
    given.length === asked.length &&
    given.every(([q, a]) => asked.includes(q) && typeof a === "string" && a.trim() !== "" && a.length <= 4000)
  );
}

function decide(id: number, answer: Answer): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.resolve(answer);
  return true;
}

/** Last title read per session, and a timer while one is waiting, so a burst of events reads once. */
const titleReads = new Map<string, { at: number; timer?: NodeJS.Timeout }>();
const TITLE_EVERY_MS = 3000;

function readTitles(sessionId: string, path: string): void {
  const r = titleReads.get(sessionId) ?? { at: 0 };
  titleReads.set(sessionId, r);
  if (r.timer) return;
  r.timer = setTimeout(async () => {
    r.at = Date.now();
    try {
      let changed = false;
      for (const t of await newTitles(path)) changed = retitle(sessionId, t.title, t.source) || changed;
      if (changed) broadcast();
    } catch (e) {
      log({ kind: "transcript-error", sessionId, error: String(e) });
    } finally {
      delete r.timer;
    }
  }, Math.max(0, r.at + TITLE_EVERY_MS - Date.now()));
  r.timer.unref();
}

const run = promisify(execFile);
const gitCache = new Map<string, Promise<{ repo: string; branch: string }>>();

/** Repo = main checkout name (so worktrees share a city), branch = current branch. */
function gitPlace(cwd: string) {
  let place = gitCache.get(cwd);
  if (!place) {
    if (!cwd) return Promise.resolve({ repo: "?", branch: "-" });
    const git = (...args: string[]) => run("git", args, { cwd }).then((r) => r.stdout.trim());
    place = Promise.all([git("rev-parse", "--path-format=absolute", "--git-common-dir"), git("branch", "--show-current")])
      .then(([common, branch]) => ({
        repo: basename(common.endsWith(".git") ? dirname(common) : common),
        branch: branch || "detached",
      }))
      .catch(() => ({ repo: basename(cwd) || "/", branch: "-" }));
    gitCache.set(cwd, place);
    // Branches change under a running session; re-ask git now and then.
    setTimeout(() => gitCache.delete(cwd), 10_000).unref();
  }
  return place;
}

const streams = new Set<ServerResponse>();

function broadcast(): void {
  const data = `data: ${JSON.stringify({ bots: [...bots.values()] })}\n\n`;
  for (const s of streams) s.write(data);
}

// shortcut: 6 h without any hook event counts as dead; a long-idle live session reappears on its next event.
setInterval(() => sweep(6 * 3600_000) && broadcast(), 60_000).unref();

async function focusTerminal(t: NonNullable<Bot["terminal"]>): Promise<void> {
  if (t.kind === "cmux") {
    await run("cmux", ["focus-panel", "--panel", t.surfaceId, "--workspace", t.workspaceId]);
    if (process.platform === "darwin") await run("open", ["-b", "com.cmuxterm.app"]);
    return;
  }
  // shortcut: WT has no focus-tab-by-session API, so this only raises the window; upgrade if WT adds one.
  await run("powershell", [
    "-NoProfile",
    "-Command",
    "$p = Get-Process WindowsTerminal -ErrorAction Stop | Select-Object -First 1; (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null",
  ]);
}

const app = Fastify({ bodyLimit: 20 * 1024 * 1024, requestTimeout: 0 });

app.post(HOOK_PATH, async (request, reply) => {
  if (request.headers[TOKEN_HEADER] !== config.token) {
    log({ kind: "rejected", reason: "bad token" });
    return reply.code(401).send();
  }

  const body = request.body as Record<string, any>;
  const event = String(body.hook_event_name);
  // Every event awaits the same cached git lookup, so a SessionEnd can't overtake an earlier event.
  const { bot, settled } = track(body, request.headers, await gitPlace(cwdOf(body)));
  for (const id of settled) pending.get(id)?.resolve("settled");
  broadcast();
  const transcript = typeof body.transcript_path === "string" ? body.transcript_path : "";
  if (event === "SessionEnd") {
    clearTimeout(titleReads.get(String(body.session_id))?.timer);
    titleReads.delete(String(body.session_id));
    if (transcript) forgetTranscript(transcript);
  } else if (bot && transcript) readTitles(bot.sessionId, transcript);
  if (logBodies) {
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.startsWith("x-")));
    delete headers[TOKEN_HEADER];
    log({ kind: "hook", event, headers, body });
  } else log({ kind: "hook", event, sessionId: body.session_id, tool: body.tool_name });

  const sid = String(body.session_id ?? "?").slice(0, 8);
  const detail = body.tool_name ?? body.notification_type ?? body.source ?? body.reason ?? "";
  console.log(`${new Date().toLocaleTimeString()}  ${sid}  ${event.padEnd(18)} ${detail}  ${body.cwd ?? ""}`);

  if (event !== "PermissionRequest") return reply.code(200).send();

  if (autoReply) return permissionResponse({ behavior: autoReply });

  const id = nextId++;
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  const answer = await new Promise<Answer | Elsewhere>((resolve) => {
    pending.set(id, { receivedAt: Date.now(), toolName: String(body.tool_name), toolInput, resolve });
    if (bot) {
      hold(bot.sessionId, { id, toolName: String(body.tool_name), toolInput: body.tool_input, cwd: bot.cwd }, body.agent_id);
      broadcast();
    }
    // Claude dropping the connection means the request was settled elsewhere (terminal prompt, timeout, interrupt).
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) resolve("cancelled");
    });
    console.log(`  ⚑ [${id}] ${body.tool_name}: ${JSON.stringify(body.tool_input).slice(0, 200)}`);
    console.log(`    answer with: a ${id}  |  d ${id}`);
  });
  const heldMs = Date.now() - pending.get(id)!.receivedAt;
  pending.delete(id);
  release(id);
  broadcast();

  const outcome = typeof answer === "string" ? answer : answer.answers ? "answered" : answer.behavior;
  log({ kind: "permission-outcome", id, sessionId: body.session_id, outcome, heldMs });
  console.log(`  ⚑ [${id}] ${outcome} after ${(heldMs / 1000).toFixed(1)}s`);
  if (answer === "cancelled") return reply;
  // The terminal's answer already applied; an empty reply just closes the hook.
  if (answer === "settled") return reply.code(200).send();
  return permissionResponse(answer, toolInput);
});

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith(API_PREFIX) && request.headers[TOKEN_HEADER] !== config.token) {
    return reply.code(401).send();
  }
});

app.get(`${API_PREFIX}/stream`, (request, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ bots: [...bots.values()] })}\n\n`);
  streams.add(res);
  request.raw.on("close", () => streams.delete(res));
});

app.post(`${API_PREFIX}/decide`, async (request, reply) => {
  const { id, behavior, answers } = request.body as Partial<Record<keyof Decision, unknown>>;
  if (typeof id !== "number" || (behavior !== "allow" && behavior !== "deny")) return reply.code(400).send();
  const p = pending.get(id);
  if (!p) return reply.code(404).send();
  if (answers !== undefined && (behavior !== "allow" || !validAnswers(p, answers))) return reply.code(400).send();
  decide(id, answers ? { behavior, answers } : { behavior });
  return reply.code(204).send();
});

app.post(`${API_PREFIX}/terminal`, async (request, reply) => {
  const { sessionId } = request.body as { sessionId?: unknown };
  const terminal = typeof sessionId === "string" ? bots.get(sessionId)?.terminal : undefined;
  if (!terminal) return reply.code(404).send();
  try {
    await focusTerminal(terminal);
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message).trim();
    return reply.code(502).send({ error: msg });
  }
  return reply.code(204).send();
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const [cmd, idText] = line.trim().split(/\s+/);
  const id = Number(idText);
  if ((cmd === "a" || cmd === "d") && !decide(id, { behavior: cmd === "a" ? "allow" : "deny" })) {
    console.log(`  no pending request ${id}`);
  }
});

await app.listen({ host: "127.0.0.1", port: config.port });
console.log(`hamlet spike daemon on http://127.0.0.1:${config.port}${HOOK_PATH}`);
console.log(`logging to ${logFile}`);
console.log(autoReply ? `auto-replying "${autoReply}" to PermissionRequest` : "holding PermissionRequests for manual answers");
