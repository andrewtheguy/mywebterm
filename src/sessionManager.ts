import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as ShadowTerminal } from "@xterm/headless";
import type { ServerWebSocket } from "bun";
import { encodeServerControl, parseSshTarget } from "./ttyProtocol";

// --- Types ---

export interface WsData {
  sessionId: string | null;
  connectionId: string;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

export interface PtySession {
  sessionId: string;
  // ssh destination the session was started with; null for the local shell.
  target: string | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  cols: number;
  rows: number;
  shadowTerm: ShadowTerminal;
  serializeAddon: SerializeAddon;
  // Non-null while an attach snapshot is being prepared: live PTY output is
  // queued here so it reaches the client only after the snapshot.
  attachPending: Uint8Array[] | null;
  attachedWs: ServerWebSocket<WsData> | null;
  createdAt: number;
  lastActivityAt: number;
  lastDetachedAt: number | null;
  state: "spawning" | "attached" | "detached" | "dead";
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatPending: boolean;
}

// --- Constants ---

const SHADOW_SCROLLBACK_LINES = 5000; // matches the client terminal's scrollback
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STALE_SWEEP_INTERVAL_MS = 60_000;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const KILL_ESCALATION_MS = 5_000;
// How long to wait for the child's real exit status once its PTY has closed.
const EXIT_STATUS_WAIT_MS = 1_000;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const OUTPUT_PREFIX = 0x30; // "0" — ServerCommand.OUTPUT
const RESTART_CLOSE_CODE = 4000;
const HEARTBEAT_CLOSE_CODE = 4001;
// Another connection attached to the same session — the evicted client must
// not auto-reconnect, or the two would keep stealing the session from each other.
const REPLACED_CLOSE_CODE = 4002;
// Session ended deliberately by the user — the client returns to the start
// screen instead of auto-reconnecting.
const ENDED_CLOSE_CODE = 4004;

export { RESTART_CLOSE_CODE, ENDED_CLOSE_CODE };

// --- Shadow terminal ---

// Server-side headless terminal that mirrors all PTY output. On reattach the
// client receives a serialized snapshot of its full state (buffers, cursor,
// and DEC private modes such as alt-screen and mouse tracking) instead of a
// raw byte replay, so apps like zellij keep working across reconnects.
function createShadowTerminal(cols: number, rows: number): { term: ShadowTerminal; addon: SerializeAddon } {
  const term = new ShadowTerminal({
    cols,
    rows,
    scrollback: SHADOW_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  return { term, addon };
}

function buildSnapshot(session: PtySession): Uint8Array {
  let snapshot = session.serializeAddon.serialize();

  // The serialize addon restores mouse *tracking* modes but not the mouse
  // *encoding* protocol (DECSET 1006/1016), which zellij and friends rely on.
  // Read it off the core and append it ourselves.
  const core = (session.shadowTerm as unknown as { _core?: { mouseStateService?: { activeEncoding?: string } } })._core;
  const activeEncoding = core?.mouseStateService?.activeEncoding;
  if (activeEncoding === "SGR") {
    snapshot += "\x1b[?1006h";
  } else if (activeEncoding === "SGR_PIXELS") {
    snapshot += "\x1b[?1016h";
  }

  return new TextEncoder().encode(snapshot);
}

// --- Module state ---

const sessions = new Map<string, PtySession>();
let staleSweepTimer: ReturnType<typeof setInterval> | null = null;
let shellCommand: string[] = ["/bin/sh"];
let spawnCwd: string | undefined;
let sshConfigPath: string | undefined;

export function setSshConfigPath(path: string | undefined): void {
  if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
    throw new Error("ssh config path must be a non-empty string or undefined");
  }
  sshConfigPath = path;
}

export function setCwd(cwd: string | undefined): void {
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new Error("Working directory must be a non-empty string or undefined");
  }
  spawnCwd = cwd;
}

export function setShellCommand(cmd: string[]): void {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new Error("Shell command must be a non-empty array");
  }
  if (typeof cmd[0] !== "string" || cmd[0].length === 0) {
    throw new Error("Shell command executable (first element) must be a non-empty string");
  }
  for (let i = 1; i < cmd.length; i++) {
    if (typeof cmd[i] !== "string") {
      throw new Error(`Shell command argument at index ${i} must be a string`);
    }
  }
  shellCommand = cmd;
}

