#!/usr/bin/env node

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const packageJSON = require(join(root, "package.json"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const artifactsDir = join(root, "artifacts");
const dryRun = process.argv.includes("--dry-run");
const otp = optionValue("--otp") || process.env.NPM_CONFIG_OTP;

await mkdir(artifactsDir, { recursive: true });

await run(npm, ["ci"]);
await run(npm, ["test"]);

const { stdout } = await run(npm, ["pack", "--pack-destination", artifactsDir], { capture: true });
const tarballName = stdout.trim().split(/\r?\n/).at(-1);
if (!tarballName) throw new Error("npm pack did not report a tarball name");
const tarball = resolve(artifactsDir, tarballName);

const prefix = await mkdtemp(join(tmpdir(), "agent-tui-release-"));
try {
  await run(npm, ["install", "--global", "--prefix", prefix, tarball]);
  for (const bin of Object.keys(packageJSON.bin ?? {})) {
    await run(installedBin(prefix, bin), ["--version"]);
  }
} finally {
  await rm(prefix, { recursive: true, force: true });
}

console.log("");
console.log(`Verified local release package: ${tarball}`);

if (dryRun) {
  console.log("");
  console.log("Dry run enabled. Publish with:");
  console.log(`  npm publish ${tarball} --access public`);
} else {
  await run(npm, ["publish", tarball, "--access", "public", ...otp ? [`--otp=${otp}`] : []]);
}

function installedBin(prefix, bin) {
  if (process.platform === "win32") return join(prefix, `${bin}.cmd`);
  return join(prefix, "bin", bin);
}

function optionValue(name) {
  const exactPrefix = `${name}=`;
  const exact = process.argv.find((arg) => arg.startsWith(exactPrefix));
  if (exact) return exact.slice(exactPrefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    if (options.capture) {
      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrBuffer += String(chunk);
        process.stderr.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout: stdoutBuffer, stderr: stderrBuffer });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
