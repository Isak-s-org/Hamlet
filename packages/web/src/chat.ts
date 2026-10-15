// The chat sheet: a session's conversation, read live from its transcript through the daemon, and
// a composer that types into the session's cmux surface. It sits beside the village, which stays
// usable. Entries are only ever appended; tool cards build their bodies when first opened, so a
// long session stays light.
import { API_PREFIX, SEND_CAP, type Bot, type ChatEntry, type ChatEvent, type Command, type Subagent } from "@hamlet/shared/world";
import {
  allCommands,
  esc,
  inputHtml,
  isAgent,
  matchCommands,
  menuHtml,
  menuQuery,
  prose,
  resultHtml,
  Seen,
  sendBlock,
  subagentHtml,
  tailSplit,
  toolSummary,
  type MenuCommand,
} from "./chat-format.js";
import { collapse, enter, expand, slideIn, slideOut } from "./motion.js";
import { answersFor, decide, pick, questionsHtml, questionsOf, setOther } from "./questions.js";

type Tool = Extract<ChatEntry, { kind: "tool" }>;
type Result = Extract<ChatEntry, { kind: "result" }>;

const root = document.querySelector<HTMLElement>(".chat")!;
/** Entries handled per animation frame, so a long backlog never freezes the tab. */
const PER_FRAME = 200;
/** Top-level entries drawn when a chat opens, and per step when scrolling back. */
const TAIL = 150;

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
/** The backlog above what's drawn, oldest first; scrolling near the top draws more of it. */
let older: ChatEntry[] = [];
let backlogTimer: ReturnType<typeof setTimeout> | undefined;
/** The sheet waits for its first entries before sliding in, so it arrives filled. */
let slideTimer: ReturnType<typeof setTimeout> | undefined;
let sliding = false;
let scheduled = false;
let frame = 0;
let following = true;
/** Off until the backlog is drawn: only entries that arrive after it animate in. */
let live = false;
/** The sheet is sliding away: its stream is already shut, and it counts as closed. */
let closing = false;
/** Unsent text per session, so closing the chat to answer a prompt keeps it. */
const drafts = new Map<string, string>();
/** The session's "/" commands, from its transcript. */
let commands: Command[] = [];
/** The chat's bot as of the last update; undefined once its session has ended. */
let current: Bot | undefined;
/** The chat's cmux surface, kept after its session ends: /clear starts the next session in it. */
let surface: string | undefined;
/** Messages typed while Claude works, waiting for the turn to take them. */
let inQueue: string[] = [];
/** The message on its way, and its session: the chat can close and reopen before cmux answers. */
let inFlight: { id: string; text: string } | undefined;
let menu: MenuCommand[] = [];
let active = 0;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
/** The request the question card shows, and what went wrong answering it. */
let asked: number | undefined;
let askError = "";
const TOO_LONG = `Too long to send (max ${SEND_CAP / 1024} KB).`;
/** From this sheet width, subagents get their own column and their lines leave the Agent cards. */
const TWO_MIN = 900;
const WIDTH_KEY = "hamlet.chatWidth";
/** Sheet wide enough for the subagent column: subagent entries go to `subEntries`, not the log. */
let two = false;
let subagents: Subagent[] = [];
/** Each subagent's entries, by the Agent call that started it. */
const subEntries = new Map<string, ChatEntry[]>();
/** The Agent call whose subagent the column shows. */
let selected: string | undefined;
let subFollowing = true;
/** Running subagents' durations tick while the sheet is open. */
let ticker: ReturnType<typeof setInterval> | undefined;

export const chatOpen = () => !root.hidden && !closing;
export const chatSession = () => (chatOpen() ? sessionId : undefined);
export const chatSurface = () => (chatOpen() ? surface : undefined);

