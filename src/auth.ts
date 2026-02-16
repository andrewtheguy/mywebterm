import { createHash, timingSafeEqual } from "node:crypto";

const AUTH_SECRET = process.env.AUTH_SECRET;

const validTokens = new Set<string>();

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

export function createSession(): string {
  const token = crypto.randomUUID();
  validTokens.add(token);
  return token;
}

export function isValidSession(token: string): boolean {
  return validTokens.has(token);
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
