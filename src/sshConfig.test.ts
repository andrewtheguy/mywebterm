import { describe, expect, test } from "bun:test";

import { parseSshConfigHosts } from "./sshConfig";

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