let width = (() => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || (innerWidth >= 1600 ? 1120 : 560);
  } catch {
    return 560;
  }
})();
/** Room for the sheet that still leaves some village beside it. */
const clampWidth = (w: number) => Math.round(Math.max(380, Math.min(w, innerWidth - 240)));
/** The sheet's width, or 0 on a narrow screen, where it covers everything and the village needs no room. */
const sheetWidth = () => (innerWidth < 720 ? 0 : clampWidth(width));
let hooks: { inset(px: number): void; loadMarkdown(): void } = { inset() {}, loadMarkdown() {} };
/** main.ts owns the world: the sheet tells it how much of the view it covers. */
export const setChatHooks = (h: typeof hooks) => void (hooks = h);
addEventListener("resize", () => chatOpen() && applyWidth() && reload());

/** Sizes the sheet to `width`. Returns whether that moved it across the two-column width. */
function applyWidth(): boolean {
  const w = sheetWidth();
  setSheet(w);
  const was = two;
  two = w >= TWO_MIN;
  renderSide();
  return two !== was;
}

function setSheet(w: number): void {
  root.parentElement!.style.setProperty("--sheet", w ? `${w}px` : "100%");
  root.querySelector(".grip")?.setAttribute("aria-valuenow", String(w));
  hooks.inset(w);
}

/** Drag the sheet's left edge, or focus it and use the arrow keys. The width is kept for next time. */
function resizable(grip: HTMLElement): void {
  const done = () => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {} // a private window keeps the width for this visit only
    if (applyWidth()) reload();
  };
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    root.classList.add("resizing");
    // Only the width follows the pointer; the columns change on release, which redraws the log.
    const move = (m: PointerEvent) => setSheet((width = clampWidth(innerWidth - m.clientX)));
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", () => {
      grip.removeEventListener("pointermove", move);
      root.classList.remove("resizing");
      done();
    }, { once: true });
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    width = clampWidth(sheetWidth() + (e.key === "ArrowLeft" ? 40 : -40));
    done();
  });
}

/** Like iOS, a scroller in the sheet shows its scrollbar only while it moves. Scroll doesn't bubble, so this listens in capture. */
const scrollTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
root.addEventListener("scroll", (e) => {
  const el = e.target as HTMLElement;
  el.classList.add("scrolling");
  clearTimeout(scrollTimers.get(el));
  scrollTimers.set(el, setTimeout(() => el.classList.remove("scrolling"), 800));
}, true);

/** Opens the sheet on `bot`, or switches an open sheet to it in place. Focus stays put, so the village's keys keep working. */
export function openChat(bot: Bot, name: string): void {
  if (chatOpen() && sessionId === bot.sessionId) return updateChat(bot, name);
  // Mid-slide-out the sheet still has its DOM: it turns around instead of being rebuilt.
  const arriving = root.hidden || closing;
  const closingBefore = closing;
  if (root.hidden) build();
  closing = root.inert = false;
  root.hidden = false;
  root.classList.remove("empty");
  root.parentElement!.classList.add("sheet");
  hooks.loadMarkdown();
  applyWidth();
  show(bot, name);
  if (!arriving) return;
  // Mid-slide-out it turns around at once; otherwise it waits off-screen for its entries, briefly.
  if (closingBefore) return void slideIn(root);
  root.style.transform = "translateX(100%)";
  sliding = true;
  slideTimer = setTimeout(arrive, 150);
}

