// AskUserQuestion requests: what the user has picked so far, the options as the chat shows them,
// and sending a decision on any held request.
import { API_PREFIX, type Decision, type PendingPermission, type Question } from "@hamlet/shared/world";
import { esc } from "./chat-format.js";

export const questionsOf = (p?: PendingPermission): Question[] | undefined =>
  p?.toolName === "AskUserQuestion" ? (((p.toolInput ?? {}) as { questions?: Question[] }).questions ?? []) : undefined;

/** What the user has picked so far, per held request: option labels per question, plus "Other" text. */
type Picks = { chosen: Set<string>[]; other: string[] };
const OTHER = "\0other";
const picks = new Map<number, Picks>();

function picksFor(p: PendingPermission, qs: Question[]): Picks {
  let s = picks.get(p.id);
  if (!s) picks.set(p.id, (s = { chosen: qs.map(() => new Set()), other: qs.map(() => "") }));
  return s;
}

/** Forgets the picks of requests no longer held. A restarted daemon reuses ids, so a reconnect passes none. */
export function prunePicks(held: number[]): void {
  for (const id of picks.keys()) if (!held.includes(id)) picks.delete(id);
}

/** Answers keyed by question text, multi-select labels joined with ", ", or undefined while one is missing. */
export function answersFor(p: PendingPermission, qs: Question[]): Record<string, string> | undefined {
  const s = picksFor(p, qs);
  const out: Record<string, string> = {};
  for (const [i, q] of qs.entries()) {
    const labels = q.options.map((o) => o.label).filter((l) => s.chosen[i]!.has(l));
    if (s.chosen[i]!.has(OTHER) && s.other[i]!.trim()) labels.push(s.other[i]!.trim());
    if (!labels.length) return;
    out[q.question] = labels.join(", ");
  }
  return out;
}

/** Toggles option `j` of question `i`, or "Other" for -1. True when "Other" was just chosen, so its field wants focus. */
export function pick(p: PendingPermission, qs: Question[], i: number, j: number): boolean {
  const q = qs[i];
  const label = j < 0 ? OTHER : q?.options[j]?.label;
  if (!q || label === undefined) return false;
  const chosen = picksFor(p, qs).chosen[i]!;
  if (q.multiSelect) chosen.has(label) ? chosen.delete(label) : chosen.add(label);
  else chosen.clear(), chosen.add(label);
  return label === OTHER && chosen.has(OTHER);
}

export const setOther = (p: PendingPermission, qs: Question[], i: number, text: string) => void (picksFor(p, qs).other[i] = text);

/** Each question with its options, plus "Other", marked with what's picked. */
export function questionsHtml(p: PendingPermission, qs: Question[]): string {
  const s = picksFor(p, qs);
  return qs
    .map((q, i) => {
      const opt = (j: number, label: string, desc = "") =>
        `<button type="button" class="opt" role="${q.multiSelect ? "checkbox" : "radio"}" aria-checked="${s.chosen[i]!.has(j < 0 ? OTHER : label)}" data-ask="pick" data-arg="${i}:${j}">
          <b>${esc(label)}</b>${desc ? `<span>${esc(desc)}</span>` : ""}</button>`;
      return `<div class="q" role="group" aria-label="${esc(q.header || q.question)}">
        <span class="kicker">${esc(q.header)}${q.multiSelect ? " · PICK ANY" : ""}</span>
        <p>${esc(q.question)}</p>
        <div class="opts">${q.options.map((o, j) => opt(j, o.label, o.description)).join("")}${opt(-1, "Other", "Type your own answer")}</div>
        ${s.chosen[i]!.has(OTHER) ? `<input class="other" data-q="${i}" placeholder="Your answer" maxlength="2000" value="${esc(s.other[i]!)}">` : ""}
      </div>`;
    })
    .join("");
}

/** Sends a decision on a held request; resolves to what went wrong, if anything. */
export async function decide(decision: Decision): Promise<string | undefined> {
  try {
    const res = await fetch(`${API_PREFIX}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    if (res.status === 404) return "That request was already answered or cancelled.";
    if (!res.ok) return `Daemon answered ${res.status}.`;
  } catch {
    return "Couldn't reach the daemon.";
  }
}
