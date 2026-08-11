# Architecture

MyWebTerm is a single-process Bun server that spawns a shell as a pseudo-terminal
(PTY) and bridges it to a React frontend over a WebSocket. There is no external
terminal daemon (e.g. ttyd); the PTY comes from `Bun.spawn(..., { terminal })`.

## Component map

```
 Browser                              Bun server (single process)
┌──────────────────────────┐        ┌───────────────────────────────────────┐
│  App.tsx (React UI)       │        │  index.ts                             │
│  └─ useTerminal.ts        │  WS    │  ├─ Bun.serve routes + websocket{}    │
│      (xterm.js + socket)  │◄──────►│  ├─ auth gate (cookie check)          │
│                           │  /tty/ │  └─ handleWsMessage (control + frames)│
│  loginPage.ts (login)     │   ws   │                                       │
└──────────────────────────┘        │  sessionManager.ts                    │
                                     │  ├─ sessions: Map<sessionId, PtySession>
                                     │  ├─ createSession / attachSession     │
                                     │  ├─ heartbeat + stale sweep           │
                                     │  └─ shadow terminal (@xterm/headless) │
                                     │        │ Bun.spawn terminal           │
                                     │        ▼                              │
                                     │     $SHELL (PTY process)              │
                                     │                                       │
                                     │  auth.ts  — token/cookie sessions     │
                                     │  ttyProtocol.ts — wire format         │
                                     └───────────────────────────────────────┘
```

Key files:

| File | Responsibility |
|---|---|
| `src/index.ts` | `Bun.serve` setup, HTTP routes, auth gate, WebSocket lifecycle, message router |
| `src/sessionManager.ts` | PTY session map, spawn/attach/detach/destroy, heartbeat, stale sweep, shadow terminal + resume snapshot |
| `src/auth.ts` | Cookie-based auth sessions (token map, TTL, `Set-Cookie` helpers) |
| `src/ttyProtocol.ts` | Encode/decode of control messages and binary tty frames |
| `src/App.tsx` | React UI shell, toolbar, logout/restart buttons |
| `src/useTerminal.ts` | xterm.js wiring, WebSocket connection, reconnect/backoff, sessionStorage |
| `src/loginPage.ts` | Standalone `/login` page HTML |
| `src/openUrl.ts` | URL validation and new-tab opening for terminal links and OSC 1338 |
| `src/listenTarget.ts` | Parsing of `--listen` (port, host:port, or `unix:<path>[,mode=NNN]`) |
| `scripts/webterm-open` | Optional, manually installed helper that emits OSC 1338 |

## HTTP routes

Defined in the `routes` table at `src/index.ts:387`.

| Route | Method | Auth required | Purpose |
|---|---|---|---|
| `/` | GET | yes | The terminal app (HTML) |
| `/login` | GET | no | Login page |
| `/api/auth/login` | POST | no | Verify credentials, set session cookie |
| `/api/auth/logout` | POST | cookie | Invalidate token, clear cookie, **destroy PTYs** |
| `/api/auth/check` | GET | no | Report whether the request is authenticated |
| `/api/config` | GET | yes | Version, app title, shell command, `authEnabled` |
| `/api/sessions` | GET | yes | List active PTY sessions + child processes |
| `/api/restart` | POST | yes | Destroy all PTY sessions (keep login) |
| `/tty/ws` | WS upgrade | cookie | Terminal I/O channel |
| static | GET | no | fonts (`.woff2`), PWA icons, `manifest.json`, `sw.js` |

### Auth gate

Before serving `/api/*` or upgrading `/tty/ws`, the request must carry a valid
session cookie (unless the server was started with `--no-auth`). The gate is in
`fetch()` at `src/index.ts:458`: unauthenticated API/WS requests get `401`,
everything else gets `404`. See [Sessions & Connections](./sessions-and-connections.md)
for what the cookie represents.

## Data flow (keystroke → screen)

```
keypress ──► useTerminal encodes INPUT frame ──► WS ──► handleWsMessage
                                                          └─► proc.terminal.write()
shell output ──► Bun terminal data() callback ──► shadowTerm.write()
                                              └─► sendOutputFrame(attachedWs)
                                                     │
output frame ◄────────────────────────── WS ◄───────┘
   └─► useTerminal writes bytes into xterm.js ──► rendered to canvas/DOM
```

- Output is **always** parsed into the session's server-side **shadow terminal**
  (`@xterm/headless`, see `createShadowTerminal` in `sessionManager.ts`) even
  while detached, then forwarded to the attached WebSocket if one is present.
- On reconnect, `attachSession` sends a **serialized snapshot** of the shadow
  terminal (`@xterm/addon-serialize`) instead of replaying raw bytes. The
  snapshot restores scrollback, the alternate screen, cursor state, and DEC
  private modes (mouse tracking, bracketed paste, etc.), so full-screen apps
  like zellij keep working across reconnects. The serialize addon does not emit
  the mouse *encoding* mode, so `buildSnapshot` appends `?1006h`/`?1016h`
  manually. Live output that arrives while the snapshot is being prepared is
  queued (`attachPending`) and flushed afterwards to preserve byte order.
  The snapshot is text-only: inline images rendered by the client's
  `@xterm/addon-image` (sixel/IIP/kitty) are dropped on reconnect — the
  headless shadow terminal discards image sequences and the serialize addon
  cannot emit them.
