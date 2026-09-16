import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSshConfigHosts, parseSshConfigHosts } from "./sshConfig";

describe("parseSshConfigHosts", () => {
  test("lists one alias per Host entry, skipping patterns and comments", () => {
    const config = `
# comment
Host nas nas.local.priv.example.com
  HostName nas.local.priv.example.com
  User debian

host pbs
  User root

Host *
  ServerAliveInterval 30

Host !bastion web-*
  User nobody

Host web-* fallbackname
  User www
`;
    expect(parseSshConfigHosts(config)).toEqual(["nas", "pbs", "fallbackname"]);
  });

  test("deduplicates and handles empty content", () => {
    expect(parseSshConfigHosts("")).toEqual([]);
    expect(parseSshConfigHosts("Host a\nHost a b\n")).toEqual(["a"]);
  });
});

describe("loadSshConfigHosts", () => {
  test("reads the current file contents on every call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mywebterm-sshconfig-"));
    const path = join(dir, "config");
    try {
      await Bun.write(path, "Host alpha\n");
      expect(await loadSshConfigHosts(path)).toEqual(["alpha"]);

      await Bun.write(path, "Host alpha\nHost beta\n");
      expect(await loadSshConfigHosts(path)).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws a readable error when the file is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mywebterm-sshconfig-"));
    const path = join(dir, "missing");
    try {
      expect(loadSshConfigHosts(path)).rejects.toThrow(`cannot read ssh config ${path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
