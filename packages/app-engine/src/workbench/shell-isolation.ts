export type ShellIsolationMode = "none" | "auto" | "required";

export interface ShellIsolationPreferences {
  mode?: ShellIsolationMode;
  executablePath?: string | null;
  version?: string | null;
  sourceURL?: string | null;
  sha256?: string | null;
  installSkipped?: boolean | null;
}

export function localShellIsolationOptions(preferences: ShellIsolationPreferences = {}) {
  const executablePath = preferences.executablePath?.trim() || process.env.AGENT_ISOLATOR_PATH?.trim();
  const isolation = preferences.mode ?? "auto";
  return {
    isolation,
    isolationOptions: {
      filesystem: "workdir-readwrite",
      network: "allowed",
      env: "inherit",
    },
    ...(executablePath ? { isolator: { executablePath } } : {}),
  } as const;
}
