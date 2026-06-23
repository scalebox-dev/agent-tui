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
import type { ShellIsolationMode, ShellIsolationPreferences } from "./shell-isolation.js";
import {
  ensureConfiguredIsolator,
  installConfiguredIsolator,
  normalizeSourceURL,
  relocateInstalledIsolator,
  validateInstalledIsolator,
  type IsolatorInstallOptions,
} from "./isolator-installer.js";

export interface WorkbenchSettingsSnapshot {
  defaultPreset?: string | null;
  runPreset?: string;
  shellIsolation?: ShellIsolationPreferences;
  activity?: string;
  warning?: string;
}

export interface WorkbenchSettingsController {
  loadInitial(options: Pick<AgentRunOptions, "modelExplicit" | "preset" | "presetExplicit">): Promise<WorkbenchSettingsSnapshot>;
  saveDefaultPreset(input: {
    value: string;
    profileName?: string;
    options: Pick<AgentRunOptions, "modelExplicit" | "preset" | "presetExplicit">;
  }): Promise<WorkbenchSettingsSnapshot & { message: string; activity: string }>;
  saveShellIsolationMode(value: string): Promise<WorkbenchSettingsSnapshot & { message: string; activity: string }>;
  saveIsolatorPath(value: string): Promise<WorkbenchSettingsSnapshot & { message: string; activity: string }>;
  saveIsolatorSource(value: string): Promise<WorkbenchSettingsSnapshot & { message: string; activity: string }>;
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
    shellIsolation?: ShellIsolationPreferences;
  }): string;
  defaultPresetHelp(defaultPreset?: string | null): string;
  shellIsolationHelp(shellIsolation?: ShellIsolationPreferences): string;
  isolatorPathHelp(shellIsolation?: ShellIsolationPreferences): string;
  clearPresetToolCatalogCache(baseURL?: string): void;
}

export interface WorkbenchSettingsControllerOptions {
  loadWorkbenchPreferencesImpl?: typeof loadWorkbenchPreferences;
  updateWorkbenchPreferencesImpl?: typeof updateWorkbenchPreferences;
  isAvailablePresetImpl?: typeof isAvailablePreset;
  listAvailablePresetsImpl?: typeof listAvailablePresets;
  clearPresetToolCatalogCacheImpl?: typeof clearPresetToolCatalogCache;
  isolatorInstallOptions?: IsolatorInstallOptions;
  formatError?: (error: unknown) => string;
}