/** The sheet's DOM and its listeners, built once per opening. */
function build(): void {
  root.innerHTML = `<div class="grip" role="separator" aria-orientation="vertical" aria-label="Chat width" aria-valuemin="380" tabindex="0"></div>
    <header>
      <span class="dot"></span>
      <span class="head"><span class="repo"></span><span class="subtitle"></span></span>
      <button class="pill" data-act="chat-close" hidden></button>
      <button class="ghost" data-act="chat-close" aria-label="Close">ESC</button>
    </header>
    <div class="pane">
      <div class="log" tabindex="0"></div>
      <button class="jump primary" data-act="chat-jump" hidden>↓ NEW MESSAGES</button>
    </div>
    <p class="none">No session selected</p>
    <p class="note" hidden></p>
    <section class="ask" aria-label="Question" hidden></section>
    <form class="composer">
      <ul class="menu" id="chat-menu" role="listbox" aria-label="Commands" hidden></ul>
      <div class="queued" hidden>
        <div class="top"><span class="label">QUEUED</span><button class="outline" type="button" data-key="send-now" title="Interrupt Claude and send the queued messages now">SEND NOW</button></div>
        <ol></ol>
      </div>
      <div class="card">
        <div class="top"><span class="label">MESSAGE</span><span class="hints">⏎ SEND · ⇧⏎ NEW LINE · / COMMANDS</span></div>
        <textarea rows="1" role="combobox" aria-label="Message" aria-controls="chat-menu" aria-autocomplete="list" aria-expanded="false" placeholder="Message this session"></textarea>
        <div class="foot"><p class="status" aria-live="polite"></p><button class="outline" type="button" data-key="stop" title="Interrupt Claude's turn, like Esc in the terminal" hidden>■ STOP</button><button class="primary" type="submit">[⏎] SEND</button></div>
      </div>
    </form>
    <aside class="side" hidden>
      <ol class="subs" aria-label="Subagents"></ol>
      <div class="sublog" tabindex="0"></div>
    </aside>`;
  resizable(root.querySelector<HTMLElement>(".grip")!);
  root.querySelector(".subs")!.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-sub]");
    if (row) select(row.dataset.sub!);
  });
  const sub = root.querySelector<HTMLElement>(".sublog")!;
  sub.addEventListener("scroll", () => (subFollowing = sub.scrollHeight - sub.scrollTop - sub.clientHeight < 40));
  clearInterval(ticker);
  ticker = setInterval(() => subagents.some((s) => helperOf(s)) && renderSide(), 1000);
  const el = root.querySelector<HTMLElement>(".log")!;
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) el.addEventListener(type, () => (touched = true), { passive: true });
  el.addEventListener("scroll", () => {
    if (el.scrollTop < 400) drawOlder();
    following = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (following) root.querySelector<HTMLElement>(".jump")!.hidden = true;
  });
  const ta = textarea()!;
  ta.addEventListener("input", () => {
    if (sessionId) drafts.set(sessionId, ta.value);
    grow();
    refreshMenu();
    refreshComposer();
  });
  ta.addEventListener("keydown", composerKey);
  root.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  for (const b of root.querySelectorAll<HTMLButtonElement>(".composer [data-key]")) b.addEventListener("click", () => void press(b.dataset.key!));
  // mousedown, not click: the textarea keeps focus.
  root.querySelector(".menu")!.addEventListener("mousedown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("li[data-i]");
    if (!row) return;
    e.preventDefault();
    complete(Number(row.dataset.i));
  });
  const ask = root.querySelector<HTMLElement>(".ask")!;
  ask.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ask]");
    const p = current?.permission;
    const qs = questionsOf(p);
    if (!b || !p || !qs) return;
    if (b.dataset.ask !== "pick") return void answerQuestion(b.dataset.ask as "allow" | "deny");
    const [i, j] = b.dataset.arg!.split(":").map(Number) as [number, number];
    const other = pick(p, qs, i, j);
    renderAsk(true);
    if (other) ask.querySelector<HTMLInputElement>(`input[data-q="${i}"]`)?.focus();
  });
  // Typing in "Other" updates the picks in place; a rebuild would steal focus.
  ask.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const p = current?.permission;
    const qs = questionsOf(p);
    if (!p || !qs || input.dataset.q === undefined) return;
    setOther(p, qs, Number(input.dataset.q), input.value);
    ask.querySelector<HTMLButtonElement>('[data-ask="allow"]')!.disabled = !answersFor(p, qs);
  });
  ask.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.matches("input.other")) return;
    if (e.key === "Enter") void answerQuestion("allow");
    else if (e.key === "Escape") t.blur();
  });
}

