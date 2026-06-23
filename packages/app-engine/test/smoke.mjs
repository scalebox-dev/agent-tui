import assert from "node:assert/strict";
import { createAgentEngine, createWorkbenchAuthController } from "../dist/index.js";

assert.equal(typeof createAgentEngine, "function");
assert.equal(typeof createWorkbenchAuthController, "function");
