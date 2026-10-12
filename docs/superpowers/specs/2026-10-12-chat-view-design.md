# Chat view, phase 1 (read-only)

Open a session's conversation from its bot and read it closely, much like the terminal shows it.
Phase 2 (sending messages) is a separate spec.

## Goal and success criteria

- **Purpose:** full review of what a session did, without switching to its terminal.
- From a selected bot, `[C] CHAT` (or the `C` key) opens a full-screen overlay. It shows the whole
  session from its first prompt: prompts, Claude's replies, tool calls with their inputs and
  results, Edit/Write diffs, subagent work nested under the call that started it, non-empty
  thinking, and system notices.
- New lines show up within about a second while the overlay is open.
- A 20 MB transcript opens without freezing the tab.
- ESC returns to the village with the bot still selected.

## Transcript format (observed)

Claude Code writes one JSON object per line. The lines the chat uses:

| Line | Becomes |
| :- | :- |
| `type: "user"`, `message.content` is a string (not `isMeta`, not starting with `<`) | `prompt` |
| `type: "user"`, `message.content[]` with `tool_result` | `result` for its `tool_use_id` |
| `type: "assistant"`, `content[]` `text` | `text` |
| `type: "assistant"`, `content[]` `tool_use` | `tool` |
| `type: "assistant"`, `content[]` `thinking` with non-empty text | `thinking` (most are empty and skipped) |
| `type: "system"`, subtype `api_error`, `informational`, `local_command`, `turn_duration` | `notice` |
| Compaction marker (shape not yet seen in local transcripts; confirm against a compacted session) | `notice` ("Context compacted") |

Skipped: `attachment`, `mode`, `permission-mode`, `file-history-*`, `last-prompt`, `ai-title`,
`queue-operation`, `cost-state`, `atis-latch`, and the system subtypes `stop_hook_summary` and
`away_summary`. Unknown line types are skipped, never an error.

Subagents write `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`, where `<dir>/<sessionId>.jsonl`
is the session's transcript. Each has a sibling `agent-<agentId>.meta.json` whose `toolUseId` is the
Agent/Task call that started it.

## Daemon

### `transcript.ts`: `JsonlTail`

Extract the cursor logic already in `newTitles` into a reusable class:

```ts
class JsonlTail {
  constructor(path: string, opts: { maxLine: number });
  /** Complete lines appended since the last call. A shrunk file restarts from 0 and sets `reset`. */
  read(): Promise<{ lines: string[]; reset: boolean }>;
}
```

It keeps the existing behavior: chunked reads, a `StringDecoder` for UTF-8 characters split across
chunks, and an unfinished last line carried over. A line longer than `maxLine` is replaced by a
stub that won't parse. Titles use `maxLine` 64 KB, as today. The chat uses 8 MB.

### `chat.ts`: entries

`ChatEntry` lives in `@hamlet/shared` (`world.ts`) so the web app can use it:

```ts
type ChatEntry = { uuid: string; at: string; parent?: string } & (
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "result"; toolUseId: string; text: string; isError: boolean; truncated?: number }
  | { kind: "notice"; text: string; level: "info" | "error" }
);
```

- `toEntries(line: string, parent?: string): ChatEntry[]` is pure. It returns `[]` for skipped or
  unparsable lines. `parent` is the subagent's `toolUseId`.
- Result text joins the result's text blocks (images become `[image]`) and is capped at 32 KB.
  `truncated` holds the original length in bytes when capped.
- A `uuid` per entry (transcript `uuid` plus block index) lets the client ignore duplicates after a
  reconnect.

### Endpoint: `GET /api/sessions/:id/chat` (SSE)

- Token check as for every `/api` route. An unknown session id returns 404.
- The daemon stores each bot's transcript path: from `transcript_path` when a hook brings one, or
  from `findTranscript` (`registry.ts`) when the session was discovered in Claude Code's session
  registry. A hook's path replaces a discovered one. The path is kept in a daemon-side map, not on
  `Bot`, and the client never sends a path. A session with no stored path
  gets one event, `{ error: "no-transcript" }`, and the stream stays open until a path arrives.
- Events, each one `data: <json>`:
  - `{ entries: ChatEntry[] }`: the backlog is sent in batches of 500 entries, then appended
    entries as they come.
  - `{ reset: true }`: the transcript was rewritten, so the client clears and the backlog follows.
  - `{ error: "no-transcript" | "unreadable" }`.
- **Watching:** one watcher per session, shared by every open stream for it. Every 500 ms it reads
  the main tail and lists `subagents/`. It opens a tail for each new `agent-*.jsonl`, reading its
  `meta.json` for `parent`. The first stream to open runs the backlog and later streams get the same
  backlog from a cache of that session's entries. The watcher and cache are dropped 30 s after the
  last stream closes, and at `SessionEnd`.
- Read errors are logged (`kind: "chat-error"`) and sent as `unreadable`. The watcher keeps
  polling, so a file that shows up later recovers.

## Web

### `chat.ts` (new module)

`main.ts` is 644 lines already, so the overlay lives in its own module, which exports
`openChat(bot)` and `closeChat()`. It reuses the theme variables and monospace look of the bubble.

- **Header:** villager name, `repo / branch`, session title, live state dot, `ESC`. While the bot
  waits on a permission, a `WAITING: <tool>` pill closes the chat and opens the bubble.
- **Prompts:** `>`-prefixed blocks.
- **Claude's text:** plain text with `white-space: pre-wrap`. Fenced code blocks get the code
  background. No markdown library in phase 1.
- **Tool cards:** a one-line header (`▸ Bash  pnpm test`, `▸ Edit  packages/daemon/src/bots.ts`),
  collapsed by default. Expanded, a card shows the input and the result, matched by `toolUseId`.
  An error result gets a red edge, and a capped one shows `Result truncated (1.2 MB)`. A card with
  no result yet shows `running…`.
- **Diffs:** Edit and MultiEdit show each edit as `-` lines (old_string) then `+` lines
  (new_string). Write shows `+` lines. This is a plain line listing, not a minimal diff.
- **Subagents:** an Agent/Task card shows its description. Expanded, it lists the entries whose
  `parent` is its id, indented, rendered the same way (one level).
- **Thinking:** a collapsed `Thinking` row.
- **Notices:** thin divider lines.
- **Follow-scroll:** pinned to the bottom while the reader is at the bottom. Scrolling up stops
  following and shows `↓ New messages`. Batches render in `requestAnimationFrame` chunks so the
  overlay opens at once.
- **Errors:** `no-transcript` shows "Waiting for this session's transcript…", and `unreadable`
  shows "Couldn't read this session's transcript." with the daemon log path.
- `[C] CHAT` sits in the bubble next to `[T] OPEN TERMINAL`. The `C` key works while a bot is
  selected and no text field has focus. The EventSource closes with the overlay.

## Testing

- `JsonlTail`: appended reads, a UTF-8 character split across reads, a shrunk file (`reset`), and
  the long-line stub.
- `toEntries`: trimmed fixture lines from real transcripts for every row of the table above, the
  skipped types, `parent` tagging, the 32 KB cap, and empty thinking.
- Endpoint: 401 without a token, 404 for an unknown session, and backlog then appended entries
  from a temp transcript (temp `HAMLET_HOME` and port).
- UI: checked by hand on a live session, including one with a subagent and a large transcript.

## Out of scope

Sending messages (phase 2), search, markdown rendering, answering permissions inside the chat, and
nesting deeper than one subagent level.
