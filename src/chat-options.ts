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
  access?: string;
  restart?: boolean;
  stream?: boolean;
};

export function normalizeChatOptions(promptParts: string[], options: ChatOptions) {
  const presetExplicit = options.preset !== undefined;
  const modelExplicit = options.model !== undefined && options.model !== "";
  const preset = presetExplicit ? options.preset : (modelExplicit ? undefined : "pro-search");
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
    accessMode: parseAccessMode(options.access),
  };
}

function optionalNumber(value: string | undefined, label: string) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function parseAccessMode(value: string | undefined): WorkdirAccessMode {
  const mode = value || "approval";
  if (mode === "approval" || mode === "full") return mode;
  throw new Error("--access must be either approval or full");
}
