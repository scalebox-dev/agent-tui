import {
  createLocalContextPackage,
  type LocalContextManifest,
  type LocalSummary,
  type LocalWorkspace,
  type LocalWorkspaceSnapshot,
} from "@agent-api/sdk/local";
import { resolve } from "node:path";
import { runtime } from "../runtime/index.js";

export interface WorkspaceOptions {
  path?: string;
  name?: string;
}

export interface WorkspaceContextOptions extends WorkspaceOptions {
  query?: string;
  maxFiles?: number;
  maxBytes?: number;
  includeContent?: boolean;
}

export interface WorkspaceService {
  root: string;
  name: string;
  workspace: LocalWorkspace;
  summarize(): Promise<LocalSummary>;
  snapshot(): Promise<LocalWorkspaceSnapshot>;
  packageContext(options?: Omit<WorkspaceContextOptions, "path" | "name">): Promise<LocalContextManifest>;
  contextBlock(options?: Omit<WorkspaceContextOptions, "path" | "name">): Promise<string>;
}

export async function openWorkspace(options: WorkspaceOptions = {}): Promise<WorkspaceService> {
  await runtime.ensure();
  const root = resolve(options.path || process.cwd());
  const name = options.name || root.split(/[\\/]/).filter(Boolean).at(-1) || "workspace";
  const workspace = runtime.workspace(root, {
    name,
    trusted: true,
    gitignore: true,
  });

  return {
    root,
    name,
    workspace,
    summarize: () => workspace.summarize(),
    snapshot: () => workspace.snapshot({ hash: true }),
    packageContext: (contextOptions = {}) =>
      createLocalContextPackage(workspace, {
        query: contextOptions.query,
        includeSearch: Boolean(contextOptions.query),
        maxFiles: contextOptions.maxFiles,
        maxBytes: contextOptions.maxBytes,
        includeContent: contextOptions.includeContent,
      }),
    contextBlock: async (contextOptions = {}) => {
      const context = await createLocalContextPackage(workspace, {
        query: contextOptions.query,
        includeSearch: Boolean(contextOptions.query),
        maxFiles: contextOptions.maxFiles,
        maxBytes: contextOptions.maxBytes,
        includeContent: contextOptions.includeContent,
      });
      return [
        "Local workspace context follows. Use it as user-provided project context; do not assume files outside this manifest exist.",
        "```json",
        JSON.stringify(context, null, 2),
        "```",
      ].join("\n");
    },
  };
}

export async function buildWorkspaceContextBlock(options: WorkspaceContextOptions) {
  const service = await openWorkspace(options);
  return service.contextBlock(options);
}
