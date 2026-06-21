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
                                     │  └─ ScrollbackBuffer (100KB ring)     │
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
| `src/sessionManager.ts` | PTY session map, spawn/attach/detach/destroy, heartbeat, stale sweep, scrollback |
| `src/auth.ts` | Cookie-based auth sessions (token map, TTL, `Set-Cookie` helpers) |
| `src/ttyProtocol.ts` | Encode/decode of control messages and binary tty frames |
| `src/App.tsx` | React UI shell, toolbar, logout/restart buttons |
| `src/useTerminal.ts` | xterm.js wiring, WebSocket connection, reconnect/backoff, sessionStorage |
| `src/loginPage.ts` | Standalone `/login` page HTML |

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
shell output ──► Bun terminal data() callback ──► scrollbackBuffer.write()
                                              └─► sendOutputFrame(attachedWs)
                                                     │
output frame ◄────────────────────────── WS ◄───────┘
   └─► useTerminal writes bytes into xterm.js ──► rendered to canvas/DOM
```

- Output is **always** appended to the session's 100KB `ScrollbackBuffer` ring
  (`sessionManager.ts:44`) even while detached, then forwarded to the attached
  WebSocket if one is present. On reconnect the buffer is replayed so the screen
  is restored. See `attachSession` (`sessionManager.ts:270`).
- Terminal resize travels as a `RESIZE_TERMINAL` frame and calls
  `proc.terminal.resize()` (`index.ts:231`).

For the exact frame and message formats, see
[WebSocket Protocol](./websocket-protocol.md).
