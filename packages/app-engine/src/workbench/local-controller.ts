import { createLocalShellToolRegistry, createLocalWorkdirToolRegistry } from "@agent-api/sdk/local";
import { openWorkdir, type WorkdirService } from "../workdir/index.js";
import type { WorkbenchState, WorkbenchWorkdirStatus } from "./state.js";
import { localShellIsolationOptions } from "./shell-isolation.js";
import type { ShellIsolationPreferences } from "./shell-isolation.js";

export interface WorkbenchLocalController {
  load(path?: string): Promise<WorkbenchWorkdirStatus>;
  isLoaded(): boolean;
  summaryText(): Promise<string>;
  searchText(query: string): Promise<{ text: string; count: number }>;
  approvalPreview(approval: LocalApprovalLike): string;
  applyApproval(approval: LocalApprovalLike): Promise<string | Record<string, unknown>>;
}

export interface WorkbenchLocalControllerOptions {
  openWorkdirImpl?: typeof openWorkdir;
  getShellIsolation?: () => ShellIsolationPreferences | undefined;
}

type LocalApprovalLike = NonNullable<WorkbenchState["pendingLocalTool"]>;

export function createWorkbenchLocalController(options: WorkbenchLocalControllerOptions = {}): WorkbenchLocalController {
  const openWorkdirImpl = options.openWorkdirImpl ?? openWorkdir;
  let workdir: WorkdirService | null = null;

  return {
    async load(path) {
      const next = await openWorkdirImpl({ path });
      const summary = await next.summarize();
      workdir = next;
      return {
        root: next.root,
        name: next.name,
        fileCount: summary.file_count,
        totalBytes: summary.total_bytes,
        scanTruncated: summary.scan_truncated,
      };
    },

    isLoaded() {
      return Boolean(workdir);
    },

    async summaryText() {
      const current = requireWorkdir();
      const summary = await current.summarize();
      const previews = summary.text_previews
        .slice(0, 5)
        .map((preview) => `- ${preview.path} (${formatBytes(preview.size)})`)
        .join("\n");
      return [
        `Workdir summary for ${current.name}`,
        `Files: ${summary.file_count}`,
        `Size: ${formatBytes(summary.total_bytes)}`,
        previews ? `Previews:\n${previews}` : "No text previews available.",
      ].join("\n");
    },

    async searchText(query) {
      const trimmed = query.trim();
      if (!trimmed) {
        return { text: "Usage: /search <query>", count: 0 };
      }
      const current = requireWorkdir();
      const results = await current.workdir.grep({ pattern: trimmed, limit: 12 });
      const matches = results.matches
        .map((match: { path: string; line_number: number; line: string }) => `${match.path}:${match.line_number}: ${match.line.trim()}`)
        .join("\n");
      return {
        text: matches || `No matches for "${trimmed}".`,
        count: results.matches.length,
      };
    },

    approvalPreview(approval) {
      return formatLocalToolApproval(approval);
    },

    async applyApproval(approval) {
      const current = requireWorkdir();
      const workdirRegistry = createLocalWorkdirToolRegistry(current.workdir, { accessMode: "full" });
      const shellRegistry = createLocalShellToolRegistry({
        workdir: current.workdir,
        accessMode: "full",
        ...localShellIsolationOptions(options.getShellIsolation?.()),
      } as Parameters<typeof createLocalShellToolRegistry>[0]);
      if (approval.name === workdirRegistry.toolName) {
        return await workdirRegistry.execute(approval.name, approval.arguments);
      }
      if (approval.name === shellRegistry.toolName) {
        return await shellRegistry.execute(approval.name, approval.arguments);
      }
      throw new Error(`no local handler registered for function ${approval.name}`);
    },
  };

  function requireWorkdir() {
    if (!workdir) throw new Error("Workdir is still loading.");
    return workdir;
  }
}

function formatLocalToolApproval(approval: {
  name: string;
  action?: string;
  arguments: Record<string, unknown>;
  preview?: unknown;
}) {
  return [
    `Local approval requested: ${approval.name}${approval.action ? `.${approval.action}` : ""}`,
    "Arguments:",
    JSON.stringify(approval.arguments, null, 2),
    approval.preview ? ["Preview:", JSON.stringify(approval.preview, null, 2)].join("\n") : "",
    "",
    "Use /apply to execute this action once, /apply-all to allow future local actions, or /reject to discard it.",
  ].filter(Boolean).join("\n");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
