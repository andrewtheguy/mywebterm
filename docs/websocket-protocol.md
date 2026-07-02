# WebSocket Protocol

All terminal traffic flows over a single WebSocket at `/tty/ws`. The protocol is
defined and (de)serialized in `src/ttyProtocol.ts` and exercised by
`src/ttyProtocol.test.ts`.

Two kinds of WebSocket messages are used:

- **Text frames** — JSON **control messages** (handshake, ping/pong, errors).
- **Binary frames** — **tty frames**: a 1-byte command prefix followed by a raw
  payload (terminal input/output).

The server's message router (`handleWsMessage`, `index.ts:173`) branches on the
message type: `string` → control message, otherwise → binary tty frame.

## Control messages (JSON text frames)

### Client → server (`ClientControlMessage`)

| `type` | Fields | Meaning |
|---|---|---|
| `handshake` | `columns`, `rows` | Start a new session (spawn a shell) |
| `reconnect` | `sessionId`, `columns`, `rows` | Resume an existing session |
| `pong` | `timestamp` | Reply to a server `ping` |

Parsed and validated by `parseClientControl` (`ttyProtocol.ts:32`). Dimensions
must be finite, positive integers; invalid messages are rejected (and an invalid
control message closes the socket with code `1002`).

### Server → client (`ServerControlMessage`)

| `type` | Fields | Meaning |
|---|---|---|
| `session_info` | `sessionId` | Sent after handshake/reconnect; client stores the id |
| `ping` | `timestamp` | Heartbeat; expects a `pong` within 10s |
| `session_ended` | `exitCode`, `signal` | Shell exited (one or the other is non-null) |
| `error` | `message` | e.g. "Session not found or already dead" |

Serialized by `encodeServerControl` (`ttyProtocol.ts:69`) — a plain
`JSON.stringify`.

## Binary tty frames

A tty frame is `[command byte][payload bytes...]`. The command byte is the ASCII
character for the command; the payload is raw bytes.

```
┌──────────┬───────────────────────────┐
│ cmd (1B) │ payload (0..N bytes)       │
└──────────┴───────────────────────────┘
```

### Client commands (`ClientCommand`)

| Byte | Name | Payload |
|---|---|---|
| `'0'` | `INPUT` | raw keystrokes (UTF-8 bytes) → `proc.terminal.write()` |
| `'1'` | `RESIZE_TERMINAL` | JSON `{ columns, rows }` → `proc.terminal.resize()` |

Built with `encodeInput` / `encodeResize` (`ttyProtocol.ts:99`, `:104`).

### Server commands (`ServerCommand`)

| Byte | Name | Payload |
|---|---|---|
| `'0'` | `OUTPUT` | raw terminal output bytes → written into xterm.js |
| `'1'` | `SET_WINDOW_TITLE` | (reserved) |
| `'2'` | `SET_PREFERENCES` | (reserved) |

The server emits `OUTPUT` frames via `sendOutputFrame` (`sessionManager.ts:144`),
which prepends the `0x30` (`'0'`) prefix. Frames are decoded with `decodeFrame`
(`ttyProtocol.ts:111`), which splits off the first byte as the command and
returns the rest as the payload. An empty buffer is rejected.

## Connection lifecycle summary

1. Client opens WS → server starts a 30s handshake timer (`index.ts:408`).
2. Client sends `handshake` (start) or `reconnect` (resume); the timer is cleared.
3. Server replies `session_info`; for resume it then sends a serialized
   snapshot of the shadow terminal (screen, scrollback, and terminal modes) as
   an `OUTPUT` frame.
4. Steady state: `INPUT`/`RESIZE_TERMINAL` frames up, `OUTPUT` frames down,
   `ping`/`pong` keeping the link alive.
5. On socket close the PTY is **detached** (kept alive), not destroyed
   (`index.ts:417`).

See [Sessions & Connections](./sessions-and-connections.md) for session
lifetimes, eviction (code 4002), heartbeat, and the full close-code table.
