import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const IS_MACOS = process.platform === "darwin";
const SWIFT_SRC = join(import.meta.dir, "tray", "tray.swift");
const TRAY_BIN = join(import.meta.dir, "tray", "tray_darwin_arm64");

let trayProcess: ReturnType<typeof spawn> | null = null;

async function ensureBinary(): Promise<void> {
  if (existsSync(TRAY_BIN)) return;

  console.log("[tray] Compiling tray helper…");
  const proc = Bun.spawn(["swiftc", "-framework", "Cocoa", "-O", "-o", TRAY_BIN, SWIFT_SRC], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`swiftc failed with exit code ${exitCode}`);
  }
  console.log("[tray] Tray helper compiled successfully");
}

export async function startTray(url: string): Promise<void> {
  if (!IS_MACOS) return;
  try {
    await ensureBinary();
  } catch (err) {
    console.error("[tray] Failed to compile tray helper:", err);
    return;
  }

  trayProcess = spawn(TRAY_BIN, ["--url", url], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  trayProcess.stdout?.setEncoding("utf-8");
  trayProcess.stdout?.on("data", (data: string) => {
    if (data.trim() === "quit") {
      console.log("[tray] Quit requested from tray icon");
      process.kill(process.pid, "SIGTERM");
    }
  });

  trayProcess.on("exit", (code) => {
    console.log(`[tray] Tray helper exited (code=${code})`);
    trayProcess = null;
  });

  trayProcess.on("error", (err) => {
    console.error("[tray] Tray helper error:", err);
    trayProcess = null;
  });
}

export function stopTray(): void {
  if (trayProcess) {
    trayProcess.kill();
    trayProcess = null;
  }
}
