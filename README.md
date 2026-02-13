# myttyd

Custom web terminal using React + xterm.js with Bun's built-in PTY. No external `ttyd` process required — the server spawns `$SHELL` (or `/bin/sh` fallback) directly.

## Run

Install deps:

```bash
bun install
```

Start dev server:

```bash
bun dev
```

Open the printed URL in a browser. The terminal connects over WebSocket and spawns your shell.

## Build

```bash
bun run build
```

## Test

```bash
bun test
```
