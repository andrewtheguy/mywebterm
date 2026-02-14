import { spawn as cpSpawn } from "node:child_process";
import { parseArgs } from "node:util";
import { type Server, type ServerWebSocket, serve } from "bun";
import boldFont from "./fonts/JetBrainsMonoNerdFontMono-Bold.woff2" with { type: "file" };
import regularFont from "./fonts/JetBrainsMonoNerdFontMono-Regular.woff2" with { type: "file" };
import symbolsFont from "./fonts/SymbolsNerdFontMono-Regular.woff2" with { type: "file" };
import index from "./index.html";
import {
  attachSession,
  createSession,
  destroyAllSessions,
  detachSession,
  getSession,
  getSessionSummaries,
  handlePong,
  registerShutdownHandlers,
  setShellCommand,
  startStaleSweep,
  type WsData,
} from "./sessionManager";
import { ClientCommand, decodeFrame, parseClientControl } from "./ttydProtocol";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";

const { values, positionals } = parseArgs({
  options: {
    version: { type: "boolean", short: "v" },
  },
  strict: false,
  allowPositionals: true,
});

if (values.version) {
  console.log(`mywebterm ${VERSION}`);
  process.exit(0);
}

if (process.env.DAEMONIZE === "1") {
  const STRIPPED_ENV_PREFIXES = ["ZELLIJ", "TMUX", "DAEMONIZE"];
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );

  let child: ReturnType<typeof cpSpawn>;
  try {
    child = cpSpawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env: cleanEnv,
    });
  } catch (error) {
    console.error("Failed to daemonize:", error);
    process.exit(1);
  }

  if (!child.pid) {
    console.error("Failed to daemonize: child process has no PID");
    process.exit(1);
  }

  child.unref();
  console.log(`Daemonized (PID ${child.pid})`);
  process.exit(0);
}

// Embed font files into memory at startup so they work without
// the fonts directory on the filesystem at runtime.
const fontBuffers = new Map<string, ArrayBuffer>([
  ["JetBrainsMonoNerdFontMono-Bold.woff2", await Bun.file(boldFont).arrayBuffer()],
  ["JetBrainsMonoNerdFontMono-Regular.woff2", await Bun.file(regularFont).arrayBuffer()],
  ["SymbolsNerdFontMono-Regular.woff2", await Bun.file(symbolsFont).arrayBuffer()],
]);

const command = positionals.length > 0 ? positionals : [process.env.SHELL || "/bin/sh"];
const hostname = process.env.HOST || "::";
const port = parseInt(process.env.PORT || "8671", 10);
const MAX_COLS = 500;
const MAX_ROWS = 200;

function clampDimension(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

let nextConnectionId = 0;
function createConnectionId(): string {
  nextConnectionId += 1;
  return `${Date.now()}-${nextConnectionId}`;
}

setShellCommand(command);
registerShutdownHandlers();
startStaleSweep();

function handleWsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
  // Text messages are control messages (JSON)
  if (typeof message === "string") {
    const ctrl = parseClientControl(message);
    if (!ctrl) {
      ws.close(1002, "Invalid control message");
      return;
    }

    switch (ctrl.type) {
      case "handshake":
        createSession(ws, ctrl.columns, ctrl.rows);
        return;
      case "reconnect":
        attachSession(ctrl.sessionId, ws, ctrl.columns, ctrl.rows);
        return;
      case "pong":
        if (ws.data.sessionId) {
          handlePong(ws.data.sessionId);
        }
        return;
    }
    return;
  }

  // Binary messages are ttyd frames — require an attached session
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  const session = getSession(sessionId);
  if (!session) return;

  let rawBuffer: ArrayBuffer;
  if (message instanceof ArrayBuffer) {
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
  if (!terminal) return;

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
      session.cols = newCols;
      session.rows = newRows;
      terminal.resize(newCols, newRows);
      break;
    }

    default:
      break;
  }
}

const server = serve<WsData>({
  routes: {
    "/ttyd/ws": (req: Request, server: Server<WsData>) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const connectionId = createConnectionId();
      const upgraded = server.upgrade(req, {
        data: { sessionId: null, connectionId },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return undefined;
    },
    "/api/restart": {
      POST: () => {
        destroyAllSessions();
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

        return Response.json({ ppid, children, sessions: getSessionSummaries() });
      },
    },
    "/api/config": () =>
      Response.json({
        hscroll: process.env.DISABLE_HSCROLL !== "1",
        appTitle: process.env.APP_TITLE || "MyWebTerm",
      }),
    "/": index,
  },

  websocket: {
    open(_ws) {
      // WS is open but no session yet — wait for handshake or reconnect control message.
    },
    message(ws, message) {
      handleWsMessage(ws, message);
    },
    close(ws) {
      const sessionId = ws.data.sessionId;
      if (!sessionId) return;

      const session = getSession(sessionId);
      if (!session) return;

      // Detach (keep PTY alive) instead of destroying
      if (session.attachedWs === ws) {
        detachSession(session);
      }
    },
  },

  hostname,
  port,

  fetch(req) {
    // Serve font files in production (dev server handles this automatically via HMR).
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith(".woff2")) {
      const requested = pathname.split("/").pop() ?? "";
      // Bun's bundler adds a content hash: "Font-e5tw0acz.woff2" -> try "Font.woff2"
      const unhashed = requested.replace(/-[a-z0-9]{8}\.woff2$/, ".woff2");
      const buffer = fontBuffers.get(unhashed) ?? fontBuffers.get(requested);
      if (buffer) {
        return new Response(buffer, {
          headers: {
            "Content-Type": "font/woff2",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url} (command: ${JSON.stringify(command)})`);