/** Points the built sheet at `bot`: a fresh log, its draft, its header and its stream. */
function show(bot: Bot, name: string): void {
  disconnect();
  sessionId = bot.sessionId;
  selected = undefined;
  log = root.querySelector<HTMLElement>(".log")!;
  log.innerHTML = "";
  showNote("");
  setStatus("");
  const ta = textarea()!;
  ta.value = drafts.get(bot.sessionId) ?? "";
  ta.readOnly = inFlight?.id === bot.sessionId;
  updateChat(bot, name);
  connect(bot.sessionId);
  grow();
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
  // Shut at once, but stays on screen (and lets clicks through) until it has slid away.
  closing = root.inert = true;
  sliding = false;
  clearTimeout(slideTimer);
  root.parentElement!.classList.remove("sheet");
  hooks.inset(0);
  clearInterval(ticker);
  void slideOut(root).then((done) => {
    if (!done) return; // reopened mid-close: openChat has the sheet now
    closing = root.inert = false;
    root.hidden = true;
    root.innerHTML = "";
  });
}

/** Leaves the open sheet empty: no session is selected. */
export function emptyChat(): void {
  if (!chatOpen()) return;
  disconnect();
  current = surface = undefined;
  root.classList.add("empty");
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

/** Draws the session again from a fresh stream, for when subagent lines move between the log and the column. */
function reload(): void {
  const id = sessionId;
  if (!id) return;
  source?.close();
  clearTimeout(retry);
  reset();
  connect(id);
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
  pill.title = questionsOf(bot?.permission) ? "Answer the question below" : "Answer in the bubble above the bot";
  current = bot;
  if (bot) surface = bot.terminal?.kind === "cmux" ? bot.terminal.surfaceId : undefined;
  refreshComposer();
  renderAsk();
  // Which subagents run, and what they do, comes with the bot.
  renderSide();
}

/** A held question replaces the composer with its options, rebuilt only for a new request or a pick. */
function renderAsk(force = false): void {
  const el = root.querySelector<HTMLElement>(".ask");
  if (!el) return;
  const p = current?.permission;
  const qs = questionsOf(p);
  el.hidden = !qs;
  root.querySelector<HTMLElement>(".composer")!.hidden = !!qs;
  if (!p || !qs) return void (asked = undefined);
  if (asked === p.id && !force) return;
  if (asked !== p.id) askError = "";
  asked = p.id;
  const scroll = el.querySelector(".questions")?.scrollTop ?? 0;
  el.innerHTML = `<div class="card"><div class="top"><span class="label">QUESTION</span></div>
    <div class="questions">${questionsHtml(p, qs)}</div>
    <div class="foot"><p class="status error">${esc(askError)}</p>
      <button class="outline" type="button" data-ask="deny">[D] DECLINE</button>
      <button class="primary" type="button" data-ask="allow" ${answersFor(p, qs) ? "" : "disabled"}>[A] ANSWER</button></div></div>`;
  el.querySelector(".questions")!.scrollTop = scroll;
}

/** Answers the held question with the picks, or declines it. */
export async function answerQuestion(behavior: "allow" | "deny"): Promise<void> {
  const p = current?.permission;
  const qs = questionsOf(p);
  if (!p || !qs) return;
  const answers = behavior === "allow" ? answersFor(p, qs) : undefined;
  if (behavior === "allow" && !answers) return;
  askError = (await decide({ id: p.id, behavior, ...(answers && { answers }) })) ?? "";
  if (askError && asked === p.id) renderAsk(true);
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
  subEntries.clear();
  subagents = [];
  const sub = root.querySelector(".sublog");
  if (sub) sub.innerHTML = "";
  renderSide();
  commands = [];
  closeMenu();
  inQueue = [];
  renderQueue();
  queue = [];
  older = [];
  clearTimeout(backlogTimer);
  // A frame asked for by the previous session would draw this one's backlog as live entries.
  cancelAnimationFrame(frame);
  scheduled = false;
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
  if ("queued" in e) return (inQueue = e.queued), renderQueue();
  if ("subagents" in e) return (subagents = e.subagents), renderSide();
  if ("commands" in e) {
    commands = e.commands;
    return refreshMenu();
  }
  if ("error" in e)
    return showNote(e.error === "no-transcript" ? "Waiting for this session's transcript…" : "Couldn't read this session's transcript. The daemon log has the error.");
  showNote("");
  for (const entry of seen.fresh(e.entries)) {
    if (two && entry.parent) stash(entry);
    else queue.push(entry);
  }
  // The backlog arrives as several messages at once: wait for the last before drawing its tail.
  if (!live) clearTimeout(backlogTimer), (backlogTimer = setTimeout(drain, 30)), (scheduled = true);
  else if (!scheduled) (scheduled = true), (frame = requestAnimationFrame(drain));
}

function drain(): void {
  scheduled = false;
  if (!log) return;
  if (!live) return drawBacklog();
  const batch = queue.splice(0, PER_FRAME);
  enter(batch.flatMap((entry) => place(entry)));
  if (following) log.scrollTop = log.scrollHeight;
  else if (batch.length) root.querySelector<HTMLElement>(".jump")!.hidden = false;
  if (queue.length) (scheduled = true), (frame = requestAnimationFrame(drain));
}

/** The backlog's last entries, all at once and pinned to the end; the rest waits in `older`. */
function drawBacklog(): void {
  const split = tailSplit(queue, TAIL);
  older = split.older;
  queue = [];
  split.tail.forEach((entry) => place(entry));
  live = true;
  touched = false;
  settle();
  // A short tail leaves nothing to scroll, and so nothing to ask for more.
  while (older.length && log!.scrollHeight <= log!.clientHeight) drawOlder();
  if (sliding) requestAnimationFrame(arrive);
}

/**
 * Entries off screen are laid out at an estimated height (content-visibility), so the end moves as
 * the ones near it render for real. Stay on it for a moment, unless the reader takes over: the
 * scroll events of these jumps arrive after the growth, so they can't tell.
 */
let touched = false;
function settle(frames = 30): void {
  if (!log || touched || !frames) return;
  jumpToEnd();
  requestAnimationFrame(() => settle(frames - 1));
}

/** Draws the next stretch of the backlog above the log without moving what's on screen. */
function drawOlder(): void {
  if (!log || !older.length) return;
  const split = tailSplit(older, TAIL);
  older = split.older;
  const box = document.createDocumentFragment();
  // Subagent lines already waiting for a card in this stretch are newer than the stretch's own:
  // they go in after it, not before.
  const waiting = new Map(orphans);
  orphans.clear();
  split.tail.forEach((entry) => place(entry, box));
  for (const [parent, entries] of waiting)
    if (cards.has(parent)) entries.forEach((entry) => place(entry));
    else orphans.set(parent, [...(orphans.get(parent) ?? []), ...entries]);
  const height = log.scrollHeight;
  log.prepend(box);
  log.scrollTop += log.scrollHeight - height;
}

function arrive(): void {
  clearTimeout(slideTimer);
  if (!sliding) return;
  sliding = false;
  void slideIn(root);
}

/** Puts an entry on screen and returns the elements it added; a result only fills its card. */
function place(entry: ChatEntry, into: ParentNode = log!): HTMLElement[] {
  if (entry.kind === "result") {
    results.set(entry.toolUseId, entry);
    fillResult(entry.toolUseId);
    return [];
  }
  const parent = entry.parent ? cards.get(entry.parent) : undefined;
  if (entry.parent && !parent) return orphans.set(entry.parent, [...(orphans.get(entry.parent) ?? []), entry]), [];
  const el = element(entry);
  (parent?.el.querySelector<HTMLElement>(".sub") ?? into).append(el);
  if (entry.kind !== "tool") return [el];
  const placed = [el, ...(orphans.get(entry.id) ?? []).flatMap((o) => place(o))];
  orphans.delete(entry.id);
  fillResult(entry.id);
  return placed;
}

function element(entry: Exclude<ChatEntry, Result>): HTMLElement {
  if (entry.kind === "tool") return toolCard(entry);
  const el = document.createElement(entry.kind === "thinking" ? "details" : "div");
  if (entry.kind === "prompt") (el.className = "prompt"), (el.innerHTML = `<span class="caret">&gt;</span><p>${esc(entry.text)}</p>`);
  else if (entry.kind === "text") (el.className = "reply"), (el.innerHTML = prose(entry.text));
  else if (entry.kind === "thinking") (el.className = "thinking"), (el.innerHTML = `<summary>Thinking</summary><div class="body"><p class="say">${esc(entry.text)}</p></div>`), disclose(el as HTMLDetailsElement);
  // Multi-line notices are command output (/context, /cost): keep its layout.
  else if (entry.text.includes("\n")) (el.className = `output ${entry.level}`), (el.innerHTML = `<pre>${esc(entry.text)}</pre>`);
  else (el.className = `notice ${entry.level}`), (el.innerHTML = `<span>${esc(entry.text)}</span>`);
  return el;
}

function toolCard(tool: Tool): HTMLDetailsElement {
  const el = document.createElement("details");
  el.className = two && tool.id === selected ? "tool picked" : "tool";
  el.dataset.state = "running";
  // In two columns an Agent card opens its subagent there; in one, the subagent's lines nest in it.
  const agent = isAgent(tool.name);
  el.innerHTML = `<summary>${agent && two ? `<button type="button" class="open">OPEN ›</button>` : ""}<span class="name">${esc(tool.name)}</span> <span class="what">${esc(toolSummary(tool.name, tool.input))}</span><span class="status"></span></summary><div class="body"><div class="input"></div>${agent && !two ? `<div class="sub"></div>` : ""}<div class="result"></div></div>`;
  el.querySelector(".open")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    select(tool.id);
  });
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

