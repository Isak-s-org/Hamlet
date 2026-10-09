// M0 hook spike — throwaway. Logs every hook event and holds PermissionRequests so we
// can answer the spec's open questions before designing the real daemon.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import { appDataDir, HOOK_PATH, loadOrCreateConfig, TOKEN_HEADER } from "@agent-civ/shared";

type Behavior = "allow" | "deny";

interface Pending {
  id: number;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  receivedAt: number;
  resolve: (behavior: Behavior) => void;
}

const config = loadOrCreateConfig();
const logDir = join(appDataDir(), "spike-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "hooks.jsonl");

/** SPIKE_AUTO=allow|deny answers every PermissionRequest at once; default holds it for a manual answer. */
const autoReply = process.env.SPIKE_AUTO as Behavior | undefined;

const pending = new Map<number, Pending>();
let nextId = 1;

function log(entry: Record<string, unknown>): void {
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function permissionResponse(behavior: Behavior) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: behavior === "allow" ? { behavior } : { behavior, message: "Denied from Agent Civ" },
    },
  };
}

function decide(id: number, behavior: Behavior): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.resolve(behavior);
  return true;
}

const app = Fastify({ bodyLimit: 20 * 1024 * 1024, requestTimeout: 0 });

app.post(HOOK_PATH, async (request, reply) => {
  if (request.headers[TOKEN_HEADER] !== config.token) {
    log({ kind: "rejected", reason: "bad token", headers: request.headers });
    return reply.code(401).send();
  }

  const body = request.body as Record<string, any>;
  const event = String(body.hook_event_name);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.startsWith("x-")));
  delete headers[TOKEN_HEADER];
  log({ kind: "hook", event, headers, body });

  const sid = String(body.session_id ?? "?").slice(0, 8);
  const detail = body.tool_name ?? body.notification_type ?? body.source ?? body.reason ?? "";
  console.log(`${new Date().toLocaleTimeString()}  ${sid}  ${event.padEnd(18)} ${detail}  ${body.cwd ?? ""}`);

  if (event !== "PermissionRequest") return reply.code(200).send();

  if (autoReply) return permissionResponse(autoReply);

  const id = nextId++;
  const behavior = await new Promise<Behavior | "cancelled">((resolve) => {
    pending.set(id, {
      id,
      sessionId: String(body.session_id),
      toolName: String(body.tool_name),
      toolInput: body.tool_input,
      receivedAt: Date.now(),
      resolve,
    });
    // Claude dropping the connection means the request was settled elsewhere (terminal prompt, timeout, interrupt).
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) resolve("cancelled");
    });
    console.log(`  ⚑ [${id}] ${body.tool_name}: ${JSON.stringify(body.tool_input).slice(0, 200)}`);
    console.log(`    answer with: a ${id}  |  d ${id}`);
  });
  const heldMs = Date.now() - pending.get(id)!.receivedAt;
  pending.delete(id);

  log({ kind: "permission-outcome", id, sessionId: body.session_id, outcome: behavior, heldMs });
  console.log(`  ⚑ [${id}] ${behavior} after ${(heldMs / 1000).toFixed(1)}s`);
  if (behavior === "cancelled") return reply;
  return permissionResponse(behavior);
});

app.get("/spike/pending", async (request, reply) => {
  if (request.headers[TOKEN_HEADER] !== config.token) return reply.code(401).send();
  return [...pending.values()].map(({ resolve, ...p }) => p);
});

app.post<{ Params: { id: string }; Body: { behavior: Behavior } }>("/spike/decide/:id", async (request, reply) => {
  if (request.headers[TOKEN_HEADER] !== config.token) return reply.code(401).send();
  const ok = decide(Number(request.params.id), request.body.behavior);
  return reply.code(ok ? 200 : 404).send({ ok });
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const [cmd, idText] = line.trim().split(/\s+/);
  const id = Number(idText);
  if ((cmd === "a" || cmd === "d") && !decide(id, cmd === "a" ? "allow" : "deny")) {
    console.log(`  no pending request ${id}`);
  }
});

await app.listen({ host: "127.0.0.1", port: config.port });
console.log(`agent-civ spike daemon on http://127.0.0.1:${config.port}${HOOK_PATH}`);
console.log(`logging to ${logFile}`);
console.log(autoReply ? `auto-replying "${autoReply}" to PermissionRequest` : "holding PermissionRequests for manual answers");
