import type { AgentRunOptions } from "../agent.js";
import type { ConversationRunSettings } from "../config.js";
import {
  selectedConversationPendingAutomaticContinuation,
  selectedConversationPendingLocalTool,
  selectedConversationRunningRun,
  type WorkbenchCommand,
} from "./state.js";
import { checkForUpdate, formatUpdateNotice, installUpdate, type UpdateCheckResult, type UpdateInstallResult } from "../update.js";
import type { WorkbenchAuthController } from "./auth-controller.js";
import type { WorkbenchConversationController } from "./conversation-controller.js";
import type { WorkbenchEffect, WorkbenchEngine } from "./engine.js";
import type { WorkbenchLocalController } from "./local-controller.js";
import { formatAutomaticContinuationLimit, normalizeAutomaticContinuationLimitPreference, UnknownPresetError } from "./settings-controller.js";
import type { WorkbenchSettingsController } from "./settings-controller.js";
import type { WorkbenchTranscriptStore } from "./transcript-store.js";
import type { WorkbenchTurnController } from "./turn-controller.js";
import type { WorkbenchWorkspaceController } from "./workspace-controller.js";
import type {
  LocalKnowledgePruneResult,
  LocalKnowledgeScope,
  LocalKnowledgeSearchResult,
  LocalKnowledgeService,
  LocalKnowledgeSourceType,
  LocalKnowledgeStats,
} from "@agent-api/sdk/local";

export interface WorkbenchCommandController {
  run(command: WorkbenchCommand): Promise<void>;
  runEffects(effects: WorkbenchEffect[]): Promise<void>;
}

export interface WorkbenchCommandControllerOptions {
  authController: WorkbenchAuthController;
  conversationController: WorkbenchConversationController;
  engine: WorkbenchEngine;
  localController: WorkbenchLocalController;
  localKnowledge?: LocalKnowledgeService;
  options: AgentRunOptions;
  profileName: string;
  settingsController: WorkbenchSettingsController;
  transcriptStore?: WorkbenchTranscriptStore;
  turnController: WorkbenchTurnController;
  workspaceController: WorkbenchWorkspaceController;
  checkForUpdateImpl?: typeof checkForUpdate;
  formatUpdateNoticeImpl?: typeof formatUpdateNotice;
  installUpdateImpl?: typeof installUpdate;
  onDeleteProfile(): Promise<void>;
  onExit(): void;
  onLogin(): void;
  onLogout(): void;
  onSwitchProfile(name?: string): void;
}

