# Chat view, phase 2 (send messages)

Type into a session from its chat overlay, with a "/" menu of the commands that session can run.
Builds on phase 1 (`2026-10-12-chat-view-design.md`).

## Goal and success criteria

- **Purpose:** reply to a session from the village without switching to its terminal.
- The chat overlay has a composer at the bottom. Enter sends; the text arrives in the session's cmux
  surface as if typed there and is submitted.
- Multi-line messages arrive as one prompt.
- Typing `/` lists the session's skills and custom commands plus a few safe built-ins, filtered as
  you type.
- Sessions outside cmux (Windows Terminal, IDE, desktop app, unknown) stay read-only, and the
  composer says why.
- Text can never land in a permission prompt that Hamlet knows is open.

## Decisions

- **Injection:** the daemon shells out to the `cmux` CLI, as `focusTerminal` already does, with a
  single `cmux rpc terminal.paste` call whose `submit_key: "return"` presses Enter after the paste.
  Checked on cmux 0.64.20: the text arrives as one bracketed paste with its newlines kept, ESC is
  replaced with a space, and one `\r` follows. Plain `cmux send` is not used: it turns `\n` into
  Enter, which would split a message into several prompts.
- **Busy sessions:** sending while the bot is working is allowed. Claude Code queues text typed
  mid-turn, and the composer says so.
- **Commands:** the session's own list comes from its transcript. Built-ins are not in the
  transcript, so a short constant lists the ones that run without a picker in the terminal.
- **The terminal's own input is left alone.** If the user has half-typed something there, Hamlet's
  text is added after it. Clearing it first could destroy a draft.

## Transcript format (observed)

Each main transcript has an `attachment` line with `attachment.type: "skill_listing"`:

```json
{ "type": "skill_listing", "isInitial": true, "skillCount": 121,
  "names": ["fix-at-the-source", "code-review:code-review", "init", "..."],
  "content": "- fix-at-the-source: Use when a solution feels like...\n- code-review:code-review: Code review a pull request\n..." }
```

- `isInitial: true` is the full list at session start. Later lines with `isInitial: false` carry
  only additions (seen when a plugin is installed mid-session).
- `content` has one `- <name>: <description>` line per name. Descriptions can be long.
- Subagent transcripts have their own listing. Only the main transcript's is used.
- The listing covers skills, custom commands, plugin commands and bundled skills (`/init`,
  `/simplify`, `/loop`…). It does not cover built-ins such as `/clear`.

## Daemon

### `terminal.ts` (new)

`focusTerminal` moves here from `main.ts`, next to the new sending code.

```ts
/** Text as it may reach the terminal, or why not. */
export function cleanText(text: string): { text: string } | { error: "empty" | "too-long" };
/** The cmux arguments that paste `text` into a surface and submit it. */
export function pasteArgs(t: CmuxTerminal, text: string): string[];
/** Pastes and submits `text`. Rejects with cmux's stderr. */
export function sendText(t: CmuxTerminal, text: string): Promise<void>;
```

- `cleanText`:
  - Turns `\r\n` and lone `\r` into `\n`.
  - Strips every C0 control character except `\n` and `\t`, plus DEL and C1. A pasted `ESC` must
    not reach the TUI.
  - Trims trailing whitespace.
  - Empty text is an error. So is text over `SEND_CAP` = 64 KB (UTF-8 bytes) after cleaning.
- `pasteArgs` builds
  `["rpc", "terminal.paste", JSON.stringify({ workspace_id, surface_id, text, submit_key: "return" })]`.
- `sendText` runs it with `execFile` (never a shell) and a 5 s timeout. Paste and Enter are one
  call, so two quick sends can't interleave.

### `chat.ts`: `commandsIn`

```ts
export interface Command { name: string; description: string }
/** The commands a `skill_listing` line lists, and whether they replace the list. Never throws. */
export function commandsIn(line: string): { commands: Command[]; initial: boolean } | undefined;
```

- Names come from `names`.
- Descriptions come from the matching `- <name>: ` line in `content`, cut to 200 characters.
  A name with no matching line gets an empty description.
- Returns `undefined` for anything else: other lines, malformed JSON, `names` that isn't a string
  array.

### `feed.ts`

- `ChatFeed` runs `commandsIn` on main-transcript lines only. An initial listing replaces its
  command list; an addition merges in by name.
- Viewers get a `{ commands }` event:
  - on connect, after the backlog, if the list isn't empty;
  - whenever a new listing line changes it.
- A `reset` clears the list along with the entries.

### Endpoint: `POST /api/sessions/:id/send`

Body: `{ text: string }`. The token check already covers it.

| Case | Reply |
| :- | :- |
| `text` missing or not a string | 400 |
| Empty after cleaning | 400 `{ error: "empty" }` |
| Over `SEND_CAP` | 413 |
| Unknown session | 404 |
| Bot has a held permission (including `AskUserQuestion`) | 409 |
| `bot.terminal` missing or not cmux | 422 |
| cmux fails or times out | 502 `{ error: <stderr> }` |
| Sent | 204 |

The target always comes from `bots.get(id).terminal`. The browser never names a surface.

The daemon's body limit (20 MB) is far above `SEND_CAP`, so 413 comes from `cleanText`.

## Shared

`world.ts`:

- `ChatEvent` gains `| { commands: Command[] }`, and `Command` is exported.
- `SEND_CAP` is exported, so the web app can stop over-long input before it is sent.
- `BUILTIN_COMMANDS: Command[]`, the safe built-ins: `clear`, `compact`, `context`, `cost`. They
  run without a picker in the terminal. Picker commands (`model`, `config`, `resume`, `mcp`…)
  and `exit` are left out.

