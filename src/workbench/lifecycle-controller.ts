import type { WorkbenchAuthController } from "./auth-controller.js";
import type { WorkbenchAction, WorkbenchWorkdirStatus } from "../tui/workbench.js";
import { checkForUpdate, formatUpdateNotice, type UpdateCheckResult } from "../update.js";

export type WorkbenchLifecycleEffect =
  | { type: "dispatch"; action: WorkbenchAction }
  | { type: "close"; delayMs: number };

export interface WorkbenchLifecycleController {
  maybeCheckForUpdate(): Promise<WorkbenchLifecycleEffect[]>;
  refreshAuth(profile?: string): Promise<WorkbenchLifecycleEffect[]>;
  initialPrompt(input: { busy: boolean; promptParts: string[]; workdir: WorkbenchWorkdirStatus | null }): string | undefined;
}

export interface WorkbenchLifecycleControllerOptions {
  authController: WorkbenchAuthController;
  checkForUpdateImpl?: typeof checkForUpdate;
  formatUpdateNoticeImpl?: typeof formatUpdateNotice;
  formatError?: (error: unknown) => string;
  refreshWindowMs?: number;
  updateCheckEnabled?: boolean;
}

export function createWorkbenchLifecycleController(
  options: WorkbenchLifecycleControllerOptions,
): WorkbenchLifecycleController {
  const checkForUpdateImpl = options.checkForUpdateImpl ?? checkForUpdate;
  const formatUpdateNoticeImpl = options.formatUpdateNoticeImpl ?? formatUpdateNotice;
  const formatError = options.formatError ?? userFacingError;
  const refreshWindowMs = options.refreshWindowMs ?? 5 * 60_000;
  const updateCheckEnabled = options.updateCheckEnabled ?? process.env.AGENT_TUI_UPDATE_CHECK !== "0";
  let updateNoticeShown = false;
  let authRefreshWarningShown = false;
  let initialPromptSubmitted = false;

  return {
    async maybeCheckForUpdate() {
      if (updateNoticeShown || !updateCheckEnabled) return [];
      updateNoticeShown = true;
      try {
        const result = await checkForUpdateImpl();
        return updateNoticeEffects(result, formatUpdateNoticeImpl);
      } catch {
        return [];
      }
    },

    async refreshAuth(profile) {
      try {
        const result = await options.authController.refresh(profile, refreshWindowMs);
        if (!result.refreshed) return [];
        authRefreshWarningShown = false;
        return [
          { type: "dispatch", action: { type: "activity.add", level: "success", text: "Auth session refreshed" } },
        ];
      } catch (error) {
        if (authRefreshWarningShown) return [];
        authRefreshWarningShown = true;
        return [
          {
            type: "dispatch",
            action: {
              type: "message.add",
              role: "system",
              text: `${formatError(error)}\n\nClosing the workbench because authenticated agent conversations are unavailable.`,
            },
          },
          { type: "dispatch", action: { type: "activity.add", level: "error", text: "Auth session needs login; closing" } },
          { type: "close", delayMs: 1500 },
        ];
      }
    },

    initialPrompt(input) {
      if (initialPromptSubmitted || input.busy || !input.workdir) return undefined;
      const prompt = input.promptParts.join(" ").trim();
      if (!prompt) return undefined;
      initialPromptSubmitted = true;
      return prompt;
    },
  };
}

export function updateNoticeEffects(
  result: UpdateCheckResult | null | undefined,
  formatNotice: typeof formatUpdateNotice = formatUpdateNotice,
): WorkbenchLifecycleEffect[] {
  if (!result?.updateAvailable) return [];
  return [
    { type: "dispatch", action: { type: "activity.add", level: "warning", text: `Update available: ${result.latest}` } },
    { type: "dispatch", action: { type: "message.add", role: "system", text: formatNotice(result) } },
  ];
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
