import assert from "node:assert/strict";
import * as appEngineRoot from "../dist/index.js";
import { createAgentEngine } from "../dist/core.js";
import { createMemoryStorage } from "../dist/storage/index.js";
import { createWorkbenchAuthController } from "../dist/workbench.js";

assert.deepEqual(Object.keys(appEngineRoot), []);
assert.equal(typeof createAgentEngine, "function");
assert.equal(typeof createWorkbenchAuthController, "function");
assert.equal(typeof createMemoryStorage, "function");
