const encoder = new TextEncoder();

export const ClientCommand = {
  INPUT: "0",
  RESIZE_TERMINAL: "1",
} as const;

export const ServerCommand = {
  OUTPUT: "0",
  SET_WINDOW_TITLE: "1",
  SET_PREFERENCES: "2",
} as const;

export interface DecodedFrame {
  command: string;
  payload: Uint8Array;
}

// --- Control messages (JSON text frames) ---

export type ClientControlMessage =
  | { type: "handshake"; columns: number; rows: number; sshTarget?: string }
  | { type: "reconnect"; sessionId: string; columns: number; rows: number }
  | { type: "pong"; timestamp: number }
  // End the current session deliberately (kill the PTY, return to the start screen)
  | { type: "terminate" };

// --- SSH destinations ---

export interface SshTarget {
  destination: string; // [user@]host, safe to pass to ssh as a positional arg
  port?: number;
}

// Accepts "[user@]host[:port]". The leading character of user and host must be
// alphanumeric so a destination can never be mistaken for an ssh option
// (e.g. "-oProxyCommand=..."). IPv6 literals are not supported.
const SSH_TARGET_RE = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/;

export function parseSshTarget(raw: string): SshTarget | null {
  if (raw.length === 0 || raw.length > 256) return null;
  const match = raw.match(SSH_TARGET_RE);
  if (!match) return null;

  let port: number | undefined;
  if (match[3] !== undefined) {
    port = Number(match[3]);
    if (port < 1 || port > 65535) return null;
  }

  const destination = match[1] ? `${match[1]}@${match[2]}` : (match[2] as string);
  return { destination, port };
}

export type ServerControlMessage =
  | { type: "session_info"; sessionId: string }
  | { type: "ping"; timestamp: number }
  | { type: "session_ended"; exitCode: number | null; signal: string | null }
  | { type: "error"; message: string };

export function parseClientControl(text: string): ClientControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  const isValidDimension = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;

  switch (msg.type) {
    case "handshake": {
      if (!isValidDimension(msg.columns) || !isValidDimension(msg.rows)) {
        return null;
      }
      if (msg.sshTarget !== undefined) {
        if (typeof msg.sshTarget !== "string" || parseSshTarget(msg.sshTarget) === null) {
          return null;
        }
        return { type: "handshake", columns: msg.columns, rows: msg.rows, sshTarget: msg.sshTarget };
      }
      return { type: "handshake", columns: msg.columns, rows: msg.rows };
    }
    case "reconnect":
      if (typeof msg.sessionId === "string" && isValidDimension(msg.columns) && isValidDimension(msg.rows)) {
        return { type: "reconnect", sessionId: msg.sessionId, columns: msg.columns, rows: msg.rows };
      }
      return null;
    case "pong":
      if (typeof msg.timestamp === "number") {
        return { type: "pong", timestamp: msg.timestamp };
      }
      return null;
    case "terminate":
      return { type: "terminate" };
    default:
      return null;
  }
}

export function encodeServerControl(msg: ServerControlMessage): string {
  return JSON.stringify(msg);
}

function encodePrefixedPayload(command: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefixed = new Uint8Array(payload.length + 1);
  prefixed[0] = command.charCodeAt(0);
  prefixed.set(payload, 1);
  return prefixed;
}

function normalizeHandshakeDimension(name: "columns" | "rows", value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid ${name}: expected a finite number, got ${value}.`);
  }

  if (value <= 0) {
    throw new TypeError(`Invalid ${name}: expected a positive number, got ${value}.`);
  }

  return Math.max(1, Math.floor(value));
}

export function buildHandshake(columns: number, rows: number): string {
  // Contract: handshake dimensions must be finite, positive integers.
  const normalizedColumns = normalizeHandshakeDimension("columns", columns);
  const normalizedRows = normalizeHandshakeDimension("rows", rows);
  return JSON.stringify({ type: "handshake", columns: normalizedColumns, rows: normalizedRows });
}

export function encodeInput(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const payload = typeof data === "string" ? encoder.encode(data) : data;
  return encodePrefixedPayload(ClientCommand.INPUT, payload);
}

export function encodeResize(columns: number, rows: number): Uint8Array<ArrayBuffer> {
  const normalizedColumns = normalizeHandshakeDimension("columns", columns);
  const normalizedRows = normalizeHandshakeDimension("rows", rows);
  const payload = encoder.encode(JSON.stringify({ columns: normalizedColumns, rows: normalizedRows }));
  return encodePrefixedPayload(ClientCommand.RESIZE_TERMINAL, payload);
}

export function decodeFrame(arrayBuffer: ArrayBuffer): DecodedFrame {
  const payload = new Uint8Array(arrayBuffer);
  if (payload.length === 0) {
    throw new Error("Cannot decode an empty tty frame.");
  }

  return {
    command: String.fromCharCode(payload[0] as number),
    payload: payload.slice(1),
  };
}
