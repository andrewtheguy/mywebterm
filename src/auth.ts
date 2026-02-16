import { timingSafeEqual } from "node:crypto";

const AUTH_SECRET = process.env.AUTH_SECRET;

const validTokens = new Set<string>();

const COOKIE_NAME = "mywebterm_session";

export function getAuthSecret(): string | undefined {
  return AUTH_SECRET;
}

export function validateSecret(candidate: string): boolean {
  if (!AUTH_SECRET) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(AUTH_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