export function createWorkbenchCommandController(options: WorkbenchCommandControllerOptions): WorkbenchCommandController {
  const dispatch = options.engine.dispatch;
  const checkForUpdateImpl = options.checkForUpdateImpl ?? checkForUpdate;
  const formatUpdateNoticeImpl = options.formatUpdateNoticeImpl ?? formatUpdateNotice;
  const installUpdateImpl = options.installUpdateImpl ?? installUpdate;

  return {
    async run(command) {
      const commandResult = options.engine.handleCommand(command);
      if (commandResult.handled) {
        await runEffects(commandResult.effects);
        if (handledCommandUpdatesRunSettings(command)) await persistCurrentRunSettings();
        return;
      }
      switch (command.kind) {
        case "abort":
          const activeRun = selectedConversationRunningRun(options.engine.snapshot());
          if (!activeRun) {
            dispatch({ type: "message.add", role: "system", text: "No agent turn is running for the selected conversation." });
            return;
          }
          await options.turnController.abort("Abort requested.", activeRun.id);
          return;
        case "config":
          await runConfigCommand(command);
          return;
        case "preset":
          await runPresetCommand(command.value);
          return;
        case "continuation_limit":
          await runContinuationLimitCommand(command.value);
          return;
        case "knowledge":
          await runKnowledgeCommand(command);
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
        case "rename_conversation":
          await renameConversation(command.name);
          return;
        case "delete_conversation":
          await deleteConversation(command.name);
          return;
        case "list_conversations":
          await showConversations(command.query);
          return;
        case "list_workspaces":
          await showWorkspaces(command.query);
          return;
        case "switch_workspace":
          await switchWorkspace(command.id);
          return;
        case "update":
          await checkForCliUpdate();
          return;
        case "preview":
          showEditPreview();
          return;
        case "resume":
          resumeTimedPause(command.message);
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
          currentAutomaticContinuationLimit: state.automaticContinuationLimit,
          automaticContinuationLimit: state.defaultAutomaticContinuationLimit,
          localKnowledgeEnabled: state.localKnowledgeEnabled,
          localSkillsEnabled: state.localSkillsEnabled,
          memoryRead: state.memoryRead,
          memoryTenantSearch: state.memoryTenantSearch,
          memoryWrite: state.memoryWrite,
          renderMode: state.renderMode,
          shellIsolation: state.shellIsolation,
          workspaceSkillsEnabled: state.workspaceSkillsEnabled,
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
        dispatch({ type: "settings.set", settings: { defaultPreset: settings.defaultPreset } });
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
          text: options.settingsController.automaticContinuationLimitHelp(state.defaultAutomaticContinuationLimit),
        });
        return;
      }
      try {
        const settings = await options.settingsController.saveAutomaticContinuationLimit(command.value);
        dispatch({ type: "settings.set", settings: { defaultAutomaticContinuationLimit: settings.automaticContinuationLimit } });
        dispatch({ type: "message.add", role: "system", text: settings.message });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `Could not save automatic continuation limit: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Automatic continuation limit save failed" });
      }
      return;
    }

    if (command.field === "knowledge") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: options.settingsController.localKnowledgeHelp(state.localKnowledgeEnabled),
        });
        return;
      }
      try {
        const settings = await options.settingsController.saveLocalKnowledgeEnabled(command.value);
        dispatch({ type: "settings.set", settings: { localKnowledgeEnabled: settings.localKnowledgeEnabled ?? true } });
        dispatch({ type: "message.add", role: "system", text: settings.message });
        dispatch({ type: "activity.add", level: "success", text: settings.activity });
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `Could not save local knowledge default: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "Local knowledge default save failed" });
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
    await persistCurrentRunSettings();
  }

  async function runContinuationLimitCommand(value?: string) {
    const state = options.engine.snapshot();
    if (!value) {
      dispatch({
        type: "message.add",
        role: "system",
        text: `Continuation limit: ${formatAutomaticContinuationLimit(state.automaticContinuationLimit)}. Use /continuation-limit <n>, /continuation-limit unlimited, or /continuation-limit reset.`,
      });
      return;
    }
    try {
      const normalized = normalizeAutomaticContinuationLimitPreference(value);
      dispatch({ type: "settings.set", settings: { automaticContinuationLimit: normalized } });
      dispatch({
        type: "message.add",
        role: "system",
        text: `Conversation continuation limit set to ${formatAutomaticContinuationLimit(normalized)}.`,
      });
      dispatch({ type: "activity.add", level: "success", text: `Continuation limit: ${formatAutomaticContinuationLimit(normalized)}` });
      await persistCurrentRunSettings();
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Could not set continuation limit: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Continuation limit update failed" });
    }
  }

  async function runKnowledgeCommand(command: Extract<WorkbenchCommand, { kind: "knowledge" }>) {
    const state = options.engine.snapshot();
    if (command.enabled !== undefined) {
      dispatch({ type: "settings.set", settings: { localKnowledgeEnabled: command.enabled } });
      dispatch({ type: "message.add", role: "system", text: `Local knowledge set to ${command.enabled ? "on" : "off"} for this conversation.` });
      dispatch({ type: "activity.add", level: command.enabled ? "success" : "warning", text: `Local knowledge: ${command.enabled ? "on" : "off"}` });
      await persistCurrentRunSettings();
      return;
    }

    if (command.action === "search") {
      await searchLocalKnowledge(command.query ?? "");
      return;
    }
    if (command.action === "prune") {
      await pruneLocalKnowledge(Boolean(command.dryRun));
      return;
    }
    if (command.action === "status" || command.action === undefined) {
      dispatch({
        type: "message.add",
        role: "system",
        text: await localKnowledgeStatusText(state),
      });
      return;
    }
  }

  async function localKnowledgeStatusText(state: ReturnType<WorkbenchEngine["snapshot"]>) {
    const service = options.localKnowledge;
    const lines = [
      `Local knowledge: ${state.localKnowledgeEnabled ? "on" : "off"}`,
      `Store: ${service ? "available" : "unavailable"}`,
      `Scope: ${formatLocalKnowledgeScope(localKnowledgeScopeFromState(state))}`,
    ];
    if (!service) {
      lines.push("The local knowledge store is not wired for this session.");
      return lines.join("\n");
    }
    if (!service.stats) {
      lines.push("Stats: unavailable for this local knowledge provider.");
      lines.push("Use /knowledge search <query> to query the provider.");
      return lines.join("\n");
    }
    try {
      lines.push(...formatLocalKnowledgeStats(await service.stats(localKnowledgeScopeFromState(state))));
    } catch (error) {
      lines.push(`Stats unavailable: ${userFacingError(error)}`);
    }
    lines.push("Use /knowledge search <query>, /knowledge prune dry-run, or /knowledge prune.");
    return lines.join("\n");
  }

  async function searchLocalKnowledge(query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /knowledge search <query>" });
      dispatch({ type: "activity.add", level: "warning", text: "Local knowledge search missing query" });
      return;
    }
    const service = options.localKnowledge;
    if (!service) {
      dispatch({ type: "message.add", role: "system", text: "Local knowledge store is not available for this session." });
      dispatch({ type: "activity.add", level: "warning", text: "Local knowledge unavailable" });
      return;
    }
    try {
      const result = await service.search({
        query: trimmed,
        limit: 8,
        scope: localKnowledgeScopeFromState(options.engine.snapshot()),
      });
      dispatch({ type: "message.add", role: "system", text: formatLocalKnowledgeSearchResult(trimmed, result) });
      dispatch({ type: "activity.add", level: "success", text: `Local knowledge search: ${result.data.length} hit${result.data.length === 1 ? "" : "s"}` });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Local knowledge search failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Local knowledge search failed" });
    }
  }

  async function pruneLocalKnowledge(dryRun: boolean) {
    const service = options.localKnowledge;
    if (!service?.prune) {
      dispatch({ type: "message.add", role: "system", text: "Local knowledge prune is not available for this session." });
      dispatch({ type: "activity.add", level: "warning", text: "Local knowledge prune unavailable" });
      return;
    }
    try {
      const result = await service.prune({
        dryRun,
        scope: localKnowledgeScopeFromState(options.engine.snapshot()),
      });
      dispatch({ type: "message.add", role: "system", text: formatLocalKnowledgePruneResult(result) });
      dispatch({ type: "activity.add", level: "success", text: dryRun ? "Local knowledge prune preview ready" : "Local knowledge pruned" });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Local knowledge prune failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Local knowledge prune failed" });
    }
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
      const state = options.engine.snapshot();
      const transcript = options.transcriptStore && state.conversationId
        ? await options.transcriptStore.exportConversation(state.conversationId)
        : effect.transcript;
      const file = await options.conversationController.exportTranscript({ ...effect, transcript });
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
    const state = options.engine.snapshot();
    const conversation = await options.conversationController.startNewConversation(
      name,
      options.options.profile,
      state.currentWorkspaceId,
      state.currentWorkspaceName,
    );
    await options.transcriptStore?.clearConversation(conversation.id);
    dispatch({ type: "messages.clear" });
    dispatch({
      type: "conversation.set",
      id: conversation.id,
      name: conversation.name,
      previousResponseId: conversation.previousResponseId,
      runSettings: conversation.runSettings,
      status: conversation.status,
    });
    await persistCurrentRunSettings();
    dispatch({
      type: "message.add",
      role: "system",
      text: conversation.message,
    });
  }

  async function switchConversation(name: string) {
    const state = options.engine.snapshot();
    const conversation = await options.conversationController.switchConversation(
      name,
      options.options.profile,
      state.currentWorkspaceId,
      state.currentWorkspaceName,
    );
    const restored = await options.transcriptStore?.loadRecentMessages(conversation.id, 80) ?? [];
    dispatch(restored.length > 0 ? { type: "messages.restore", messages: restored } : { type: "messages.clear" });
    dispatch({
      type: "conversation.set",
      id: conversation.id,
      name: conversation.name,
      previousResponseId: conversation.previousResponseId,
      runSettings: conversation.runSettings,
      status: conversation.status,
    });
    dispatch({
      type: "message.add",
      role: "system",
      text: restored.length > 0
        ? `${conversation.message}\nLoaded ${restored.length} local transcript message${restored.length === 1 ? "" : "s"}.`
        : conversation.message,
      });
  }

  async function renameConversation(name?: string) {
    const nextName = name?.trim();
    if (!nextName) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /rename <new-conversation-name>" });
      dispatch({ type: "activity.add", level: "warning", text: "Conversation rename missing name" });
      return;
    }
    try {
      const state = options.engine.snapshot();
      const conversation = await options.conversationController.renameConversation(
        state.currentConversation,
        nextName,
        options.options.profile,
        state.currentWorkspaceId,
      );
      dispatch({
        type: "conversation.set",
        id: conversation.id,
        name: conversation.name,
        previousResponseId: conversation.previousResponseId,
        runSettings: conversation.runSettings,
        status: conversation.status,
      });
      dispatch({ type: "message.add", role: "system", text: conversation.message });
      dispatch({ type: "activity.add", level: "success", text: `Conversation renamed: ${conversation.name}` });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Conversation rename failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Conversation rename failed" });
    }
  }

  async function deleteConversation(name?: string) {
    const trimmed = name?.trim();
    if (!trimmed) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /delete <conversation-name>" });
      dispatch({ type: "activity.add", level: "warning", text: "Conversation delete missing name" });
      return;
    }
    try {
      const state = options.engine.snapshot();
      const summary = state.conversationSummaries.find((conversation) => conversation.name === trimmed);
      const deleted = await options.conversationController.deleteConversation(trimmed, options.options.profile, state.currentWorkspaceId);
      if (summary?.id) await options.transcriptStore?.clearConversation(summary.id);
      const deletingActive = state.currentConversation === trimmed;
      if (deletingActive) {
        const next = await options.conversationController.startNewConversation(
          "default",
          options.options.profile,
          state.currentWorkspaceId,
          state.currentWorkspaceName,
        );
        await options.transcriptStore?.clearConversation(next.id);
        dispatch({ type: "messages.clear" });
        dispatch({
          type: "conversation.set",
          id: next.id,
          name: next.name,
          previousResponseId: next.previousResponseId,
          runSettings: next.runSettings,
          status: next.status,
        });
        dispatch({
          type: "message.add",
          role: "system",
          text: `${deleted.message}\nStarted fresh conversation "${next.name}" (${next.id}).`,
        });
      } else {
        dispatch({ type: "message.add", role: "system", text: deleted.message });
      }
      dispatch({ type: "activity.add", level: "success", text: `Conversation deleted: ${trimmed}` });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Conversation delete failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Conversation delete failed" });
    }
  }

  async function showConversations(query?: string) {
    try {
      dispatch({
        type: "message.add",
        role: "system",
        text: await options.conversationController.listConversations(
          options.options.profile,
          query,
          options.engine.snapshot().currentWorkspaceId,
        ),
      });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
    }
  }

  async function showWorkspaces(query?: string) {
    const state = options.engine.snapshot();
    const needle = query?.trim().toLowerCase();
    const rows = state.workspaceSummaries
      .filter((workspace) => !needle || [workspace.id, workspace.name, workspace.role].some((value) => value.toLowerCase().includes(needle)))
      .map((workspace) => {
        const current = workspace.id === state.currentWorkspaceId ? "*" : " ";
        return `${current} ${workspace.id}\t${workspace.name}\t${workspace.role}\t${workspace.membershipStatus || workspace.status}`;
      });
    const current = state.currentWorkspaceId
      ? `Current workspace: ${state.currentWorkspaceName || state.currentWorkspaceId} (${state.currentWorkspaceId})`
      : "Current workspace: unresolved";
    const switching = state.workspaceSwitchable
      ? "Use /workspace <workspace_id> to switch."
      : "API key profiles are fixed to one workspace; switch profile/key to change workspace.";
    dispatch({
      type: "message.add",
      role: "system",
      text: [current, switching, rows.length ? rows.join("\n") : "No workspaces loaded."].join("\n"),
    });
  }

  async function switchWorkspace(workspaceId?: string) {
    const id = workspaceId?.trim();
    if (!id) {
      await showWorkspaces();
      return;
    }
    const state = options.engine.snapshot();
    try {
      dispatch({ type: "activity.add", text: `Switching workspace: ${id}` });
      const snapshot = await options.workspaceController.switchWorkspace(
        options.options.profile,
        id,
        state.workspaceAuthType ?? "api_key",
      );
      dispatch({
        type: "workspace.set",
        workspace: {
          authType: snapshot.authType,
          id: snapshot.current.id,
          name: snapshot.current.name,
          role: snapshot.current.role,
          switchable: snapshot.switchable,
        },
      });
      dispatch({ type: "workspaces.set", workspaces: snapshot.workspaces });
      const conversation = await options.conversationController.resolveConversation(
        state.currentConversation,
        options.options.profile,
        snapshot.current.id,
        snapshot.current.name,
      );
      const restored = await options.transcriptStore?.loadRecentMessages(conversation.id, 80) ?? [];
      dispatch(restored.length > 0 ? { type: "messages.restore", messages: restored } : { type: "messages.clear" });
      dispatch({
        type: "conversation.set",
        id: conversation.id,
        name: conversation.name,
        previousResponseId: conversation.previousResponseId,
        runSettings: conversation.runSettings,
        status: conversation.status,
      });
      dispatch({
        type: "message.add",
        role: "system",
        text: `Switched workspace to "${snapshot.current.name}" (${snapshot.current.id}).\n${conversation.message}`,
      });
      dispatch({ type: "activity.add", level: "success", text: `Workspace switched: ${snapshot.current.name}` });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Workspace switch failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Workspace switch failed" });
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

  async function persistCurrentRunSettings() {
    const state = options.engine.snapshot();
    if (!state.conversationId) return;
    await options.conversationController.updateRunSettings(
      state.currentConversation,
      conversationRunSettingsFromState(state),
      options.options.profile,
      state.currentWorkspaceId,
    );
  }

  function handledCommandUpdatesRunSettings(command: WorkbenchCommand) {
    if (command.kind === "access") return Boolean(command.mode);
    if (command.kind === "context") return true;
    if (command.kind === "knowledge") return command.enabled !== undefined;
    if (command.kind === "memory") return Boolean(command.field) || command.enabled === false;
    if (command.kind === "model") return Boolean(command.value);
    if (command.kind === "skills") return Boolean(command.field) || command.enabled !== undefined;
    if (command.kind === "workdir") return command.enabled !== undefined;
    return false;
  }

  function conversationRunSettingsFromState(state: ReturnType<WorkbenchEngine["snapshot"]>): ConversationRunSettings {
    return {
      accessMode: state.accessMode,
      automaticContinuationLimit: state.automaticContinuationLimit ?? null,
      contextEnabled: state.contextEnabled,
      localKnowledgeEnabled: state.localKnowledgeEnabled,
      localSkillsEnabled: state.localSkillsEnabled,
      memoryRead: state.memoryRead,
      memoryTenantSearch: state.memoryTenantSearch,
      memoryWrite: state.memoryWrite,
      model: state.runModel || null,
      preset: state.runPreset || null,
      workspaceSkillsEnabled: state.workspaceSkillsEnabled,
    };
  }

  function showEditPreview() {
    const state = options.engine.snapshot();
    const pendingLocalTool = selectedConversationPendingLocalTool(state);
    if (pendingLocalTool) {
      dispatch({ type: "message.add", role: "system", text: options.localController.approvalPreview(pendingLocalTool) });
      return;
    }
    const pendingContinuation = selectedConversationPendingAutomaticContinuation(state);
    if (pendingContinuation) {
      dispatch({ type: "message.add", role: "system", text: pendingContinuation.message });
      return;
    }
    if (state.pendingUpdate) {
      dispatch({ type: "message.add", role: "system", text: updatePreviewText(state.pendingUpdate.result) });
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending action." });
  }

  function resumeTimedPause(message?: string) {
    const state = options.engine.snapshot();
    const activeRun = selectedConversationRunningRun(state);
    if (options.turnController.resumeTimedPause(message, activeRun?.id)) {
      if (activeRun) dispatch({ type: "run.status.set", runId: activeRun.id, status: "running", statusText: message || "timed pause resumed" });
      dispatch({
        type: "message.add",
        role: "system",
        text: message
          ? `Resuming timed local pause: ${message}`
          : "Resuming timed local pause.",
      });
      dispatch({ type: "activity.add", level: "success", text: "Timed local pause resumed" });
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: [
        "No timed local pause is active.",
        selectedConversationPendingAutomaticContinuation(state)
          ? "Automatic continuation checkpoints still use /apply or /apply-all."
          : "",
        message ? `Resume note recorded locally: ${message}` : "",
      ].filter(Boolean).join("\n"),
    });
    dispatch({ type: "activity.add", level: "warning", text: "No timed local pause to resume" });
  }

  async function checkForCliUpdate() {
    dispatch({ type: "activity.add", text: "Checking for CLI update" });
    try {
      const result = await checkForUpdateImpl();
      if (!result) {
        dispatch({ type: "message.add", role: "system", text: "Could not check for a CLI update right now." });
        dispatch({ type: "activity.add", level: "warning", text: "Update check unavailable" });
        return;
      }
      if (!result.updateAvailable) {
        dispatch({ type: "message.add", role: "system", text: `CLI is already up to date: ${result.packageName} ${result.current}.` });
        dispatch({ type: "activity.add", level: "success", text: "CLI already up to date" });
        return;
      }
      dispatch({ type: "update.pending.set", result });
      dispatch({ type: "message.add", role: "system", text: updatePreviewText(result) });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Update check failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Update check failed" });
    }
  }

  async function applyPendingEdit(allowFutureLocalActions: boolean) {
    const state = options.engine.snapshot();
    if (state.pendingUpdate) {
      const pending = state.pendingUpdate;
      dispatch({ type: "activity.add", level: "warning", text: `Installing CLI update: ${pending.result.latest}` });
      dispatch({ type: "message.add", role: "system", text: "Installing CLI update. The workbench will close after the update succeeds." });
      try {
        const result = await installUpdateImpl(pending.result);
        dispatch({ type: "update.pending.clear" });
        dispatch({
          type: "message.add",
          role: "system",
          text: updateInstallSuccessText(pending.result, result),
        });
        dispatch({ type: "activity.add", level: "success", text: `CLI updated to ${pending.result.latest}; closing` });
        setTimeout(options.onExit, 500);
      } catch (error) {
        dispatch({ type: "message.add", role: "system", text: `CLI update failed: ${userFacingError(error)}` });
        dispatch({ type: "activity.add", level: "error", text: "CLI update failed" });
      }
      return;
    }
    const pendingContinuation = selectedConversationPendingAutomaticContinuation(state);
    if (pendingContinuation) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Continuing automatic workflow: ${pendingContinuation.count}/${pendingContinuation.limit}`,
      });
      const pending = pendingContinuation;
      if (pending.runId) {
        dispatch({ type: "run.status.set", runId: pending.runId, status: "completed", statusText: "automatic continuation resumed" });
      }
      dispatch({ type: "automatic_continuation.pending.clear", runId: pending.runId });
      if (allowFutureLocalActions) {
        dispatch({ type: "automatic_continuation.unlock", unlocked: true });
      }
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
        sourceRunId: pending.runId,
      });
      return;
    }
    if (!options.localController.isLoaded()) {
      dispatch({ type: "message.add", role: "system", text: unavailableWorkdirText() });
      return;
    }
    const pendingLocalTool = selectedConversationPendingLocalTool(state);
    if (pendingLocalTool) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Applying local action: ${pendingLocalTool.name}${pendingLocalTool.action ? `.${pendingLocalTool.action}` : ""}`,
      });
      try {
        const result = await options.localController.applyApproval(pendingLocalTool);
        if (pendingLocalTool.runId) {
          dispatch({ type: "run.status.set", runId: pendingLocalTool.runId, status: "completed", statusText: "local action applied" });
        }
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
            formatLocalActionResultForDisplay(result),
          ].join("\n"),
        });
        dispatch({ type: "activity.add", level: "success", text: "Local action applied" });
        const approval = pendingLocalTool;
        dispatch({ type: "local_tool.pending.clear", runId: approval.runId });
        await options.turnController.continueAfterLocalApproval({
          approval,
          result,
          accessMode: nextAccessMode,
          sourceRunId: approval.runId,
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
    const pendingContinuation = selectedConversationPendingAutomaticContinuation(state);
    if (pendingContinuation) {
      dispatch({
        type: "activity.add",
        text: `Stopped automatic workflow: ${pendingContinuation.responseID || pendingContinuation.continuation.previousResponseID}`,
      });
      if (pendingContinuation.runId) {
        dispatch({ type: "run.status.set", runId: pendingContinuation.runId, status: "aborted", statusText: "automatic continuation rejected" });
      }
      dispatch({ type: "automatic_continuation.pending.clear", runId: pendingContinuation.runId });
      dispatch({ type: "message.add", role: "system", text: "Automatic workflow stopped at the checkpoint." });
      return;
    }
    const pendingLocalTool = selectedConversationPendingLocalTool(state);
    if (pendingLocalTool) {
      dispatch({
        type: "activity.add",
        text: `Rejected local action: ${pendingLocalTool.name}${pendingLocalTool.action ? `.${pendingLocalTool.action}` : ""}`,
      });
      if (pendingLocalTool.runId) {
        dispatch({ type: "run.status.set", runId: pendingLocalTool.runId, status: "aborted", statusText: "local action rejected" });
      }
      dispatch({ type: "local_tool.pending.clear", runId: pendingLocalTool.runId });
      return;
    }
    if (state.pendingUpdate) {
      dispatch({
        type: "activity.add",
        text: `Canceled CLI update: ${state.pendingUpdate.result.latest}`,
      });
      dispatch({ type: "update.pending.clear" });
      dispatch({ type: "message.add", role: "system", text: "CLI update canceled." });
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

const maxDisplayedLocalResultChars = 2400;

function formatLocalActionResultForDisplay(result: string | Record<string, unknown>) {
  const rendered = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (rendered.length <= maxDisplayedLocalResultChars) {
    return ["Result:", rendered].join("\n");
  }
  const summary = summarizeLocalActionResult(result);
  const omitted = rendered.length - maxDisplayedLocalResultChars;
  return [
    "Result:",
    summary ? `${summary}\n` : "",
    rendered.slice(0, maxDisplayedLocalResultChars).trimEnd(),
    `[display truncated: omitted ${omitted} chars]`,
  ].filter(Boolean).join("\n");
}

function summarizeLocalActionResult(result: string | Record<string, unknown>) {
  if (typeof result === "string") return "";
  const lines: string[] = [];
  const action = stringField(result, "action");
  const object = stringField(result, "object");
  if (action || object) lines.push(`Summary: ${[action, object].filter(Boolean).join(" ")}`);
  const path = stringField(result, "path") || stringField(result, "file");
  if (path) lines.push(`Path: ${path}`);
  const files = firstListField(result, ["changed_files", "files", "paths"]);
  if (files.length > 0) {
    const shown = files.slice(0, 8).join(", ");
    lines.push(`Files: ${shown}${files.length > 8 ? `, ... (${files.length} total)` : ""}`);
  }
  for (const key of ["applied", "edits", "changes", "matches", "results"]) {
    const value = result[key];
    if (Array.isArray(value)) lines.push(`${key}: ${value.length}`);
  }
  for (const key of ["changed", "edit_count", "ok", "scan_truncated"]) {
    const value = result[key];
    if (value != null && !Array.isArray(value) && typeof value !== "object") lines.push(`${key}: ${String(value)}`);
  }
  return lines.join("\n");
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : "";
}

function firstListField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const field = value[key];
    const values = Array.isArray(field) ? field.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean) : [];
    if (values.length > 0) return values;
  }
  return [];
}

