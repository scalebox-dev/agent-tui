import { appVersion } from "./runtime/index.js";

export interface UpdateCheckResult {
  current: string;
  latest: string;
  packageName: string;
  updateAvailable: boolean;
}

export interface UpdateCheckOptions {
  currentVersion?: string;
  packageName?: string;
  registryURL?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const defaultPackageName = "@agent-api/cli";
const defaultRegistryURL = "https://registry.npmjs.org";

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const packageName = options.packageName || process.env.AGENT_TUI_UPDATE_PACKAGE || defaultPackageName;
  const current = options.currentVersion || appVersion();
  const registryURL = (options.registryURL || process.env.AGENT_TUI_NPM_REGISTRY || defaultRegistryURL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = combineSignals(options.signal, controller.signal);
  try {
    const response = await fetch(`${registryURL}/${encodeURIComponent(packageName).replace(/^%40/, "@")}/latest`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => undefined) as { version?: unknown } | undefined;
    const latest = typeof payload?.version === "string" ? payload.version : "";
    if (!latest) return null;
    return {
      current,
      latest,
      packageName,
      updateAvailable: compareVersions(latest, current) > 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatUpdateNotice(result: UpdateCheckResult): string {
  return `Update available: ${result.packageName} ${result.current} -> ${result.latest}. Run: npm install -g ${result.packageName}@latest`;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
