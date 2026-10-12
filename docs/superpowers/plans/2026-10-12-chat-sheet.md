# Chat Sheet, Markdown and Village Polish: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the full-screen chat into a smooth right-hand sheet with markdown replies and a themed composer. A selected bot stands still, the bubble's rows are truncated to fit the card, and sidebar repos start expanded.

**Architecture:**
- **All web.** Everything is in `packages/web`.
- **Pure helpers, tested in Node:** `shortPath` and `tailSplit` (in `chat-format.ts`), `mdHtml` (in a new `markdown.ts`), and `slideIn`/`slideOut` (in `motion.ts`).
- **DOM and engine changes,** checked in a browser:
  - `chat.ts`: the sheet, tail-first rendering and the composer card;
  - `main.ts`: non-modal keys, select switches the chat, and the bubble rows;
  - `engine.js` / `creatures.js`: `setInset` and holding the selected bot still.

**Tech Stack:** TypeScript (ESM), Vite 8, plain DOM, three.js (WebGPU) engine in JS, Motion 13, `node:test` through `tsx`. One new dependency: `markdown-it`.

**Spec:** `docs/superpowers/specs/2026-10-12-chat-sheet-design.md`

## Global Constraints

- `markdown-it` is the only new runtime dependency, pinned to an exact version (`14.1.0`), with `@types/markdown-it` (`14.1.2`) as a dev dependency.
- Transcript text never becomes markup. `html: false`; links are checked and get `target="_blank" rel="noopener noreferrer"`; images are never loaded.
- Sheet width: `min(560px, 100%)`. Full width below 720px, with no inset there.
- `TAIL` = 150 entries placed on open. Older entries are prepended within 400px of the top.
- Style follows the surrounding code. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm typecheck` and `pnpm test` pass after every task.

## Review Focus

1. **Markdown that tries to inject:** raw HTML, `javascript:` links, images pointing at remote URLs. Tested in Task 2.
2. **A subagent entry in the tail whose Agent card is in the older part,** and a tool result whose card is older. It must end up inside its card once the older part is prepended, never loose in the log. Tested in Task 4 (`tailSplit`). The rest is held by the existing orphan and result maps.
3. **Switching bots while the sheet is open.** The old stream closes, the draft of each session is kept, and the inset stays the same. Checked by hand in Task 3.
4. **A tiny viewport.** The sheet is full width and the inset is 0, so the village is never squeezed into a sliver. Checked by hand in Task 3.
5. **A long `NOW` or `CWD` value.** It's cut with an ellipsis inside the card, and the full text is in its title. Tested in Task 1 (`shortPath`), checked by hand.

---

### Task 1: Village fixes

**Files:**
- `packages/web/src/world/creatures.js` and `engine.js`;
- `packages/web/src/main.ts`, `style.css`;
- `chat-format.ts` and `chat-format.test.ts`.

**Interfaces:**
- Produces `shortPath(path: string, max = 40): string`.

- [ ] **Step 1: Failing test** in `chat-format.test.ts`:

```ts
test("long paths keep their tail", () => {
  assert.equal(shortPath("/Users/me/x"), "/Users/me/x");
  assert.equal(shortPath("/Users/isak.gerre/Documents/projects/Hamlet/packages/web", 30), "…/projects/Hamlet/packages/web");
  assert.equal(shortPath("/"), "/");
  assert.equal(shortPath("/a/" + "b".repeat(60), 20).length <= 20, true);
});
```

- [ ] **Step 2:** Run `pnpm --filter @hamlet/web test`. Expected: FAIL, because `shortPath` is not exported.

- [ ] **Step 3: Implement `shortPath`.** Add it to `chat-format.ts`. It keeps whole trailing segments that fit after `…/`, and cuts the last segment if even that one is too long:

```ts
/** A path that fits `max` characters: whole trailing folders after "…/", as the end is the part that tells sessions apart. */
export function shortPath(path: string, max = 40): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let tail = parts.pop()!;
  while (parts.length && `…/${parts.at(-1)}/${tail}`.length <= max) tail = `${parts.pop()}/${tail}`;
  const out = `…/${tail}`;
  return out.length <= max ? out : `…${out.slice(out.length - max + 1)}`;
}
```

- [ ] **Step 4: Bubble rows** in `main.ts`, `renderBubble`. Every `kv` row gets the shape `<span class="kv"><span class="k">NOW</span><b title="${esc(full)}">${esc(value)}</b></span>`:
  - `NOW` (the activity);
  - `TOOL`;
  - both `CWD` rows, using `shortPath(cwd)` with the full path in the title. They drop the `.cwd` class in favour of `.kv`.

- [ ] **Step 5: Styles.** Replace the `.kv` and `.cwd` rules in `style.css`:

```css
.kv { display: flex; gap: 12px; min-width: 0; font: 12px var(--mono); color: var(--i-soft); }
.kv .k { flex: none; width: 4ch; }
.kv b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; color: var(--i-ink); }
```

  Keep `.cwd` only if other code still uses it (grep first).

- [ ] **Step 6: Repos start expanded.** In `main.ts`:
  - rename `expanded` to `collapsed`, with `const open = !collapsed.has(repo)`;
  - `toggleRepo` becomes `if (collapsed.delete(repo)) world?.flyToCity(repo); else collapsed.add(repo);`.

- [ ] **Step 7: Selected bot stands still.**
  - In `creatures.js`, `update(dt, t, city, d, slot, camera, held = false)`, and the walking branch becomes `if (next && t >= this.pauseUntil && !held) {`.
  - In `engine.js`, the loop calls `v.update(dt, t, city, d, slots.get(v.data.sessionId) ?? 0, camera, v.data.sessionId === selected)`.
  - Add a comment: a held bot keeps its pose, so its bubble stays readable.

- [ ] **Step 8:** Run `pnpm typecheck` and `pnpm test`. Expected: PASS. Then check in the browser:
  - a selected working bot stops walking;
  - a long `NOW` value is cut with an ellipsis;
  - repos start open.

- [ ] **Step 9: Commit:** `"Hold a selected bot still, fit the bubble's rows, open repos by default"`.

---

### Task 2: Markdown

**Files:**
- `packages/web/package.json` (dependency);
- create `packages/web/src/markdown.ts` and `markdown.test.ts`;
- `chat.ts`, `chat-format.ts`, `style.css`.

**Interfaces:**
- Produces `mdHtml(text: string): string`, from `markdown.ts`.
- `chat-format.ts` gains:
  - `setMarkdown(fn: ((t: string) => string) | undefined)`;
  - `prose(text): string`, which returns `mdHtml(text)` once it's set and `textHtml(text)` until then.

- [ ] **Step 1:** Run `pnpm --filter @hamlet/web add markdown-it@14.1.0` and `pnpm --filter @hamlet/web add -D @types/markdown-it@14.1.2`.

- [ ] **Step 2: Failing tests**, `markdown.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mdHtml } from "./markdown.js";

