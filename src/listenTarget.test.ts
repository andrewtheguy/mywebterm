import { describe, expect, test } from "bun:test";

import { describeListenTarget, type ListenTarget, parseListenTarget } from "./listenTarget";

function parseAs<K extends ListenTarget["kind"]>(kind: K, raw: string): Extract<ListenTarget, { kind: K }> {
  const target = parseListenTarget(raw);
  expect(target.kind).toBe(kind);
  return target as Extract<ListenTarget, { kind: K }>;
}

describe("parseListenTarget", () => {
  test("treats a bare number as a port on loopback", () => {
    expect(parseListenTarget("8671")).toEqual({ kind: "tcp", hostname: "127.0.0.1", port: 8671, isLoopback: true });
  });

  test("parses host:port", () => {
    expect(parseListenTarget("0.0.0.0:9090")).toEqual({
      kind: "tcp",
      hostname: "0.0.0.0",
      port: 9090,
      isLoopback: false,
    });
    expect(parseAs("tcp", "localhost:9090").isLoopback).toBe(true);
    expect(parseAs("tcp", "127.0.0.5:9090").isLoopback).toBe(true);
    expect(parseAs("tcp", "example.internal:9090").isLoopback).toBe(false);
  });

  test("parses bracketed IPv6 with a port", () => {
    expect(parseListenTarget("[::1]:8671")).toEqual({ kind: "tcp", hostname: "::1", port: 8671, isLoopback: true });
    expect(parseListenTarget("[fdb8::1]:8671")).toEqual({
      kind: "tcp",
      hostname: "fdb8::1",
      port: 8671,
      isLoopback: false,
    });
  });

  test("requires brackets around IPv6 so the port is unambiguous", () => {
    expect(() => parseListenTarget("::1:8671")).toThrow(/bracketed/);
    expect(() => parseListenTarget("[::1]")).toThrow(/:port/);
  });

  test("parses unix sockets, owner-only by default", () => {
    expect(parseListenTarget("unix:/run/mywebterm.sock")).toEqual({
      kind: "unix",
      path: "/run/mywebterm.sock",
      mode: 0o600,
    });
  });

  test("parses an explicit socket mode", () => {
    expect(parseListenTarget("unix:/run/mywebterm.sock,mode=660")).toEqual({
      kind: "unix",
      path: "/run/mywebterm.sock",
      mode: 0o660,
    });
    expect(parseAs("unix", "unix:/run/mywebterm.sock,mode=0660").mode).toBe(0o660);
  });

  test("keeps a path that only looks like a mode suffix", () => {
    expect(parseListenTarget("unix:/run/sock,mode=99")).toEqual({
      kind: "unix",
      path: "/run/sock,mode=99",
      mode: 0o600,
    });
  });

  test("rejects malformed values", () => {
    expect(() => parseListenTarget("")).toThrow();
    expect(() => parseListenTarget("0")).toThrow(/1-65535/);
    expect(() => parseListenTarget("70000")).toThrow(/1-65535/);
    expect(() => parseListenTarget("127.0.0.1:0")).toThrow(/1-65535/);
    expect(() => parseListenTarget("127.0.0.1:http")).toThrow(/1-65535/);
    expect(() => parseListenTarget("127.0.0.1")).toThrow(/missing port/);
    expect(() => parseListenTarget(":8671")).toThrow(/host is empty/);
    expect(() => parseListenTarget("unix:")).toThrow(/path is empty/);
  });
});

describe("describeListenTarget", () => {
  test("renders a URL for tcp and a path with mode for unix", () => {
    expect(describeListenTarget(parseListenTarget("8671"))).toBe("http://127.0.0.1:8671/");
    expect(describeListenTarget(parseListenTarget("[::1]:8671"))).toBe("http://[::1]:8671/");
    expect(describeListenTarget(parseListenTarget("unix:/run/wt.sock,mode=660"))).toBe("/run/wt.sock (mode 660)");
  });
});
