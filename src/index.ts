import { parseArgs } from "node:util";
import { type Server, type ServerWebSocket, serve } from "bun";
import {
  clearSessionCookie,
  createSession as createAuthSession,
  extractSessionToken,
  getSessionCookie,
  hasAuthSecret,
  invalidateSession,
  isRequestAuthenticated,
  validateSecret,
} from "./auth";
import boldFont from "./fonts/JetBrainsMonoNerdFontMono-Bold.woff2" with { type: "file" };
import regularFont from "./fonts/JetBrainsMonoNerdFontMono-Regular.woff2" with { type: "file" };
import symbolsFont from "./fonts/SymbolsNerdFontMono-Regular.woff2" with { type: "file" };
import index from "./index.html";
import { buildLoginPageHtml } from "./loginPage";
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
import { ClientCommand, decodeFrame, parseClientControl } from "./ttyProtocol";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";

const USAGE = `Usage: bun src/index.ts [options] [-- shell command...]

Options:
  -h, --help          Show this help message
  -v, --version       Show version
  -p, --port <n>      Port to listen on (default: 8671)
      --daemonize     Run as a background daemon
      --no-hscroll    Disable horizontal scrolling
      --title <s>     Set the terminal title (default: "MyWebTerm")`;

const parseArgsOptions = {
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    port: { type: "string", short: "p" },
    daemonize: { type: "boolean" },
    "no-hscroll": { type: "boolean" },
    title: { type: "string" },
  },
  strict: true,
  allowPositionals: true,
} as const;

let values: ReturnType<typeof parseArgs<typeof parseArgsOptions>>["values"];
let positionals: string[];
try {
  ({ values, positionals } = parseArgs(parseArgsOptions));
} catch (err) {
  // If the user passed -h/--help alongside an unknown flag, still show help
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  console.error(err instanceof Error ? err.message : err);
  console.error("Run with --help for usage information.");
  process.exit(1);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  console.log(`mywebterm ${VERSION}`);
  process.exit(0);
}

if (values.daemonize) {
  console.error("--daemonize is temporarily disabled (fork loop bug). Use the 'tray' branch for the fixed version.");
  process.exit(1);
}

if (!hasAuthSecret()) {
  console.error("AUTH_SECRET environment variable is required but not set.");
  process.exit(1);
}

// Embed font files into memory at startup so they work without
// the fonts directory on the filesystem at runtime.
const fontBuffers = new Map<string, ArrayBuffer>([
  ["JetBrainsMonoNerdFontMono-Bold.woff2", await Bun.file(boldFont).arrayBuffer()],
  ["JetBrainsMonoNerdFontMono-Regular.woff2", await Bun.file(regularFont).arrayBuffer()],
  ["SymbolsNerdFontMono-Regular.woff2", await Bun.file(symbolsFont).arrayBuffer()],
]);

const command = positionals.length > 0 ? positionals : [process.env.SHELL || "/bin/sh", "-l"];
const hostname = "127.0.0.1";
const DEFAULT_PORT = 8671;
const port = (() => {
  if (!values.port) return DEFAULT_PORT;
  const n = parseInt(values.port, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid port: ${values.port} (must be an integer 1–65535)`);
    process.exit(1);
  }
  return n;
})();
const hscroll = !values["no-hscroll"];
const appTitle = values.title ?? "MyWebTerm";
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

    if (ws.data.handshakeTimer !== null) {
      clearTimeout(ws.data.handshakeTimer);
      ws.data.handshakeTimer = null;
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
  }

  // Binary messages are tty frames — require an attached session
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

function isSecureRequest(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https";
}

function handleLoginPage(): Response {
  return new Response(buildLoginPageHtml(appTitle), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now >= record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  record.count += 1;
  return record.count <= LOGIN_MAX_ATTEMPTS;
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

async function handleLoginPost(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";

  if (!checkLoginRateLimit(ip)) {
    console.warn(`[auth] rate-limited login from ${ip}`);
    return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
  }

  let body: { secret?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.secret !== "string" || !validateSecret(body.secret)) {
    console.warn(`[auth] invalid login attempt from ${ip}`);
    return Response.json({ error: "Invalid secret" }, { status: 401 });
  }
  clearLoginAttempts(ip);
  const token = createAuthSession();
  return Response.json(
    { ok: true },
    {
      headers: { "Set-Cookie": getSessionCookie(token, isSecureRequest(req)) },
    },
  );
}

function handleLogout(req: Request): Response {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const token = extractSessionToken(req);
  if (token) invalidateSession(token);
  return Response.json(
    { ok: true },
    {
      headers: { "Set-Cookie": clearSessionCookie() },
    },
  );
}

function handleAuthCheck(req: Request): Response {
  if (isRequestAuthenticated(req)) {
    return Response.json({ authenticated: true });
  }
  return Response.json({ authenticated: false }, { status: 401 });
}

function handleWebSocketUpgrade(req: Request, srv: Server<WsData>): Response | undefined {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  const connectionId = createConnectionId();
  const upgraded = srv.upgrade(req, {
    data: { sessionId: null, connectionId, handshakeTimer: null },
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  return undefined;
}

function handleConfig(): Response {
  return Response.json({
    hscroll,
    appTitle,
    shellCommand: command,
  });
}

async function handleSessions(): Promise<Response> {
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
}

function handleRestart(): Response {
  destroyAllSessions();
  return Response.json({ ok: true });
}

const server = serve<WsData>({
  routes: {
    "/": index,
    "/login": handleLoginPage,
    "/api/auth/login": { POST: handleLoginPost },
    "/api/auth/logout": { POST: handleLogout },
    "/api/auth/check": handleAuthCheck,
  },

  websocket: {
    open(ws) {
      // Close the connection if no handshake/reconnect arrives within 30s.
      ws.data.handshakeTimer = setTimeout(() => {
        if (!ws.data.sessionId) {
          ws.close(4003, "Handshake timeout");
        }
      }, 30_000);
    },
    message(ws, message) {
      handleWsMessage(ws, message);
    },
    close(ws) {
      if (ws.data.handshakeTimer !== null) {
        clearTimeout(ws.data.handshakeTimer);
        ws.data.handshakeTimer = null;
      }

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

  fetch(req, srv) {
    const pathname = new URL(req.url).pathname;

    // Serve font files (always public).
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

    // Auth gate for API and WebSocket routes
    if (!isRequestAuthenticated(req)) {
      if (pathname.startsWith("/api/") || pathname === "/tty/ws") {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Authenticated routes
    if (pathname === "/tty/ws") {
      return handleWebSocketUpgrade(req, srv);
    }
    if (pathname === "/api/config") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return handleConfig();
    }
    if (pathname === "/api/sessions" && req.method === "GET") {
      return handleSessions();
    }
    if (pathname === "/api/restart" && req.method === "POST") {
      return handleRestart();
    }

    return new Response("Not Found", { status: 404 });
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url} (command: ${JSON.stringify(command)})`);
