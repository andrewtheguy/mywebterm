// Extract concrete Host aliases from an OpenSSH client config. The config
// format itself is interpreted by ssh (-F); we only list the aliases so the
// GUI can offer them as choices. Wildcard/negated patterns are skipped.
export function parseSshConfigHosts(content: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = line.match(/^Host\s+(.+)$/i);
    if (!match) continue;

    for (const name of (match[1] as string).split(/\s+/)) {
      if (name.length === 0) continue;
      if (/[*?!]/.test(name)) continue; // pattern, not a concrete host
      if (!seen.has(name)) {
        seen.add(name);
        hosts.push(name);
      }
    }
  }

  return hosts;
}
