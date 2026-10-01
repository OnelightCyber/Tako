import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run release <version>, for example npm run release 0.2.0");
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

const status = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim();
if (status) {
  console.error("Commit or stash your changes first — the release must match what is on GitHub.");
  process.exit(1);
}

const edit = (file, update) => {
  const path = join(root, file);
  writeFileSync(path, update(readFileSync(path, "utf8")));
};

edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("Cargo.toml", (s) => s.replace(/(\[workspace\.package\][^[]*?version = )"[^"]+"/, `$1"${version}"`));

run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
run("cargo", ["update", "-p", "tako", "-p", "tako-hook", "--offline"]);

run("git", ["add", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"]);
run("git", ["commit", "-m", `Release v${version}`]);
run("git", ["tag", `v${version}`]);
run("git", ["push", "origin", "HEAD", `v${version}`]);

console.log(`\n  v${version} pushed. GitHub Actions is building the installer and the update.\n`);
