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
  type ChatEvent,
  type Decision,
  type Question,
} from "@hamlet/shared";
import { bots, cwdOf, discover, hold, prune, release, retitle, sweep, track } from "./bots.js";
import { findTranscript, liveSessions, terminalHeaders } from "./registry.js";
import { Feeds } from "./feed.js";
import { cleanText, focusTerminal, sendText } from "./terminal.js";
import { forgetTranscript, isTranscriptPath, newTitles } from "./transcript.js";

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

/** Each session's transcript, from its hooks or the session registry. The chat view only ever reads these paths. */
const transcripts = new Map<string, string>();
const feeds = new Feeds((sessionId, error) => log({ kind: "chat-error", sessionId, error: String(error) }));

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

/** Picks up sessions that were running before the daemon started or before the hooks were installed, and drops exited ones. */
async function scanSessions(): Promise<void> {
  const live = await liveSessions();
  let changed = prune(new Set(live.map((s) => s.sessionId)));
  for (const s of live) {
    if (bots.has(s.sessionId)) continue;
    const [place, headers] = await Promise.all([gitPlace(s.cwd), terminalHeaders(s.pid)]);
    const bot = discover(s, headers, place);
    if (!bot) continue;
    changed = true;
    const transcript = await findTranscript(s.sessionId);
    if (transcript) {
      if (!transcripts.has(bot.sessionId)) transcripts.set(bot.sessionId, transcript);
      readTitles(bot.sessionId, transcript);
    }
  }
  if (changed) broadcast();
}

const SCAN_EVERY_MS = 10_000;
async function scanLoop(): Promise<void> {
  try {
    await scanSessions();
  } catch (e) {
    log({ kind: "registry-error", error: String(e) });
  }
  setTimeout(scanLoop, SCAN_EVERY_MS).unref();
}
void scanLoop();

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
  const transcript = typeof body.transcript_path === "string" && isTranscriptPath(body.transcript_path) ? body.transcript_path : "";
  if (event === "SessionEnd") {
    const sessionId = String(body.session_id);
    clearTimeout(titleReads.get(sessionId)?.timer);
    titleReads.delete(sessionId);
    transcripts.delete(sessionId);
    feeds.drop(sessionId);
    if (transcript) forgetTranscript(transcript);
  } else if (bot && transcript) {
    // Only the main thread's path is the session's transcript.
    if (body.agent_id === undefined) transcripts.set(bot.sessionId, transcript);
    readTitles(bot.sessionId, transcript);
  }
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

app.get(`${API_PREFIX}/sessions/:id/chat`, (request, reply) => {
  const { id } = request.params as { id: string };
  if (!bots.has(id)) return reply.code(404).send();
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (e: ChatEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  let unsubscribe: (() => void) | undefined;
  const attach = () => {
    const path = transcripts.get(id);
    if (path) unsubscribe = feeds.subscribe(id, path, send);
    return !!path;
  };
  // A session can be known before any hook brought its transcript path; wait for one.
  let wait: NodeJS.Timeout | undefined;
  if (!attach()) {
    send({ error: "no-transcript" });
    wait = setInterval(() => attach() && clearInterval(wait), 1000);
  }
  request.raw.on("close", () => {
    clearInterval(wait);
    unsubscribe?.();
  });
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

app.post(`${API_PREFIX}/sessions/:id/send`, async (request, reply) => {
  const { id } = request.params as { id: string };
  const { text } = (request.body ?? {}) as { text?: unknown };
  if (typeof text !== "string") return reply.code(400).send();
  const clean = cleanText(text);
  if ("error" in clean) return reply.code(clean.error === "empty" ? 400 : 413).send({ error: clean.error });
  const bot = bots.get(id);
  if (!bot) return reply.code(404).send();
  // Typed text would land in the terminal's permission dialog.
  if (bot.permission) return reply.code(409).send();
  if (bot.terminal?.kind !== "cmux") return reply.code(422).send();
  try {
    await sendText(bot.terminal, clean.text);
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message).trim();
    return reply.code(502).send({ error: msg });
  }
  log({ kind: "sent", sessionId: id, chars: clean.text.length });
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
