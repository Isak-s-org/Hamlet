# Contributing

Thanks for your interest in Hamlet! Issues and pull requests are welcome.

## Setup

```sh
pnpm install
pnpm typecheck
pnpm test
```

You need Node.js 22+ and pnpm 8. See the [README](README.md) for running the daemon and the UI.

## Pull requests

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep each PR focused on one change.
- Make sure `pnpm typecheck` and `pnpm test` pass, and add tests for installer and daemon logic.
- Match the style of the surrounding code.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