## Web

### `chat-format.ts`

```ts
/** Commands for a `/query`: prefix matches on the name first, then substring, each group A–Z. Max 50. */
export function matchCommands(query: string, list: Command[]): Command[];
/** The session's commands plus the built-ins; the session's entry wins on a name clash. */
export function allCommands(session: Command[]): (Command & { builtin?: true })[];
```

### `chat.ts`: composer

A `<form class="composer">` below the log: an auto-growing textarea (up to about 8 lines), a
SEND button, and a one-line status under them.

- **Keys:**
  - **Enter** sends and **Shift+Enter** adds a newline.
  - PageUp/PageDown scroll the log while the composer has focus.
  - Village shortcuts are already ignored while the chat is open.
- **Focus:** opening the chat focuses the composer when it can send, and the log otherwise.
- **Disabled states.** The draft is kept in all of them:

  | Condition | Composer shows |
  | :- | :- |
  | `bot.terminal` missing | "Read-only: Hamlet can't find this session's terminal." |
  | `bot.terminal.kind === "wt"` | "Read-only: sending works for cmux sessions only. This one runs in Windows Terminal." |
  | `bot.permission` set | "Answer the WAITING prompt first." |
  | Bot gone (session ended) | "This session has ended." |

  `updateChat` already runs on every bot change, so it also re-evaluates these.
- **Drafts:** a `Map<sessionId, string>` in memory keeps unsent text across closing and reopening
  the chat. A successful send clears the draft.
- **Sending:**
  - The textarea is locked while the request is in flight.
  - On 204 the box clears. The status says "Sent", or "Queued: Claude picks it up after the
    current step" if the bot was `working`, and fades after a few seconds.
  - The message reaches the log by itself through the transcript. No "pending" entry is drawn:
    slash commands such as `/clear` never become a prompt entry, so it couldn't be matched.
- **Errors.** The text stays in the box, and the status shows the reason:

  | Reply | Status |
  | :- | :- |
  | 409 | "Answer the WAITING prompt first." |
  | 422 | The read-only reason from the table above |
  | 413 | "Too long to send (max 64 KB)." |
  | 502 | "Couldn't reach cmux: <first line of error>" |
  | Network error | "Couldn't reach the daemon." |

### `chat.ts`: "/" menu

- **Opening:** the menu opens while the whole textarea matches `^/\S*$`. It is a listbox above the
  composer showing `matchCommands(query, allCommands(sessionCommands))`.
- **Rows:** each row has `/name`, a one-line description cut off with an ellipsis, and a small
  `built-in` tag where it applies.
- **Keys:**
  - **↑/↓** moves the highlight.
  - **Tab** or **Enter** replaces the text with `/name ` and closes the menu. A second Enter sends,
    so arguments can be typed first.
  - **ESC** closes the menu. When the menu is closed, ESC closes the chat as before.
- **Mouse:** clicking a row completes it the same way.
- **Before the listing arrives:** until a `{ commands }` event comes in, only the built-ins show.
- **Escaping:** names and descriptions come from the transcript and are HTML-escaped.
- **Accessibility:** `role="listbox"` with `aria-activedescendant`.

## Testing

`node:test` with `assert/strict`, as now. `pnpm typecheck` and `pnpm test` must pass.

- **`terminal.test.ts`:**
  - `cleanText`: ESC and other control characters are stripped, `\r\n` is normalized, trailing
    space is trimmed, empty and over-cap text are errors, and `\t` and `\n` survive.
  - `pasteArgs`: builds the exact arguments.
- **`chat.test.ts`:**
  - `commandsIn`: an initial listing, an addition, a name with no description line, and a
    description containing `: `.
  - It returns `undefined` for a non-listing line, for malformed JSON, and for a non-array `names`.
- **`feed.test.ts`:**
  - A listing sends `{ commands }` after the backlog.
  - An addition merges into the list.
  - A subagent's listing is ignored.
- **`server.test.ts`:** the test daemon's `PATH` starts with a temp directory holding a fake `cmux`
  script that appends its arguments to a file. The tests cover:
  - 204, and the recorded paste;
  - 409 with a held permission;
  - 422 for a session with no cmux headers;
  - 502 when the fake exits non-zero;
  - 400 for empty text, and 413 for over-cap text.
- **`chat-format.test.ts`:**
  - `matchCommands`: prefix before substring, case-insensitive, capped.
  - `allCommands`: the session's entry wins over a built-in with the same name.
- **Manual:** send a three-line message and a `/` command to a real Claude Code session in cmux.

## Known limitations

- **Race with a new prompt.** The 409 check runs when the request arrives. A permission prompt that
  opens after that can still catch the text, just like typing in the terminal at that moment.
- **Half-typed terminal input.** Text already in the terminal's input is kept, and the sent message
  is added after it.
- **Hidden commands.** Commands hidden from the model (`disable-model-invocation`) are not in the
  transcript listing, so the menu can't show them. They can still be typed.
- **Unlisted built-ins.** Other built-ins are not in the menu but can still be typed. If one opens a
  picker, it has to be finished in the terminal.

## Out of scope

- Sending from non-cmux terminals (roadmap "Later": possibly through the Claude Agent SDK).
- Interrupting a turn (Esc) from the app.
- Attaching images or files.
- A "pending" bubble or delivery confirmation for a sent message.
