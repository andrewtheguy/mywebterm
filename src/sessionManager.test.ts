import { describe, expect, test } from "bun:test";

import { buildSessionCommand, buildSpawnEnv, setShellCommand } from "./sessionManager";

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

describe("buildSpawnEnv", () => {
  test("keeps locale variables for local shell sessions", () => {
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LANG = "en_US.UTF-8";
    const env = buildSpawnEnv(false);
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
  });

  test("strips LANG/LANGUAGE/LC_* for ssh sessions", () => {
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LC_CTYPE = "en_US.UTF-8";
    process.env.LANG = "en_US.UTF-8";
    process.env.LANGUAGE = "en_US:en";
    const env = buildSpawnEnv(true);
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.LANG).toBeUndefined();
    expect(env.LANGUAGE).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.PATH).toBe(process.env.PATH);
  });
});
