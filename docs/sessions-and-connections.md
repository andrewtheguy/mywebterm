# Sessions & Connections

Most confusion about MyWebTerm comes from treating "session" as one thing. It is
**three** independent things with independent lifetimes. Logout, restart, start,
and resume each act on a different subset of them.

## The three concepts

| Concept | Lives in | Identified by | Lifetime |
|---|---|---|---|
| **Auth session** | `src/auth.ts` — `validTokens` Map + `mywebterm_session` cookie | token (UUID) in an HttpOnly cookie | 24h, refreshed on every authenticated request; purged when expired |
| **PTY session** | `src/sessionManager.ts` — `sessions` Map | `sessionId` (UUID) | from shell spawn until the shell exits, a restart, or the 5-min idle sweep |
| **WebSocket connection** | `src/index.ts` `websocket{}` handlers | `connectionId` (per socket) | from upgrade until the socket closes |

The PTY session is **decoupled** from the WebSocket: if the socket drops, the
shell keeps running and the client reconnects later (replaying scrollback). The
auth session is decoupled from both: it is just "are you allowed to talk to the
server at all."

## Start vs. Resume (the handshake)

When a WebSocket opens, the client must send one control message within 30s or
the server closes it with code **4003** (`index.ts:408`). That message is one of:

- **Start** → `{ type: "handshake", columns, rows }` → `createSession`
  (`sessionManager.ts:192`). Mints a new `sessionId`, spawns a fresh shell,
  replies `{ type: "session_info", sessionId }`. The client saves the id in
  `sessionStorage` under `mywebterm-session-id` (`useTerminal.ts:80`).

- **Resume** → `{ type: "reconnect", sessionId, columns, rows }` → `attachSession`
  (`sessionManager.ts:270`). Re-attaches to the existing PTY, resizes it if the
  viewport changed, and **replays the scrollback buffer** so the screen is
  restored.

On page load the client tries **resume** first using the stored id. If the
server replies `{ type: "error", message: "Session not found or already dead" }`
(`sessionManager.ts:274`), the client clears the stored id and falls back to a
fresh **start**.

```
page load ─► stored sessionId? ─yes─► send "reconnect" ─► exists?─yes─► attach + replay
                  │                                          │
                  no                                         no ─► error ─► clear id
                  ▼                                                          │
              send "handshake" ◄──────────────────────────────────────── (retry)
```

## One viewer per terminal (the "kick out")

A PTY session holds at most **one** attached WebSocket at a time. When a second
connection attaches to the *same* `sessionId`, the previous socket is evicted
with close code **4002** (`attachSession:278`):

```ts
// Detach previous client if still connected
if (session.attachedWs && session.attachedWs !== ws) {
  closeClientSocket(session.attachedWs, 4002, "Replaced by new connection");
}
```

**Why this exists:** it prevents two live connections from driving the *same*
shell at once and clobbering each other's input/output (the classic split-brain
when a reconnect races a still-open socket).

This is **per-`sessionId`**, not per-tab or per-user. The `sessionId` lives in
`sessionStorage`, which is scoped to a single tab and is **not** shared across
tabs, browsers, or devices. So opening MyWebTerm in a new tab/browser/device
sends a fresh **handshake** and spawns its own independent shell — these coexist
and nobody is evicted. You can run as many concurrent shells as you like.

Eviction (4002) only fires when a second live connection attaches to the **same**
`sessionId`, which requires that id to be reused — in practice:

- **Reload** of a tab (it reconnects to its own session; the old socket has
  usually already closed, so normally no overlap, but a brief race is possible).
- **Duplicating a tab** — browsers copy `sessionStorage` into the duplicate, so
  it reconnects to the original's shell and takes it over.
- A **reconnect race** where a stale/zombie socket on that session is still
  attached when the new one arrives.

## Heartbeat & stale cleanup

- **Heartbeat** (`startHeartbeat`, `sessionManager.ts:160`): while attached, the
  server sends `{ type: "ping" }` every **30s** and expects a `pong`. If no pong
  arrives within **10s**, the connection is force-detached with close code
  **4001** (the PTY stays alive). Constants: `HEARTBEAT_INTERVAL_MS`,
  `HEARTBEAT_TIMEOUT_MS`.
- **Stale sweep** (`sweepStaleSessions`, `sessionManager.ts:395`): every **60s**
  the server destroys any PTY that has been *detached* for more than **5 minutes**
  (`SESSION_IDLE_TIMEOUT_MS`). This reclaims abandoned shells.
- **Auth purge** (`auth.ts:21`): expired auth tokens are dropped hourly.

## Logout vs. Restart

These act on different concepts — this is the key distinction.

| Action | Trigger | Auth session | PTY session(s) | Net effect |
|---|---|---|---|---|
| **Logout** | `App.tsx` logout button → `POST /api/auth/logout` | **invalidated**, cookie cleared | **destroyed** (`destroyAllSessions`) | Fully signed out; next login **starts fresh** |
| **Restart** | toolbar restart → `POST /api/restart` | untouched | **destroyed** | Still logged in; gets a brand-new shell |

### Logout flow (current behavior)

Logout deliberately tears down everything so the next login can never resume a
stale shell — which previously made the UI say "resume" right after a logout.

- **Server** (`handleLogout`, `index.ts:311`): invalidates the token, then calls
  `destroyAllSessions()` (`sessionManager.ts:360`), killing each shell and
  closing its socket. Responds with a cleared cookie.
- **Client** (`handleLogout`, `App.tsx:1616`): removes `mywebterm-session-id`
  from `sessionStorage`, then navigates to `/login`.

Because the stored id is gone and the PTY is destroyed, logging back in always
sends a **handshake** (fresh shell), never a **reconnect**.

### Restart flow

`handleRestart` (`index.ts:382`) calls the same `destroyAllSessions()` but leaves
the auth token intact. Client-side `restart()` (`useTerminal.ts:1043`) clears the
stored id and reconnects, so a new shell spins up while you stay logged in. Use
it to clear a wedged shell or stale process.

## WebSocket close codes

| Code | Name | Meaning | Client reaction (`useTerminal.ts:979`) |
|---|---|---|---|
| `1000` | Normal | Shell exited / session destroyed | Clear stored id; show "Disconnected"; stop |
| `1002` | Protocol error | Invalid control message (`index.ts:178`) | Default: backoff reconnect |
| `4000` | Restart | Session destroyed by restart/logout (`RESTART_CLOSE_CODE`) | Clear id, reset terminal, reconnect immediately ("Restarting…") |
| `4001` | Heartbeat timeout | No pong in time (`HEARTBEAT_CLOSE_CODE`) | Keep id, backoff reconnect ("Connection lost") |
| `4002` | Replaced | Another connection attached to the same `sessionId` | Default: backoff reconnect |
| `4003` | Handshake timeout | No handshake/reconnect within 30s of open | Default: backoff reconnect |

> Note on logout: server-side `destroyAllSessions()` closes the live socket with
> code `4000`, which the client would normally treat as "Restart" and reconnect.
> Because logout immediately does a full-page navigation to `/login` (and the
> cookie is now cleared, so any reconnect would `401`), that attempt is torn down
> by the page reload. Clearing `sessionStorage` keeps the post-login state clean.

## Cross-references

- Wire format for control messages and frames: [WebSocket Protocol](./websocket-protocol.md)
- Component map and routes: [Architecture](./architecture.md)
