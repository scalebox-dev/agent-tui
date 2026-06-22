import {
  clearPresetToolCatalogCache,
  isAvailablePreset,
  listAvailablePresets,
  type AgentRunOptions,
} from "../agent.js";
import {
  loadWorkbenchPreferences,
  updateWorkbenchPreferences,
  type WorkbenchPreferences,
} from "../config.js";
import type { RenderMode } from "../tui/workbench.js";

export interface WorkbenchSettingsSnapshot {
  defaultPreset?: string | null;
  runPreset?: string;
}

export interface WorkbenchSettingsController {
  loadInitial(options: Pick<AgentRunOptions, "modelExplicit" | "preset" | "presetExplicit">): Promise<WorkbenchSettingsSnapshot>;
  saveDefaultPreset(input: {
    value: string;
    profileName?: string;
    options: Pick<AgentRunOptions, "modelExplicit" | "preset" | "presetExplicit">;
  }): Promise<WorkbenchSettingsSnapshot & { message: string; activity: string }>;
  validatePreset(profileName: string | undefined, preset: string): Promise<boolean>;
  presetListText(input: { profileName?: string; currentPreset?: string; prefix: string }): Promise<string>;
  configText(input: {
    accessMode: string;
    contextEnabled: boolean;
    defaultPreset?: string | null;
    profileName: string;
    runModel?: string;
    runPreset?: string;
    renderMode: RenderMode;
  }): string;
  defaultPresetHelp(defaultPreset?: string | null): string;
  clearPresetToolCatalogCache(baseURL?: string): void;
}

export interface WorkbenchSettingsControllerOptions {
  loadWorkbenchPreferencesImpl?: typeof loadWorkbenchPreferences;
  updateWorkbenchPreferencesImpl?: typeof updateWorkbenchPreferences;
  isAvailablePresetImpl?: typeof isAvailablePreset;
  listAvailablePresetsImpl?: typeof listAvailablePresets;
  clearPresetToolCatalogCacheImpl?: typeof clearPresetToolCatalogCache;
  formatError?: (error: unknown) => string;
}

export function createWorkbenchSettingsController(options: WorkbenchSettingsControllerOptions = {}): WorkbenchSettingsController {
  const loadWorkbenchPreferencesImpl = options.loadWorkbenchPreferencesImpl ?? loadWorkbenchPreferences;
  const updateWorkbenchPreferencesImpl = options.updateWorkbenchPreferencesImpl ?? updateWorkbenchPreferences;
  const isAvailablePresetImpl = options.isAvailablePresetImpl ?? isAvailablePreset;
  const listAvailablePresetsImpl = options.listAvailablePresetsImpl ?? listAvailablePresets;
  const clearPresetToolCatalogCacheImpl = options.clearPresetToolCatalogCacheImpl ?? clearPresetToolCatalogCache;
  const formatError = options.formatError ?? userFacingError;

  return {
    async loadInitial(agentOptions) {
      const preferences = await loadWorkbenchPreferencesImpl();
      return {
        defaultPreset: preferences.defaultPreset,
        runPreset: shouldApplyDefaultPreset(agentOptions)
          ? effectiveDefaultPreset(preferences, agentOptions.preset)
          : undefined,
      };
    },

    async saveDefaultPreset(input) {
      const normalized = normalizeDefaultPreset(input.value);
      if (typeof normalized === "string" && !(await isAvailablePresetImpl(input.profileName, normalized))) {
        throw new UnknownPresetError(normalized);
      }
      const preferences = await updateWorkbenchPreferencesImpl({ defaultPreset: normalized });
      return {
        defaultPreset: preferences.defaultPreset,
        runPreset: shouldApplyDefaultPreset(input.options)
          ? effectiveDefaultPreset(preferences, input.options.preset)
          : undefined,
        message: `Saved default preset: ${formatDefaultPreset(preferences.defaultPreset)}.`,
        activity: `Default preset saved: ${formatDefaultPreset(preferences.defaultPreset)}`,
      };
    },

    async validatePreset(profileName, preset) {
      return isAvailablePresetImpl(profileName, preset);
    },

    async presetListText(input) {
      try {
        const presets = await listAvailablePresetsImpl(input.profileName);
        return [
          input.prefix,
          "",
          "Available presets:",
          ...formatPresetList(presets, input.currentPreset),
        ].join("\n");
      } catch (error) {
        return [
          input.prefix,
          "",
          `Available presets could not be loaded: ${formatError(error)}`,
        ].join("\n");
      }
    },

    configText: runConfigText,

    defaultPresetHelp(defaultPreset) {
      return `Default preset: ${formatDefaultPreset(defaultPreset)}. Use /config preset <name>, /config preset none, or /config preset reset.`;
    },

    clearPresetToolCatalogCache(baseURL) {
      clearPresetToolCatalogCacheImpl(baseURL);
    },
  };
}

export class UnknownPresetError extends Error {
  constructor(public readonly preset: string) {
    super(`Unknown preset: ${preset}`);
    this.name = "UnknownPresetError";
  }
}

export function normalizeDefaultPreset(value: string) {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed || lowered === "reset" || lowered === "default" || lowered === "builtin") return undefined;
  if (["none", "off", "disable", "disabled"].includes(lowered)) return null;
  return trimmed;
}

export function formatDefaultPreset(value: string | null | undefined) {
  if (value === undefined) return "built-in (pro-search)";
  return value ?? "none";
}

export function effectiveDefaultPreset(preferences: WorkbenchPreferences, builtInPreset?: string) {
  if ("defaultPreset" in preferences) return preferences.defaultPreset ?? undefined;
  return builtInPreset;
}

export function formatPresetList(presets: Awaited<ReturnType<typeof listAvailablePresets>>, currentPreset?: string) {
  if (presets.length === 0) return ["- none returned by this endpoint"];
  return presets.map((preset) => {
    const description = preset.description ? ` - ${preset.description}` : "";
    const current = currentPreset && preset.preset === currentPreset;
    return `${current ? "*" : "-"} ${preset.preset}${current ? " (current)" : ""}${description}`;
  });
}

function shouldApplyDefaultPreset(options: Pick<AgentRunOptions, "modelExplicit" | "preset" | "presetExplicit">) {
  return !options.presetExplicit && !options.modelExplicit;
}

function runConfigText({
  accessMode,
  contextEnabled,
  defaultPreset,
  profileName,
  runModel,
  runPreset,
  renderMode,
}: {
  accessMode: string;
  contextEnabled: boolean;
  defaultPreset?: string | null;
  profileName: string;
  runModel?: string;
  runPreset?: string;
  renderMode: RenderMode;
}) {
  return [
    `Profile: ${profileName}`,
    `Preset: ${runPreset || "none"}`,
    `Default preset: ${formatDefaultPreset(defaultPreset)}`,
    `Model: ${runModel || "auto"}`,
    `Render mode: ${renderMode}`,
    `local_workdir tool: ${contextEnabled ? "on" : "off"}`,
    `local_shell tool: ${contextEnabled ? "on" : "off"}`,
    `Local access: ${accessMode}`,
  ].join("\n");
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
