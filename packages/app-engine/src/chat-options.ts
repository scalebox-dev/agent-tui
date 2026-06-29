import type { WorkdirAccessMode } from "./agent.js";

export type ChatOptions = {
  profile?: string;
  conversation?: string;
  preset?: string;
  model?: string;
  file?: string;
  stdin?: boolean;
  workdir?: string;
  localContext?: boolean;
  contextQuery?: string;
  maxContextFiles?: string;
  maxContextBytes?: string;
  localSkill?: string[];
  localSkills?: boolean;
  memory?: boolean;
  memoryRead?: boolean;
  memoryWrite?: boolean;
  memoryTenantSearch?: boolean;
  workspaceSkills?: boolean;
  automaticContinuationLimit?: string;
  access?: string;
  restart?: boolean;
  stream?: boolean;
};

export function normalizeChatOptions(promptParts: string[], options: ChatOptions) {
  const presetExplicit = options.preset !== undefined;
  const modelExplicit = options.model !== undefined && options.model !== "";
  const preset = presetExplicit ? options.preset : (modelExplicit ? undefined : "pro-search");
  const parsedAccessMode = parseAccessMode(options.access);
  const accessMode = parsedAccessMode ?? (options.workdir || options.localContext ? "approval" : undefined);
  return {
    profile: options.profile,
    promptParts,
    file: options.file,
    stdin: options.stdin,
    preset,
    presetExplicit,
    model: options.model,
    modelExplicit,
    stream: options.stream !== false,
    conversation: options.conversation || "default",
    continueConversation: true,
    restartConversation: options.restart,
    workdir: options.workdir,
    includeLocalContext: options.localContext,
    contextQuery: options.contextQuery,
    maxContextFiles: optionalNumber(options.maxContextFiles, "--max-context-files"),
    maxContextBytes: optionalNumber(options.maxContextBytes, "--max-context-bytes"),
    localSkillPaths: options.localSkill,
    discoverLocalSkills: options.localSkills !== false,
    memory: memoryOptions(options),
    skillTool: options.workspaceSkills ? { tenant_search: true } : undefined,
    automaticContinuationLimit: optionalLimit(options.automaticContinuationLimit ?? process.env.AGENT_AUTOMATIC_CONTINUATION_LIMIT, "--automatic-continuation-limit"),
    accessMode,
  };
}

function memoryOptions(options: ChatOptions) {
	if (!options.memory && !options.memoryRead && !options.memoryWrite && !options.memoryTenantSearch) {
		return undefined;
	}
	return {
		enabled: true,
		...(options.memoryRead ? { read: true } : {}),
		...(options.memoryWrite ? { write: true } : {}),
		...(options.memoryTenantSearch ? { tenant_search: true } : {}),
	};
}

function optionalNumber(value: string | undefined, label: string) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function optionalLimit(value: string | undefined, label: string) {
  if (value == null || value === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["unlimited", "infinite", "off", "none", "disable", "disabled"].includes(normalized)) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = optionalNumber(value, label);
  if (parsed === undefined) return undefined;
  if (parsed < 0) throw new Error(`${label} must be zero or greater`);
  return Math.floor(parsed);
}

function parseAccessMode(value: string | undefined): WorkdirAccessMode | undefined {
  if (!value) return undefined;
  if (value === "off" || value === "approval" || value === "full") return value;
  throw new Error("--access must be off, approval, or full");
}
