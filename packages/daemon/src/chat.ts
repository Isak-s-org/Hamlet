// Turns Claude Code transcript lines into chat entries for the web app's chat view. Pure, so the
// rules can be tested on lines copied from real transcripts.
import type { ChatEntry, Command } from "@hamlet/shared";

/** Longest tool result or input string sent to the browser, so a 20 MB transcript still opens quickly. */
export const TEXT_CAP = 32 * 1024;

type Line = Record<string, any>;

const capped = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}\n… (truncated)` : s);

/** Caps every string in a tool input, at any depth: MultiEdit keeps its strings in `edits`. */
function capInput(v: unknown): unknown {
  if (typeof v === "string") return capped(v);
  if (Array.isArray(v)) return v.map(capInput);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capInput(x)]));
  return v;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "content"}]`)).join("\n");
}

/** Claude Code wraps commands, reminders and notifications in tags; only what the user typed is a prompt. */
export const typed = (t: unknown): t is string => typeof t === "string" && t.trim() !== "" && !t.trimStart().startsWith("<");
const INTERRUPTED = /^\[Request interrupted by user/;
/** CSI escape sequences, such as colors. */
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g;

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function notice(e: Line): { text: string; level: "info" | "error" } | undefined {
  switch (e.subtype) {
    case "api_error":
      return { text: `API error: ${e.error?.formatted ?? e.error?.message ?? "request failed"}`, level: "error" };
    case "informational":
      return typeof e.content === "string" && e.content ? { text: e.content, level: "info" } : undefined;
    case "local_command": {
      const content = String(e.content ?? "");
      // The line that records the command itself: show it as typed, not its tags.
      const name = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1];
      if (name) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(content)?.[1] ?? "";
        return { text: `${name} ${args}`.trim(), level: "info" };
      }
      // Command output keeps the terminal's colors (/context, /cost); the chat shows plain text.
      const text = content.replace(/<[^>]+>/g, "").replace(ANSI, "").trim();
      return text ? { text, level: "info" } : undefined;
    }
    case "turn_duration":
      return typeof e.durationMs === "number" ? { text: `Turn took ${duration(e.durationMs)}`, level: "info" } : undefined;
    // Not seen in local transcripts yet; this is the subtype Claude Code gives its compaction marker.
    case "compact_boundary":
      return { text: "Context compacted", level: "info" };
  }
}

/** The chat entries in one transcript line. `parent` is set for a subagent's transcript: the call that started it. */
export function toEntries(line: string, parent?: string): ChatEntry[] {
  // Never throws: a line that does would lose the rest of its poll's lines.
  try {
    return convert(JSON.parse(line), parent);
  } catch {
    return [];
  }
}

function convert(e: Line, parent?: string): ChatEntry[] {
  if (!e || typeof e !== "object" || typeof e.uuid !== "string") return [];
  // Older Claude Code versions wrote subagent turns into the main transcript.
  if (!parent && e.isSidechain) return [];
  const base = (i: number) => ({ uuid: `${e.uuid}:${i}`, at: String(e.timestamp ?? ""), ...(parent ? { parent } : {}) });
  const content = e.message?.content;
  const out: ChatEntry[] = [];
  if (e.type === "user" && !e.isMeta && !e.isCompactSummary) {
    const blocks: Line[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    blocks.forEach((c, i) => {
      // A fork's transcript repeats the result of the call that started it; the parent's card has the real one.
      if (c?.type === "tool_result") {
        if (parent && c.tool_use_id === parent) return;
        const text = resultText(c.content);
        const cut = text.length > TEXT_CAP;
        out.push({
          ...base(i),
          kind: "result",
          toolUseId: String(c.tool_use_id),
          text: cut ? text.slice(0, TEXT_CAP) : text,
          isError: c.is_error === true,
          ...(cut ? { truncated: Buffer.byteLength(text) } : {}),
        });
      } else if (c?.type === "text" && INTERRUPTED.test(String(c.text))) out.push({ ...base(i), kind: "notice", text: "Interrupted", level: "info" });
      else if (c?.type === "text" && typed(c.text)) out.push({ ...base(i), kind: "prompt", text: c.text });
    });
  } else if (e.type === "assistant" && Array.isArray(content)) {
    content.forEach((c: Line, i: number) => {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ ...base(i), kind: "text", text: c.text });
      else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) out.push({ ...base(i), kind: "thinking", text: c.thinking });
      // A fork's transcript starts with a copy of the call that started it.
      else if (c?.type === "tool_use" && c.id !== parent) out.push({ ...base(i), kind: "tool", id: String(c.id), name: String(c.name), input: capInput(c.input ?? {}) });
    });
  } else if (e.type === "system") {
    const n = notice(e);
    if (n) out.push({ ...base(0), kind: "notice", ...n });
  }
  return out;
}

/** An assistant line's token count: its turn's input, cache and output. Each content block repeats its turn's usage. */
export function tokensOf(line: string): number | undefined {
  if (!line.includes('"usage"')) return undefined;
  try {
    const u = JSON.parse(line)?.message?.usage;
    if (!u || typeof u !== "object") return undefined;
    return ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce((n, k) => n + (Number(u[k]) || 0), 0);
  } catch {
    return undefined;
  }
}

/**
 * Applies a `queue-operation` line to `queue`, Claude Code's input queue in order. A queued message
 * leaves it when its turn starts (dequeue) or when a running turn takes it in (remove). Returns
 * whether the line changed the queue. Never throws.
 */
export function applyQueueOp(line: string, queue: string[]): boolean {
  if (!line.includes('"queue-operation"')) return false;
  try {
    const e = JSON.parse(line);
    if (e?.type !== "queue-operation") return false;
    const content = typeof e.content === "string" ? e.content : "";
    if (e.operation === "enqueue") return queue.push(content), true;
    if (e.operation === "dequeue") return queue.shift() !== undefined;
    const i = e.operation === "remove" ? queue.indexOf(content) : -1;
    return i >= 0 && (queue.splice(i, 1), true);
  } catch {
    return false;
  }
}

const DESCRIPTION_CAP = 200;

/**
 * The commands a `skill_listing` attachment lists: the skills, custom and plugin commands the session
 * can run. `initial` lists replace what came before; later ones add to it. Never throws.
 */
export function commandsIn(line: string): { commands: Command[]; initial: boolean } | undefined {
  // Every transcript line passes through here; most can be skipped without parsing.
  if (!line.includes('"skill_listing"')) return;
  try {
    const a = JSON.parse(line)?.attachment;
    if (a?.type !== "skill_listing" || !Array.isArray(a.names) || !a.names.every((n: unknown) => typeof n === "string")) return;
    // `content` has one "- <name>: <description>" row per name; names never contain ": ".
    const described = new Map<string, string>();
    for (const row of String(a.content ?? "").split("\n")) {
      const at = row.indexOf(": ");
      if (row.startsWith("- ") && at > 2) described.set(row.slice(2, at), row.slice(at + 2).trim());
    }
    const cut = (d: string) => (d.length > DESCRIPTION_CAP ? `${d.slice(0, DESCRIPTION_CAP - 1)}…` : d);
    return { initial: a.isInitial !== false, commands: (a.names as string[]).map((name) => ({ name, description: cut(described.get(name) ?? "") })) };
  } catch {
    return;
  }
}
