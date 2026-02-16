import { createHash, timingSafeEqual } from "node:crypto";

const AUTH_SECRET = process.env.AUTH_SECRET;

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const validTokens = new Map<string, number>(); // token -> expiresAt

const COOKIE_NAME = "mywebterm_session";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function hasAuthSecret(): boolean {
  return AUTH_SECRET != null && AUTH_SECRET.length > 0;
}

export function validateSecret(candidate: string): boolean {
  const a = sha256(candidate);
  const b = sha256(AUTH_SECRET ?? "");
  return timingSafeEqual(a, b) && AUTH_SECRET !== undefined;
}

function purgeExpiredTokens(): void {
  const now = Date.now();
  for (const [token, expiresAt] of validTokens) {
    if (now >= expiresAt) {
      validTokens.delete(token);
    }
  }
}

setInterval(purgeExpiredTokens, PURGE_INTERVAL_MS).unref();

export function createSession(): string {
  purgeExpiredTokens();
  const token = crypto.randomUUID();
  validTokens.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function isValidSession(token: string): boolean {
  const expiresAt = validTokens.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    validTokens.delete(token);
    return false;
  }
  // Refresh TTL on activity rather than rotating the token. Session fixation
  // is not a practical concern here: the server binds to localhost only and is
  // expected to sit behind an authenticating reverse proxy, so an attacker
  // cannot inject or observe cookie values on the wire.
  validTokens.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

export function invalidateSession(token: string): void {
  validTokens.delete(token);
}

export function invalidateAllSessions(): void {
  validTokens.clear();
}

export function getSessionCookie(token: string, secure: boolean): string {
  let cookie = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  if (secure) {
    cookie += "; Secure";
  }
  return cookie;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function extractSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return null;
}

export function isRequestAuthenticated(req: Request): boolean {
  const token = extractSessionToken(req);
  if (!token) return false;
  return isValidSession(token);
}
