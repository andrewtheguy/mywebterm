# MyWebTerm

> [!IMPORTANT]
> MyWebTerm is a single-user tool: it is built for one operator (who may connect from multiple devices), and provides no multi-user isolation or security. Don't expose it to multiple distinct users.
> Each browser tab spawns its own independent shell, so you can run many at once across tabs and devices. A single shell stays attached to one connection at a time, so reconnecting to that same shell (e.g. after a reload, or from a duplicated tab) takes over and drops the previous connection.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

A web-based terminal that runs your shell in the browser. Built with React, xterm.js, and Bun's built-in PTY.

When a browser connects, the server spawns `$SHELL` (falling back to `/bin/sh`) as a pseudo-terminal and bridges it to the frontend over WebSocket. Sessions are decoupled from connections — if a WebSocket drops, the PTY stays alive and the client automatically reconnects and restores the screen from a server-side snapshot.

## Screenshots

<table>
<tr>
<td><strong>Desktop</strong></td>
<td><strong>Mobile</strong></td>
</tr>
<tr>
<td><img width="600" alt="Desktop screenshot" src="https://github.com/user-attachments/assets/af8c2165-de0a-427b-b6b0-8965c5a61207" /></td>
<td><img width="200" alt="Mobile screenshot" src="https://github.com/user-attachments/assets/5211b2cf-2988-4c3c-9b17-7f973389ef4e" /></td>
</tr>
</table>

## Usage

```bash
mywebterm [options] [-- command [args...]]
```

By default each session runs `$SHELL`. Pass a command after `--` to override:

```bash
mywebterm -- fish
mywebterm -- bash --norc
mywebterm --listen 9090 --title Dev -- python3
```

### SSH sessions

The start screen offers an explicit choice: start the local shell, or SSH to
another host. Choosing SSH shows the `Host` aliases from the `--ssh-config`
file (if configured) as one-click choices, plus a free-form
`user@host[:port]` field (IPv6 literals work too: `user@[fdb8::1]` or
`user@[fdb8::1]:2222`). SSH sessions run the system `ssh` client (spawned
with `ServerAliveInterval=30` keepalives so a dead network can't leave it
hanging). Lifecycle is identical to shell sessions: the ssh process survives
reconnects, and is killed — with SIGKILL escalation if it ignores SIGTERM —
when the session is destroyed or has been detached for 5 minutes, so
disconnected pages never leave dangling ssh processes behind.

`--ssh-config <path>` points ssh at a custom OpenSSH client config (the
standard `ssh -F` mechanism — no custom config format), replacing
`~/.ssh/config` for these sessions. Anything ssh supports works there:
`HostName`, `User`, `IdentityFile`, `ProxyJump`, etc.

`LANG`/`LC_*` are stripped from ssh sessions' environment (ssh would otherwise
forward this machine's locale to remote hosts that may not have it generated,
causing setlocale warnings on login); the remote host's default locale is used
instead.

## Features

- Direct PTY via Bun — spawns shell processes but does not require external terminal daemons (e.g., ttyd)
- Session persistence — PTY survives connection drops, auto-reconnect restoring screen, scrollback, and terminal modes (full-screen apps like zellij survive reconnects)
- Heartbeat — server-initiated ping/pong detects stale connections; detached sessions are cleaned up after 5 minutes
- Graceful shutdown — SIGTERM/SIGINT kill all PTY processes for fast systemd restarts
- Mobile support — soft keyboard, touch selection, long-press word select, paste helper for iOS
- Terminal resize — automatic reflow on browser window resize
- Copy tools — copy selection, copy recent output, selectable text panel
- Inline images — sixel, iTerm2 inline images (IIP), and kitty graphics via `@xterm/addon-image`; decoded in the browser, so no GPU is needed on the server. Images are not restored after a reconnect (the resume snapshot is text-only)
- Flexible binding — a single `--listen` option takes a port, a host:port, or a unix domain socket (with an explicit mode) for reverse-proxy setups
- Link opening — URLs in the output are clickable and open in the browser viewing the terminal; programs on the far side can request an open with `webterm-open`

### Opening links

