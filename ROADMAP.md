# Roadmap

Planned features, roughly in priority order. Hamlet is an early prototype, so this list will change.

## Done

- **Villager names and session subtitles.** Each world has its own names. The subtitle is Claude Code's
  title for the session (`/rename` wins over the AI title), or the first prompt until there is one.
- **Answer `AskUserQuestion` from the village.** Options show as buttons, with multi-select and "Other".
  Answers go back to Claude Code as `updatedInput.answers` on the held `PermissionRequest`.
- **Thought bubbles.** A name tag above each bot shows what it's doing, such as "Editing bots.ts".
- **Answer in either place.** Claude Code shows its own prompt while the hook is held, and the first
  answer wins. It keeps the hook open when the terminal answers, so the daemon clears the request
  when the tool's result arrives or the agent moves on (next prompt, `Stop`, idle).
- **Pick up running sessions.** The daemon reads Claude Code's session registry
  (`~/.claude/sessions`), so sessions that were running before the daemon started or before the
  hooks were installed show up right away, and a bot leaves soon after its process exits.
- **Notifications.** A sound, and optionally a desktop notification, when a bot starts waiting while
  the tab isn't focused. The tab title shows how many bots are waiting.
- **Chat view (read-only).** `[C] CHAT` on a bot opens its conversation in a sheet beside the
  village (replies rendered as markdown):
  prompts, replies, tool calls with inputs, results and diffs, subagent work, and notices, live
  from the transcript.
- **Send messages.** A composer under the chat types into the session's cmux surface: Enter sends,
  multi-line messages arrive as one prompt, and a `/` menu lists the session's skills and commands
  plus `/clear`, `/compact`, `/context` and `/cost`. Sessions outside cmux stay read-only, and
  sending waits while a permission prompt is open.
- **Subagent helpers.** Each running subagent is a small villager that follows its bot, tagged with
  its type and what it's doing (`SubagentStart` / `SubagentStop`). A subagent's permission prompt
  shows over its helper.
- **Subagent column.** Drag the chat sheet's left edge wider (900px or more) and every subagent of the
  session is listed beside the chat: running ones first, with type, description, what it's doing, tool
  count, tokens and duration. Clicking a row, or an Agent card's OPEN, shows its transcript there.
  Narrower, its lines nest in the Agent card as before.

## Next

### Easy install

- `npx hamlet` (or a global install) that runs the daemon and serves the built web UI, without
  cloning the repo.
- Later: a menubar or tray app that starts on login.

## Later / ideas

- Richer permission prompts: full command or diff preview, and "always allow this" rules.
- Activity feed for each town, plus stats for each session (time working vs waiting, tool counts).
- Send messages from non-cmux terminals, possibly by running sessions through the Claude Agent SDK.
- A Haiku-generated subtitle that updates as the session goes on (opt-in, needs an API key).

## Open questions

- `ExitPlanMode` also needs `updatedInput` to be approved from a hook; Allow alone may not be enough.
- Can we read transcripts for desktop-app and IDE sessions the same way?
