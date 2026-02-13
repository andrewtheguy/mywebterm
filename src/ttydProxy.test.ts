import { describe, expect, test } from "bun:test";

import { isWebSocketUpgradeRequest, rewriteProxyRequestUrl } from "./ttydProxy";

describe("ttydProxy", () => {
  test("rewrites /ttyd/ws path to upstream /ws", () => {
    const upstreamBaseUrl = new URL("http://127.0.0.1:7681");
    const target = rewriteProxyRequestUrl("http://localhost:3000/ttyd/ws", upstreamBaseUrl);
    expect(target.toString()).toBe("http://127.0.0.1:7681/ws");
  });

  test("preserves query string while rewriting", () => {
    const upstreamBaseUrl = new URL("https://ttyd.example.com");
    const target = rewriteProxyRequestUrl("https://app.example.com/ttyd/token?x=1", upstreamBaseUrl);
    expect(target.toString()).toBe("https://ttyd.example.com/token?x=1");
  });

  test("combines proxy suffix with upstream base path", () => {
    const upstreamBaseUrl = new URL("http://127.0.0.1:7681/base/");
    const target = rewriteProxyRequestUrl("http://localhost:3000/ttyd/ws", upstreamBaseUrl);
    expect(target.toString()).toBe("http://127.0.0.1:7681/base/ws");
  });

  test("maps /ttyd to upstream root path", () => {
    const upstreamBaseUrl = new URL("http://127.0.0.1:7681/root");
    const target = rewriteProxyRequestUrl("http://localhost:3000/ttyd", upstreamBaseUrl);
    expect(target.toString()).toBe("http://127.0.0.1:7681/root");
  });

  test("throws when path does not match proxy prefix", () => {
    const upstreamBaseUrl = new URL("http://127.0.0.1:7681");
    expect(() =>
      rewriteProxyRequestUrl("http://localhost:3000/not-proxy/ws", upstreamBaseUrl),
    ).toThrowError('Proxy path must start with "/ttyd"');
  });

  test("detects websocket upgrade requests case-insensitively", () => {
    const req = new Request("http://localhost:3000/ttyd/ws", {
      headers: {
        upgrade: "WebSocket",
      },
    });
    expect(isWebSocketUpgradeRequest(req)).toBe(true);
  });

  test("returns false when upgrade header is missing", () => {
    const req = new Request("http://localhost:3000/ttyd/ws");
    expect(isWebSocketUpgradeRequest(req)).toBe(false);
  });

  test("returns false when upgrade header is not websocket", () => {
    const req = new Request("http://localhost:3000/ttyd/ws", {
      headers: {
        upgrade: "h2c",
      },
    });
    expect(isWebSocketUpgradeRequest(req)).toBe(false);
  });
});