Clicking a URL in the terminal opens it in a new tab **of the browser you are
viewing MyWebTerm in** — never on the machine the shell or ssh session is
running on. This covers plain URLs in the output and OSC 8 hyperlinks (`ls
--hyperlink`, `gh`, `cargo`, …). Only `http`/`https` links open; anything else
is refused.

Programs that launch a browser themselves (`xdg-open`, `gh auth login`, `python
-m webbrowser`, Shopify CLI's preview shortcut) never print a URL to click —
they spawn a browser on the host the shell is running on, where there is no
display. MyWebTerm handles this without any setup: every session gets a
`webterm-open` helper with `$BROWSER` pointed at it, so those programs end up
opening a tab in the browser you are viewing MyWebTerm in. `$BROWSER` holds an
absolute path, because `$PATH` is not dependable — a login shell sources
`/etc/profile`, which replaces `$PATH` rather than adding to it, and tmux hands
every new pane a login shell. The helper's directory is prepended to `$PATH` as
well, so the command can be typed by hand in shells that keep it.

Nothing is installed by hand, on any host. Local sessions get the helper from a
private directory created at startup and deleted on exit. ssh sessions carry it
over the ssh command line into `$XDG_RUNTIME_DIR` on the remote host — which
logind clears when your last session there ends, so nothing persists — falling
back to `~/.cache` on hosts that have no runtime dir. If the remote is read-only
or lacks `base64`, the install is skipped and the session starts as usual, just
without the helper.

The helper prints `OSC 1338 ; <url> BEL`; MyWebTerm shows a toast with an
**Open** button, and clicking it opens the URL locally. The confirmation is
deliberate — anything writing to the tty can emit that sequence, and browsers
block popups that no click asked for.

Delivering that sequence is less obvious than it looks:

- Launchers built on the npm `open` package spawn the browser detached, so it
  has no controlling terminal and its stdio is `/dev/null`. The helper falls
  back to `$WEBTERM_TTY` and then to a terminal an ancestor process still holds.
- Inside **tmux or zellij**, `/dev/tty` is only the pane, and the pane's owner
  decides what escapes. With a stock tmux config nothing escapes at all — even
  the DCS passthrough needs `set -g allow-passthrough on` — and zellij drops the
  sequence whatever the wrapping, with no passthrough option to turn on. So the
  helper writes to the outer terminal
  directly instead, found via `tmux display-message -p '#{client_tty}'`, then
  `$WEBTERM_TTY` (exported into every session for exactly this), then
  `$SSH_TTY`. Neither multiplexer needs configuring, and `allow-passthrough`
  only matters as a fallback.

  The one case that misses is attaching to a multiplexer session that was
  started outside MyWebTerm: its server hands panes the `$WEBTERM_TTY` it was
  started with, so under zellij the toast can land in the terminal that session
  came from. tmux is asked live and is unaffected.
- On a host without `/proc` (macOS), set `export WEBTERM_TTY="$(tty)"` there to
  cover the detached-launcher case.

### Inline images

Programs that output terminal graphics render real pixel images in the browser.
Detection is automatic — the terminal advertises sixel in its Device Attributes
(DA1) response and answers pixel-size reports (`CSI 14 t` / `CSI 16 t`), so
well-behaved tools pick sixel without any flags:

```bash
chafa photo.jpg          # auto-detects sixel
img2sixel photo.png
yazi                     # image preview works out of the box
```

Notes:

- Decoding happens client-side in `@xterm/addon-image`; the server just passes
  bytes through, so a headless server without a GPU works fine.
- Sixel and iTerm2 IIP are fully supported; kitty graphics support is partial
  (still work-in-progress upstream in the addon).
- Images live only in the browser: they are dropped on reconnect because the
  resume snapshot is text-only (see
  [Architecture — Inline images](docs/architecture.md#inline-images)).
- Image storage is capped at 32 MB (FIFO); oldest images are evicted first and
  replaced with a placeholder.

## Options

| Flag | Default | Description |
|---|---|---|
| `-h`, `--help` | | Show usage and exit |
| `-v`, `--version` | | Show version and exit |
| `-l`, `--listen <target>` | `127.0.0.1:8671` | Where to bind — see [Listen targets](#listen-targets) |
| `--htpasswd-file <path>` | `.htpasswd` | Path to htpasswd credentials file |
| `--daemonize` | off | Detach from the parent process and run in the background |
| `--no-auth` | off | Disable authentication (loopback or unix socket only) |
| `--title <s>` | `MyWebTerm` | Customize the app heading and browser tab title |
| `--ssh-config <path>` | | OpenSSH client config for ssh sessions (`ssh -F`); its `Host` aliases appear on the start screen |

A shell command can be specified after `--` (e.g. `mywebterm -- /bin/bash`). When omitted, the `SHELL` environment variable is used (falling back to `/bin/sh`). `SHELL` is set by your OS/login shell — do not set it manually; use `-- command` to override instead.

### Listen targets

`--listen` is the only binding option; it takes one of these forms:

| Value | Meaning |
|---|---|
| `8671` | That port on `127.0.0.1` |
| `0.0.0.0:8671` | Host and port; any interface |
| `[::1]:8671` | IPv6 literal — brackets are required so the port is unambiguous |
| `unix:/run/mywebterm.sock` | Unix domain socket, created with mode `600` |
| `unix:/run/mywebterm.sock,mode=660` | Unix socket with explicit permissions |

A unix socket removes network exposure entirely, which moves the access control
onto the filesystem: any local user who can open the socket file can connect.
`600` (the default) is owner-only; `660` with a shared group is the usual
choice when the reverse proxy in front runs as another user, but it hands a
connection to every member of that group — and with `--no-auth` that is an
unauthenticated shell, so pick the group accordingly. `--no-auth` is allowed
here for the same reason it is allowed on loopback: nothing off the machine can
reach the listener.

A socket left behind by a crash is reclaimed at startup; if a live server is
already listening on it, the new one refuses to start rather than stealing the
path. The socket is removed on exit.

```bash
mywebterm --listen unix:/run/mywebterm.sock,mode=660 --no-auth
```

```caddyfile
# Caddy in front of it
webterm.example.com {
    reverse_proxy unix//run/mywebterm.sock
}
```

### Authentication

MyWebTerm uses an `.htpasswd` file with bcrypt-hashed passwords. Generate credentials with:

```bash
bun run htpasswd <username> > .htpasswd
```

The server reads `.htpasswd` from the working directory by default. Use `--htpasswd-file <path>` or the `HTPASSWD_FILE` environment variable to specify a different location. The file is hot-reloaded when it changes.

Use `--no-auth` to disable authentication entirely. It is only allowed when the listener is unreachable from the network — a loopback address or a unix socket. On a unix socket the socket's mode is then the only thing standing between other local users and a shell, so keep it at `600` unless a specific group needs in (see [Listen targets](#listen-targets)).

### Exposing publicly

MyWebTerm gives full shell access to anyone who can reach it — it is a highly privileged program. By default it only listens on the loopback interface (`127.0.0.1:8671`). When authentication is enabled (the default), you can use `--listen` to bind elsewhere, e.g. `--listen 0.0.0.0:8671`. Alternatively, put it behind a reverse proxy such as [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) or Caddy — a unix socket (`--listen unix:/run/mywebterm.sock`) is the tidiest way to do that, since the server is then unreachable except through the proxy.

> [!NOTE]
> Avoid using HTTP basic auth with Safari — Safari does not reliably send cached credentials for WebSocket upgrade requests and XHR/fetch calls, which will break the terminal connection. Use cookie/session-based auth (e.g. OAuth2 Proxy) instead.

## Install

```bash
curl -fsSL https://andrewtheguy.github.io/mywebterm/install.sh | bash
```

Or install a specific version:

```bash
curl -fsSL https://andrewtheguy.github.io/mywebterm/install.sh | bash -s v0.0.4
```

Pre-built binaries are available for Linux (amd64, arm64) and macOS (arm64).

## Documentation

Internal architecture and protocol docs live in [`docs/`](docs/):

- [Architecture](docs/architecture.md) — component map, routes, and data flow
- [Sessions & Connections](docs/sessions-and-connections.md) — auth session vs. PTY session vs. WebSocket connection, start/resume, and logout vs. restart
- [WebSocket Protocol](docs/websocket-protocol.md) — control messages and binary tty frame format

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
