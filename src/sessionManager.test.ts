import { describe, expect, test } from "bun:test";
import { buildSessionCommand, buildSpawnEnv, setShellCommand, setSshConfigPath } from "./sessionManager";

describe("buildSessionCommand", () => {
  test("returns the configured shell command unchanged when no ssh target is given", () => {
    setShellCommand(["/bin/bash", "--norc"]);
    const command = buildSessionCommand(undefined);
    expect(command).toEqual(["/bin/bash", "--norc"]);

    command.push("--mutated");
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

  test("inserts -F when a custom ssh config is set", () => {
    setSshConfigPath("/etc/mywebterm/ssh_config");
    try {
      expect(buildSessionCommand("nas")).toEqual([
        "ssh",
        "-F",
        "/etc/mywebterm/ssh_config",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "nas",
      ]);
    } finally {
      setSshConfigPath(undefined);
    }
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

  test("preserves browser-related variables in local sessions", () => {
    const saved = {
      BROWSER: process.env.BROWSER,
      DISPLAY: process.env.DISPLAY,
      PATH: process.env.PATH,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      WEBTERM_TTY: process.env.WEBTERM_TTY,
    };
    process.env.BROWSER = "/custom/browser";
    process.env.DISPLAY = ":42";
    process.env.PATH = "/custom/bin";
    process.env.WAYLAND_DISPLAY = "wayland-42";
    process.env.WEBTERM_TTY = "/dev/pts/42";
    try {
      const local = buildSpawnEnv(false);
      expect(local.BROWSER).toBe("/custom/browser");
      expect(local.DISPLAY).toBe(":42");
      expect(local.PATH).toBe("/custom/bin");
      expect(local.WAYLAND_DISPLAY).toBe("wayland-42");
      expect(local.WEBTERM_TTY).toBe("/dev/pts/42");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
