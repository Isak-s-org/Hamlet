// The chat overlay: a session's conversation, read live from its transcript through the daemon.
// Entries are only ever appended; tool cards build their bodies when first opened, so a long
// session stays light.
import { API_PREFIX, type Bot, type ChatEntry, type ChatEvent } from "@hamlet/shared/world";
import { esc, inputHtml, isAgent, resultHtml, Seen, textHtml, toolSummary } from "./chat-format.js";
import { collapse, enter, expand, growFrom, shrinkTo } from "./motion.js";

type Tool = Extract<ChatEntry, { kind: "tool" }>;
type Result = Extract<ChatEntry, { kind: "result" }>;

const root = document.querySelector<HTMLElement>(".chat")!;
/** Entries handled per animation frame, so a long backlog never freezes the tab. */
const PER_FRAME = 200;

let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let sessionId: string | undefined;
let log: HTMLElement | undefined;
const seen = new Seen();
const cards = new Map<string, { el: HTMLDetailsElement; tool: Tool }>();
const results = new Map<string, Result>();
/** Subagent entries whose Agent card isn't on screen yet. */
const orphans = new Map<string, ChatEntry[]>();
let queue: ChatEntry[] = [];
let scheduled = false;
let following = true;
/** Off while the backlog shows: only entries placed after the queue first drains animate in. */
let live = false;
/** The chat is shrinking away: its stream is already shut, and it counts as closed. */
let closing = false;

export const chatOpen = () => !root.hidden && !closing;
export const chatSession = () => (chatOpen() ? sessionId : undefined);

export function openChat(bot: Bot, name: string): void {
  const from = bubbleRect();
  disconnect();
  closing = root.inert = false;
  sessionId = bot.sessionId;
  root.hidden = false;
  root.innerHTML = `<header>
      <span class="dot"></span>
      <span class="head"><span class="repo"></span><span class="subtitle"></span></span>
      <button class="pill" data-act="chat-close" hidden></button>
      <button class="ghost" data-act="chat-close" aria-label="Close">ESC</button>
    </header>
    <div class="log" tabindex="0"></div>
    <p class="note" hidden></p>
    <button class="jump primary" data-act="chat-jump" hidden>↓ NEW MESSAGES</button>`;
  log = root.querySelector<HTMLElement>(".log")!;
  log.addEventListener("scroll", () => {
    following = log!.scrollHeight - log!.scrollTop - log!.clientHeight < 40;
    if (following) root.querySelector<HTMLElement>(".jump")!.hidden = true;
  });
  updateChat(bot, name);
  connect(bot.sessionId);
  log.focus();
  void growFrom(root, from);
}

/** The selected bot's bubble, where the chat grows from and shrinks back to, if it's on screen. */
function bubbleRect(): DOMRect | undefined {
  const bubble = document.querySelector<HTMLElement>(".bubble.open");
  if (!bubble || getComputedStyle(bubble).visibility === "hidden") return;
  const r = bubble.getBoundingClientRect();
  return r.width && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : undefined;
}

function connect(id: string): void {
  const s = (source = new EventSource(`${API_PREFIX}/sessions/${encodeURIComponent(id)}/chat`));
  s.onmessage = (e) => receive(JSON.parse(e.data) as ChatEvent);
  // A non-200 reply (the daemon is down or restarting) closes the stream for good: open a new one.
  s.onerror = () => {
    if (s.readyState !== EventSource.CLOSED || source !== s) return;
    showNote("Lost the daemon. Reconnecting…");
    retry = setTimeout(() => connect(id), 2000);
  };
}

export function closeChat(): void {
  if (!chatOpen()) return;
  disconnect();
  // Shut at once, but stays on screen (and lets clicks through) until it has shrunk away.
  closing = root.inert = true;
  void shrinkTo(root, bubbleRect()).then((done) => {
    if (!done) return; // reopened mid-close: openChat has the overlay now
    closing = root.inert = false;
    root.hidden = true;
    root.innerHTML = "";
  });
}

/** Ends the stream and forgets the session's entries, leaving the overlay's DOM to the caller. */
function disconnect(): void {
  source?.close();
  source = undefined;
  clearTimeout(retry);
  sessionId = undefined;
  log = undefined;
  reset();
}

/** Header only: the name, place, title and state can change while the chat is open. */
export function updateChat(bot: Bot | undefined, name: string): void {
  const header = root.querySelector("header");
  if (!header) return;
  header.className = bot?.state ?? "ended";
  header.querySelector(".repo")!.innerHTML = bot ? `${esc(name)} <span class="branch">${esc(bot.repo)} / ${esc(bot.branch)}</span>` : `${esc(name)} <span class="branch">ended</span>`;
  header.querySelector(".subtitle")!.textContent = bot?.title ?? "";
  const pill = header.querySelector<HTMLElement>(".pill")!;
  pill.hidden = bot?.state !== "needs_input";
  pill.textContent = bot?.permission ? `WAITING · ${bot.permission.toolName}` : "WAITING";
  pill.title = "Close the chat to answer in the bubble";
}

export function jumpToEnd(): void {
  if (!log) return;
  log.scrollTop = log.scrollHeight;
  following = true;
  root.querySelector<HTMLElement>(".jump")!.hidden = true;
}

