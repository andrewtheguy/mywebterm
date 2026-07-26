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

// The leading character of a user or hostname must be alphanumeric so a
// destination can never be mistaken for an ssh option (e.g.
// "-oProxyCommand=..."). IPv6 literals are handled separately below.
const SSH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IPV6_ZONE_RE = /^[A-Za-z0-9._-]+$/;

function isIpv4Address(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// IPv6 literal, optionally with a "%zone" scope suffix (link-local addresses).
// Written out rather than done with one regex so the group count and the
// IPv4-mapped tail stay readable.
function isIpv6Address(text: string): boolean {
  const percent = text.indexOf("%");
  let addr = text;
  if (percent !== -1) {
    addr = text.slice(0, percent);
    if (!IPV6_ZONE_RE.test(text.slice(percent + 1))) return false;
  }
  if (!addr.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(addr)) return false;

  const halves = addr.split("::");
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;

  let groups = 0;
  for (const [i, half] of halves.entries()) {
    if (half === "") continue;
    const parts = half.split(":");
    for (const [j, part] of parts.entries()) {
      if (part.includes(".")) {
        // An IPv4-mapped tail is only valid as the very last group.
        if (i !== halves.length - 1 || j !== parts.length - 1) return false;
        if (!isIpv4Address(part)) return false;
        groups += 2;
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return false;
        groups += 1;
      }
    }
  }
  return compressed ? groups <= 7 : groups === 8;
}

// Accepts "[user@]host[:port]", where host is a hostname, an IPv4 address, a
// bracketed IPv6 literal ("[fdb8::1]", the only form that can carry a port) or
// a bare IPv6 literal ("fdb8::1"). Brackets are stripped from the returned
// destination: ssh resolves "user@fdb8::1" but not "user@[fdb8::1]".
export function parseSshTarget(raw: string): SshTarget | null {
  if (raw.length === 0 || raw.length > 256) return null;

  let rest = raw;
  let user: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    user = rest.slice(0, at);
    if (!SSH_NAME_RE.test(user)) return null;
    rest = rest.slice(at + 1);
  }

  let host: string;
  let portText: string | undefined;
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end === -1) return null;
    host = rest.slice(1, end);
    if (!isIpv6Address(host)) return null;
    const tail = rest.slice(end + 1);
    if (tail !== "") {
      if (!tail.startsWith(":")) return null;
      portText = tail.slice(1);
    }
  } else if (isIpv6Address(rest)) {
    // Unbracketed: a trailing ":port" would be indistinguishable from another
    // address group, so the whole string is the address.
    host = rest;
  } else {
    const colon = rest.indexOf(":");
    host = colon === -1 ? rest : rest.slice(0, colon);
    if (colon !== -1) portText = rest.slice(colon + 1);
    if (!SSH_NAME_RE.test(host)) return null;
  }

  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }

  const destination = user !== undefined ? `${user}@${host}` : host;
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