/** Keeps a subagent entry for the column, and draws it there when its subagent is the one shown. */
function stash(entry: ChatEntry): void {
  const list = subEntries.get(entry.parent!) ?? [];
  if (!list.length) subEntries.set(entry.parent!, list);
  list.push(entry);
  if (entry.parent !== selected) return;
  const els = placeSub(entry);
  if (live) enter(els);
  const sub = root.querySelector<HTMLElement>(".sublog")!;
  if (subFollowing) sub.scrollTop = sub.scrollHeight;
}

/** Like place(), into the subagent column: its own Agent calls are cards with an OPEN of their own. */
function placeSub(entry: ChatEntry): HTMLElement[] {
  if (entry.kind === "result") {
    results.set(entry.toolUseId, entry);
    fillResult(entry.toolUseId);
    return [];
  }
  const el = element(entry);
  root.querySelector(".sublog")!.append(el);
  if (entry.kind === "tool") fillResult(entry.id);
  return [el];
}

/** Shows the subagent started by Agent call `parent` in the column. */
function select(parent: string): void {
  selected = parent;
  const sub = root.querySelector<HTMLElement>(".sublog")!;
  sub.innerHTML = "";
  for (const entry of subEntries.get(parent) ?? []) placeSub(entry);
  sub.scrollTop = sub.scrollHeight;
  subFollowing = true;
  for (const card of root.querySelectorAll(".tool.picked")) card.classList.remove("picked");
  cards.get(parent)?.el.classList.add("picked");
  renderSide();
}

