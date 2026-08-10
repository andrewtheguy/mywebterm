import { expect, test } from "bun:test";
import { clearSessionCookie, getSessionCookie, isSecureRequest } from "./auth";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

test("https requests are secure", () => {
  expect(isSecureRequest(req("https://example.com/login"))).toBe(true);
});

test("plain http requests are not secure", () => {
  expect(isSecureRequest(req("http://mywebterm.workstation-ct.localhost:3800/login"))).toBe(false);
});

test("x-forwarded-proto wins over the request url", () => {
  expect(isSecureRequest(req("http://localhost:8671/login", { "x-forwarded-proto": "https" }))).toBe(true);
  expect(isSecureRequest(req("https://localhost/login", { "x-forwarded-proto": "http" }))).toBe(false);
});

test("only the first x-forwarded-proto hop counts", () => {
  expect(isSecureRequest(req("http://localhost/login", { "x-forwarded-proto": "https, http" }))).toBe(true);
  expect(isSecureRequest(req("http://localhost/login", { "x-forwarded-proto": "http, https" }))).toBe(false);
});

test("session cookie omits Secure over plain http so Safari keeps it", () => {
  const cookie = getSessionCookie("tok", req("http://mywebterm.workstation-ct.localhost:3800/login"));
  expect(cookie).toBe("mywebterm_session=tok; HttpOnly; SameSite=Strict; Path=/");
});

test("session cookie sets Secure behind an https proxy", () => {
  const cookie = getSessionCookie("tok", req("http://localhost:8671/login", { "x-forwarded-proto": "https" }));
  expect(cookie).toBe("mywebterm_session=tok; HttpOnly; SameSite=Strict; Secure; Path=/");
});

test("clearing cookie mirrors the Secure flag", () => {
  expect(clearSessionCookie(req("http://localhost:8671/logout"))).toBe(
    "mywebterm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  expect(clearSessionCookie(req("https://example.com/logout"))).toBe(
    "mywebterm_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0",
  );
});
