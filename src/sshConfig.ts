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

// Read the config from disk and list its aliases. Called on every request
// rather than cached at startup, so edits to the file are picked up without a
// restart. Throws with a readable message when the file can no longer be read
// (deleted, replaced by a directory, permissions changed).
export async function loadSshConfigHosts(path: string): Promise<string[]> {
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch (err) {
    // The errno code alone ("ENOENT", "EACCES") reads better than the full
    // message, which repeats the path.
    const detail = (err as { code?: string } | null)?.code ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`cannot read ssh config ${path}: ${detail}`);
  }
  return parseSshConfigHosts(content);
}