const helperOf = (s: Subagent) => current?.helpers?.find((h) => h.agentId === s.agentId);

/** The column, shown in two-column mode once the session has a subagent: running ones first, newest first. */
function renderSide(): void {
  const side = root.querySelector<HTMLElement>(".side");
  if (!side) return;
  side.hidden = !two || !subagents.length;
  root.classList.toggle("two", !side.hidden);
  if (side.hidden) return;
  const now = Date.now();
  const rows = subagents
    .map((s) => ({ s, helper: helperOf(s) }))
    .sort((a, b) => Number(!!b.helper) - Number(!!a.helper) || (b.s.start ?? "").localeCompare(a.s.start ?? ""));
  // Rebuilt every tick: a focused row gets its focus back.
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".subs [data-sub]")?.dataset.sub;
  const list = side.querySelector<HTMLElement>(".subs")!;
  list.innerHTML = rows
    .map(({ s, helper }) => `<li><button type="button" class="subrow" data-sub="${esc(s.parent)}" aria-pressed="${s.parent === selected}">${subagentHtml(s, helper, now)}</button></li>`)
    .join("");
  if (focused) [...list.querySelectorAll<HTMLElement>("[data-sub]")].find((b) => b.dataset.sub === focused)?.focus();
}

/** Marks the card done or failed, and fills in the result once the card is open. */
function fillResult(toolUseId: string): void {
  const card = cards.get(toolUseId);
  const r = results.get(toolUseId);
  if (!card || !r) return;
  card.el.dataset.state = r.isError ? "error" : "done";
  const slot = card.el.querySelector<HTMLElement>(".result")!;
  if (card.el.open && !slot.innerHTML) slot.innerHTML = resultHtml(r, isAgent(card.tool.name));
}

