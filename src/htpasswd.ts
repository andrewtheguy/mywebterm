import { readFileSync } from "node:fs";

let store = new Map<string, string>();
let filePath = "";
let lastModified = 0;
let reloadPromise: Promise<void> | null = null;

function loadHtpasswd(path: string): Map<string, string> {
  const content = readFileSync(path, "utf-8");

  const entries = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const username = line.slice(0, idx);
    const hash = line.slice(idx + 1);

    if (!/^\$2[aby]\$/.test(hash)) {
      throw new Error(`Unsupported hash for user "${username}" (only bcrypt $2a$/$2b$/$2y$ supported)`);
    }

    entries.set(username, hash);
  }

  if (entries.size === 0) {
    throw new Error(`No valid entries found in htpasswd file: ${path}`);
  }

  return entries;
}

export function initHtpasswd(path: string): void {
  store = loadHtpasswd(path);
  filePath = path;
  lastModified = Bun.file(path).lastModified;
  console.log(`[htpasswd] loaded ${store.size} user(s) from ${path}`);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  if (!filePath) return false;

  // Hot-reload if file changed, deduplicating concurrent callers
  const currentMtime = Bun.file(filePath).lastModified;
  if (currentMtime !== lastModified) {
    if (!reloadPromise) {
      reloadPromise = (async () => {
        try {
          const newStore = loadHtpasswd(filePath);
          store = newStore;
          lastModified = currentMtime;
          console.log(`[htpasswd] reloaded ${store.size} user(s) from ${filePath}`);
        } catch (err) {
          console.error("[htpasswd] failed to reload:", err);
        } finally {
          reloadPromise = null;
        }
      })();
    }
    await reloadPromise;
  }

  const hash = store.get(username);
  if (!hash) return false;

  return Bun.password.verify(password, hash);
}

export function hasUsers(): boolean {
  return store.size > 0;
}
