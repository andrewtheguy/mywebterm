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
-m webbrowser`, Shopify CLI's preview shortcut) are separate from link clicks.
By default, they keep their normal behavior on the shell's host. MyWebTerm does
not install an opener, wrap the configured command or ssh login, or alter
`BROWSER`, `PATH`, `DISPLAY`, `WAYLAND_DISPLAY`, or `WEBTERM_TTY` for this
feature. Any policy or integration belongs in the environment that launches
MyWebTerm, the shell profile, ssh target, or multiplexer configuration.

#### One-time cleanup after v0.0.73–v0.0.76

Those releases left the generated helper on disk so long-lived tmux servers
would not lose it. This version intentionally does not delete host files either.
If an old `BROWSER` still points at `webterm-open`, clear it from the shell or
service that owns it. Existing tmux servers can also retain the old values:

```bash
unset BROWSER WEBTERM_TTY
tmux set-environment -gu BROWSER
tmux set-environment -gu WEBTERM_TTY
```

Clearing tmux's server environment only affects newly created processes, so
restart any existing tmux shells or panes that inherited those variables.
Restart a long-lived zellij session if it inherited them too. The stale helper
file is inert once nothing points at it; if desired, manually remove
`webterm-open` from the `mywebterm/bin` directory under `$XDG_RUNTIME_DIR`,
`$XDG_CACHE_HOME` (or `~/.cache`), or `/tmp/mywebterm-$(id -u)`.

#### Block host-side browsers

If the MyWebTerm process inherits a graphical session and browser launches are
unwanted, remove the display variables outside the program. Setting `BROWSER`
to `/bin/false` also stops programs that honor an explicit browser command:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY BROWSER=/bin/false mywebterm
```

For a systemd service, put the same policy in the unit:

```systemd
[Service]
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY
Environment=BROWSER=/bin/false
```

Run `systemctl daemon-reload` and restart the service after editing it.

#### Opt in to browser-opening toasts

To route an application's browser request to the browser viewing MyWebTerm,
install [`scripts/webterm-open`](scripts/webterm-open) yourself on the host
where that application runs and point `BROWSER` at its absolute path:

```bash
mkdir -p "$HOME/.local/bin"
install -m 755 scripts/webterm-open "$HOME/.local/bin/webterm-open"
export BROWSER="$HOME/.local/bin/webterm-open"
```

Put the export in that host's shell profile if it should apply to every shell.
For a local shell launched by a systemd-managed MyWebTerm, use an external
service setting such as
`Environment=BROWSER=/home/you/.local/bin/webterm-open`. For an ssh session,
copy the script to the target host and configure `BROWSER` in the remote login
environment; MyWebTerm does not transfer it or add a remote ssh command.

The script prints `OSC 1338 ; <url> BEL`; MyWebTerm shows a toast with an
**Open** button, and clicking it opens the URL locally. The confirmation is
deliberate — anything writing to the tty can emit that sequence, and browsers
block popups that no click asked for.

Multiplexers need their own setup too:

- **tmux:** make `BROWSER` available to new panes (start the tmux server with it,
  configure it in each pane's shell profile, or use `tmux set-environment -g
  BROWSER "$HOME/.local/bin/webterm-open"`). The helper normally asks tmux for
  the attached client's tty. On tmux 3.3 or newer, its wrapped fallback requires
  `set -g allow-passthrough on` in `~/.tmux.conf`; older versions do not
  recognize that option, so omit it there.
- **zellij:** zellij does not currently offer tmux-style arbitrary escape
  passthrough ([upstream issue](https://github.com/zellij-org/zellij/issues/3954)).
  Record the outer tty yourself before starting zellij and make both variables
  available to its panes:

  ```bash
  export BROWSER="$HOME/.local/bin/webterm-open"
  export WEBTERM_TTY="$(tty)"
  zellij
  ```

  A long-lived zellij server can retain a stale tty from the terminal where it
  started. Refresh or restart that external setup when attaching from a
  different terminal.
- **Detached launchers or hosts without `/proc`:** set `WEBTERM_TTY="$(tty)"`
  before launching the program or multiplexer. On Linux the helper also tries
  to find a terminal held by an ancestor process.

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
