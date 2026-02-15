# MyWebTerm

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> There is no limit on concurrent sessions; every browser tab spawns its own shell.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

A web-based terminal that runs your shell in the browser. Built with React, xterm.js, and Bun's built-in PTY.

When a browser connects, the server spawns `$SHELL` (falling back to `/bin/sh`) as a pseudo-terminal and bridges it to the frontend over WebSocket. Sessions are decoupled from connections — if a WebSocket drops, the PTY stays alive and the client automatically reconnects with scrollback replay.

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

- Direct PTY via Bun — spawns shell processes but does not require external terminal daemons (e.g., ttyd)
- Session persistence — PTY survives connection drops, auto-reconnect with scrollback replay
- Heartbeat — server-initiated ping/pong detects stale connections; detached sessions are cleaned up after 5 minutes
- Graceful shutdown — SIGTERM/SIGINT kill all PTY processes for fast systemd restarts
- Mobile support — soft keyboard, touch selection, long-press word select, paste helper for iOS
- Terminal resize — automatic reflow on browser window resize
- Copy tools — copy selection, copy recent output, selectable text panel

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8671` | Port to listen on |
| `DAEMONIZE` | `0` | Set to `1` to detach from the parent process (strips `ZELLIJ`/`TMUX` env vars from spawned shells) |
| `DISABLE_HSCROLL` | `0` | Set to `1` to disable the minimum 80-column width with horizontal scrollbar on narrow viewports |
| `APP_TITLE` | `MyWebTerm` | Customize the app heading and browser tab title |

### Exposing publicly

MyWebTerm gives full shell access to anyone who can reach it — it is a highly privileged program. For this reason it only listens on the loopback interface (`127.0.0.1`) and cannot be configured to bind to other addresses. To make it accessible over a network, put it behind a reverse proxy that handles authentication, such as [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) or Caddy with basic auth.

> [!NOTE]
> Avoid using HTTP basic auth with Safari — Safari does not reliably send cached credentials for WebSocket upgrade requests and XHR/fetch calls, which will break the terminal connection. Use cookie/session-based auth (e.g. OAuth2 Proxy) instead.

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
