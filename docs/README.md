# MyWebTerm Documentation

Internal documentation for how MyWebTerm works under the hood. For installation,
CLI usage, flags, and authentication setup, see the [root README](../README.md).

These docs exist because the relationship between *logging in*, *the running
shell*, and *the browser connection* is easy to confuse — they are three
independent things with independent lifetimes.

## Contents

- **[Architecture](./architecture.md)** — component map, HTTP routes, and the
  end-to-end data flow from keystroke to screen.
- **[Sessions & Connections](./sessions-and-connections.md)** — the core
  reference: auth session vs. PTY session vs. WebSocket connection, start vs.
  resume, the one-viewer-per-terminal rule, heartbeat, stale cleanup, and how
  **logout** differs from **restart**.
- **[WebSocket Protocol](./websocket-protocol.md)** — the wire format: JSON
  control messages and the binary tty frame encoding.