test("raw HTML stays text", () => {
  const html = mdHtml(`hi <script>alert(1)</script> <img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<script") && !html.includes("<img"), html);
});

test("unsafe links are not links, images never load", () => {
  assert.ok(!mdHtml("[x](javascript:alert(1))").includes("<a"), mdHtml("[x](javascript:alert(1))"));
  const img = mdHtml("![logo](https://example.com/a.png)");
  assert.ok(!img.includes("<img"), img);
  assert.match(img, /<a href="https:\/\/example\.com\/a\.png"[^>]*>logo<\/a>/);
});

test("links open in a new tab without an opener", () => {
  assert.match(mdHtml("[docs](https://example.com)"), /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("Claude's usual markdown renders", () => {
  const html = mdHtml("## Plan\n\n- one\n  - nested\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nline one\nline two");
  for (const bit of ["<h2>", "<ul>", "<table>", '<pre class="code" data-lang="ts">', "const x = 1;", "line one<br>"]) assert.ok(html.includes(bit), bit);
});
```

- [ ] **Step 3:** Run `pnpm --filter @hamlet/web test`. Expected: FAIL, because `./markdown.js` can't be found.

- [ ] **Step 4: Implement** `markdown.ts`:

```ts
// Markdown for Claude's replies and reports. Transcript text is untrusted: raw HTML stays text,
// links are checked by markdown-it and open in a new tab, and images become links so a transcript
// can never make the page fetch anything.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const rules = md.renderer.rules;
const esc = md.utils.escapeHtml;

rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i]!.attrSet("target", "_blank");
  tokens[i]!.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, i, options);
};
rules.image = (tokens, i) => {
  const t = tokens[i]!;
  const src = t.attrGet("src") ?? "";
  const alt = t.content || src;
  return md.validateLink(src) ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(alt)}</a>` : esc(alt);
};
rules.fence = (tokens, i) => {
  const t = tokens[i]!;
  const lang = t.info.trim().split(/\s+/)[0] ?? "";
  return `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(t.content.replace(/\n$/, ""))}</pre>`;
};

export const mdHtml = (text: string): string => md.render(text);
```

  `md.validateLink` is public in markdown-it 14. If the image token's `src` was already refused by the parser, the image is never created, so this check is a second guard.

- [ ] **Step 5:** Run the tests. Expected: PASS. Adjust only the test's expected HTML if markdown-it's serialization differs, for example attribute order, and record a ruling.

- [ ] **Step 6: Wire it in.**
  - In `chat-format.ts`, add:

    ```ts
    let markdown: ((t: string) => string) | undefined;
    export const setMarkdown = (fn) => (markdown = fn);
    export const prose = (t) => (markdown ?? textHtml)(t);
    ```

  - Use `prose` for:
    - `text` entries in `chat.ts` `element()`, which becomes `el.innerHTML = prose(entry.text)`;
    - the results of Agent/Task cards in `resultHtml`, when the card is an agent's (pass `agent: boolean`);
    - an `ExitPlanMode` input in `inputHtml`, as `prose(String(input.plan))`.
  - In `main.ts`, at startup:

    ```ts
    const loadMarkdown = () => import("./markdown.js").then((m) => setMarkdown(m.mdHtml));
    (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1000)))(() => void loadMarkdown());
    ```

    Export `loadMarkdown` for `openChat` to call too. Its promise is cached by the module system.
  - Add a test in `chat-format.test.ts` that `prose` uses `textHtml` until `setMarkdown` is called, then the given function.

- [ ] **Step 7: Styles,** scoped to `.chat .reply` and `.chat .md`. Wrap prose in `<div class="md">`.

```css
.chat .md { display: flex; flex-direction: column; gap: 8px; line-height: 1.55; overflow-wrap: anywhere; }
.chat .md > * { margin: 0; }
.chat .md h1, .chat .md h2, .chat .md h3, .chat .md h4 { font: 600 15px 'Hanken Grotesk', system-ui, sans-serif; margin-top: 6px; }
.chat .md h1 { font-size: 18px; } .chat .md h2 { font-size: 16px; }
.chat .md ul, .chat .md ol { padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
.chat .md li > ul, .chat .md li > ol { margin-top: 2px; }
.chat .md blockquote { padding-left: 10px; border-left: 2px solid var(--i-line); color: var(--i-mid); }
.chat .md code { font: 12px var(--mono); padding: 1px 4px; border-radius: 3px; background: var(--i-code); }
.chat .md pre code { padding: 0; background: none; }
.chat .md pre.code[data-lang]::before { content: attr(data-lang); display: block; margin-bottom: 4px; font: 10px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--i-soft); }
.chat .md .table { overflow-x: auto; }
.chat .md table { border-collapse: collapse; font-size: 13px; }
.chat .md th, .chat .md td { padding: 4px 10px; border: 1px solid var(--i-line); text-align: left; }
.chat .md th { font-weight: 600; background: var(--i-sel); }
.chat .md hr { border: 0; border-top: 1px solid var(--i-line); }
.chat .md a { color: var(--i-amber-t); }
```

  To give wide tables a scroll box, add `rules.table_open = () => '<div class="table"><table>'` and `rules.table_close = () => '</table></div>'` to `markdown.ts`, and extend the table test to expect `<div class="table">`.

- [ ] **Step 8:** Run `pnpm typecheck` and `pnpm test`. Expected: PASS. In the browser, check a reply with a heading, a list, a table and code.

- [ ] **Step 9: Commit:** `"Render Claude's replies as markdown"`.

---

### Task 3: The sheet

**Files:**
- `motion.ts` and `motion.test.ts`;
- `chat.ts`, `main.ts`, `style.css`, `index.html`;
- `world/engine.js` and `engine.d.ts`.

**Interfaces:**
- Produces `slideIn(el): Promise<boolean>` and `slideOut(el): Promise<boolean>`, and `World.setInset(px: number): void`.
- `growFrom`, `shrinkTo` and `insetOf` are removed.
- `openChat(bot, name)` on an open sheet switches session without sliding.
- `chatOpen()` stays.

- [ ] **Step 1: Motion.** In `motion.ts`, replace `insetOf`, `growFrom` and `shrinkTo`:

```ts
/** The sheet slides in from the right edge; mid-slide-out it turns around where it is. */
export function slideIn(el: HTMLElement): Promise<boolean> {
  const from = running.has(el) ? getComputedStyle(el).transform : "translateX(100%)";
  return settle(el, { transform: [from === "none" ? "translateX(100%)" : from, "translateX(0px)"] });
}

