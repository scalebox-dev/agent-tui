#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

await mkdir(join(root, "artifacts"), { recursive: true });

if (!existsSync(join(root, "node_modules"))) {
  await run(npm, ["install"]);
}

await run(npm, ["run", "build"]);
await run(npm, ["link"]);

console.log("");
console.log("agent-tui is linked for local development.");
console.log("");
console.log("Run:");
console.log("  agent-tui");
console.log("");
console.log("Other linked aliases:");
console.log("  agent-api");
console.log("  agentsway");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
