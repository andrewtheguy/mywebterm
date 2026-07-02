import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as ShadowTerminal } from "@xterm/headless";
import type { ServerWebSocket } from "bun";
import { encodeServerControl } from "./ttyProtocol";

// --- Types ---

export interface WsData {
  sessionId: string | null;
  connectionId: string;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

export interface PtySession {
  sessionId: string;
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
const MAX_COLS = 500;
const MAX_ROWS = 200;
const OUTPUT_PREFIX = 0x30; // "0" — ServerCommand.OUTPUT
const RESTART_CLOSE_CODE = 4000;
const HEARTBEAT_CLOSE_CODE = 4001;

export { RESTART_CLOSE_CODE };

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

// --- Session lifecycle ---

export function createSession(ws: ServerWebSocket<WsData>, cols: number, rows: number): void {
  const sessionId = crypto.randomUUID();
  const clampedCols = clampDimension(cols, 80, MAX_COLS);
  const clampedRows = clampDimension(rows, 24, MAX_ROWS);

  const shadow = createShadowTerminal(clampedCols, clampedRows);

  const session: PtySession = {
    sessionId,
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
    proc = Bun.spawn(shellCommand, {
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
        exit(_terminal, exitCode, signal) {
          const current = sessions.get(sessionId);
          if (!current) return;

          console.log(`[session ${sessionId}] PTY exited (code=${exitCode}, signal=${signal})`);
          current.state = "dead";
          current.proc = null;
          current.attachPending = null;
          current.shadowTerm.dispose();
          stopHeartbeat(current);

          if (current.attachedWs) {
            current.attachedWs.send(
              encodeServerControl({ type: "session_ended", exitCode: exitCode ?? null, signal: signal ?? null }),
            );
            closeClientSocket(current.attachedWs, 1000, "Session destroyed");
            current.attachedWs = null;
          }

          sessions.delete(sessionId);
        },
      },
      env: { ...process.env, TERM: "xterm-256color" },
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
    closeClientSocket(session.attachedWs, 4002, "Replaced by new connection");
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

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log(`[session ${sessionId}] destroying`);
  stopHeartbeat(session);
  session.state = "dead";
  session.attachPending = null;
  session.shadowTerm.dispose();

  if (session.proc) {
    try {
      session.proc.terminal?.close();
    } catch {
      // Terminal may already be closed
    }
    try {
      session.proc.kill();
    } catch {
      // Process may already be dead
    }
    session.proc = null;
  }

  if (session.attachedWs) {
    closeClientSocket(session.attachedWs, RESTART_CLOSE_CODE, "Restart");
    session.attachedWs = null;
  }

  sessions.delete(sessionId);
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

export function getSessionSummaries(): {
  sessionId: string;
  state: string;
  pid: number | undefined;
  lastActivityAt: number;
}[] {
  return [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    state: s.state,
    pid: s.proc?.pid,
    lastActivityAt: s.lastActivityAt,
  }));
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