// Resolve the argv for a new session: ssh to a remote host when a target is
// given, the configured shell command otherwise. The keepalive options make a
// hung ssh (dead network, unreachable host) exit on its own instead of
// lingering until the stale sweep kills it. MyWebTerm deliberately does not
// wrap either command or inject setup into the remote login.
export function buildSessionCommand(sshTarget: string | undefined): string[] {
  if (sshTarget === undefined) return [...shellCommand];
  const parsed = parseSshTarget(sshTarget);
  if (!parsed) {
    throw new Error(`Invalid ssh target: ${sshTarget}`);
  }
  return [
    "ssh",
    // -F replaces ~/.ssh/config entirely (native OpenSSH mechanism), so
    // targets can be Host aliases defined in the custom config.
    ...(sshConfigPath !== undefined ? ["-F", sshConfigPath] : []),
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    ...(parsed.port !== undefined ? ["-p", String(parsed.port)] : []),
    parsed.destination,
  ];
}

// ssh forwards LANG/LC_* to the remote host (SendEnv in the default
// ssh_config), and the remote side may not have this machine's locale
// generated — producing setlocale warnings on every login. Strip them for ssh
// sessions so the remote host falls back to its own default locale. Browser-
// and display-related variables pass through unchanged; their policy belongs
// to the process manager or shell configuration.
export function buildSpawnEnv(isSsh: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
  if (isSsh) {
    for (const key of Object.keys(env)) {
      if (key === "LANG" || key === "LANGUAGE" || key.startsWith("LC_")) {
        delete env[key];
      }
    }
  }
  return env;
}

// --- Helpers ---