export function createWorkbenchSettingsController(options: WorkbenchSettingsControllerOptions = {}): WorkbenchSettingsController {
  const loadWorkbenchPreferencesImpl = options.loadWorkbenchPreferencesImpl ?? loadWorkbenchPreferences;
  const updateWorkbenchPreferencesImpl = options.updateWorkbenchPreferencesImpl ?? updateWorkbenchPreferences;
  const isAvailablePresetImpl = options.isAvailablePresetImpl ?? isAvailablePreset;
  const listAvailablePresetsImpl = options.listAvailablePresetsImpl ?? listAvailablePresets;
  const clearPresetToolCatalogCacheImpl = options.clearPresetToolCatalogCacheImpl ?? clearPresetToolCatalogCache;
  const isolatorInstallOptions = options.isolatorInstallOptions ?? {};
  const formatError = options.formatError ?? userFacingError;

  return {
    async loadInitial(agentOptions) {
      const loadedPreferences = await loadWorkbenchPreferencesImpl();
      const { preferences, activity, warning } = await reconcileConfiguredIsolator(
        loadedPreferences,
        updateWorkbenchPreferencesImpl,
        isolatorInstallOptions,
        formatError,
      );
      return {
        defaultPreset: preferences.defaultPreset,
        ...(preferences.isolation ? { shellIsolation: preferences.isolation } : {}),
        ...(activity ? { activity } : {}),
        ...(warning ? { warning } : {}),
        runPreset: shouldApplyDefaultPreset(agentOptions)
          ? effectiveDefaultPreset(preferences, agentOptions.preset)
          : undefined,
      };
    },

    async saveShellIsolationMode(value) {
      const mode = normalizeShellIsolationMode(value);
      const preferences = await updateWorkbenchPreferencesImpl({ isolation: { mode } });
      return {
        ...settingsSnapshot(preferences),
        message: `Saved shell isolation mode: ${formatShellIsolation(preferences.isolation)}.`,
        activity: `Shell isolation mode saved: ${preferences.isolation?.mode ?? "auto"}`,
      };
    },

    async saveIsolatorPath(value) {
      const executablePath = normalizeIsolatorPath(value);
      if (!executablePath) {
        const preferences = await updateWorkbenchPreferencesImpl({ isolation: { executablePath } });
        return {
          ...settingsSnapshot(preferences),
          message: `Saved isolator path: ${formatIsolatorPath(preferences.isolation)}.`,
          activity: "Isolator path cleared",
        };
      }
      const current = (await loadWorkbenchPreferencesImpl()).isolation;
      if (current?.sourceURL) {
        const result = await installConfiguredIsolator({
          sourceURL: current.sourceURL,
          executablePath,
          sha256: current.sha256,
        }, isolatorInstallOptions);
        const preferences = await updateWorkbenchPreferencesImpl({
          isolation: { executablePath: result.executablePath, sourceURL: result.sourceURL, sha256: result.sha256, installSkipped: false },
        });
        return {
          ...settingsSnapshot(preferences),
          message: `Installed isolator to ${result.executablePath}.`,
          activity: result.replaced ? "Isolator refreshed" : "Isolator installed",
        };
      }
      const validatedPath = current?.executablePath
        ? await relocateInstalledIsolator(current.executablePath, executablePath, isolatorInstallOptions)
        : await validateInstalledIsolator(executablePath, isolatorInstallOptions);
      const preferences = await updateWorkbenchPreferencesImpl({ isolation: { executablePath: validatedPath, installSkipped: false } });
      return {
        ...settingsSnapshot(preferences),
        message: `Saved verified isolator path: ${formatIsolatorPath(preferences.isolation)}.`,
        activity: "Isolator path verified",
      };
    },

    async saveIsolatorSource(value) {
      const sourceURL = normalizeIsolatorSource(value);
      const current = (await loadWorkbenchPreferencesImpl()).isolation;
      if (!sourceURL) {
        const preferences = await updateWorkbenchPreferencesImpl({ isolation: { sourceURL, sha256: null } });
        return {
          ...settingsSnapshot(preferences),
          message: "Cleared isolator source URL.",
          activity: "Isolator source cleared",
        };
      }
      if (!current?.executablePath) {
        throw new Error("Set a verified isolator path before saving a source URL.");
      }
      const result = await installConfiguredIsolator({
        sourceURL,
        executablePath: current.executablePath,
        sha256: current.sha256,
      }, isolatorInstallOptions);
      const preferences = await updateWorkbenchPreferencesImpl({
        isolation: { sourceURL: result.sourceURL, executablePath: result.executablePath, sha256: result.sha256, installSkipped: false },
      });
      return {
        ...settingsSnapshot(preferences),
        message: `Installed isolator from ${result.sourceURL}.`,
        activity: result.replaced ? "Isolator refreshed from source" : "Isolator installed from source",
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
        ...(preferences.isolation ? { shellIsolation: preferences.isolation } : {}),
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

    shellIsolationHelp(shellIsolation) {
      return `Shell isolation: ${formatShellIsolation(shellIsolation)}. Use /config isolation none, /config isolation auto, or /config isolation required.`;
    },

    isolatorPathHelp(shellIsolation) {
      return [
        `Isolator path: ${formatIsolatorPath(shellIsolation)}`,
        `Isolator source: ${formatIsolatorSource(shellIsolation)}`,
        "Use /config isolator path <absolute-path>, /config isolator source <https-url>, or /config isolator none to clear the path.",
      ].join("\n");
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

function settingsSnapshot(preferences: WorkbenchPreferences): WorkbenchSettingsSnapshot {
  return {
    ...("defaultPreset" in preferences ? { defaultPreset: preferences.defaultPreset } : {}),
    ...(preferences.isolation ? { shellIsolation: preferences.isolation } : {}),
  };
}

export function normalizeShellIsolationMode(value: string): ShellIsolationMode {
  const lowered = value.trim().toLowerCase();
  if (lowered === "none" || lowered === "off" || lowered === "disable" || lowered === "disabled") return "none";
  if (lowered === "auto" || lowered === "default") return "auto";
  if (lowered === "required" || lowered === "require" || lowered === "strict") return "required";
  throw new Error("Unknown shell isolation mode. Use none, auto, or required.");
}

export function normalizeIsolatorPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Usage: /config isolator <path>, or /config isolator none.");
  const lowered = trimmed.toLowerCase();
  if (["none", "off", "disable", "disabled", "clear", "reset"].includes(lowered)) return null;
  return trimmed;
}

export function normalizeIsolatorSource(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Usage: /config isolator source <https-url>, or /config isolator source none.");
  const lowered = trimmed.toLowerCase();
  if (["none", "off", "disable", "disabled", "clear", "reset"].includes(lowered)) return null;
  return normalizeSourceURL(trimmed);
}

export function formatShellIsolation(value: ShellIsolationPreferences | undefined) {
  return value?.mode ?? "auto";
}

export function formatIsolatorPath(value: ShellIsolationPreferences | undefined) {
  return value?.executablePath || process.env.AGENT_ISOLATOR_PATH || "not configured";
}

export function formatIsolatorSource(value: ShellIsolationPreferences | undefined) {
  return value?.sourceURL || "not configured";
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
  shellIsolation,
}: {
  accessMode: string;
  contextEnabled: boolean;
  defaultPreset?: string | null;
  profileName: string;
  runModel?: string;
  runPreset?: string;
  renderMode: RenderMode;
  shellIsolation?: ShellIsolationPreferences;
}) {
  return [
    `Profile: ${profileName}`,
    `Preset: ${runPreset || "none"}`,
    `Default preset: ${formatDefaultPreset(defaultPreset)}`,
    `Model: ${runModel || "auto"}`,
    `Render mode: ${renderMode}`,
    `Shell isolation: ${formatShellIsolation(shellIsolation)}`,
    `Isolator path: ${formatIsolatorPath(shellIsolation)}`,
    `Isolator source: ${formatIsolatorSource(shellIsolation)}`,
    `local_workdir tool: ${contextEnabled ? "on" : "off"}`,
    `local_shell tool: ${contextEnabled ? "on" : "off"}`,
    `Local access: ${accessMode}`,
  ].join("\n");
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function reconcileConfiguredIsolator(
  preferences: WorkbenchPreferences,
  updatePreferences: typeof updateWorkbenchPreferences,
  installOptions: IsolatorInstallOptions,
  formatError: (error: unknown) => string,
): Promise<{ preferences: WorkbenchPreferences; activity?: string; warning?: string }> {
  const isolation = preferences.isolation;
  if (!isolation?.sourceURL || !isolation.executablePath) return { preferences };
  try {
    const result = await ensureConfiguredIsolator({
      sourceURL: isolation.sourceURL,
      executablePath: isolation.executablePath,
      sha256: isolation.sha256,
    }, installOptions);
    if (!result.repaired) return { preferences };
    const updated = await updatePreferences({
      isolation: {
        sourceURL: result.sourceURL,
        executablePath: result.executablePath,
        sha256: result.sha256,
        installSkipped: false,
      },
    });
    return {
      preferences: updated,
      activity: `Reinstalled isolator: ${result.executablePath}`,
    };
  } catch (error) {
    return {
      preferences,
      warning: `Configured isolator is unavailable: ${formatError(error)}`,
    };
  }
}
