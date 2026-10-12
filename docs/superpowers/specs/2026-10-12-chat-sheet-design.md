# Chat sheet, markdown and village polish

Feedback on the chat view (phases 1 and 2):
- Opening the chat feels janky.
- Closing it looks clipped by the bubble.
- Replies don't render markdown.
- The composer doesn't fit the theme.

Also in scope, in the village:
- A selected bot walks away with its bubble.
- The bubble's `NOW` line overflows the card.
- Sidebar repos start collapsed.

## Goal and success criteria

- **The chat is a right-hand sheet.** The village stays live and clickable beside it.
- **Opening is smooth.** The sheet slides in already filled and pinned to the end. With 240 entries, no frame takes over 50 ms on the developer machine, measured as in "Testing".
- **Closing slides out.** Nothing clips it.
- **Replies render as markdown,** safely: transcript text can never produce markup, scripts or remote fetches.
- **The composer looks like the village UI:** cards, mono labels, key hints in brackets and the amber primary button.
- **A selected bot stands still.** The `NOW` and `CWD` values stay inside the bubble.
- **Sidebar repos start expanded.**

## Measured today

These numbers are from opening the chat on a 240-entry session:
- frames of 31–70 ms for the first seconds, and one 57 ms long task;
- the cause is the backlog being added 200 entries per frame while a full-screen clip-path animation runs, with the log pinned to the bottom every frame.

## 1. The sheet

### Layout

- `.chat` becomes a right-hand sheet: `position: absolute; top: 0; right: 0; bottom: 0; width: min(560px, 100%)`.
- It has a `--i-edge` left border and `--i-shadow`.
- The header, log, note, jump button and composer keep their order.
- At widths under 720px the sheet is full width.
- While the sheet is open, the settings cog (`top: 16px; right: 16px`) moves to `right: calc(min(560px, 100%) + 16px)`. Below 720px it's hidden behind the sheet.

### Motion

- In `motion.ts`, `slideIn(el)` and `slideOut(el)` replace `growFrom` and `shrinkTo`.
- They animate `transform` from `translateX(100%)` to `translateX(0)` and back, on `SPRING`.
- With reduced motion they end at once, like every effect.
- `bubbleRect` and the clip-path effects are deleted, and so is `insetOf` along with its test.

### Village beside the sheet

- `World` gains `setInset(px: number): void`. The engine keeps the camera's focus in the middle of the visible area left of the sheet:
  - It shifts the orthographic frustum sideways: both `left` and `right` move by `shift = (inset / 2) * fh / vh` world units, so the scale doesn't change.
  - `groundAt` adds the same shift, so panning and zooming under the cursor stay right. The raycaster and label placement use the camera, so they follow on their own.
  - The inset eases toward its target over about 300 ms in the engine's frame loop.
- Labels and the bubble are placed through the same camera, so they follow.
- `openChat` calls `world.setInset(sheetWidth)`. Closing calls `setInset(0)`. Below 720px the inset stays 0, since the sheet covers everything there.

### Non-modal interaction

- **Map and sidebar clicks:** selecting a bot (on the map or in the sidebar) while the sheet is open switches the sheet to that bot's chat.
- **Empty map clicks:** clicking empty map deselects the bot but leaves the sheet open on its session.
- **Keys:** village keys work while focus is outside the composer: `N`, `A`, `D`, `T`, `F` and `?`.
  - `C` toggles the sheet.
  - `ESC` closes the "/" menu, then the sheet.
- **Answering beside the chat:** `A`/`D` answer the selected bot's prompt in its bubble, which stays visible beside the sheet.
- **Accessibility:** `role="dialog"` stays, but `aria-modal` is removed.

### Opening fast

- **Tail first.** On the first batch for a session, only the last `TAIL` = 150 entries are placed. The others are kept in `older[]` in order, so older entries never land in the middle of the log.
- **Grouping still works.** A subagent entry whose Agent card is in `older` is held there with its parent.
- **Placement happens before the slide.** It's synchronous, before `slideIn` starts, so the sheet arrives already filled and pinned to the end.
- **Batches that come later,** while the session is still live, are placed and animated as today.
- **Older entries are added on scroll.** When the log is scrolled within 400px of its top, the next `TAIL` entries from `older` are prepended, and `scrollTop` is adjusted by the height they added, so nothing moves on screen.
- **Layout cost.** `.chat .log > *` gets `content-visibility: auto; contain-intrinsic-size: auto 60px`, so off-screen entries cost little to lay out.
- **Unchanged:** `Seen`, `reset` and the jump button.

## 2. Markdown

- **Dependency.** `markdown-it` becomes a dependency of `@hamlet/web`, pinned to an exact version. It's the only new runtime dependency.
- **Helper.** `packages/web/src/markdown.ts` exports `mdHtml(text: string): string`, pure and testable in Node. It configures markdown-it with:
  - `html: false`, so raw HTML is escaped;
  - `linkify: true` and `breaks: true`;
  - the default link check, which refuses `javascript:`, `vbscript:`, `file:` and `data:` (other than images).
