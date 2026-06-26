import type { AgentRunOptions } from "../agent.js";
import type { WorkbenchCommand } from "./state.js";
import type { WorkbenchAuthController } from "./auth-controller.js";
import type { WorkbenchConversationController } from "./conversation-controller.js";
import type { WorkbenchEffect, WorkbenchEngine } from "./engine.js";
import type { WorkbenchLocalController } from "./local-controller.js";
import { UnknownPresetError } from "./settings-controller.js";
import type { WorkbenchSettingsController } from "./settings-controller.js";
import type { WorkbenchTurnController } from "./turn-controller.js";

export interface WorkbenchCommandController {
  run(command: WorkbenchCommand): Promise<void>;
  runEffects(effects: WorkbenchEffect[]): Promise<void>;
}

export interface WorkbenchCommandControllerOptions {
  authController: WorkbenchAuthController;
  conversationController: WorkbenchConversationController;
  engine: WorkbenchEngine;
  localController: WorkbenchLocalController;
  options: AgentRunOptions;
  profileName: string;
  settingsController: WorkbenchSettingsController;
  turnController: WorkbenchTurnController;
  onDeleteProfile(): Promise<void>;
  onExit(): void;
  onLogin(): void;
  onLogout(): void;
  onSwitchProfile(name?: string): void;
}