/** The reverse: the sheet slides out to the right. The caller hides it once this resolves true. */
export function slideOut(el: HTMLElement): Promise<boolean> {
  const now = getComputedStyle(el).transform;
  return settle(el, { transform: [now === "none" ? "translateX(0px)" : now, "translateX(100%)"] });
}
```

  - Remove `FULL` and `clip-path` from `PROPS` if nothing else uses them.
  - Delete the `insetOf` tests in `motion.test.ts`.

- [ ] **Step 2: Engine inset.** In `engine.js`:
  - add `let inset = 0, insetGoal = 0;`;
  - in `step()`, add `inset += (insetGoal - inset) * (1 - Math.exp(-dt * 10));`;
  - in `applyCamera`, add `const shift = (inset / 2) * cs.fh / vh;` and use `camera.left = (-cs.fh * a) / 2 + shift; camera.right = (cs.fh * a) / 2 + shift;`;
  - in `groundAt`, change `.addScaledVector(r, (nx * cs.fh * a) / 2)` to `.addScaledVector(r, (nx * cs.fh * a) / 2 + (inset / 2) * cs.fh / vh)`;
  - add `setInset(px) { insetGoal = Math.max(0, px); },` to the api and `setInset(px: number): void;` to `engine.d.ts`.

  Check that `applyCamera` runs every frame; if it only runs on change, call it whenever `inset` moves.

- [ ] **Step 3: Sheet DOM and CSS.**
  - In `style.css`, the `.chat` rule becomes `position: absolute; top: 0; right: 0; bottom: 0; width: min(560px, 100%); z-index: 7; display: flex; flex-direction: column; background: var(--i-slab); color: var(--i-ink); border-left: 1px solid var(--i-edge); box-shadow: var(--i-shadow);`.
  - The log padding becomes `16px 20px 56px`, since the 880px centring no longer applies. The composer and menu offsets change to `20px` the same way.
  - Add `@media (max-width: 719px) { .chat { width: 100%; border-left: 0; } }`.
  - Cog: add `#app.sheet .cog { right: calc(min(560px, 100%) + 16px); }`, and the matching settings panel `right`.
  - In `index.html`, the chat section loses `aria-modal="true"`.

