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
const appEnginePackageJSON = require(join(root, "packages/app-engine/package.json"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const artifactsDir = join(root, "artifacts");
const dryRun = process.argv.includes("--dry-run");
const otp = optionValue("--otp") || process.env.NPM_CONFIG_OTP;

await mkdir(artifactsDir, { recursive: true });

await run(npm, ["ci"]);
await run(npm, ["test"]);

const appEngineTarball = await pack(["pack", "--workspace", "@agent-api/app-engine", "--pack-destination", artifactsDir]);
const cliTarball = await pack(["pack", "--pack-destination", artifactsDir]);

const prefix = await mkdtemp(join(tmpdir(), "agent-tui-release-"));
try {
  await run(npm, ["install", "--global", "--prefix", prefix, appEngineTarball, cliTarball]);
  for (const bin of Object.keys(packageJSON.bin ?? {})) {
    await run(installedBin(prefix, bin), ["--version"]);
  }
} finally {
  await rm(prefix, { recursive: true, force: true });
}

console.log("");
console.log("Verified local release packages:");
console.log(`  ${appEngineTarball}`);
console.log(`  ${cliTarball}`);

if (dryRun) {
  console.log("");
  console.log("Dry run enabled. Publish plan:");
  await printPublishPlan(appEnginePackageJSON, appEngineTarball);
  await printPublishPlan(packageJSON, cliTarball);
} else {
  await publishIfMissing(appEnginePackageJSON, appEngineTarball);
  await publishIfMissing(packageJSON, cliTarball);
}

async function pack(args) {
  const { stdout } = await run(npm, args, { capture: true });
  const tarballName = stdout.trim().split(/\r?\n/).at(-1);
  if (!tarballName) throw new Error(`${args.join(" ")} did not report a tarball name`);
  return resolve(artifactsDir, tarballName);
}

async function printPublishPlan(pkg, tarball) {
  const spec = packageSpec(pkg);
  if (await packageVersionExists(spec)) {
    console.log(`  skip ${spec} (already published)`);
    return;
  }
  console.log(`  npm publish ${tarball} --access public`);
}

async function publishIfMissing(pkg, tarball) {
  const spec = packageSpec(pkg);
  if (await packageVersionExists(spec)) {
    console.log(`Skipping ${spec}; version already exists on npm.`);
    return;
  }
  await run(npm, ["publish", tarball, "--access", "public", ...otp ? [`--otp=${otp}`] : []]);
}

async function packageVersionExists(spec) {
  const result = await run(npm, ["view", spec, "version"], { allowFailure: true, quiet: true });
  if (result.code === 0 && result.stdout.trim()) return true;
  const notFound = /E404|404 Not Found|No match found/i.test(result.stderr) || /E404|404 Not Found|No match found/i.test(result.stdout);
  if (notFound) return false;
  throw new Error(`npm view ${spec} version failed with exit code ${result.code}`);
}

function packageSpec(pkg) {
  return `${pkg.name}@${pkg.version}`;
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
    const captureOutput = options.capture || options.quiet;
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        if (!options.quiet) process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrBuffer += String(chunk);
        if (!options.quiet) process.stderr.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ code, stdout: stdoutBuffer, stderr: stderrBuffer });
        return;
      }
      if (options.allowFailure) {
        resolvePromise({ code: code ?? 1, stdout: stdoutBuffer, stderr: stderrBuffer });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
