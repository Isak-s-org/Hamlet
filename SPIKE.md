# M0 hook spike

Throwaway daemon (`packages/daemon/src/main.ts`) that logs every Claude Code hook and holds
`PermissionRequest`s so we can answer the spec's open questions with real payloads.

## Run

```sh
pnpm install
pnpm install-hooks        # shows the change to ~/.claude/settings.json, asks before writing
pnpm daemon               # logs to <app data>/agent-civ/spike-logs/hooks.jsonl
```

Held permission requests print an id; type `a <id>` or `d <id>` in the daemon terminal to answer.
`SPIKE_AUTO=allow pnpm daemon` answers everything automatically. `pnpm uninstall-hooks` removes
only Agent Civ's entries.

## Findings so far

- **cmux surface id — answered.** HTTP hook headers interpolate `CMUX_SURFACE_ID` and
  `CMUX_WORKSPACE_ID` (via `allowedEnvVars`); both reach the daemon on every event.
- **`SessionStart` can be missing.** A headless `claude -p` run sent `UserPromptSubmit`, `Stop` and
  `SessionEnd` but no `SessionStart`. The real daemon must create bots on the first event it sees.
- `Stop` carries `last_assistant_message`; `SessionEnd` carries `reason`.

## Still to check (interactive)

1. **Prompt racing.** Start an interactive session in cmux, trigger a tool that needs approval.
   Does the terminal show its own prompt while the daemon holds the request? Answer in the
   terminal: does the daemon log `cancelled`? Answer via `a <id>`: does the terminal prompt clear?
2. **Daemon down.** Stop the daemon, trigger a permission prompt. Confirm Claude falls back to the
   normal terminal prompt without a long delay.
3. **Hold timeout.** Leave a request held; confirm what happens at the 1800 s hook timeout.
4. **Windows Terminal / desktop app.** Repeat 1–2 there; check `X-Wt-Session` and `cwd` values.
