import {
  createLocalContextPackage,
  type LocalContextManifest,
  type LocalSummary,
  type LocalWorkdir,
  type LocalWorkdirSnapshot,
} from "@agent-api/sdk/local";
import { resolve } from "node:path";
import { runtime } from "../runtime/index.js";

export interface WorkdirOptions {
  path?: string;
  name?: string;
}

export interface WorkdirContextOptions extends WorkdirOptions {
  query?: string;
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
  includeContent?: boolean;
}

export interface WorkdirService {
  root: string;
  name: string;
  workdir: LocalWorkdir;
  summarize(options?: Record<string, unknown>): Promise<LocalSummary>;
  snapshot(): Promise<LocalWorkdirSnapshot>;
  packageContext(options?: Omit<WorkdirContextOptions, "path" | "name">): Promise<LocalContextManifest>;
  contextBlock(options?: Omit<WorkdirContextOptions, "path" | "name">): Promise<string>;
}

export async function openWorkdir(options: WorkdirOptions = {}): Promise<WorkdirService> {
  await runtime.ensure();
  const root = resolve(options.path || process.cwd());
  const name = options.name || root.split(/[\\/]/).filter(Boolean).at(-1) || "workdir";
  const workdir = runtime.workdir(root, {
    name,
    trusted: true,
    gitignore: true,
  });

  return {
    root,
    name,
    workdir,
    summarize: (summaryOptions = {}) => workdir.summarize(summaryOptions),
    snapshot: () => workdir.snapshot({ hash: true }),
    packageContext: (contextOptions = {}) =>
      createLocalContextPackage(workdir, {
        query: contextOptions.query,
        includeSearch: Boolean(contextOptions.query),
        maxFiles: contextOptions.maxFiles,
        maxBytes: contextOptions.maxBytes,
        maxDepth: contextOptions.maxDepth ?? 3,
        includeContent: contextOptions.includeContent,
      }),
    contextBlock: async (contextOptions = {}) => {
      const context = await createLocalContextPackage(workdir, {
        query: contextOptions.query,
        includeSearch: Boolean(contextOptions.query),
        maxFiles: contextOptions.maxFiles,
        maxBytes: contextOptions.maxBytes,
        maxDepth: contextOptions.maxDepth ?? 3,
        includeContent: contextOptions.includeContent,
      });
      return [
        "Local workdir context follows. Use it as user-provided project context; do not assume files outside this manifest exist.",
        "```json",
        JSON.stringify(context, null, 2),
        "```",
      ].join("\n");
    },
  };
}

export async function buildWorkdirContextBlock(options: WorkdirContextOptions) {
  const service = await openWorkdir(options);
  return service.contextBlock(options);
}
