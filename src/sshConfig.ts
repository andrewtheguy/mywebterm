// Extract concrete Host aliases from an OpenSSH client config. The config
// format itself is interpreted by ssh (-F); we only list aliases so the GUI
// can offer them as choices. One entry per Host directive — the first
// concrete name is the canonical alias; extra names on the same line (e.g. an
// FQDN spelling) still work when typed but would only duplicate the list.
// Wildcard/negated patterns are skipped.
export function parseSshConfigHosts(content: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = line.match(/^Host\s+(.+)$/i);
    if (!match) continue;

    const firstConcrete = (match[1] as string).split(/\s+/).find((name) => name.length > 0 && !/[*?!]/.test(name));
    if (firstConcrete !== undefined && !seen.has(firstConcrete)) {
      seen.add(firstConcrete);
      hosts.push(firstConcrete);
    }
  }

  return hosts;
}