const textarea = () => root.querySelector<HTMLTextAreaElement>(".composer textarea");

function composerKey(e: KeyboardEvent): void {
  const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;
  if (menu.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      active = (active + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length;
      renderMenu();
    } else if ((e.key === "Tab" || e.key === "Enter") && plain) complete(active);
    else if (e.key === "Escape") closeMenu();
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && plain) {
    e.preventDefault();
    void send();
  } else if (e.key === "Escape") {
    // The village's keys skip text fields: ESC leaves the composer to them.
    e.preventDefault();
    textarea()!.blur();
  } else if ((e.key === "PageUp" || e.key === "PageDown") && log) {
    e.preventDefault();
    log.scrollBy({ top: (e.key === "PageUp" ? -0.9 : 0.9) * log.clientHeight });
  }
}

function grow(): void {
  const ta = textarea();
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

/** Enables what this bot allows, and keeps the reason it can't be sent to on show. */
function refreshComposer(): void {
  const ta = textarea();
  if (!ta) return;
  const block = sendBlock(current);
  ta.disabled = !!block?.readOnly;
  root.querySelector(".composer .label")!.textContent = block?.label ?? "MESSAGE";
  root.querySelector(".composer .card")!.classList.toggle("blocked", !!block);
  root.querySelector<HTMLButtonElement>(".composer [type=submit]")!.disabled = !!block || inFlight?.id === sessionId || !ta.value.trim();
  // Interrupting is for a turn in progress; a waiting one is answered in the bubble.
  for (const b of root.querySelectorAll<HTMLElement>(".composer [data-key]")) b.hidden = !!block || current?.state !== "working";
  if (block) setStatus(block.reason, "sticky");
  else if (root.querySelector<HTMLElement>(".composer .status")?.dataset.kind === "sticky") setStatus("");
  if (ta.disabled && menu.length) closeMenu();
}

function setStatus(text: string, kind: "info" | "error" | "sticky" = "info", fade = false): void {
  const el = root.querySelector<HTMLElement>(".composer .status");
  if (!el) return;
  clearTimeout(statusTimer);
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.toggle("error", kind === "error");
  el.classList.remove("faded");
  if (fade) statusTimer = setTimeout(() => el.classList.add("faded"), 4000);
}

async function send(): Promise<void> {
  const ta = textarea();
  const id = sessionId;
  if (!ta || !id || inFlight?.id === id || sendBlock(current) || !ta.value.trim()) return;
  if (new TextEncoder().encode(ta.value).length > SEND_CAP) return setStatus(TOO_LONG, "error");
  const sent = { id, text: ta.value };
  const queued = current?.state === "working";
  inFlight = sent;
  ta.readOnly = true;
  refreshComposer();
  let status: [string, "info" | "error", boolean];
  try {
    const res = await fetch(`${API_PREFIX}/sessions/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: sent.text }),
    });
    if (res.ok) {
      if (drafts.get(id) === sent.text) drafts.delete(id);
      status = [queued ? "Queued: Claude picks it up after the current step, or SEND NOW." : "Sent.", "info", true];
    } else status = [await failure(res), "error", false];
  } catch {
    status = ["Couldn't reach the daemon.", "error", false];
  }
  if (inFlight === sent) inFlight = undefined;
  // The chat may have closed, or moved to another session, while the request was out. Reopened on
  // this session, it has a new textarea that was filled from the draft: that one gets the outcome.
  const now = textarea();
  if (sessionId !== id || !now) return;
  now.readOnly = false;
  if (status[1] === "info" && now.value === sent.text) now.value = "";
  grow();
  setStatus(...status);
  refreshComposer();
}

function renderQueue(): void {
  const box = root.querySelector<HTMLElement>(".composer .queued");
  if (!box) return;
  box.hidden = !inQueue.length;
  box.querySelector("ol")!.innerHTML = inQueue.map((q) => `<li>${esc(q)}</li>`).join("");
}

/** Presses a key in the session's terminal: "stop" (Esc) or "send-now" (ctrl+enter). */
async function press(key: string): Promise<void> {
  const id = sessionId;
  if (!id) return;
  const res = await fetch(`${API_PREFIX}/sessions/${encodeURIComponent(id)}/key/${key}`, { method: "POST" }).catch(() => undefined);
  if (sessionId !== id) return;
  if (!res) setStatus("Couldn't reach the daemon.", "error");
  else if (!res.ok) setStatus(await failure(res), "error");
  else if (key === "stop") setStatus("Stopped.", "info", true);
}

async function failure(res: Response): Promise<string> {
  switch (res.status) {
    case 400: return "Nothing to send.";
    case 404: return "This session has ended.";
    case 409: return "Answer the WAITING prompt first.";
    case 413: return TOO_LONG;
    case 422: return sendBlock(current)?.reason ?? "This session can't receive messages.";
    case 502: {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      return `Couldn't reach cmux: ${error?.split("\n")[0] || "no answer"}`;
    }
    default: return `Daemon answered ${res.status}.`;
  }
}

function refreshMenu(): void {
  const ta = textarea();
  const q = ta && !ta.disabled ? menuQuery(ta.value) : undefined;
  const was = menu[active]?.name;
  menu = q === undefined ? [] : matchCommands(q, allCommands(commands));
  // Keep the highlight on the same command while the list narrows.
  active = Math.max(0, menu.findIndex((c) => c.name === was));
  renderMenu();
}

function closeMenu(): void {
  menu = [];
  renderMenu();
}

function renderMenu(): void {
  const el = root.querySelector<HTMLElement>(".menu");
  const ta = textarea();
  if (!el || !ta) return;
  el.hidden = !menu.length;
  el.innerHTML = menuHtml(menu, active);
  ta.setAttribute("aria-expanded", String(menu.length > 0));
  if (!menu.length) return ta.removeAttribute("aria-activedescendant");
  ta.setAttribute("aria-activedescendant", `chat-cmd-${active}`);
  el.querySelector(`#chat-cmd-${active}`)?.scrollIntoView({ block: "nearest" });
}

/** Puts the command in the box with a space after it, so arguments can follow before Enter sends. */
function complete(i: number): void {
  const ta = textarea();
  const c = menu[i];
  if (!ta || !c) return;
  ta.value = `/${c.name} `;
  if (sessionId) drafts.set(sessionId, ta.value);
  closeMenu();
  grow();
  refreshComposer();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
