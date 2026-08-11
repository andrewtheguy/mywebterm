import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRemoteBootstrap,
  HELPER_NAME,
  provisionLocalHelper,
  removeLocalHelper,
  wrapLocalCommand,
} from "./openHelper";
import { buildSessionCommand, buildSpawnEnv, setShellCommand, setSshConfigPath } from "./sessionManager";

const BOOTSTRAP = buildRemoteBootstrap();

describe("buildSessionCommand", () => {
  test("wraps the configured shell command when no ssh target is given", () => {
    setShellCommand(["/bin/bash", "--norc"]);
    expect(buildSessionCommand(undefined)).toEqual(wrapLocalCommand(["/bin/bash", "--norc"]));
  });

  test("builds an ssh command with keepalive options", () => {
    expect(buildSessionCommand("user@host")).toEqual([
      "ssh",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-tt",
      "user@host",
      BOOTSTRAP,
    ]);
  });

  test("translates a :port suffix into -p", () => {
    expect(buildSessionCommand("user@host:2222")).toEqual([
      "ssh",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-tt",
      "-p",
      "2222",
      "user@host",
      BOOTSTRAP,
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
        "-tt",
        "nas",
        BOOTSTRAP,
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

  test("puts webterm-open on PATH for local sessions only", () => {
    // Installed to a fixed path now, so point it away from the real one.
    const runtime = mkdtempSync(join(tmpdir(), "mywebterm-test-"));
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;

    const dir = provisionLocalHelper();
    try {
      const local = buildSpawnEnv(false);
      expect(local.PATH?.startsWith(`${dir}:`)).toBe(true);
      expect(local.BROWSER).toBe(join(dir as string, HELPER_NAME));

      // ssh sessions get the helper from the bootstrap command instead — a
      // local path exported across the hop would point at nothing.
      const remote = buildSpawnEnv(true);
      expect(remote.PATH).toBe(process.env.PATH);
    } finally {
      removeLocalHelper();
      rmSync(runtime, { recursive: true, force: true });
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});
