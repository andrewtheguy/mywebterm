import { describe, expect, test } from "bun:test";

import { parseTtydBaseUrl } from "./serverConfig";

describe("serverConfig", () => {
  test("returns error when TTYD_BASE_URL is missing", () => {
    const result = parseTtydBaseUrl(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("TTYD_BASE_URL");
    }
  });

  test("returns error when TTYD_BASE_URL is invalid", () => {
    const result = parseTtydBaseUrl("not-a-url");
    expect(result).toEqual({
      ok: false,
      error: "Invalid TTYD_BASE_URL: not-a-url",
    });
  });

  test("rejects unsupported protocols", () => {
    const result = parseTtydBaseUrl("ftp://127.0.0.1:7681");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unsupported protocol");
    }
  });

  test("normalizes path and strips query/hash from http base URL", () => {
    const result = parseTtydBaseUrl("http://127.0.0.1:7681/root///?token=abc#hash");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.config.httpBaseUrl.toString()).toBe("http://127.0.0.1:7681/root");
    expect(result.config.wsBaseUrl.toString()).toBe("ws://127.0.0.1:7681/root");
  });

  test("derives both http and ws bases from ws input", () => {
    const result = parseTtydBaseUrl("wss://ttyd.internal:443/api");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.config.httpBaseUrl.toString()).toBe("https://ttyd.internal/api");
    expect(result.config.wsBaseUrl.toString()).toBe("wss://ttyd.internal/api");
  });
});
