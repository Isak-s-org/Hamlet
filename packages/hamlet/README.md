# hamlet-village

A tiny village where your Claude Code sessions live as bots. Watch them work and answer their permission requests from the browser.

```sh
npx hamlet-village install     # shows the change to ~/.claude/settings.json, asks before writing
npx hamlet-village             # starts Hamlet and prints a one-time link to open the village
npx hamlet-village uninstall   # removes the hooks again
```

Open the printed link to sign the browser in. After that the tab reconnects on its own across restarts. Each link works once, and the terminal prints a fresh one after every use.

The port and the hook token live in `config.json` in Hamlet's app data folder. Update with `npx hamlet-village@latest`. Requires Node 22 or later.

Source, docs and issues: https://github.com/Isak-gerre/hamlet