function clampDimension(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

function closeClientSocket(ws: ServerWebSocket<WsData>, code?: number, reason?: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}

function sendOutputFrame(ws: ServerWebSocket<WsData>, data: Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(data.length + 1);
  frame[0] = OUTPUT_PREFIX;
  frame.set(data, 1);
  ws.send(frame);
}

function stopHeartbeat(session: PtySession): void {
  if (session.heartbeatTimer !== null) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
  session.heartbeatPending = false;
}

function startHeartbeat(session: PtySession): void {
  stopHeartbeat(session);

  session.heartbeatTimer = setInterval(() => {
    const ws = session.attachedWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(session);
      return;
    }

    if (session.heartbeatPending) {
      // Pong not received within interval — force detach
      console.log(`[session ${session.sessionId}] heartbeat timeout, detaching`);
      detachSession(session, HEARTBEAT_CLOSE_CODE, "Heartbeat timeout");
      return;
    }

    session.heartbeatPending = true;
    ws.send(encodeServerControl({ type: "ping", timestamp: Date.now() }));

    // Schedule timeout check: if still pending after HEARTBEAT_TIMEOUT_MS, detach
    setTimeout(() => {
      if (session.heartbeatPending && session.attachedWs === ws) {
        console.log(`[session ${session.sessionId}] heartbeat pong timeout, detaching`);
        detachSession(session, HEARTBEAT_CLOSE_CODE, "Heartbeat timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

// The child's exit code and terminating signal. The PTY usually closes a
// moment before the process is reaped, so wait briefly; a child that outlives
// its terminal is reported as unknown rather than holding the client up.
async function resolveExitStatus(
  proc: ReturnType<typeof Bun.spawn> | null,
): Promise<{ exitCode: number | null; signal: string | null }> {
  if (!proc) return { exitCode: null, signal: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EXIT_STATUS_WAIT_MS);
  });
  const exitCode = await Promise.race([proc.exited, timedOut]);
  clearTimeout(timer);
  if (exitCode === null) return { exitCode: null, signal: null };
  const signal = proc.signalCode;
  return signal ? { exitCode: null, signal } : { exitCode, signal: null };
}

// --- Session lifecycle ---

export function createSession(ws: ServerWebSocket<WsData>, cols: number, rows: number, sshTarget?: string): void {
  let command: string[];
  try {
    command = buildSessionCommand(sshTarget);
  } catch {
    ws.send(encodeServerControl({ type: "error", message: "Invalid ssh target" }));
    closeClientSocket(ws, 1008, "Invalid ssh target");
    return;
  }

  const sessionId = crypto.randomUUID();
  const clampedCols = clampDimension(cols, 80, MAX_COLS);
  const clampedRows = clampDimension(rows, 24, MAX_ROWS);

  const shadow = createShadowTerminal(clampedCols, clampedRows);

  const session: PtySession = {
    sessionId,
    target: sshTarget ?? null,
    proc: null,
    cols: clampedCols,
    rows: clampedRows,
    shadowTerm: shadow.term,
    serializeAddon: shadow.addon,
    attachPending: null,
    attachedWs: ws,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastDetachedAt: null,
    state: "spawning",
    heartbeatTimer: null,
    heartbeatPending: false,
  };

  sessions.set(sessionId, session);
  ws.data.sessionId = sessionId;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      cwd: spawnCwd,
      terminal: {
        cols: clampedCols,
        rows: clampedRows,
        data(_terminal, data: Uint8Array) {
          const current = sessions.get(sessionId);
          if (!current) return;

          current.lastActivityAt = Date.now();
          // Copy: xterm queues writes without copying, and Bun may reuse `data`'s buffer.
          const chunk = data.slice();
          current.shadowTerm.write(chunk);

          if (current.attachPending) {
            current.attachPending.push(chunk);
          } else if (current.attachedWs && current.state === "attached") {
            sendOutputFrame(current.attachedWs, data);
          }
        },
        exit(_terminal, ptyExitCode, ptySignal) {
          const current = sessions.get(sessionId);
          if (!current) return;

          console.log(`[session ${sessionId}] PTY exited (code=${ptyExitCode}, signal=${ptySignal})`);
          const child = current.proc;
          const ws = current.attachedWs;
          current.state = "dead";
          current.proc = null;
          current.attachPending = null;
          current.attachedWs = null;
          current.shadowTerm.dispose();
          stopHeartbeat(current);
          sessions.delete(sessionId);

          if (!ws) return;
          // The callback's arguments describe the PTY (0 = EOF), not the
          // command that ran in it. Report the child's own exit status so the
          // client can tell a clean `exit` from a failed ssh.
          void resolveExitStatus(child).then((status) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(encodeServerControl({ type: "session_ended", ...status }));
            closeClientSocket(ws, 1000, "Session destroyed");
          });
        },
      },
      env: buildSpawnEnv(sshTarget !== undefined),
    });
  } catch (error) {
    console.error(`[session ${sessionId}] Failed to spawn PTY:`, error);
    session.shadowTerm.dispose();
    sessions.delete(sessionId);
    ws.data.sessionId = null;
    closeClientSocket(ws, 1011, "Failed to spawn shell");
    return;
  }

  session.proc = proc;
  session.state = "attached";
  console.log(`[session ${sessionId}] spawned pid=${proc.pid} (${JSON.stringify(command)})`);

  ws.send(encodeServerControl({ type: "session_info", sessionId }));
  startHeartbeat(session);
}

export function attachSession(sessionId: string, ws: ServerWebSocket<WsData>, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (!session || session.state === "dead") {
    ws.data.sessionId = null;
    ws.send(encodeServerControl({ type: "error", message: "Session not found or already dead" }));
    return;
  }

  // Detach previous client if still connected
  if (session.attachedWs && session.attachedWs !== ws) {
    closeClientSocket(session.attachedWs, REPLACED_CLOSE_CODE, "Replaced by new connection");
  }

  session.attachedWs = ws;
  session.state = "attached";
  session.lastDetachedAt = null;
  session.lastActivityAt = Date.now();
  ws.data.sessionId = sessionId;

  resizeSession(session, cols, rows);

  // Send session info
  ws.send(encodeServerControl({ type: "session_info", sessionId }));

  // Send a full-state snapshot once the shadow terminal has parsed all PTY
  // output received so far. Live output arriving in the meantime is queued in
  // attachPending and flushed after the snapshot, preserving byte order.
  const pending: Uint8Array[] = [];
  session.attachPending = pending;
  session.shadowTerm.write("", () => {
    if (session.attachPending !== pending) return; // superseded by a newer attach, detach, or destroy
    session.attachPending = null;
    if (session.attachedWs !== ws) return;

    const snapshot = buildSnapshot(session);
    if (snapshot.length > 0) {
      sendOutputFrame(ws, snapshot);
    }
    for (const chunk of pending) {
      sendOutputFrame(ws, chunk);
    }
  });

  startHeartbeat(session);
}

export function resizeSession(session: PtySession, cols: number | undefined, rows: number | undefined): void {
  const clampedCols = clampDimension(cols, 80, MAX_COLS);
  const clampedRows = clampDimension(rows, 24, MAX_ROWS);
  if (session.cols === clampedCols && session.rows === clampedRows) return;

  session.cols = clampedCols;
  session.rows = clampedRows;
  try {
    session.proc?.terminal?.resize(clampedCols, clampedRows);
  } catch {
    // Terminal may be in an odd state
  }
  try {
    session.shadowTerm.resize(clampedCols, clampedRows);
  } catch {
    // Shadow terminal may already be disposed
  }
}

export function detachSession(session: PtySession, closeCode?: number, closeReason?: string): void {
  stopHeartbeat(session);
  session.attachPending = null;

  if (session.attachedWs) {
    closeClientSocket(session.attachedWs, closeCode, closeReason);
    session.attachedWs = null;
  }

  if (session.state !== "dead") {
    session.state = "detached";
    session.lastDetachedAt = Date.now();
    console.log(`[session ${session.sessionId}] detached`);
  }
}

// Returns false when there was no such session to destroy.
export function destroySession(sessionId: string, closeCode: number = RESTART_CLOSE_CODE): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  console.log(`[session ${sessionId}] destroying`);
  // Deregister and close the client socket before touching the process:
  // terminal.close() invokes the PTY exit callback synchronously, which would
  // otherwise find the session still registered and close the socket itself
  // with code 1000, clobbering `closeCode`.
  sessions.delete(sessionId);
  stopHeartbeat(session);
  session.state = "dead";
  session.attachPending = null;
  session.shadowTerm.dispose();

  if (session.attachedWs) {
    closeClientSocket(session.attachedWs, closeCode, closeCode === ENDED_CLOSE_CODE ? "Session ended" : "Restart");
    session.attachedWs = null;
  }

  if (session.proc) {
    const proc = session.proc;
    try {
      proc.terminal?.close();
    } catch {
      // Terminal may already be closed
    }
    try {
      proc.kill();
    } catch {
      // Process may already be dead
    }
    // Escalate if SIGHUP/SIGTERM is ignored (e.g. an ssh wedged on a dead
    // network) so no process outlives its session.
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
    }, KILL_ESCALATION_MS);
    void proc.exited.finally(() => clearTimeout(killTimer));
    session.proc = null;
  }
  return true;
}

