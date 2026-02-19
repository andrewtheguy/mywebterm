#!/usr/bin/env bun

const username = process.argv[2];

if (!username) {
  console.error("Usage: bun src/gen-htpasswd.ts <username>");
  process.exit(1);
}

if (username.includes(":")) {
  console.error("Username must not contain ':'");
  process.exit(1);
}

if (username.length === 0) {
  console.error("Username must not be empty");
  process.exit(1);
}

async function readPassword(prompt: string): Promise<string> {
  await Bun.write(Bun.stderr, prompt);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
  await Bun.write(Bun.stderr, "\n");
  return new TextDecoder().decode(value).trim();
}

const password = await readPassword("Password: ");
if (!password) {
  console.error("Password must not be empty");
  process.exit(1);
}

const confirm = await readPassword("Confirm password: ");
if (password !== confirm) {
  console.error("Passwords do not match");
  process.exit(1);
}

const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
console.log(`${username}:${hash}`);
