# myttyd frontend

Custom web frontend for a running [ttyd](https://github.com/tsl0922/ttyd) instance using React + latest xterm.js packages.

## Run ttyd (backend)

Start ttyd in writable mode so browser input reaches the shell:

```bash
ttyd -W -p 7681 bash
```

Important:
- Do not pass `-O` / `--check-origin` for this cross-origin setup.
- This frontend currently does not implement ttyd auth token flow (`/token`), so run ttyd without credential auth in v1.

## Run this frontend (external app server)

Install deps:

```bash
bun install
```

Start dev server with required ttyd endpoint:

```bash
BUN_PUBLIC_TTYD_BASE_URL=http://127.0.0.1:7681 bun dev
```

## Build

```bash
bun run build
```

## Test

```bash
bun test
```
