import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = join(homedir(), ".tauri", "tako-updater.key");
const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(key)) {
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(key, "utf8").trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
}
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  console.warn("No updater key in ~/.tauri/tako-updater.key: the installer will build, the update signature will not.");
}

execFileSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build"], { cwd: root, stdio: "inherit", env });
execFileSync("node", [join(root, "scripts", "pack.mjs")], { cwd: root, stdio: "inherit", env });
