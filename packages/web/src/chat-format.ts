// Pure helpers for the chat view: what a tool card says, the HTML for text, diffs and results, and the composer's "/" menu.
// Transcript content is untrusted, so every string goes through esc() before it becomes HTML.
import { BUILTIN_COMMANDS, type Bot, type ChatEntry, type Command } from "@hamlet/shared/world";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const isAgent = (name: string) => name === "Agent" || name === "Task";

/** One line saying what a tool call is about, such as the command or the file. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const text =
    name === "Bash" ? str(i.command).split("\n")[0]!
    : isAgent(name) ? str(i.description)
    : str(i.file_path) || str(i.notebook_path) || str(i.pattern) || str(i.url) || str(i.query) || str(i.skill) || str(i.description);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** Claude's text: paragraphs keep their line breaks, fenced code becomes a code block. */
export function textHtml(text: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let code: string[] | undefined;
  const flush = () => {
    const p = prose.join("\n").trim();
    if (p) out.push(`<p class="say">${esc(p)}</p>`);
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("```")) (code ?? prose).push(line);
    else if (code) out.push(`<pre class="code">${esc(code.join("\n"))}</pre>`), (code = undefined);
    else flush(), (code = []);
  }
  if (code) out.push(`<pre class="code">${esc(code.join("\n"))}</pre>`);
  flush();
  return out.join("");
}

type Edit = { old_string?: unknown; new_string?: unknown };

/** Edit, MultiEdit and Write as removed (-) then added (+) lines: a listing, not a minimal diff. */
export function diffHtml(name: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const lines = (sign: "-" | "+", v: unknown) =>
    str(v) ? str(v).split("\n").map((l) => `<span class="${sign === "-" ? "del" : "add"}">${sign} ${esc(l)}</span>`) : [];
  const hunk = (e: Edit) => `<pre class="diff">${[...lines("-", e.old_string), ...lines("+", e.new_string)].join("")}</pre>`;
  if (name === "Edit") return hunk(i);
  if (name === "MultiEdit" && Array.isArray(i.edits)) return (i.edits as (Edit | null)[]).map((e) => hunk(e ?? {})).join("");
  if (name === "Write") return hunk({ new_string: i.content });
}

/** The expanded body of a tool card, above its result. */
export function inputHtml(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash") return `<pre class="code">$ ${esc(str(i.command))}</pre>`;
  if (isAgent(name)) return `<pre class="code">${esc(str(i.prompt))}</pre>`;
  const diff = diffHtml(name, input);
  if (diff !== undefined) return `<p class="path">${esc(str(i.file_path))}</p>${diff}`;
  return `<pre class="code">${esc(JSON.stringify(input, null, 2))}</pre>`;
}

export function bytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function resultHtml(r: Extract<ChatEntry, { kind: "result" }>): string {
  const note = r.truncated ? `<p class="note">Result truncated (${bytes(r.truncated)})</p>` : "";
  return `<pre class="out${r.isError ? " err" : ""}">${esc(r.text) || "(no output)"}</pre>${note}`;
}

/** Entries already shown, by uuid, so a reconnect that resends the backlog adds nothing twice. */
export class Seen {
  private ids = new Set<string>();

  fresh(entries: ChatEntry[]): ChatEntry[] {
    return entries.filter((e) => !this.ids.has(e.uuid) && !!this.ids.add(e.uuid));
  }

  clear(): void {
    this.ids.clear();
  }
}

export type MenuCommand = Command & { builtin?: true };
const MENU_MAX = 50;

/** What to filter the "/" menu by, while the whole message is a lone `/word`. */
export function menuQuery(text: string): string | undefined {
  return /^\/(\S*)$/.exec(text)?.[1];
}

/** Names that start with the query first, then those whose part after a "plugin:" prefix does, then other matches; each group A–Z. */
export function matchCommands(query: string, list: MenuCommand[]): MenuCommand[] {
  const q = query.toLowerCase();
  const rank = (c: MenuCommand) => {
    const name = c.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.split(":").at(-1)!.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
  };
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((m) => m.r < 3)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .slice(0, MENU_MAX)
    .map((m) => m.c);
}

/** The session's commands plus the built-ins the transcript doesn't list. */
export function allCommands(session: Command[]): MenuCommand[] {
  const names = new Set(session.map((c) => c.name));
  return [...session, ...BUILTIN_COMMANDS.filter((c) => !names.has(c.name)).map((c) => ({ ...c, builtin: true as const }))];
}

export function menuHtml(list: MenuCommand[], active: number): string {
  return list
    .map(
      (c, i) =>
        `<li role="option" id="chat-cmd-${i}" data-i="${i}" aria-selected="${i === active}"><span class="cmd">/${esc(c.name)}</span><span class="desc">${esc(c.description)}</span>${c.builtin ? `<span class="tag">built-in</span>` : ""}</li>`,
    )
    .join("");
}

/** Why this bot can't be sent to right now. `readOnly`: typing is pointless too, not just sending. */
export function sendBlock(bot: Bot | undefined): { reason: string; readOnly: boolean } | undefined {
  if (!bot) return { reason: "This session has ended.", readOnly: true };
  if (!bot.terminal) return { reason: "Read-only: Hamlet can't find this session's terminal.", readOnly: true };
  if (bot.terminal.kind !== "cmux") return { reason: "Read-only: sending works for cmux sessions only. This one runs in Windows Terminal.", readOnly: true };
  // Waiting with no request held still means a dialog may be open in the terminal.
  if (bot.permission || bot.state === "needs_input") return { reason: "Answer the WAITING prompt first.", readOnly: false };
}

/** A path that fits `max` characters: whole trailing folders after "…/", as the end is the part that tells sessions apart. */
export function shortPath(path: string, max = 40): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let tail = parts.pop()!;
  // parts[0] is the empty root of an absolute path; it never joins the tail.
  while (parts.length > 1 && `…/${parts.at(-1)}/${tail}`.length <= max) tail = `${parts.pop()}/${tail}`;
  const out = `…/${tail}`;
  return out.length <= max ? out : `…${out.slice(out.length - max + 1)}`;
}