export function createWorkbenchCommandController(options: WorkbenchCommandControllerOptions): WorkbenchCommandController {
  const dispatch = options.engine.dispatch;

  return {
    async run(command) {
      const commandResult = options.engine.handleCommand(command);
      if (commandResult.handled) {
        await runEffects(commandResult.effects);
        return;
      }
      switch (command.kind) {
        case "abort":
          if (!options.engine.snapshot().busy) {
            dispatch({ type: "message.add", role: "system", text: "No agent turn is running." });
            return;
          }
          await options.turnController.abort("Abort requested.");
          return;
        case "config":
          await runConfigCommand(command);
          return;
        case "preset":
          await runPresetCommand(command.value);
          return;
        case "summary":
          await showSummary();
          return;
        case "search":
          await searchWorkdir(command.query);
          return;
        case "new_conversation":
          await startNewConversation(command.name);
          return;
        case "switch_conversation":
          await switchConversation(command.name);
          return;
        case "list_conversations":
          await showConversations();
          return;
        case "preview":
          showEditPreview();
          return;
        case "apply":
          await applyPendingEdit(false);
          return;
        case "apply_all":
          await applyPendingEdit(true);
          return;
        case "reject":
          rejectPendingEdit();
          return;
      }
    },

    runEffects,
  };

  async function runEffects(effects: WorkbenchEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case "exit":
          options.onExit();
          break;
        case "login":
          options.onLogin();
          break;
        case "logout":
          dispatch({ type: "activity.add", text: `Logged out: ${options.profileName}` });
          options.onLogout();
          break;
        case "delete_profile":
          dispatch({ type: "activity.add", level: "warning", text: `Deleting profile: ${options.profileName}` });
          await options.onDeleteProfile();
          break;
        case "switch_profile":
          options.onSwitchProfile(effect.name);
          break;
        case "show_auth_status":
          await showAuthStatus();
          break;
        case "export_transcript":
          await exportTranscript(effect);
          break;
        case "clear_preset_tool_catalog_cache":
          options.settingsController.clearPresetToolCatalogCache();
          break;
      }
    }
  }

  async function runConfigCommand(command: Extract<WorkbenchCommand, { kind: "config" }>) {
    const state = options.engine.snapshot();
    if (!command.field) {
      dispatch({
        type: "message.add",
        role: "system",
        text: options.settingsController.configText({
          profileName: options.profileName,
          runPreset: state.runPreset,
          runModel: state.runModel,
          accessMode: state.accessMode,
          contextEnabled: state.contextEnabled,
          defaultPreset: state.defaultPreset,
          automaticContinuationLimit: state.automaticContinuationLimit,
          renderMode: state.renderMode,
          shellIsolation: state.shellIsolation,
        }),
      });
      return;
    }

    if (command.field === "preset") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: options.settingsController.defaultPresetHelp(state.defaultPreset),
        });
        return;
      }
      try {
        const settings = await options.settingsController.saveDefaultPreset({
          value: command.value,
          profileName: options.profileName,
          options: options.options,
        });
        dispatch({ type: "settings.set", settings: { defaultPreset: settings.defaultPreset, runPreset: settings.runPreset } });
        dispatch({
          type: "message.add",
          role: "system",
          text: settings.message,
        });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        if (error instanceof UnknownPresetError) {
          dispatch({
            type: "message.add",
            role: "system",
            text: await presetListText(`Unknown preset: ${error.preset}`),
          });
          dispatch({ type: "activity.add", level: "warning", text: `Unknown preset: ${error.preset}` });
          return;
        }
        dispatch({ type: "message.add", role: "system", text: `Could not save default preset: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Default preset save failed" });
      }
    }

    if (command.field === "continuation-limit") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: options.settingsController.automaticContinuationLimitHelp(state.automaticContinuationLimit),
        });
        return;
      }
      try {
        const settings = await options.settingsController.saveAutomaticContinuationLimit(command.value);
        dispatch({ type: "settings.set", settings: { automaticContinuationLimit: settings.automaticContinuationLimit } });
        dispatch({ type: "message.add", role: "system", text: settings.message });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `Could not save automatic continuation limit: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Automatic continuation limit save failed" });
      }
      return;
    }

    if (command.field === "isolation") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: options.settingsController.shellIsolationHelp(state.shellIsolation),
        });
        return;
      }
      try {
        const settings = await options.settingsController.saveShellIsolationMode(command.value);
        dispatch({ type: "settings.set", settings: { shellIsolation: settings.shellIsolation } });
        dispatch({ type: "message.add", role: "system", text: settings.message });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `Could not save shell isolation mode: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Shell isolation save failed" });
      }
      return;
    }

    if (command.field === "isolator") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: options.settingsController.isolatorPathHelp(state.shellIsolation),
        });
        return;
      }
      try {
        const [subcommand = "", ...rest] = command.value.split(/\s+/);
        const value = rest.join(" ").trim();
        const settings = subcommand === "source"
          ? await options.settingsController.saveIsolatorSource(value)
          : subcommand === "path"
            ? await options.settingsController.saveIsolatorPath(value)
            : await options.settingsController.saveIsolatorPath(command.value);
        dispatch({ type: "settings.set", settings: { shellIsolation: settings.shellIsolation } });
        dispatch({ type: "message.add", role: "system", text: settings.message });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `Could not save isolator path: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Isolator path save failed" });
      }
    }
  }

  async function runPresetCommand(value?: string) {
    const state = options.engine.snapshot();
    if (!value) {
      dispatch({
        type: "message.add",
        role: "system",
        text: await presetListText(`Preset: ${state.runPreset || "none"}. Use /preset <name> or /preset none.`),
      });
      return;
    }
    const normalized = normalizeOptionalSetting(value, ["none", "off", "clear"]);
    if (normalized && !(await validatePresetName(normalized))) {
      return;
    }
    dispatch({ type: "settings.set", settings: { runPreset: normalized } });
    dispatch({ type: "message.add", role: "system", text: `Preset set to ${normalized || "none"}.` });
    dispatch({ type: "activity.add", text: `Preset: ${normalized || "none"}` });
  }

  async function validatePresetName(preset: string) {
    try {
      if (await options.settingsController.validatePreset(options.profileName, preset)) return true;
      dispatch({
        type: "message.add",
        role: "system",
        text: await presetListText(`Unknown preset: ${preset}`),
      });
      dispatch({ type: "activity.add", level: "warning", text: `Unknown preset: ${preset}` });
      return false;
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Could not validate preset "${preset}": ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Preset catalog unavailable" });
      return false;
    }
  }

  async function presetListText(prefix: string) {
    return options.settingsController.presetListText({
      profileName: options.profileName,
      currentPreset: options.engine.snapshot().runPreset,
      prefix,
    });
  }

  async function showAuthStatus() {
    dispatch({ type: "activity.add", text: "Checking auth status" });
    try {
      dispatch({ type: "message.add", role: "system", text: await options.authController.statusText(options.profileName) });
      dispatch({ type: "activity.add", level: "success", text: "Auth status ready" });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
      dispatch({ type: "activity.add", level: "error", text: "Auth status failed" });
    }
  }

  async function exportTranscript(effect: Extract<WorkbenchEffect, { type: "export_transcript" }>) {
    try {
      const file = await options.conversationController.exportTranscript(effect);
      dispatch({ type: "message.add", role: "system", text: `Transcript exported:\n${file}` });
      dispatch({ type: "activity.add", level: "success", text: "Transcript exported" });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Transcript export failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Transcript export failed" });
    }
  }

  async function showSummary() {
    if (!options.localController.isLoaded()) {
      dispatch({ type: "message.add", role: "system", text: unavailableWorkdirText() });
      return;
    }
    dispatch({ type: "activity.add", text: "Summarizing workdir" });
    try {
      dispatch({
        type: "message.add",
        role: "system",
        text: await options.localController.summaryText(),
      });
      dispatch({ type: "activity.add", level: "success", text: "Workdir summary ready" });
    } catch (error) {
      dispatch({
        type: "activity.add",
        level: "error",
        text: userFacingError(error),
      });
    }
  }

  async function startNewConversation(name?: string) {
    const conversation = await options.conversationController.startNewConversation(name, options.options.profile);
    dispatch({ type: "messages.clear" });
    dispatch({
      type: "conversation.set",
      id: conversation.id,
      name: conversation.name,
      previousResponseId: conversation.previousResponseId,
      status: conversation.status,
    });
    dispatch({
      type: "message.add",
      role: "system",
      text: conversation.message,
    });
  }

  async function switchConversation(name: string) {
    const conversation = await options.conversationController.switchConversation(name, options.options.profile);
    dispatch({ type: "messages.clear" });
    dispatch({
      type: "conversation.set",
      id: conversation.id,
      name: conversation.name,
      previousResponseId: conversation.previousResponseId,
      status: conversation.status,
    });
    dispatch({
      type: "message.add",
      role: "system",
      text: conversation.message,
    });
  }

  async function showConversations() {
    try {
      dispatch({
        type: "message.add",
        role: "system",
        text: await options.conversationController.listConversations(options.options.profile),
      });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
    }
  }

  async function searchWorkdir(query: string) {
    if (!query) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /search <query>" });
      return;
    }
    if (!options.localController.isLoaded()) {
      dispatch({ type: "message.add", role: "system", text: unavailableWorkdirText() });
      return;
    }
    dispatch({ type: "activity.add", text: `Searching workdir: ${query}` });
    try {
      const result = await options.localController.searchText(query);
      dispatch({
        type: "message.add",
        role: "system",
        text: result.text,
      });
      dispatch({
        type: "activity.add",
        level: "success",
        text: `Search complete: ${result.count} matches`,
      });
    } catch (error) {
      dispatch({
        type: "activity.add",
        level: "error",
        text: userFacingError(error),
      });
    }
  }

  function showEditPreview() {
    const state = options.engine.snapshot();
    if (state.pendingLocalTool) {
      dispatch({ type: "message.add", role: "system", text: options.localController.approvalPreview(state.pendingLocalTool) });
      return;
    }
    if (state.pendingAutomaticContinuation) {
      dispatch({ type: "message.add", role: "system", text: state.pendingAutomaticContinuation.message });
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending action." });
  }

  async function applyPendingEdit(allowFutureLocalActions: boolean) {
    const state = options.engine.snapshot();
    if (state.pendingAutomaticContinuation) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Continuing automatic workflow: ${state.pendingAutomaticContinuation.count}/${state.pendingAutomaticContinuation.limit}`,
      });
      const pending = state.pendingAutomaticContinuation;
      dispatch({ type: "automatic_continuation.pending.clear" });
      dispatch({
        type: "message.add",
        role: "system",
        text: allowFutureLocalActions
          ? "Continuing automatic workflow without more continuation checkpoints for this turn."
          : "Continuing automatic workflow.",
      });
      await options.turnController.continueAfterAutomaticContinuation({
        continuation: pending.continuation,
        bypassAutomaticContinuationLimit: allowFutureLocalActions,
      });
      return;
    }
    if (!options.localController.isLoaded()) {
      dispatch({ type: "message.add", role: "system", text: unavailableWorkdirText() });
      return;
    }
    if (state.pendingLocalTool) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Applying local action: ${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`,
      });
      try {
        const result = await options.localController.applyApproval(state.pendingLocalTool);
        const nextAccessMode = allowFutureLocalActions ? "full" : state.accessMode;
        if (allowFutureLocalActions) {
          dispatch({ type: "access.set", mode: "full" });
        }
        dispatch({
          type: "message.add",
          role: "system",
          text: [
            allowFutureLocalActions
              ? "Applied local action. Future local actions in this workbench conversation are now allowed."
              : "Applied local action once. Future local actions still require approval.",
            "Continuing agent turn with the local result.",
            "Result:",
            JSON.stringify(result, null, 2),
          ].join("\n"),
        });
        dispatch({ type: "activity.add", level: "success", text: "Local action applied" });
        const approval = state.pendingLocalTool;
        dispatch({ type: "local_tool.pending.clear" });
        await options.turnController.continueAfterLocalApproval({
          approval,
          result,
          accessMode: nextAccessMode,
        });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
        dispatch({ type: "activity.add", level: "error", text: userFacingError(error) });
      }
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending action." });
  }

  function rejectPendingEdit() {
    const state = options.engine.snapshot();
    if (state.pendingAutomaticContinuation) {
      dispatch({
        type: "activity.add",
        text: `Stopped automatic workflow: ${state.pendingAutomaticContinuation.responseID || state.pendingAutomaticContinuation.continuation.previousResponseID}`,
      });
      dispatch({ type: "automatic_continuation.pending.clear" });
      dispatch({ type: "message.add", role: "system", text: "Automatic workflow stopped at the checkpoint." });
      return;
    }
    if (state.pendingLocalTool) {
      dispatch({
        type: "activity.add",
        text: `Rejected local action: ${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`,
      });
      dispatch({ type: "local_tool.pending.clear" });
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending action." });
  }

  function unavailableWorkdirText() {
    const state = options.engine.snapshot();
    if (!state.contextEnabled || state.accessMode === "off") {
      return "Local workdir tools are off. Use /workdir on, /access approval, or /access full to load and expose the current workdir.";
    }
    return "Workdir is still loading.";
  }
}

export function normalizeOptionalSetting(value: string, clearValues: string[]) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clearValues.includes(trimmed.toLowerCase()) ? undefined : trimmed;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
