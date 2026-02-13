# myttyd

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> There is no limit on concurrent sessions; every browser tab spawns its own shell.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

A web-based terminal that runs your shell in the browser. Built with React, xterm.js, and Bun's built-in PTY.

When a browser connects, the server spawns `$SHELL` (falling back to `/bin/sh`) as a pseudo-terminal and bridges it to the frontend over WebSocket using the ttyd binary frame protocol.

## Features

- Direct PTY via Bun — no external `ttyd` process needed
- Mobile support — soft keyboard, touch selection, long-press word select, paste helper for iOS
- Terminal resize — automatic reflow on browser window resize
- Copy tools — copy selection, copy recent output, selectable text panel

## Requirements

- [Bun](https://bun.sh) v1.3.5+

## Quick start

```bash
bun install
bun dev
```

Open the printed URL in a browser.

## Build

```bash
bun run build
```

## Test

```bash
bun test
```
