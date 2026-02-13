import { spawn as cpSpawn } from "node:child_process";
import { parseArgs } from "node:util";
import { type Server, type ServerWebSocket, serve } from "bun";
import index from "./index.html";
import { ClientCommand, decodeFrame } from "./ttydProtocol";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";

const { values, positionals } = parseArgs({
  options: {
    version: { type: "boolean", short: "v" },
    foreground: { type: "boolean", short: "f" },
  },
  strict: false,
  allowPositionals: true,
});

if (values.version) {
  console.log(`mywebterm ${VERSION}`);
  process.exit(0);
}

if (!values.foreground) {
  const args = [...process.argv.slice(1), "--foreground"];
  const child = cpSpawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`Daemonized (PID ${child.pid})`);
  process.exit(0);
}

interface PtySessionData {
  connectionId: string;
}

interface PtySession {
  proc: ReturnType<typeof Bun.spawn> | null;
  ws: ServerWebSocket<PtySessionData>;
  handshakeReceived: boolean;
}

const command = positionals.length > 0 ? positionals : [process.env.SHELL || "/bin/sh"];
const hostname = process.env.HOST || "::";
const port = parseInt(process.env.PORT || "8671", 10);
const MAX_COLS = 500;
const MAX_ROWS = 200;
const RESTART_CLOSE_CODE = 4000;
const STRIPPED_ENV_PREFIXES = ["ZELLIJ", "TMUX"];

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
);

function clampDimension(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}
const ptySessions = new Map<string, PtySession>();
let nextConnectionId = 0;

function createConnectionId(): string {
  nextConnectionId += 1;
  return `${Date.now()}-${nextConnectionId}`;
}

function cleanupProcessResources(session: PtySession): void {
  if (session.proc) {
    try {
      session.proc.terminal?.close();
    } catch {
      // Terminal may already be closed.
    }
    try {
      session.proc.kill();
    } catch {
      // Process may already be dead.
    }
  }
}

function cleanupSession(connectionId: string): void {
  const session = ptySessions.get(connectionId);
  if (!session) {
    return;
  }

  ptySessions.delete(connectionId);
  cleanupProcessResources(session);
}

function cleanupAllSessions(): void {
  for (const [connectionId, session] of ptySessions) {
    ptySessions.delete(connectionId);
    cleanupProcessResources(session);
    closeClientSocket(session.ws, RESTART_CLOSE_CODE, "Restart");
  }
}

function closeClientSocket(ws: ServerWebSocket<PtySessionData>, code?: number, reason?: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}

const OUTPUT_PREFIX = 0x30; // "0" — ServerCommand.OUTPUT

function sendOutputFrame(ws: ServerWebSocket<PtySessionData>, data: Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const frame = new Uint8Array(data.length + 1);
  frame[0] = OUTPUT_PREFIX;
  frame.set(data, 1);
  ws.send(frame);
}

function spawnPtyForSession(
  connectionId: string,
  ws: ServerWebSocket<PtySessionData>,
  cols: number,
  rows: number,
): void {
  const session: PtySession = { proc: null, ws, handshakeReceived: true };
  ptySessions.set(connectionId, session);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      terminal: {
        cols,
        rows,
        data(_terminal, data: Uint8Array) {
          const current = ptySessions.get(connectionId);
          if (!current) {
            return;
          }
          sendOutputFrame(current.ws, data);
        },
        exit(_terminal, _exitCode, _signal) {
          const current = ptySessions.get(connectionId);
          if (!current) {
            return;
          }
          ptySessions.delete(connectionId);
          closeClientSocket(current.ws, 1000, "Shell exited");
        },
      },
      env: { ...cleanEnv, TERM: "xterm-256color" },
    });
  } catch {
    ptySessions.delete(connectionId);
    closeClientSocket(ws, 1011, "Failed to spawn shell");
    return;
  }

  session.proc = proc;
}

function handleWsMessage(ws: ServerWebSocket<PtySessionData>, message: string | Buffer): void {
  const connectionId = ws.data.connectionId;
  const session = ptySessions.get(connectionId);

  if (!session || !session.handshakeReceived) {
    // First message is the JSON handshake: {"columns":N,"rows":N}
    let handshake: { columns?: number; rows?: number };
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      handshake = JSON.parse(text);
    } catch {
      ws.close(1002, "Invalid handshake");
      return;
    }

    const cols = clampDimension(handshake.columns, 80, MAX_COLS);
    const rows = clampDimension(handshake.rows, 24, MAX_ROWS);

    spawnPtyForSession(connectionId, ws, cols, rows);
    return;
  }

  // Subsequent messages are binary ttyd frames
  let rawBuffer: ArrayBuffer;
  if (typeof message === "string") {
    rawBuffer = new TextEncoder().encode(message).buffer as ArrayBuffer;
  } else if (message instanceof ArrayBuffer) {
    rawBuffer = message;
  } else {
    rawBuffer = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
  }

  let frame: ReturnType<typeof decodeFrame>;
  try {
    frame = decodeFrame(rawBuffer);
  } catch {
    return;
  }

  const terminal = session.proc?.terminal;
  if (!terminal) {
    return;
  }

  switch (frame.command) {
    case ClientCommand.INPUT:
      terminal.write(frame.payload);
      break;

    case ClientCommand.RESIZE_TERMINAL: {
      let resize: { columns?: number; rows?: number };
      try {
        resize = JSON.parse(new TextDecoder().decode(frame.payload));
      } catch {
        break;
      }

      const newCols = clampDimension(resize.columns, 80, MAX_COLS);
      const newRows = clampDimension(resize.rows, 24, MAX_ROWS);
      terminal.resize(newCols, newRows);
      break;
    }

    default:
      break;
  }
}

const server = serve<PtySessionData>({
  routes: {
    "/ttyd/ws": (req: Request, server: Server<PtySessionData>) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const connectionId = createConnectionId();
      const upgraded = server.upgrade(req, {
        data: { connectionId },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return undefined;
    },
    "/api/restart": {
      POST: () => {
        cleanupAllSessions();
        return Response.json({ ok: true });
      },
    },
    "/api/sessions": {
      GET: async () => {
        const ppid = process.pid;
        const children: { pid: number; command: string }[] = [];
        try {
          const result = await Bun.$`ps -ax -o pid=,ppid=,command=`.quiet().nothrow();
          const output = result.stdout.toString().trim();
          if (output) {
            for (const line of output.split("\n")) {
              const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
              if (!match) continue;
              const pid = Number(match[1]);
              const parentPid = Number(match[2]);
              if (parentPid === ppid) {
                children.push({ pid, command: match[3] ?? "" });
              }
            }
          }
        } catch {
          // ps may not be available
        }

        return Response.json({ ppid, children });
      },
    },
    "/api/config": () =>
      Response.json({
        experimentalHScroll: process.env.EXPERIMENTAL_HSCROLL === "1",
      }),
    "/*": index,
  },

  websocket: {
    open(ws) {
      // Session starts without a PTY — handshake will spawn it.
      ptySessions.set(ws.data.connectionId, {
        proc: null,
        ws,
        handshakeReceived: false,
      });
    },
    message(ws, message) {
      handleWsMessage(ws, message);
    },
    close(ws) {
      cleanupSession(ws.data.connectionId);
    },
  },

  hostname,
  port,

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url} (command: ${JSON.stringify(command)})`);
