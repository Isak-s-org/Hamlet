# Security policy

Hamlet receives Claude Code hook events and can allow or deny permission requests. A bug here
could let something approve tool calls you never saw, so please report security issues privately.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/Isak-gerre/hamlet/security/advisories/new).
Please don't open a public issue. Include steps to reproduce and the impact you expect. I'll
reply as soon as I can.

## Scope

Things that are especially relevant:

- Anything that lets a process or web page reach the daemon without the token
- Ways to answer a permission request without the user's input
- Token leaks, for example into the browser, logs or URLs
- The installer corrupting or overwriting unrelated settings in `~/.claude/settings.json`

Only the latest `main` is supported.
