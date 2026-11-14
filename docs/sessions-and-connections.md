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
shell keeps running and the client reconnects later (restoring a snapshot). The
auth session is decoupled from both: it is just "are you allowed to talk to the
server at all."

## Start vs. Resume (the handshake)

When a WebSocket opens, the client must send one control message within 30s or
the server closes it with code **4003** (`index.ts:408`). That message is one of:

- **Start** → `{ type: "handshake", columns, rows, sshTarget? }` → `createSession`
  (`sessionManager.ts:192`). Mints a new `sessionId`, spawns a fresh shell,
  replies `{ type: "session_info", sessionId }`. The client saves the id in
  `sessionStorage` under `mywebterm-session-id` (`useTerminal.ts:80`).

- **Resume** → `{ type: "reconnect", sessionId, columns, rows }` → `attachSession`
  (`sessionManager.ts`). Re-attaches to the existing PTY, resizes it if the
  viewport changed, and sends a **serialized snapshot** of the server-side
  shadow terminal (buffers, cursor, and terminal modes — see
  [Architecture](./architecture.md)). The snapshot restores only the terminal's
  screen state; the shell process itself was never interrupted and continues
  running unchanged.

On page load a tab with a stored id shows a **resume card** instead of the
session picker. The card asks `GET /api/sessions/:id` (on load, every 15s, and
when the tab becomes visible again) so it only offers a resume that can
succeed: it shows what the session runs, when it started and how long it will
still be kept, and offers **Resume** or **End Session**. Once the server
answers `404` the stored id is dropped and the picker is shown with a note
that the previous session is no longer running.

When a resume is attempted anyway and the server replies
`{ type: "error", message: "Session not found or already dead" }` (the session
was reaped while the connection was down), the client clears the stored id,
falls back to a fresh **start** on the same target, and says so in a toast.

```
page load ─► stored sessionId? ─yes─► send "reconnect" ─► exists?─yes─► attach + snapshot
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

The evicted client does **not** reconnect on its own — two tabs doing that
would steal the session from each other forever. It keeps the id and shows a
"Session moved" card with **Use Here** (take it back, evicting the other
viewer) and **Back to Start** (forget the session locally; nothing is killed).

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

## What the page offers in each state

Whenever a started session is not connected, an overlay names what happened
and offers only the actions that make sense (`src/SessionOverlay.tsx`):

| State | Cause | Actions |
|---|---|---|
| Session still running | page load with a stored id (see above) | Resume · End Session |
| Connecting… | first attempt, or a resume, in flight | Cancel, once it has taken more than a moment (a resume returns to its card; a fresh start to the picker) |
| Connection lost | socket dropped (`4001`, `1006`, …); retried with backoff, countdown shown | Retry Now · End Session |
| Session ended | shell exited (`1000`); exit code or signal shown | Start Again · Back to Start |
| Session moved | evicted by another viewer (`4002`) | Use Here · Back to Start |
| Could not start session | spawn failed or bad ssh target (`1011`, `1008`); not retried | Try Again · Back to Start |

**End Session** always asks for confirmation and kills the shell. While
attached it sends `terminate` over the socket; otherwise (resume card,
connection lost) it calls `DELETE /api/sessions/:id` and returns to the start
screen only once the server confirms. If the request fails or is refused, the
page keeps the session and says so; End Session can be tried again, or the
notice's **Leave Anyway** forgets the session locally and leaves it to the
stale sweep.
**Back to Start** never kills anything.

A dropped connection also probes `/api/auth/check`; a `401` means the login
expired or was ended elsewhere, so the page goes to `/login` instead of
retrying forever.

## Logout vs. Restart

These act on different concepts — this is the key distinction.

| Action | Trigger | Auth session | PTY session(s) | Net effect |
|---|---|---|---|---|
| **Logout** | `App.tsx` logout button (after a confirmation that states how many sessions it kills) → `POST /api/auth/logout` | **invalidated**, cookie cleared | **destroyed** (`destroyAllSessions`) | Fully signed out; next login **starts fresh** |
| **Restart** | `POST /api/restart` (no button in the page) | untouched | **destroyed** | Still logged in; gets a brand-new shell |

### Logout flow (current behavior)

Logout is a deliberate **whole-browser / whole-account sign-out**, not a
per-tab action. The auth token is invalidated and the cookie is cleared
origin-wide, so *every* tab and device immediately loses access. To match that,
logout also destroys **all** PTY sessions — not just the current tab's. This is
intentional for the single-user model: if the same user forgot to log out on
another device, logging out anywhere guarantees no live shell is left behind,
which makes logout robust and unambiguous.

- **Server** (`handleLogout`, `index.ts:311`): invalidates the token, then calls
  `destroyAllSessions()` (`sessionManager.ts:360`), killing every shell and
  closing its socket. Responds with a cleared cookie.
- **Client** (`handleLogout`, `App.tsx:1616`): removes `mywebterm-session-id`
  from `sessionStorage`, then navigates to `/login`.

Because the stored id is gone and the PTY is destroyed, logging back in always
sends a **handshake** (fresh shell), never a **reconnect**.

> Cross-tab effect (by design): other open tabs have their sockets closed with
> code `4000` and will briefly try to reconnect, but the cleared cookie makes
> those upgrades `401`; the failed attempt probes `/api/auth/check` and sends
> the tab to `/login` — so they end up signed out too, as intended. This is
> distinct from the per-`sessionId` eviction (4002) above: logout ends *all*
> sessions globally; 4002 only swaps the viewer of a *single* shell.

### Restart flow

`handleRestart` (`index.ts:382`) calls the same `destroyAllSessions()` but leaves
the auth token intact. Client-side `restart()` (`useTerminal.ts:1043`) clears the
stored id and reconnects, so a new shell spins up while you stay logged in. Use
it to clear a wedged shell or stale process.

## WebSocket close codes

| Code | Name | Meaning | Client reaction (`useTerminal.ts:979`) |
|---|---|---|---|
| `1000` | Normal | Shell exited / session destroyed | Clear stored id; show "Session ended" with the exit status; stop |
| `1002` | Protocol error | Invalid control message (`index.ts:178`) | Default: backoff reconnect |
| `1008` | Policy violation | Invalid ssh target | Clear id; show "Could not start session"; stop |
| `1011` | Internal error | Shell failed to spawn | Clear id; show "Could not start session"; stop |
| `4000` | Restart | Session destroyed by restart/logout (`RESTART_CLOSE_CODE`) | Clear id, reset terminal, reconnect immediately |
| `4001` | Heartbeat timeout | No pong in time (`HEARTBEAT_CLOSE_CODE`) | Keep id, backoff reconnect ("Connection lost") |
| `4002` | Replaced | Another connection attached to the same `sessionId` (`REPLACED_CLOSE_CODE`) | Keep id; show "Session moved"; stop (no automatic reconnect) |
| `4003` | Handshake timeout | No handshake/reconnect within 30s of open | Default: backoff reconnect |
| `4004` | Ended | Session ended deliberately via `terminate` (`ENDED_CLOSE_CODE`) | Clear id, reset terminal, return to the start screen |

> Note on logout: server-side `destroyAllSessions()` closes the live socket with
> code `4000`, which the client would normally treat as "Restart" and reconnect.
> Because logout immediately does a full-page navigation to `/login` (and the
> cookie is now cleared, so any reconnect would `401`), that attempt is torn down
> by the page reload. Clearing `sessionStorage` keeps the post-login state clean.

## Cross-references

- Wire format for control messages and frames: [WebSocket Protocol](./websocket-protocol.md)
- Component map and routes: [Architecture](./architecture.md)