function updatePreviewText(result: UpdateCheckResult) {
  return [
    formatUpdateNotice(result),
    "",
    "Use /apply to install the update and close the workbench, or /reject to cancel.",
  ].join("\n");
}

function updateInstallSuccessText(update: UpdateCheckResult, result: UpdateInstallResult) {
  return [
    `Updated ${update.packageName}: ${update.current} -> ${update.latest}.`,
    result.command ? `Command: ${result.command}` : "",
    "Restart the workbench to use the new version.",
  ].filter(Boolean).join("\n");
}

export function normalizeOptionalSetting(value: string, clearValues: string[]) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clearValues.includes(trimmed.toLowerCase()) ? undefined : trimmed;
}

function localKnowledgeScopeFromState(state: ReturnType<WorkbenchEngine["snapshot"]>): LocalKnowledgeScope {
  return {
    conversationId: state.conversationId,
    workspaceId: state.currentWorkspaceId,
    profile: state.profile,
    workdir: state.workdir?.root,
  };
}

function formatLocalKnowledgeScope(scope: LocalKnowledgeScope) {
  return [
    scope.conversationId ? `conversation=${scope.conversationId}` : "conversation=unknown",
    scope.workspaceId ? `workspace=${scope.workspaceId}` : "workspace=unknown",
    scope.profile ? `profile=${scope.profile}` : "profile=default",
    scope.workdir ? `workdir=${scope.workdir}` : "workdir=unloaded",
  ].join(" ");
}

