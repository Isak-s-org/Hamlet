// The chat sheet: a session's conversation, read live from its transcript through the daemon, and
// a composer that types into the session's cmux surface. It sits beside the village, which stays
// usable. Entries are only ever appended; tool cards build their bodies when first opened, so a
// long session stays light.
import { API_PREFIX, SEND_CAP, type Bot, type ChatEntry, type ChatEvent, type Command } from "@hamlet/shared/world";
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
  toolSummary,
  type MenuCommand,
} from "./chat-format.js";
import { collapse, enter, expand, slideIn, slideOut } from "./motion.js";

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
/** Unsent text per session, so closing the chat to answer a prompt keeps it. */
const drafts = new Map<string, string>();
/** The session's "/" commands, from its transcript. */
let commands: Command[] = [];
/** The chat's bot as of the last update; undefined once its session has ended. */
let current: Bot | undefined;
/** The message on its way, and its session: the chat can close and reopen before cmux answers. */
let inFlight: { id: string; text: string } | undefined;
let menu: MenuCommand[] = [];
let active = 0;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const TOO_LONG = `Too long to send (max ${SEND_CAP / 1024} KB).`;

export const chatOpen = () => !root.hidden && !closing;
export const chatSession = () => (chatOpen() ? sessionId : undefined);

/** The sheet's width, or 0 on a narrow screen, where it covers everything and the village needs no room. */
const sheetWidth = () => (innerWidth < 720 ? 0 : Math.min(560, innerWidth));
let hooks: { inset(px: number): void; loadMarkdown(): void } = { inset() {}, loadMarkdown() {} };
/** main.ts owns the world: the sheet tells it how much of the view it covers. */
export const setChatHooks = (h: typeof hooks) => void (hooks = h);
addEventListener("resize", () => !root.hidden && !closing && hooks.inset(sheetWidth()));

/**
 * Opens the sheet on `bot`, or switches an open sheet to it in place. `focus`: put the caret in the
 * composer, for an open the user asked for; switching from a map click leaves focus where it is.
 */
export function openChat(bot: Bot, name: string, focus = true): void {
  if (chatOpen() && sessionId === bot.sessionId) return updateChat(bot, name);
  // Mid-slide-out the sheet still has its DOM: it turns around instead of being rebuilt.
  const arriving = root.hidden || closing;
  if (root.hidden) build();
  closing = root.inert = false;
  root.hidden = false;
  root.parentElement!.classList.add("sheet");
  hooks.loadMarkdown();
  show(bot, name);
  hooks.inset(sheetWidth());
  const ta = textarea()!;
  if (focus || arriving) (ta.disabled ? log! : ta).focus();
  if (arriving) void slideIn(root);
}

/** The sheet's DOM and its listeners, built once per opening. */
function build(): void {
  root.innerHTML = `<header>
      <span class="dot"></span>
      <span class="head"><span class="repo"></span><span class="subtitle"></span></span>
      <button class="pill" data-act="chat-close" hidden></button>
      <button class="ghost" data-act="chat-close" aria-label="Close">ESC</button>
    </header>
    <div class="pane">
      <div class="log" tabindex="0"></div>
      <button class="jump primary" data-act="chat-jump" hidden>↓ NEW MESSAGES</button>
    </div>
    <p class="note" hidden></p>
    <form class="composer">
      <ul class="menu" id="chat-menu" role="listbox" aria-label="Commands" hidden></ul>
      <div class="line">
        <textarea rows="1" role="combobox" aria-label="Message" aria-controls="chat-menu" aria-autocomplete="list" aria-expanded="false" placeholder="Message this session. / for commands"></textarea>
        <button class="primary" type="submit">SEND</button>
      </div>
      <p class="status" aria-live="polite"></p>
    </form>`;
  const el = root.querySelector<HTMLElement>(".log")!;
  el.addEventListener("scroll", () => {
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
  // mousedown, not click: the textarea keeps focus.
  root.querySelector(".menu")!.addEventListener("mousedown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("li[data-i]");
    if (!row) return;
    e.preventDefault();
    complete(Number(row.dataset.i));
  });
}

/** Points the built sheet at `bot`: a fresh log, its draft, its header and its stream. */
function show(bot: Bot, name: string): void {
  disconnect();
  sessionId = bot.sessionId;
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
  root.parentElement!.classList.remove("sheet");
  hooks.inset(0);
  void slideOut(root).then((done) => {
    if (!done) return; // reopened mid-close: openChat has the sheet now
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
  current = bot;
  refreshComposer();
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
  commands = [];
  closeMenu();
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
  if ("commands" in e) {
    commands = e.commands;
    return refreshMenu();
  }
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
  else if (entry.kind === "text") (el.className = "reply"), (el.innerHTML = prose(entry.text));
  else if (entry.kind === "thinking") (el.className = "thinking"), (el.innerHTML = `<summary>Thinking</summary><div class="body"><p class="say">${esc(entry.text)}</p></div>`), disclose(el as HTMLDetailsElement);
  // Multi-line notices are command output (/context, /cost): keep its layout.
  else if (entry.text.includes("\n")) (el.className = `output ${entry.level}`), (el.innerHTML = `<pre>${esc(entry.text)}</pre>`);
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
    // The village's keys skip text fields, so the composer closes the chat itself.
    e.preventDefault();
    closeChat();
  } else if ((e.key === "PageUp" || e.key === "PageDown") && log) {
    e.preventDefault();
    log.scrollBy({ top: (e.key === "PageUp" ? -0.9 : 0.9) * log.clientHeight });
  }
}

function grow(): void {
  const ta = textarea();
  if (!ta) return;
  ta.style.height = "auto";
  // border-box: scrollHeight leaves out the 1px borders.
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

/** Enables what this bot allows, and keeps the reason it can't be sent to on show. */
function refreshComposer(): void {
  const ta = textarea();
  if (!ta) return;
  const block = sendBlock(current);
  ta.disabled = !!block?.readOnly;
  root.querySelector<HTMLButtonElement>(".composer button")!.disabled = !!block || inFlight?.id === sessionId || !ta.value.trim();
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
      status = [queued ? "Queued: Claude picks it up after the current step." : "Sent.", "info", true];
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