- **Images** never load. The `image` rule renders `<a href="src" …>alt or src</a>`, with the link check applied.
- **Links** get `target="_blank" rel="noopener noreferrer"`.
- **Fences** render as `<pre class="code" data-lang="…">`, with the language shown by CSS `::before` and no highlighting.
- **Where it's used:**
  - `text` entries (Claude's replies);
  - results of `Agent`/`Task` calls;
  - the `plan` input of an `ExitPlanMode` card.

  Prompts, thinking and other tool output stay plain.
- **Loading.**
  - `markdown.ts` is loaded with `import()` inside `requestIdleCallback`, falling back to a `setTimeout` of 1 s, after the app starts, and again on the first `openChat` if needed.
  - Until it has loaded, entries use `textHtml` as today.
  - Entries already on screen aren't re-rendered when it arrives.
- **Styles** cover `h1`–`h4`, `ul`/`ol` (including task lists), `blockquote`, `code`, `pre.code`, `table` (wrapped in a scrolling box), `hr` and `a`. They use the existing tokens and `--mono`.

## 3. Composer and "/" menu

### Composer card

- The composer becomes a card (`--i-slab`, a `--i-edge` border, 4px radius) inside the sheet's bottom padding.
- **Header row:** the label `MESSAGE`, in mono 10px uppercase with `.12em` spacing in `--i-soft`, and on the right the hints `⏎ SEND · ⇧⏎ NEW LINE · / COMMANDS` in the same style.
- **Textarea:** transparent and borderless, mono 13px/1.5 in `--i-ink`, with the same auto-grow and cap as now.
- **Focus:** while the textarea has focus, the card border turns `--i-amber-t`.
- **Footer row:** the status line on the left, in the `NOW`/`CWD` style (mono 11px, red for errors), and on the right the `[⏎] SEND` button with the `.primary` look of `[T] OPEN TERMINAL`.
- **Blocked states:** the card dims (`opacity: .7`), the label reads `READ-ONLY`, `ENDED` or `WAITING`, and the footer shows the reason. `sendBlock` gains a `label` field for this.

### "/" menu

- The menu is a card above the composer in the sidebar's list style:
  - mono 12px rows, with `--i-sel` on the highlighted row;
  - the description in `--i-soft`;
  - the `built-in` tag in mono 10px uppercase, like `03 REPOS`.
- Behaviour is unchanged.

## 4. Village fixes

### A selected bot stands still

- In `creatures.js`, `update(dt, t, city, d, slot, camera, held)`. While `held` is true the bot doesn't advance along its path: `walking` stays false, and its working, sitting or waiting pose plays in place.
- When `held` turns false, it carries on along its path.
- In `engine.js`, `held` is `v.data.sessionId === selected`.

### `NOW` and `CWD` truncate

- In `main.ts`, the bubble's rows render as `<span class="kv"><span class="k">NOW</span><b title="full">value</b></span>`. `CWD` is built the same way, its value shortened by `shortPath(cwd)`, which keeps the last segments and adds a leading `…/`.
- In `style.css`, `.kv` becomes `display: flex; gap; min-width: 0`, and the value gets `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
- `shortPath` is pure and goes in `chat-format.ts`, or a small `format.ts`, so it can be tested.

### Repos start expanded

In `main.ts`, the `expanded` set becomes `collapsed`:
- A repo is open unless it's in the set.
- Clicking an open repo adds it to the set.
- Clicking a collapsed repo removes it from the set and flies to it, as opening does now.

## Testing

`node:test` with `assert/strict`. `pnpm typecheck` and `pnpm test` must pass.

- **`markdown.test.ts`:**
  - `<script>` and `<img onerror>` in the text stay escaped;
  - a `[x](javascript:alert(1))` link is not a link;
  - `![a](https://x/y.png)` gives no `<img`;
  - a table, a nested list and a fence with its language render;
  - links carry `target="_blank"` and `rel="noopener noreferrer"`.
- **`chat-format.test.ts`:**
  - `sendBlock` labels;
  - `shortPath` (short paths unchanged, long ones keep their tail, root);
  - a pure `tailSplit(entries, n)` that returns `{ older, tail }` with subagent entries kept beside their Agent call.
- **`motion.test.ts`:** drop the `insetOf` cases.
- **Manual, in a browser:**
  - Open a 240-entry chat with a `longtask` observer and a rAF frame log. Expect no frame over 50 ms after the click.
  - Closing slides out with nothing clipping it.
  - Clicking another bot switches the sheet.
  - `A` answers a prompt with the sheet open.
  - A selected working bot stops walking.
  - A long `NOW` value is cut with an ellipsis.
  - Repos start expanded.
  - Markdown replies render headings, lists, tables and code.

## Out of scope

- Syntax highlighting.
- Resizing the sheet by dragging.
- Virtualising the whole log; the tail plus `content-visibility` covers today's sizes.
- Markdown in prompts and in raw tool output.