- [ ] **Step 4: chat.ts open and close.**
  - `export const SHEET_W = () => (innerWidth < 720 ? 0 : Math.min(560, innerWidth));`
  - **`openChat`.** It no longer rebuilds the root when the sheet is open. It also leaves the root alone while the sheet is mid-close (`closing`). In both cases it:
    1. disconnects;
    2. empties the log and resets;
    3. updates the header;
    4. connects;
    5. restores the draft.

    Factor this into `show(bot, name)`. When the sheet is closed, it builds the DOM as now, then calls `show`, then `slideIn(root)`.
  - `app.classList.add("sheet")` on open and `remove` on close. The root's parent is `#app`.
  - `world.setInset(SHEET_W())` on open and `setInset(0)` on close. `chat.ts` doesn't hold the world, so `openChat`/`closeChat` take an `onInset(px)` callback: `export function setChatHooks(h: { inset(px: number): void; loadMarkdown(): void })`, called once from `main.ts`.
  - `closeChat` calls `slideOut(root)`, not `shrinkTo`.
  - Delete `bubbleRect`.
  - Add `addEventListener("resize", ...)`: while the sheet is open, re-apply the inset.

- [ ] **Step 5: main.ts, non-modal.**
  - **`select(id)`:** after `world?.select`, if `id && chatOpen()`, open the chat for that bot. `openChat` switches in place.
  - **Keydown,** while the chat is open: `k === "escape" || k === "c"` closes it. The other keys fall through to the village handlers below, so delete the early `return`.
  - **Comment:** the sheet leaves the village usable beside it.