function reset(): void {
  if (log) log.innerHTML = "";
  seen.clear();
  cards.clear();
  results.clear();
  orphans.clear();
  queue = [];
  live = false;
  // A cleared log starts pinned to the end again.
  following = true;
  const jump = root.querySelector<HTMLElement>(".jump");
  if (jump) jump.hidden = true;
}

function showNote(text: string): void {
  const note = root.querySelector<HTMLElement>(".note");
  if (!note) return;
  note.hidden = !text;
  note.textContent = text;
}

function receive(e: ChatEvent): void {
  if ("reset" in e) return reset();
  if ("error" in e)
    return showNote(e.error === "no-transcript" ? "Waiting for this session's transcript…" : "Couldn't read this session's transcript. The daemon log has the error.");
  showNote("");
  for (const entry of seen.fresh(e.entries)) queue.push(entry);
  if (!scheduled) (scheduled = true), requestAnimationFrame(drain);
}

function drain(): void {
  scheduled = false;
  if (!log) return;
  const batch = queue.splice(0, PER_FRAME);
  const placed = batch.flatMap(place);
  // The backlog appears as it is, so even a huge session opens at once.
  if (live) enter(placed);
  if (following) log.scrollTop = log.scrollHeight;
  else if (batch.length) root.querySelector<HTMLElement>(".jump")!.hidden = false;
  if (queue.length) (scheduled = true), requestAnimationFrame(drain);
  else live = true;
}

/** Puts an entry on screen and returns the elements it added; a result only fills its card. */
function place(entry: ChatEntry): HTMLElement[] {
  if (entry.kind === "result") {
    results.set(entry.toolUseId, entry);
    fillResult(entry.toolUseId);
    return [];
  }
  const parent = entry.parent ? cards.get(entry.parent) : undefined;
  if (entry.parent && !parent) return orphans.set(entry.parent, [...(orphans.get(entry.parent) ?? []), entry]), [];
  const el = element(entry);
  (parent?.el.querySelector<HTMLElement>(".sub") ?? log!).append(el);
  if (entry.kind !== "tool") return [el];
  const placed = [el, ...(orphans.get(entry.id) ?? []).flatMap(place)];
  orphans.delete(entry.id);
  fillResult(entry.id);
  return placed;
}

function element(entry: Exclude<ChatEntry, Result>): HTMLElement {
  if (entry.kind === "tool") return toolCard(entry);
  const el = document.createElement(entry.kind === "thinking" ? "details" : "div");
  if (entry.kind === "prompt") (el.className = "prompt"), (el.innerHTML = `<span class="caret">&gt;</span><p>${esc(entry.text)}</p>`);
  else if (entry.kind === "text") (el.className = "reply"), (el.innerHTML = textHtml(entry.text));
  else if (entry.kind === "thinking") (el.className = "thinking"), (el.innerHTML = `<summary>Thinking</summary><div class="body"><p class="say">${esc(entry.text)}</p></div>`), disclose(el as HTMLDetailsElement);
  else (el.className = `notice ${entry.level}`), (el.innerHTML = `<span>${esc(entry.text)}</span>`);
  return el;
}

function toolCard(tool: Tool): HTMLDetailsElement {
  const el = document.createElement("details");
  el.className = "tool";
  el.dataset.state = "running";
  el.innerHTML = `<summary><span class="name">${esc(tool.name)}</span> <span class="what">${esc(toolSummary(tool.name, tool.input))}</span><span class="status"></span></summary><div class="body"><div class="input"></div>${isAgent(tool.name) ? `<div class="sub"></div>` : ""}<div class="result"></div></div>`;
  disclose(el, () => {
    const input = el.querySelector<HTMLElement>(".input")!;
    if (!input.innerHTML) input.innerHTML = inputHtml(tool.name, tool.input);
    fillResult(tool.id);
  });
  cards.set(tool.id, { el, tool });
  return el;
}

/** Animates a <details> open and shut. `fill` builds its body on first open, before it's measured. */
function disclose(el: HTMLDetailsElement, fill = () => {}): void {
  const body = el.querySelector<HTMLElement>(":scope > .body")!;
  let shutting = false;
  el.addEventListener("toggle", () => el.open && fill());
  // Mouse and keyboard both arrive here as a click on the summary. Opening by hand rather than by
  // default lets the body be built and measured before the toggle event, which can come a frame late.
  el.querySelector("summary")!.addEventListener("click", (e) => {
    e.preventDefault();
    if (el.open && !shutting) {
      shutting = true;
      void collapse(body).then((done) => done && ((el.open = false), (shutting = false)));
    } else {
      shutting = false;
      el.open = true;
      fill();
      void expand(body);
    }
  });
}

/** Marks the card done or failed, and fills in the result once the card is open. */
function fillResult(toolUseId: string): void {
  const card = cards.get(toolUseId);
  const r = results.get(toolUseId);
  if (!card || !r) return;
  card.el.dataset.state = r.isError ? "error" : "done";
  const slot = card.el.querySelector<HTMLElement>(".result")!;
  if (card.el.open && !slot.innerHTML) slot.innerHTML = resultHtml(r);
}
