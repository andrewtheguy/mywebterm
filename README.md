# MyWebTerm

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> There is no limit on concurrent sessions; every browser tab spawns its own shell.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

A web-based terminal that runs your shell in the browser. Built with React, xterm.js, and Bun's built-in PTY.

When a browser connects, the server spawns `$SHELL` (falling back to `/bin/sh`) as a pseudo-terminal and bridges it to the frontend over WebSocket using the ttyd binary frame protocol.

## Usage

```bash
mywebterm [-- command [args...]]
```

By default each session runs `$SHELL`. Pass a command after `--` to override:

```bash
mywebterm -- fish
mywebterm -- bash --norc
mywebterm -- python3
```

## Features

- Direct PTY via Bun — no external `ttyd` process needed
- Mobile support — soft keyboard, touch selection, long-press word select, paste helper for iOS
- Terminal resize — automatic reflow on browser window resize
- Copy tools — copy selection, copy recent output, selectable text panel

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `::` | Hostname/address to bind |
| `PORT` | `8671` | Port to listen on |
| `DAEMONIZE` | `0` | Set to `1` to detach from the parent process (strips `ZELLIJ`/`TMUX` env vars from spawned shells) |
| `DISABLE_HSCROLL` | `0` | Set to `1` to disable the minimum 80-column width with horizontal scrollbar on narrow viewports |

`SHELL` is read from the system environment (set by your OS/login shell) and used as the default command when nothing is passed after `--`. Do not set it manually — use `-- command` to override instead.

## Install

```bash
curl -fsSL https://andrewtheguy.github.io/mywebterm/install.sh | bash
```

Or install a specific version:

```bash
curl -fsSL https://andrewtheguy.github.io/mywebterm/install.sh | bash -s v0.0.4
```

Pre-built binaries are available for Linux (amd64, arm64) and macOS (arm64).

## Development

### Requirements

- [Bun](https://bun.sh) v1.3.5+

### Quick start

```bash
bun install
bun dev
```

Open the printed URL in a browser.

### Build

```bash
bun run build
```

### Test

```bash
bun test
```