- [ ] **Step 6:** Run `pnpm typecheck` and `pnpm test`. Expected: PASS. Then check in the browser:
  - the sheet slides in and out, with nothing clipping it;
  - the selected bot sits centred left of the sheet;
  - clicking another bot switches the sheet;
  - `A` answers a prompt while the sheet is open;
  - at 600px wide the sheet is full width, with no inset.

- [ ] **Step 7: Commit:** `"Show the chat as a sheet beside the village"`.

---

### Task 4: Fast open

**Files:**
- `chat-format.ts` and `chat-format.test.ts`;
- `chat.ts`, `style.css`.

**Interfaces:**
- Produces `tailSplit(entries: ChatEntry[], n: number): { older: ChatEntry[]; tail: ChatEntry[] }`. `tail` starts at the n-th top-level entry from the end, where a top-level entry has no `parent` and isn't a `result`.

- [ ] **Step 1: Failing test:**

```ts
test("the tail keeps the last n top-level entries, with what belongs to them", () => {
  const e = (uuid: string, o: object) => ({ uuid, at: "", ...o }) as ChatEntry;
  const list = [
    e("p1", { kind: "prompt", text: "a" }),
    e("t1", { kind: "tool", id: "T1", name: "Agent", input: {} }),
    e("s1", { kind: "text", text: "sub", parent: "T1" }),
    e("r1", { kind: "result", toolUseId: "T1", text: "", isError: false }),
    e("x1", { kind: "text", text: "b" }),
    e("x2", { kind: "text", text: "c" }),
  ];
  const { older, tail } = tailSplit(list, 2);
  assert.deepEqual(tail.map((x) => x.uuid), ["x1", "x2"]);
  assert.deepEqual(older.map((x) => x.uuid), ["p1", "t1", "s1", "r1"]);
  assert.deepEqual(tailSplit(list, 10).older, []);
});
```

- [ ] **Step 2:** Run the web tests. Expected: FAIL, because `tailSplit` is not exported.

- [ ] **Step 3: Implement:**

```ts
/** Splits a backlog so only its last `n` top-level entries are drawn at first; subagent lines and results ride with them. */
export function tailSplit(entries: ChatEntry[], n: number): { older: ChatEntry[]; tail: ChatEntry[] } {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.parent || e.kind === "result") continue;
    if (++seen === n) return { older: entries.slice(0, i), tail: entries.slice(i) };
  }
  return { older: [], tail: entries };
}
```

  A subagent entry or result in the tail whose card is in `older` waits in `orphans`/`results` until that card is prepended. `place()` already handles both.

- [ ] **Step 4: Wire it in** `chat.ts`:
  - `let older: ChatEntry[] = []` and `let first = true`, both reset in `reset()`.
  - In `receive`, when `first` is set, the batch is the start of the backlog. Accumulate entries while batches arrive in the same task. Simplest: the first `entries` event runs `const { older: o, tail } = tailSplit(fresh, TAIL); older = o;`, and only `tail` goes into the queue. Set `first = false` after the first `entries` event.

    Batches are 500 entries. A backlog longer than 500 arrives in several events, so `older` must also take the later backlog events. Treat every `entries` event that arrives before the first `drain` has run as backlog: keep `backlog = true` until `drain` empties the queue the first time, as `live` does now. Then run `tailSplit` on the queue in `drain` the first time, instead of in `receive`.
  - `place(entry, into?: HTMLElement)`:
    - Without `into`, it appends to the log as now.
    - Prepending builds the next chunk into a fragment container, `const box = document.createElement("div")`, placing each entry with `into = box`, then runs `log.prepend(...box.childNodes)`.
    - Compensate the scroll: `const h = log.scrollHeight; …prepend…; log.scrollTop += log.scrollHeight - h;`.
  - **Scroll listener:** `if (log.scrollTop < 400 && older.length) prependOlder();`, where `prependOlder` takes `tailSplit(older, TAIL)`, keeps its `older` and places its `tail`.
  - **First placement:** the first drain places the tail synchronously in one pass rather than `PER_FRAME`, since it's at most ~150 top-level entries. Then `jumpToEnd()`. `openChat` awaits one `requestAnimationFrame` after the first drain before `slideIn` when it can. If no entries arrive within 150 ms, it slides in anyway.
  - **CSS:** `.chat .log > * { content-visibility: auto; contain-intrinsic-size: auto 60px; }`.

