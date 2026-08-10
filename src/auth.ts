export { initHtpasswd, verifyCredentials } from "./htpasswd";

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface SessionData {
  expiresAt: number;
  username: string;
}

const validTokens = new Map<string, SessionData>();

const COOKIE_NAME = "mywebterm_session";

// Whether the cookie gets `Secure` follows the scheme the browser actually used.
// Safari, unlike Chrome, drops `Secure` cookies on plain http:// even for
// localhost, so a hardcoded `Secure` silently breaks login behind a reverse
// proxy that speaks HTTP (e.g. `http://foo.localhost:3800` via Caddy). Sending a
// plaintext cookie over a plaintext connection gives nothing away that the
// connection itself wasn't already exposing. Behind a proxy the real scheme
// arrives in X-Forwarded-Proto; direct connections fall back to the request URL.
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function purgeExpiredTokens(): void {
  const now = Date.now();
  for (const [token, data] of validTokens) {
    if (now >= data.expiresAt) {
      validTokens.delete(token);
    }
  }
}

setInterval(purgeExpiredTokens, PURGE_INTERVAL_MS).unref();

export function createSession(username: string): string {
  purgeExpiredTokens();
  const token = crypto.randomUUID();
  validTokens.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, username });
  return token;
}

export function isValidSession(token: string): boolean {
  const data = validTokens.get(token);
  if (data === undefined) return false;
  if (Date.now() >= data.expiresAt) {
    validTokens.delete(token);
    return false;
  }
  // Refresh TTL on activity rather than rotating the token. createSession()
  // issues a fresh token on each login, which prevents classic session fixation.
  // The cookie is HttpOnly + SameSite=Strict (+ Secure over HTTPS).
  data.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

export function invalidateSession(token: string): void {
  validTokens.delete(token);
}

export function invalidateAllSessions(): void {
  validTokens.clear();
}

export function getSessionCookie(token: string, req: Request): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict${secure}; Path=/`;
}

export function clearSessionCookie(req: Request): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict${secure}; Path=/; Max-Age=0`;
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
