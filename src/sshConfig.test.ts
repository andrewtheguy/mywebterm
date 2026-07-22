import { describe, expect, test } from "bun:test";

import { parseSshConfigHosts } from "./sshConfig";

describe("parseSshConfigHosts", () => {
  test("lists concrete host aliases, skipping patterns and comments", () => {
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
`;
    expect(parseSshConfigHosts(config)).toEqual(["nas", "nas.local.priv.example.com", "pbs"]);
  });

  test("deduplicates and handles empty content", () => {
    expect(parseSshConfigHosts("")).toEqual([]);
    expect(parseSshConfigHosts("Host a\nHost a b\n")).toEqual(["a", "b"]);
  });
});
