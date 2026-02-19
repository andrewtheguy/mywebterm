import { readFileSync } from "node:fs";

let credential: { username: string; hash: string } | null = null;
let filePath = "";
let lastModified = 0;
let reloadPromise: Promise<void> | null = null;

function loadHtpasswd(path: string): { username: string; hash: string } {
  const content = readFileSync(path, "utf-8");

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

    return { username, hash };
  }

  throw new Error(`No valid entries found in htpasswd file: ${path}`);
}

export function initHtpasswd(path: string): void {
  credential = loadHtpasswd(path);
  filePath = path;
  lastModified = Bun.file(path).lastModified;
  console.log(`[htpasswd] loaded user "${credential.username}" from ${path}`);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  if (!filePath) return false;

  // Hot-reload if file changed, deduplicating concurrent callers
  const currentMtime = Bun.file(filePath).lastModified;
  if (currentMtime !== lastModified) {
    if (!reloadPromise) {
      reloadPromise = (async () => {
        try {
          credential = loadHtpasswd(filePath);
          lastModified = currentMtime;
          console.log(`[htpasswd] reloaded user "${credential.username}" from ${filePath}`);
        } catch (err) {
          console.error("[htpasswd] failed to reload:", err);
        } finally {
          reloadPromise = null;
        }
      })();
    }
    await reloadPromise;
  }

  if (!credential || username !== credential.username) return false;

  return Bun.password.verify(password, credential.hash);
}