function formatLocalKnowledgeStats(stats: LocalKnowledgeStats) {
  const lines = [
    `Sources: ${stats.sources}`,
    `Chunks: ${stats.chunks}`,
    `Bytes: ${formatBytes(stats.bytes)}`,
    `Deleted sources: ${stats.deletedSources}`,
  ];
  const sourceLines = (Object.entries(stats.bySourceType ?? {}) as Array<[LocalKnowledgeSourceType, { sources: number; chunks: number; bytes: number } | undefined]>)
    .filter((entry): entry is [LocalKnowledgeSourceType, { sources: number; chunks: number; bytes: number }] => Boolean(entry[1]))
    .map(([type, value]) => `- ${type}: ${value.sources} source${value.sources === 1 ? "" : "s"}, ${value.chunks} chunk${value.chunks === 1 ? "" : "s"}, ${formatBytes(value.bytes)}`);
  if (sourceLines.length > 0) lines.push("By source type:", ...sourceLines);
  return lines;
}

function formatLocalKnowledgeSearchResult(query: string, result: LocalKnowledgeSearchResult) {
  if (result.data.length === 0) return `Local knowledge search: no hits for "${query}".`;
  return [
    `Local knowledge search: ${result.data.length} hit${result.data.length === 1 ? "" : "s"} for "${query}".`,
    "",
    ...result.data.slice(0, 8).flatMap((hit, index) => [
      `${index + 1}. ${hit.title || hit.sourceUri} (${hit.sourceType})`,
      hit.sourceUri,
      snippet(hit.text),
      "",
    ]),
  ].join("\n").trimEnd();
}

function formatLocalKnowledgePruneResult(result: LocalKnowledgePruneResult) {
  return [
    result.dryRun ? "Local knowledge prune preview:" : "Local knowledge pruned:",
    `Deleted sources: ${result.deletedSources}`,
    `Deleted chunks: ${result.deletedChunks}`,
    `Reclaimed bytes: ${formatBytes(result.reclaimedBytes)}`,
  ].join("\n");
}

function snippet(text: string, maxLength = 500) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
