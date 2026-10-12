// Pure helpers for the chat view: what a tool card says, and the HTML for text, diffs and results.
// Transcript content is untrusted, so every string goes through esc() before it becomes HTML.
import type { ChatEntry } from "@hamlet/shared/world";

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
  if (name === "MultiEdit" && Array.isArray(i.edits)) return (i.edits as Edit[]).map(hunk).join("");
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
