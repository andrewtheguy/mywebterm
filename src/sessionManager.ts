import type { ServerWebSocket } from "bun";
import { encodeServerControl } from "./ttyProtocol";

// --- Types ---

export interface WsData {
  sessionId: string | null;
  connectionId: string;
}

export interface PtySession {
  sessionId: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  cols: number;
  rows: number;
  scrollbackBuffer: ScrollbackBuffer;
  attachedWs: ServerWebSocket<WsData> | null;
  createdAt: number;
  lastActivityAt: number;
  lastDetachedAt: number | null;
  state: "spawning" | "attached" | "detached" | "dead";
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatPending: boolean;
}

// --- Constants ---

const SCROLLBACK_CAPACITY = 100 * 1024; // 100KB
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

// --- ScrollbackBuffer ---

export class ScrollbackBuffer {
  private buffer: Uint8Array;
  private head = 0;
  private length = 0;

  constructor(private capacity = SCROLLBACK_CAPACITY) {
    this.buffer = new Uint8Array(capacity);
  }

  write(data: Uint8Array): void {
    if (data.length === 0) return;

    if (data.length >= this.capacity) {
      // Data larger than buffer: keep only the last `capacity` bytes
      this.buffer.set(data.subarray(data.length - this.capacity));
      this.head = 0;
      this.length = this.capacity;
      return;
    }

    const writeStart = (this.head + this.length) % this.capacity;
    const firstChunk = Math.min(data.length, this.capacity - writeStart);
    this.buffer.set(data.subarray(0, firstChunk), writeStart);
    if (firstChunk < data.length) {
      this.buffer.set(data.subarray(firstChunk), 0);
    }

    const newLength = this.length + data.length;
    if (newLength > this.capacity) {
      const overflow = newLength - this.capacity;
      this.head = (this.head + overflow) % this.capacity;
      this.length = this.capacity;
    } else {
      this.length = newLength;
    }
  }

  read(): Uint8Array {
    if (this.length === 0) return new Uint8Array(0);

    const result = new Uint8Array(this.length);
    const firstChunk = Math.min(this.length, this.capacity - this.head);
    result.set(this.buffer.subarray(this.head, this.head + firstChunk));
    if (firstChunk < this.length) {
      result.set(this.buffer.subarray(0, this.length - firstChunk), firstChunk);
    }
    return result;
  }

  clear(): void {
    this.head = 0;
    this.length = 0;
  }

  get size(): number {
    return this.length;
  }
}

// --- Module state ---

const sessions = new Map<string, PtySession>();
let staleSweepTimer: ReturnType<typeof setInterval> | null = null;
let shellCommand: string[] = [process.env.SHELL || "/bin/sh"];

export function setShellCommand(cmd: string[]): void {
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

  const session: PtySession = {
    sessionId,
    proc: null,
    cols: clampedCols,
    rows: clampedRows,
    scrollbackBuffer: new ScrollbackBuffer(),
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
      terminal: {
        cols: clampedCols,
        rows: clampedRows,
        data(_terminal, data: Uint8Array) {
          const current = sessions.get(sessionId);
          if (!current) return;

          current.lastActivityAt = Date.now();
          current.scrollbackBuffer.write(data);

          if (current.attachedWs && current.state === "attached") {
            sendOutputFrame(current.attachedWs, data);
          }
        },
        exit(_terminal, exitCode, signal) {
          const current = sessions.get(sessionId);
          if (!current) return;

          console.log(`[session ${sessionId}] PTY exited (code=${exitCode}, signal=${signal})`);
          current.state = "dead";
          current.proc = null;
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
    ws.send(encodeServerControl({ type: "error", message: "Session not found or already dead" }));
    return;
  }

  // Detach previous client if still connected
  if (session.attachedWs && session.attachedWs !== ws) {
    closeClientSocket(session.attachedWs, 4002, "Replaced by new connection");
  }

  const clampedCols = clampDimension(cols, 80, MAX_COLS);
  const clampedRows = clampDimension(rows, 24, MAX_ROWS);

  session.attachedWs = ws;
  session.state = "attached";
  session.lastDetachedAt = null;
  session.lastActivityAt = Date.now();
  ws.data.sessionId = sessionId;

  // Resize PTY if dimensions changed
  if (session.proc?.terminal && (session.cols !== clampedCols || session.rows !== clampedRows)) {
    session.cols = clampedCols;
    session.rows = clampedRows;
    try {
      session.proc.terminal.resize(clampedCols, clampedRows);
    } catch {
      // Terminal may be in an odd state
    }
  }

  // Send session info
  ws.send(encodeServerControl({ type: "session_info", sessionId }));

  // Replay scrollback buffer
  const scrollback = session.scrollbackBuffer.read();
  if (scrollback.length > 0) {
    sendOutputFrame(ws, scrollback);
  }

  startHeartbeat(session);
}

export function detachSession(session: PtySession, closeCode?: number, closeReason?: string): void {
  stopHeartbeat(session);

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
  scrollbackSize: number;
}[] {
  return [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    state: s.state,
    pid: s.proc?.pid,
    lastActivityAt: s.lastActivityAt,
    scrollbackSize: s.scrollbackBuffer.size,
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

export function registerShutdownHandlers(): void {
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);
}
