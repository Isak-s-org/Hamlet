<p align="center">
  <img src="assets/readme/hero.webp" alt="Hamlet: every Claude Code session, living in one world" width="100%">
</p>

# Hamlet

A tiny village where your Claude Code sessions live as bots. Hamlet listens to Claude Code's
hooks, shows each session as a bot in a 3D world, and lets you answer permission requests from
the village instead of hunting for the right terminal.

> **Status: early prototype.** Expect rough edges and breaking changes.

## Quickstart

You need Node.js 22+, pnpm 8, [Claude Code](https://claude.com/claude-code) and a browser with
WebGPU support.

```sh
git clone https://github.com/Isak-gerre/hamlet.git
cd hamlet
pnpm install
pnpm install-hooks   # shows the change to ~/.claude/settings.json and asks before writing it
pnpm dev             # starts the daemon and the web UI together
```

Open the URL from the `web` pane, start a Claude Code session, and a bot appears.

> **Heads up:** `install-hooks` changes your global Claude Code settings. It only adds Hamlet's
> own entries and backs the file up first. If the daemon isn't running, Claude Code treats the
> hook as a non-blocking error and falls back to its normal prompt. To remove the hooks, run
> `pnpm uninstall-hooks`.

## Features

![Answer permission prompts from the map](assets/readme/feature-permissions.webp)

![Bot states: working, needs input, idle, errored](assets/readme/feature-states.webp)

![Three worlds: Stone Age, Suburb and Japan](assets/readme/feature-worlds.webp)

- **Answer from the map.** Allow or deny a permission request without finding its terminal, or
  press `T` to jump to that terminal.
- **See every session at a glance.** Bots show whether they are working, waiting, idle or errored.
- **Repos become towns.** Each repo is a town and each branch a district.
- **Three worlds and a day cycle.** Choose a world and a time of day in settings, or let the day
  run on its own.

## Usage

| Key | Action |
| --- | --- |
| `N` | Jump to the next waiting bot |
| `A` / `D` | Allow / deny the open permission request |
| `T` | Open the bot's terminal |
| `F` | Frame the whole world |
| `?` | Show all controls |

`pnpm dev` opens Turborepo's terminal UI with one pane per process. Use the arrow keys to switch
panes. To answer requests from the terminal instead, select the `daemon` pane, press `i` to type
into it, and `Ctrl+Z` to leave. You can also run `pnpm daemon` and `pnpm web` separately.

Hamlet keeps its config and logs in `~/Library/Application Support/hamlet` (macOS),
`%APPDATA%\hamlet` (Windows) or `~/.config/hamlet` (Linux). Set `HAMLET_HOME` to change this.

## How it works

Claude Code sends hook events to a local daemon. The daemon tracks each session, holds permission
requests until you answer them, and streams updates to the web UI.

| Package | Role |
| --- | --- |
| `packages/daemon` | Local server on `127.0.0.1:4747` that receives hook events and answers permission requests |
| `packages/web` | The village, rendered with three.js (WebGPU) |
| `packages/installer` | Adds Hamlet's hooks to `~/.claude/settings.json` and removes them again |
| `packages/shared` | Config, types and constants shared by the other packages |

Everything runs on your machine. Hooks only talk to `127.0.0.1`, and every request is checked
against a random token stored in Hamlet's app-data directory.

## Development

```sh
pnpm typecheck
pnpm test
```

Notes from the hook spike are in [`docs/spike.md`](docs/spike.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