export function destroyAllSessions(): void {
  for (const sessionId of [...sessions.keys()]) {
    destroySession(sessionId);
  }
}

export function handlePong(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.heartbeatPending = false;
  }
}

export function getSession(sessionId: string): PtySession | undefined {
  return sessions.get(sessionId);
}

export interface SessionSummary {
  sessionId: string;
  state: PtySession["state"];
  // ssh destination, or null for the local shell
  target: string | null;
  pid: number | undefined;
  createdAt: number;
  lastActivityAt: number;
  // When the stale sweep will reap the session; null while a client is attached.
  expiresAt: number | null;
}

function summarizeSession(s: PtySession): SessionSummary {
  return {
    sessionId: s.sessionId,
    state: s.state,
    target: s.target,
    pid: s.proc?.pid,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.state === "detached" && s.lastDetachedAt !== null ? s.lastDetachedAt + SESSION_IDLE_TIMEOUT_MS : null,
  };
}

export function getSessionSummary(sessionId: string): SessionSummary | undefined {
  const session = sessions.get(sessionId);
  return session && session.state !== "dead" ? summarizeSession(session) : undefined;
}

export function getSessionSummaries(): SessionSummary[] {
  return [...sessions.values()].map(summarizeSession);
}

// --- Stale session sweep ---

function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.state === "detached" && session.lastDetachedAt !== null) {
      const idleMs = now - session.lastDetachedAt;
      if (idleMs >= SESSION_IDLE_TIMEOUT_MS) {
        console.log(`[session ${sessionId}] stale (detached for ${Math.round(idleMs / 1000)}s), destroying`);
        destroySession(sessionId);
      }
    }
  }
}

export function startStaleSweep(): void {
  if (staleSweepTimer !== null) return;
  staleSweepTimer = setInterval(sweepStaleSessions, STALE_SWEEP_INTERVAL_MS);
}

export function stopStaleSweep(): void {
  if (staleSweepTimer !== null) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
}

// --- Graceful shutdown ---

function gracefulShutdown(): void {
  console.log("Shutting down: destroying all sessions");
  stopStaleSweep();
  destroyAllSessions();
  process.exit(0);
}

let shutdownHandlersRegistered = false;

export function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);
}
