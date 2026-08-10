import { chmodSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Server, type ServerWebSocket, serve } from "bun";
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import {
  clearSessionCookie,
  createSession as createAuthSession,
  extractSessionToken,
  getSessionCookie,
  initHtpasswd,
  invalidateSession,
  isRequestAuthenticated,
  setDevMode,
  verifyCredentials,
} from "./auth";
import boldFont from "./fonts/JetBrainsMonoNerdFontMono-Bold.woff2" with { type: "file" };
import regularFont from "./fonts/JetBrainsMonoNerdFontMono-Regular.woff2" with { type: "file" };
import symbolsFont from "./fonts/SymbolsNerdFontMono-Regular.woff2" with { type: "file" };
import index from "./index.html";
import { DEFAULT_LISTEN, describeListenTarget, parseListenTarget } from "./listenTarget";
import { buildLoginPageHtml } from "./loginPage";
import manifestJson from "./manifest.json";
import { provisionLocalHelper, removeLocalHelper } from "./openHelper";
import pwaIcon192Path from "./pwa-icon-192.png" with { type: "file" };
import pwaIcon512Path from "./pwa-icon-512.png" with { type: "file" };
import {
  attachSession,
  createSession,
  destroyAllSessions,
  destroySession,
  detachSession,
  ENDED_CLOSE_CODE,
  getSession,
  getSessionSummaries,
  handlePong,
  registerShutdownHandlers,
  resizeSession,
  setCwd,
  setShellCommand,
  setSshConfigPath,
  startStaleSweep,
  type WsData,
} from "./sessionManager";
import { parseSshConfigHosts } from "./sshConfig";
import { ClientCommand, decodeFrame, parseClientControl } from "./ttyProtocol";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";

const USAGE = `Usage: bun src/index.ts [options] [-- shell command...]

Options:
  -h, --help          Show this help message
  -v, --version       Show version
  -l, --listen <target>   Where to bind (default: ${DEFAULT_LISTEN}). One of:
                            8671                       port on 127.0.0.1
                            0.0.0.0:8671               host and port
                            [::1]:8671                 IPv6, brackets required
                            unix:/run/wt.sock          unix socket, mode 600
                            unix:/run/wt.sock,mode=660 unix socket, given mode
      --htpasswd-file <path>  Path to htpasswd file (default: .htpasswd)
      --no-auth       Disable authentication (loopback or unix socket only)
      --dev           Enable development mode (HMR, non-secure cookies)
      --title <s>     Set the terminal title (default: "MyWebTerm")
      --cwd <path>    Set the working directory for the shell (default: $HOME)
      --ssh-config <path>  OpenSSH client config for ssh sessions (passed to ssh -F);
                           its Host aliases are offered on the start screen`;