- Terminal resize travels as a `RESIZE_TERMINAL` frame and calls
  `resizeSession`, which resizes both the PTY and the shadow terminal.

For the exact frame and message formats, see
[WebSocket Protocol](./websocket-protocol.md).

## Opening links

The URL bytes reach the browser like all other output — through the PTY, the
shadow terminal, and the WebSocket — but the server has no link-handling code:
validation and navigation live entirely on the client (`src/openUrl.ts`, wired
up in `useTerminal.ts`). Every URL is run through
`normalizeOpenableUrl`, which accepts only `http:`/`https:`, rejects embedded
credentials (`https://github.com@evil.example`) and rejects control characters,
spaces and bidi overrides — output on a tty is attacker-controlled in exactly
the way a URL bar is not. Opening goes through a synthetic `<a target="_blank"
rel="noopener noreferrer">` click rather than `window.open`, which keeps the
user gesture and avoids `noopener` swallowing the return value.

Two paths reach it:

| Trigger | Path | Confirmation |
|---|---|---|
| Click on a plain URL in the output | `WebLinksAddon` → `activateTerminalLink` | none — the click *is* the gesture |
| Click on an OSC 8 hyperlink | `linkHandler` terminal option → `activateTerminalLink` | none |
| `OSC 1338 ; <url> BEL` from the far side | `createOpenUrlOscHandler` → sonner toast | **Open** button |

OSC 1338 is MyWebTerm's own identifier (one past iTerm2's 1337). It exists so a
program can ask the viewer to open a page. The sequence arrives without a user
gesture, so the client requires an **Open** click; that also prevents any
process writing to the tty from navigating the viewer silently. Toast ids are
keyed on the URL, so repeat requests replace their own toast instead of
stacking.

### Optional webterm-open integration

The server deliberately stops at the OSC handler. It does not embed, install,
or inject an opener, and it does not modify `BROWSER`, `PATH`, `DISPLAY`,
`WAYLAND_DISPLAY`, or `WEBTERM_TTY`. Local sessions receive the configured
command directly. SSH sessions receive a normal ssh invocation with no remote
command or bootstrap payload. This keeps process and environment policy outside
the terminal server.

[`scripts/webterm-open`](../scripts/webterm-open) is an optional administrator
tool, not runtime server code. A user may install it on a local or remote host
and set `BROWSER` in a shell profile, systemd unit, tmux environment, or other
external launcher. Conversely, a user who wants no host-side browser can clear
`DISPLAY`/`WAYLAND_DISPLAY` and set `BROWSER=/bin/false` in that launcher. The
concrete recipes live in the README.

The helper writes to `/dev/tty`, not stdout, because callers like `gh auth
login` capture stdout. For detached launchers it tries a user-supplied
`WEBTERM_TTY`, then walks `/proc/<ppid>/fd/{2,1,0}` for a terminal held by an
ancestor. Inside tmux it first asks for the attached client tty and otherwise
uses a DCS passthrough; the latter requires `allow-passthrough`. Zellij has no
equivalent arbitrary escape passthrough, so a user must provide `WEBTERM_TTY`
before starting it (or rely on `SSH_TTY` in an ssh session). None of those
variables or settings is supplied by MyWebTerm.

The handler mirrors the OSC 52 clipboard bridge next to it, which is the same
shape of problem: a terminal escape asking the *browser* to do something the
remote host cannot.

## Inline images

Image sequences are handled entirely on the client by `@xterm/addon-image`,
loaded in `useTerminal.ts` next to the fit and WebGL addons (it requires
`allowProposedApi: true` on the xterm `Terminal`). The server plays no part in
image handling — sixel/IIP/kitty payloads travel through the WebSocket as
ordinary output bytes and are decoded in the browser (the addon ships an
inlined WASM sixel decoder), so a headless server without a GPU is fully
sufficient.

Supported protocols:

| Protocol | Encoding | Status |
|---|---|---|
| Sixel | `DCS q ... ST` | Full |
| iTerm2 inline images (IIP) | `OSC 1337 ; File=... ST` | Full (PNG/JPEG/GIF/QOI, no animation) |
| Kitty graphics (TGP) | `APC G ... ST` | Partial (WIP upstream) |

How applications detect support:

- The addon rewrites the DA1 (primary Device Attributes) response to
  `CSI ? 62 ; 4 ; 9 ; 22 c` — the `4` advertises sixel, which is how tools like
  `chafa`, `img2sixel`, and `yazi` auto-select a graphics protocol.
- It also enables the `windowOptions` pixel-size reports (`CSI 14 t` window
  size, `CSI 16 t` cell size, `CSI 18 t` size in chars) that image tools use to
  scale output to the character grid. `TERM` stays `xterm-256color`; detection
  works via these runtime queries, not terminfo.

Constraints and lifecycle:

- Image storage is a 32 MB FIFO cache (`storageLimit` in `useTerminal.ts`);
  evicted images show a placeholder.
- Images exist only in the attached browser tab. The server-side shadow
  terminal (`@xterm/headless`) discards image sequences, and
  `@xterm/addon-serialize` cannot emit them, so the resume snapshot is
  text-only and images do not survive reconnects.
- `Terminal.reset()` does **not** clear the addon's image storage (the API
  reset bypasses the RIS sequence handler the addon listens to), so every
  `terminal.reset()` call site in `useTerminal.ts` is paired with an explicit
  `imageAddon.reset()` — otherwise stale images would composite over the
  replayed snapshot after a reconnect.