- [ ] **Step 5:** Run `pnpm typecheck` and `pnpm test`. Expected: PASS. In the browser, open this session's chat with a `longtask` observer and a rAF frame log. Expected: no frame over 50 ms after the click. Scroll to the top: older entries appear without the view jumping.

- [ ] **Step 6: Commit:** `"Open the chat on its last entries and add older ones on scroll"`.

---

### Task 5: Composer card and menu

**Files:**
- `chat-format.ts` and `chat-format.test.ts`;
- `chat.ts`, `style.css`.

**Interfaces:**
- `sendBlock` returns `{ reason; readOnly; label: "READ-ONLY" | "ENDED" | "WAITING" }`.

- [ ] **Step 1: Failing test:** extend the `sendBlock` test so ended gives `label: "ENDED"`, wt and no terminal give `"READ-ONLY"`, and permission or `needs_input` give `"WAITING"`. Update the existing `deepEqual` expectations to include `label`.

- [ ] **Step 2:** Run it to see it fail, add the `label` field, and run it to see it pass.

- [ ] **Step 3: Markup** in `openChat`:

```html
<form class="composer">
  <ul class="menu" ...></ul>
  <div class="card">
    <div class="top"><span class="label">MESSAGE</span><span class="hints">⏎ SEND · ⇧⏎ NEW LINE · / COMMANDS</span></div>
    <textarea ...></textarea>
    <div class="foot"><p class="status" aria-live="polite"></p><button class="primary" type="submit">[⏎] SEND</button></div>
  </div>
</form>
```

  `refreshComposer` sets `.label` to `block?.label ?? "MESSAGE"` and toggles `card.classList.toggle("blocked", !!block)`.

- [ ] **Step 4: Styles.** Replace the composer rules:

```css
.chat .composer { position: relative; padding: 10px 20px 14px; }
.chat .composer .card { border: 1px solid var(--i-edge); border-radius: 4px; background: var(--i-slab); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; transition: border-color .15s; }
.chat .composer .card:focus-within { border-color: var(--i-amber-t); }
.chat .composer .card.blocked { opacity: .7; }
.chat .composer .top, .chat .composer .foot { display: flex; align-items: center; gap: 12px; }
.chat .composer .label, .chat .composer .hints { font: 10px var(--mono); letter-spacing: .12em; color: var(--i-soft); }
.chat .composer .hints { margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat .composer textarea { box-sizing: border-box; width: 100%; resize: none; min-height: 22px; max-height: 12.5em; padding: 0; border: 0; outline: none; background: none; color: var(--i-ink); font: 13px/1.5 var(--mono); }
.chat .composer .status { flex: 1; min-width: 0; margin: 0; font: 11px var(--mono); color: var(--i-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity .4s; }
.chat .composer .status.error { color: var(--i-red-t); }
.chat .composer .status.faded { opacity: 0; }
.chat .menu { left: 20px; right: 20px; border-color: var(--i-edge); border-radius: 4px; box-shadow: var(--i-shadow); }
.chat .menu .tag { font: 10px var(--mono); letter-spacing: .12em; text-transform: uppercase; border: 0; color: var(--i-soft); }
```

  `grow()` adds 0 instead of 2: the textarea has no border now.

- [ ] **Step 5:** Run `pnpm typecheck` and `pnpm test`. Expected: PASS. In the browser, in both the light and dark theme:
  - the card's border turns amber on focus;
  - blocked states dim the card and change its label;
  - the menu matches the sidebar.

- [ ] **Step 6: Wrap up.** Update `ROADMAP.md` with the "Chat view" lines (sheet, markdown) and the README's chat bullet ("in a sheet beside the village").

- [ ] **Step 7: Commit:** `"Restyle the composer and command menu like the village cards"`.