const parseArgsOptions = {
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    listen: { type: "string", short: "l" },
    "htpasswd-file": { type: "string" },
    "no-auth": { type: "boolean" },
    dev: { type: "boolean" },
    title: { type: "string" },
    cwd: { type: "string" },
    "ssh-config": { type: "string" },
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

if (values.dev) {
  setDevMode(true);
}

const noAuth = !!values["no-auth"];

const listenTarget = (() => {
  try {
    const target = parseListenTarget(values.listen ?? DEFAULT_LISTEN);
    // Resolve here rather than in the parser so the parser stays pure and the
    // socket path in errors and in the startup line is the one actually bound.
    return target.kind === "unix" ? { ...target, path: resolve(target.path) } : target;
  } catch (err) {
    console.error(`Invalid --listen value: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
})();

const unixSocket = listenTarget.kind === "unix" ? listenTarget : null;

// Prevent unauthenticated access on non-loopback interfaces. A unix socket is
// not reachable over the network at all, so filesystem permissions are the
// access control there and --no-auth is fine.
if (noAuth && listenTarget.kind === "tcp" && !listenTarget.isLoopback) {
  console.error("--no-auth is only allowed when listening on loopback or a unix socket.");
  process.exit(1);
}

if (!noAuth) {
  const htpasswdPath = values["htpasswd-file"] ?? process.env.HTPASSWD_FILE ?? ".htpasswd";
  try {
    initHtpasswd(htpasswdPath);
  } catch (err) {
    console.error(`Failed to load htpasswd file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// Embed font and icon files into memory at startup so they work without
// the source directories on the filesystem at runtime.
const fontBuffers = new Map<string, ArrayBuffer>([
  ["JetBrainsMonoNerdFontMono-Bold.woff2", await Bun.file(boldFont).arrayBuffer()],
  ["JetBrainsMonoNerdFontMono-Regular.woff2", await Bun.file(regularFont).arrayBuffer()],
  ["SymbolsNerdFontMono-Regular.woff2", await Bun.file(symbolsFont).arrayBuffer()],
]);
const pwaIcon192 = await Bun.file(pwaIcon192Path).arrayBuffer();
const pwaIcon512 = await Bun.file(pwaIcon512Path).arrayBuffer();
const appleTouchIcon = await Bun.file(appleTouchIconPath).arrayBuffer();

const command = positionals.length > 0 ? positionals : [process.env.SHELL || "/bin/sh", "-l"];
const appTitle = values.title ?? "MyWebTerm";

let nextConnectionId = 0;
function createConnectionId(): string {
  nextConnectionId += 1;
  return `${Date.now()}-${nextConnectionId}`;
}

setShellCommand(command);
if (values.cwd) {
  try {
    const stat = statSync(values.cwd);
    if (!stat.isDirectory()) {
      console.error(`Invalid --cwd: ${values.cwd} is not a directory`);
      process.exit(1);
    }
  } catch {
    console.error(`Invalid --cwd: ${values.cwd} does not exist`);
    process.exit(1);
  }
}
setCwd(values.cwd || process.env.HOME || undefined);

let sshHosts: string[] = [];
if (values["ssh-config"]) {
  // Absolute path: the PTY spawns with its own cwd, so a relative -F would
  // resolve against the wrong directory.
  const sshConfigPath = resolve(values["ssh-config"]);
  const sshConfigFile = Bun.file(sshConfigPath);
  if (!(await sshConfigFile.exists())) {
    console.error(`Invalid --ssh-config: ${values["ssh-config"]} does not exist`);
    process.exit(1);
  }
  setSshConfigPath(sshConfigPath);
  sshHosts = parseSshConfigHosts(await sshConfigFile.text());
}

// Sessions pick this up from $PATH, so it has to exist before the first one.
// The cleanup handler goes on immediately: startup can still exit(1) below,
// and gracefulShutdown ends in process.exit, so "exit" covers every way out.
provisionLocalHelper();
process.on("exit", removeLocalHelper);

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
        createSession(ws, ctrl.columns, ctrl.rows, ctrl.sshTarget);
        return;
      case "reconnect":
        attachSession(ctrl.sessionId, ws, ctrl.columns, ctrl.rows);
        return;
      case "pong":
        if (ws.data.sessionId) {
          handlePong(ws.data.sessionId);
        }
        return;
      case "terminate":
        if (ws.data.sessionId) {
          destroySession(ws.data.sessionId, ENDED_CLOSE_CODE);
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

      resizeSession(session, resize.columns, resize.rows);
      break;
    }

    default:
      break;
  }
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

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return Response.json({ error: "Missing username or password" }, { status: 400 });
  }
  // biome-ignore lint/complexity/useRegexLiterals: literal form triggers noControlCharactersInRegex
  const safeUsername = body.username.replace(new RegExp("[\\x00-\\x1f\\x7f]", "g"), "").slice(0, 64);
  if (!(await verifyCredentials(body.username, body.password))) {
    console.warn(`[auth] invalid login attempt from ${ip} (user: ${safeUsername})`);
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }
  clearLoginAttempts(ip);
  console.log(`[auth] login success for user "${safeUsername}" from ${ip}`);
  const token = createAuthSession(body.username);
  return Response.json(
    { ok: true },
    {
      headers: { "Set-Cookie": getSessionCookie(token) },
    },
  );
}

function handleLogout(req: Request): Response {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const token = extractSessionToken(req);
  if (token) invalidateSession(token);
  destroyAllSessions(); // tear down PTYs so next login starts fresh
  return Response.json(
    { ok: true },
    {
      headers: { "Set-Cookie": clearSessionCookie() },
    },
  );
}

function handleAuthCheck(req: Request): Response {
  if (noAuth || isRequestAuthenticated(req)) {
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
    version: VERSION,
    appTitle,
    shellCommand: command,
    authEnabled: !noAuth,
    sshHosts,
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

// A socket file left behind by a crash is indistinguishable from a live one on
// disk, so the only honest check is to try connecting to it.
async function clearStaleSocket(path: string): Promise<void> {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(path);
  } catch {
    return; // Nothing in the way.
  }

  if (!info.isSocket()) {
    console.error(`Refusing to bind: ${path} exists and is not a socket.`);
    process.exit(1);
  }

  // Only a socket we own is ours to reclaim — someone else's may well be live
  // and merely unreachable to us.
  if (info.uid !== process.getuid?.()) {
    console.error(`Refusing to bind: ${path} belongs to uid ${info.uid}.`);
    process.exit(1);
  }

  try {
    const probe = await Bun.connect({ unix: path, socket: { data() {} } });
    probe.end();
    console.error(`Another server is already listening on ${path}.`);
    process.exit(1);
  } catch {
    // Bun reports every unix connect failure as ENOENT, so "connection
    // refused" cannot be told apart from any other failure; with the socket
    // confirmed to be ours, treating a failure as leftover is the useful read.
    unlinkSync(path);
  }
}

if (unixSocket) {
  await clearStaleSocket(unixSocket.path);
}

serve<WsData>({
  routes: {
    "/": index,
    "/login": handleLoginPage,
    "/api/auth/login": { POST: handleLoginPost },
    "/api/auth/logout": { POST: handleLogout },
    "/api/auth/check": handleAuthCheck,
    "/manifest.json": () => Response.json(manifestJson, { headers: { "Content-Type": "application/manifest+json" } }),
    "/sw.js": () =>
      new Response("// no-op service worker for PWA installability\n", {
        headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache" },
      }),
    "/pwa-icon-192.png": () => new Response(pwaIcon192, { headers: { "Content-Type": "image/png" } }),
    "/pwa-icon-512.png": () => new Response(pwaIcon512, { headers: { "Content-Type": "image/png" } }),
    "/apple-touch-icon.png": () => new Response(appleTouchIcon, { headers: { "Content-Type": "image/png" } }),
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

  ...(listenTarget.kind === "unix"
    ? { unix: listenTarget.path }
    : { hostname: listenTarget.hostname, port: listenTarget.port }),

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
    if (!noAuth && !isRequestAuthenticated(req)) {
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

  development: values.dev && {
    hmr: true,
    console: true,
  },
});

if (unixSocket) {
  // Bun creates the socket under the process umask, which is usually 755.
  chmodSync(unixSocket.path, unixSocket.mode);
  // gracefulShutdown ends in process.exit, so an "exit" listener covers both
  // SIGTERM/SIGINT and a plain return.
  process.on("exit", () => {
    try {
      unlinkSync(unixSocket.path);
    } catch {
      // Already gone, or the directory went away first.
    }
  });
}

console.log(`Server running at ${describeListenTarget(listenTarget)} (command: ${JSON.stringify(command)})`);
