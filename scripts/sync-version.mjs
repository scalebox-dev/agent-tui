#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
  console.error(`Invalid version in package.json: ${version}`);
  process.exit(1);
}

const runtimePath = path.join(packageRoot, "src", "runtime", "index.ts");
const current = fs.readFileSync(runtimePath, "utf8");
const next = current.replace(/export const cliVersion = ".*";/, `export const cliVersion = "${version}";`);
if (current !== next) {
  fs.writeFileSync(runtimePath, next);
}
console.log(`Synced @agent-api/cli version ${version} -> src/runtime/index.ts`);
