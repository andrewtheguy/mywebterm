import { describe, expect, test } from "bun:test";

import { buildSessionCommand, setShellCommand } from "./sessionManager";

describe("buildSessionCommand", () => {
  test("returns the configured shell command when no ssh target is given", () => {
    setShellCommand(["/bin/bash", "--norc"]);
    expect(buildSessionCommand(undefined)).toEqual(["/bin/bash", "--norc"]);
  });

  test("builds an ssh command with keepalive options", () => {
    expect(buildSessionCommand("user@host")).toEqual([
      "ssh",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "user@host",
    ]);
  });

  test("translates a :port suffix into -p", () => {
    expect(buildSessionCommand("user@host:2222")).toEqual([
      "ssh",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "user@host",
    ]);
  });

  test("throws on invalid targets", () => {
    expect(() => buildSessionCommand("-oProxyCommand=evil")).toThrow();
    expect(() => buildSessionCommand("host name")).toThrow();
  });
});
