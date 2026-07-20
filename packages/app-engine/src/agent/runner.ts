import { readFile } from "node:fs/promises";
import {
  functionCallOutputInput,
  pendingFunctionCalls,
  resolvePresetTools,
  resolvePresetToolsFromCatalog,
  type AgentResponse,
  type FunctionCallOutputInput,
  type Input,
  type LocalSkillDescriptor,
  type MemoryOptions,
  type PresetToolCatalogClient,
  type RequestOptions,
  type ResponseStreamEvent,
  type SkillToolOptions,
  type Tool,
} from "@agent-api/sdk";
import { localSkillFromDirectory, pendingLocalSkillCalls, runLocalSkillHandlers } from "@agent-api/sdk/node";
import {
  createLocalPauseToolRegistry,
  createLocalKnowledgeToolRegistry,
  createLocalShellToolRegistry,
  createLocalWorkdirToolRegistry,
  formatLocalKnowledgeContext,
  localPauseToolInstructions,
  localShellToolInstructions,
  localWorkdirToolInstructions,
  type LocalKnowledgeService,
  type LocalKnowledgeScope,
  type LocalPauseHandle,
  type LocalPauseRequest,
  type LocalPauseResult,
  type LocalShellToolRegistry,
  type LocalWorkdirToolRegistry,
} from "@agent-api/sdk/local";
import { resolvePreviousResponseID, updateConversation } from "../conversation/index.js";
import { localToolDisplayArguments, localToolDisplayResult } from "../local-display.js";
import { resolveRuntimeProfile } from "../profile.js";
import { runtime } from "../runtime/index.js";
import { buildWorkdirContextBlock, openWorkdir } from "../workdir/index.js";
import { localShellIsolationOptions } from "../workbench/shell-isolation.js";
import type { ShellIsolationPreferences } from "../workbench/shell-isolation.js";
import type { ConversationRunSettings } from "../config.js";

export interface AgentRunOptions {
  profile?: string;
  promptParts: string[];
  file?: string;
  stdin?: boolean;
  preset?: string;
  presetExplicit?: boolean;
  model?: string;
  modelExplicit?: boolean;
  stream?: boolean;
  conversation?: string;
  conversationExplicit?: boolean;
  workspaceId?: string;
  workspaceName?: string;
  continueConversation?: boolean;
  restartConversation?: boolean;
  previousResponseId?: string;
  workdir?: string;
  includeLocalContext?: boolean;
  contextQuery?: string;
  maxContextFiles?: number;
  maxContextBytes?: number;
  localSkillPaths?: string[];
  discoverLocalSkills?: boolean;
  memory?: MemoryOptions;
  skillTool?: SkillToolOptions;
  accessMode?: WorkdirAccessMode;
  shellIsolation?: ShellIsolationPreferences;
  automaticContinuationLimit?: number;
  bypassAutomaticContinuationLimit?: boolean;
  automaticContinuationCount?: number;
  abortSignal?: AbortSignal;
  localPause?: LocalPauseHooks;
  localKnowledge?: LocalKnowledgeService;
  localKnowledgeEnabled?: boolean;
}

export type WorkdirAccessMode = "off" | "approval" | "full";

export interface AgentTurnResult {
  text: string;
  responseID?: string;
  paused?: boolean;
  pause?: AutomaticContinuationPause;
}

export interface AutomaticContinuationPause {
  reason: "automatic_continuation_limit";
  message: string;
  continuation: AutomaticContinuationState;
  count: number;
  limit: number;
  responseID?: string;
}

export interface AutomaticContinuationState {
  input: Input;
  previousResponseID: string;
  automaticContinuationCount: number;
}

export interface LocalToolApprovalRequest {
  name: string;
  action?: string;
  arguments: Record<string, unknown>;
  preview?: unknown;
  callID: string;
  responseID: string;
}

export type { LocalPauseHandle, LocalPauseRequest, LocalPauseResult };

export interface LocalPauseHooks {
  maxDurationMs?: number;
  onPauseStart?: (handle: LocalPauseHandle) => void;
  onPauseEnd?: (result: LocalPauseResult) => void;
}

export type AgentTurnEvent =
  | { type: "text.delta"; delta: string }
  | { type: "response.started"; responseID?: string }
  | { type: "response.completed"; responseID?: string }
  | { type: "response.failed"; message: string }
  | { type: "reasoning.started" }
  | { type: "reasoning.stopped"; thought?: string }
  | { type: "reasoning.search_queries"; queries: string[] }
  | { type: "reasoning.search_results"; count: number }
  | { type: "reasoning.fetch_url_queries"; urls: string[] }
  | { type: "reasoning.fetch_url_results"; count: number }
  | { type: "tool.completed"; name: string; status?: string }
  | { type: "local_tool.started"; name: string; action?: string; arguments?: Record<string, unknown> }
  | { type: "local_tool.completed"; name: string; action?: string; arguments?: Record<string, unknown>; result?: Record<string, unknown>; requiresApproval?: boolean }
  | ({ type: "local_tool.approval_requested" } & LocalToolApprovalRequest)
  | ({ type: "automatic_continuation.paused" } & AutomaticContinuationPause)
  | { type: "model.requested"; model?: string; provider?: string }
  | { type: "model.completed"; model?: string; provider?: string }
  | { type: "model.failed"; model?: string; provider?: string }
  | { type: "step.completed"; stepType?: string }
  | { type: "step.failed"; stepType?: string }
  | { type: "raw"; eventType: string };

type PresetListResponse = Awaited<ReturnType<PresetToolCatalogClient["presets"]["list"]>>;
type ToolListResponse = Awaited<ReturnType<PresetToolCatalogClient["tools"]["list"]>>;

export interface ResolveAgentRequestToolsOptions {
  baseURL?: string;
  cacheTTLMS?: number;
}

export interface PresetSummary {
  preset: string;
  description?: string;
}

const defaultCatalogCacheTTLMS = 10 * 60_000;
const presetCatalogCache = new Map<string, CacheEntry<PresetListResponse>>();
const toolCatalogCache = new Map<string, CacheEntry<ToolListResponse>>();

interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

export async function runAgent(options: AgentRunOptions) {
  const result = await runAgentTurn(options, (event) => {
    if (event.type === "text.delta") process.stdout.write(event.delta);
  });
  if (result.text && options.stream === false) {
    console.log(result.text);
  } else if (result.paused && result.text) {
    process.stdout.write(`${result.text}\n`);
  } else if (options.stream !== false) {
    process.stdout.write("\n");
  }
}

export async function runAgentTurn(options: AgentRunOptions, onEvent?: (event: AgentTurnEvent) => void): Promise<AgentTurnResult> {
  const runtimeProfile = await resolveRuntimeProfile(options.profile);
  await prepareLocalKnowledge(options);
  const localContext = await prepareLocalContext(options);
  const input = await buildInput(options);
  const previousResponseId = await resolvePreviousResponseID(options);
  const tools = await resolveAgentRequestTools(
    runtimeProfile.client,
    options.preset,
    localContext?.registry.definitions(),
    { baseURL: runtimeProfile.profile.baseURL },
  );
  const params = {
    input,
    instructions: localContext?.instructions,
    tools,
    preset: options.preset,
    model: options.model,
    previous_response_id: previousResponseId,
    local_skills: localContext?.localSkills.length ? localContext.localSkills : undefined,
    memory: options.memory,
    skill_tool: options.skillTool,
    stream: options.stream ?? true,
  };

  if (localContext) {
    return await runAgentTurnWithLocalTools(
      runtimeProfile.client.agent,
      runtimeProfile.client.responses,
      params,
      options,
      localContext,
      onEvent,
    );
  }

  if (params.stream) {
    const stream = await runtimeProfile.client.agent.create({ ...params, stream: true }, requestAbortOptions(options.abortSignal));
    let finalResponseID = "";
    let text = "";
    for await (const event of stream) {
      throwIfAborted(options.abortSignal);
      emitAgentTurnEvent(event, onEvent);
      if (event.type === "response.output_text.delta" && event.delta) {
        text += event.delta;
      }
      if (event.response?.id) {
        finalResponseID = event.response.id;
      }
      if (event.type === "response.failed") {
        const message = event.error?.message || "agent run failed";
        throw new Error(message);
      }
    }
    if (finalResponseID) {
      await persistConversation(options, finalResponseID);
    }
    return { text, responseID: finalResponseID || undefined };
  }

  const response = await runtimeProfile.client.agent.create({ ...params, stream: false }, requestAbortOptions(options.abortSignal));
  await persistConversation(options, response.id);
  return { text: response.output_text || "", responseID: response.id };
}

export async function resumeAgentAfterLocalApproval(
  options: AgentRunOptions,
  approval: LocalToolApprovalRequest,
  output: string | Record<string, unknown>,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<AgentTurnResult> {
  const runtimeProfile = await resolveRuntimeProfile(options.profile);
  await prepareLocalKnowledge(options);
  const localContext = await prepareLocalContext(options);
  if (!localContext) {
    throw new Error("local tools are not available for approval continuation");
  }
  const tools = await resolveAgentRequestTools(
    runtimeProfile.client,
    options.preset,
    localContext.registry.definitions(),
    { baseURL: runtimeProfile.profile.baseURL },
  );
  return await runAgentTurnWithLocalTools(
    runtimeProfile.client.agent,
    runtimeProfile.client.responses,
    {
      input: [functionCallOutputInput(approval.callID, output)],
      instructions: localContext.instructions,
      tools,
      preset: options.preset,
      model: options.model,
      previous_response_id: approval.responseID,
      local_skills: localContext.localSkills.length ? localContext.localSkills : undefined,
      memory: options.memory,
      skill_tool: options.skillTool,
      stream: options.stream ?? true,
    },
    options,
    localContext,
    onEvent,
  );
}

export async function resumeAgentAfterAutomaticContinuation(
  options: AgentRunOptions,
  continuation: AutomaticContinuationState,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<AgentTurnResult> {
  const runtimeProfile = await resolveRuntimeProfile(options.profile);
  await prepareLocalKnowledge(options);
  const localContext = await prepareLocalContext(options);
  if (!localContext) {
    throw new Error("local tools are not available for automatic continuation");
  }
  const tools = await resolveAgentRequestTools(
    runtimeProfile.client,
    options.preset,
    localContext.registry.definitions(),
    { baseURL: runtimeProfile.profile.baseURL },
  );
  return await runAgentTurnWithLocalTools(
    runtimeProfile.client.agent,
    runtimeProfile.client.responses,
    {
      input: continuation.input,
      instructions: localContext.instructions,
      tools,
      preset: options.preset,
      model: options.model,
      previous_response_id: continuation.previousResponseID,
      local_skills: localContext.localSkills.length ? localContext.localSkills : undefined,
      memory: options.memory,
      skill_tool: options.skillTool,
      stream: options.stream ?? true,
    },
    {
      ...options,
      automaticContinuationCount: continuation.automaticContinuationCount,
    },
    localContext,
    onEvent,
  );
}

export async function listAvailablePresets(profileName?: string): Promise<PresetSummary[]> {
  const runtimeProfile = await resolveRuntimeProfile(profileName);
  const presets = await cachedPresetCatalog(
    runtimeProfile.profile.baseURL,
    defaultCatalogCacheTTLMS,
    () => runtimeProfile.client.presets.list(),
  );
  return presets.data
    .map((preset) => {
      const item = preset as { preset?: unknown; name?: unknown; description?: unknown };
      const name = typeof item.preset === "string"
        ? item.preset
        : typeof item.name === "string"
          ? item.name
          : "";
      return {
        preset: name,
        description: typeof item.description === "string" ? item.description : undefined,
      };
    })
    .filter((preset) => preset.preset.length > 0)
    .sort((a, b) => a.preset.localeCompare(b.preset));
}

export async function isAvailablePreset(profileName: string | undefined, preset: string): Promise<boolean> {
  const available = await listAvailablePresets(profileName);
  return available.some((item) => item.preset === preset);
}

async function runAgentTurnWithLocalTools(
  agent: Awaited<ReturnType<typeof resolveRuntimeProfile>>["client"]["agent"],
  responses: Awaited<ReturnType<typeof resolveRuntimeProfile>>["client"]["responses"],
  initialParams: {
    input: Input;
    instructions?: string;
    tools?: Tool[];
    preset?: string;
    model?: string;
    previous_response_id?: string;
    local_skills?: LocalSkillDescriptor[];
    memory?: MemoryOptions;
    skill_tool?: SkillToolOptions;
    stream: boolean;
  },
  options: AgentRunOptions,
  localContext: LocalExecutionContext,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<AgentTurnResult> {
  let input = initialParams.input;
  let previousResponseID = initialParams.previous_response_id;
  let automaticContinuationCount = options.automaticContinuationCount ?? 0;
  const automaticContinuationLimit = normalizeAutomaticContinuationLimit(options.automaticContinuationLimit);

  for (;;) {
    throwIfAborted(options.abortSignal);
    const isAutomaticContinuationCall = isAutomaticContinuationInput(input, previousResponseID);
    if (
      isAutomaticContinuationCall &&
      previousResponseID &&
      !options.bypassAutomaticContinuationLimit &&
      automaticContinuationCount >= automaticContinuationLimit
    ) {
      const continuationResponseID = previousResponseID;
      const message = automaticContinuationPauseMessage(automaticContinuationCount, automaticContinuationLimit, continuationResponseID);
      const pause: AutomaticContinuationPause = {
        reason: "automatic_continuation_limit",
        message,
        continuation: {
          input,
          previousResponseID: continuationResponseID,
          automaticContinuationCount,
        },
        count: automaticContinuationCount,
        limit: automaticContinuationLimit,
        responseID: continuationResponseID,
      };
      onEvent?.({ type: "automatic_continuation.paused", ...pause });
      await persistConversation(options, continuationResponseID);
      return {
        text: message,
        responseID: continuationResponseID,
        paused: true,
        pause,
      };
    }
    const requestRuntimeProfile = isAutomaticContinuationCall ? await resolveRuntimeProfile(options.profile) : undefined;
    const response = await createAgentResponseWithOptionalStream(requestRuntimeProfile?.client.agent ?? agent, {
      input,
      instructions: initialParams.instructions,
      tools: initialParams.tools,
      preset: initialParams.preset,
      model: initialParams.model,
      previous_response_id: previousResponseID,
      local_skills: initialParams.local_skills,
      memory: initialParams.memory,
      skill_tool: initialParams.skill_tool,
      stream: initialParams.stream,
    }, requestRuntimeProfile?.client.responses ?? responses, options.abortSignal, onEvent);
    throwIfAborted(options.abortSignal);
    if (isAutomaticContinuationCall) {
      automaticContinuationCount += 1;
    }
    if (initialParams.stream === false) {
      onEvent?.({ type: "response.started", responseID: response.id });
    }

    if (response.status === "failed") {
      const message = agentResponseFailureMessage(response);
      onEvent?.({ type: "response.failed", message });
      throw new Error(message);
    }

    const pending = pendingFunctionCalls(response);
    if (pending.length === 0) {
      if (initialParams.stream === false) {
        onEvent?.({ type: "response.completed", responseID: response.id });
      }
      await persistConversation(options, response.id);
      return { text: response.output_text || "", responseID: response.id };
    }

    const localSkillOutputs = await executeLocalSkillCalls(response, localContext.localSkills, options.abortSignal, onEvent);
    const localSkillCallIDs = new Set(localSkillOutputs.map((output) => output.call_id));
    const localResult = await executeLocalFunctionCalls(response, localContext.registry, localSkillCallIDs, options.abortSignal, onEvent);
    if (localResult.approvalRequested) {
      const message = localApprovalMessage(localResult.approvalRequested);
      if (initialParams.stream !== false) {
        onEvent?.({ type: "text.delta", delta: message });
      }
      if (initialParams.stream === false) {
        onEvent?.({ type: "response.completed", responseID: response.id });
      }
      await persistConversation(options, response.id);
      return {
        text: message,
        responseID: response.id,
      };
    }
    const outputs = [...localSkillOutputs, ...localResult.outputs];
    input = outputs;
    previousResponseID = response.id;
  }
}

function normalizeAutomaticContinuationLimit(value: number | undefined) {
  if (value === undefined) return 8;
  if (!Number.isFinite(value) || value < 0) return 8;
  return Math.floor(value);
}

function automaticContinuationPauseMessage(count: number, limit: number, responseID: string) {
  return [
    `Automatic workflow paused after ${count} continuation call${count === 1 ? "" : "s"} (limit: ${limit}).`,
    `Last response: ${responseID}.`,
    "Use /apply to continue, /apply-all to continue without more automatic continuation checkpoints for this turn, or /reject to stop here.",
  ].join("\n");
}

function isAutomaticContinuationInput(input: Input, previousResponseID: string | undefined) {
  if (!previousResponseID || !Array.isArray(input)) return false;
  return input.some((item) => item && typeof item === "object" && "type" in item && item.type === "function_call_output");
}

async function persistConversation(options: AgentRunOptions, responseID: string) {
  await updateConversation({
    ...options,
    runSettings: conversationRunSettingsFromOptions(options),
  }, responseID);
}

function conversationRunSettingsFromOptions(options: AgentRunOptions): ConversationRunSettings {
  return {
    accessMode: options.accessMode,
    automaticContinuationLimit: options.automaticContinuationLimit ?? null,
    contextEnabled: Boolean(options.includeLocalContext),
    localKnowledgeEnabled: options.localKnowledgeEnabled !== false,
    localSkillsEnabled: options.discoverLocalSkills !== false,
    memoryRead: Boolean(options.memory?.read || options.memory?.enabled || options.memory?.tenant_search),
    memoryTenantSearch: Boolean(options.memory?.tenant_search),
    memoryWrite: Boolean(options.memory?.write),
    model: options.model || null,
    preset: options.preset || null,
    workspaceSkillsEnabled: Boolean(options.skillTool?.tenant_search),
  };
}

async function createAgentResponseWithOptionalStream(
  agent: Awaited<ReturnType<typeof resolveRuntimeProfile>>["client"]["agent"],
  params: {
    input: Input;
    instructions?: string;
    tools?: Tool[];
    preset?: string;
    model?: string;
    previous_response_id?: string;
    local_skills?: LocalSkillDescriptor[];
    memory?: MemoryOptions;
    skill_tool?: SkillToolOptions;
    stream: boolean;
  },
  responses: Awaited<ReturnType<typeof resolveRuntimeProfile>>["client"]["responses"],
  abortSignal?: AbortSignal,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<AgentResponse> {
  throwIfAborted(abortSignal);
  if (!params.stream) {
    const response = await agent.create({ ...params, stream: false }, requestAbortOptions(abortSignal));
    throwIfAborted(abortSignal);
    return response;
  }

  const stream = await agent.create({ ...params, stream: true }, requestAbortOptions(abortSignal));
  let finalResponse: AgentResponse | undefined;
  let responseID = "";
  let sawTextDelta = false;
  for await (const event of stream) {
    throwIfAborted(abortSignal);
    emitAgentTurnEvent(event, onEvent);
    if (event.type === "response.output_text.delta") {
      sawTextDelta = true;
    }
    if (event.response?.id) {
      responseID = event.response.id;
    }
    if (event.type === "response.completed" && event.response) {
      finalResponse = withOutputText(event.response);
    }
    if (event.type === "response.failed") {
      throw new Error(event.error?.message || "agent run failed");
    }
  }

  throwIfAborted(abortSignal);
  if (!finalResponse && responseID) {
    finalResponse = await responses.retrieve(responseID, {}, requestAbortOptions(abortSignal));
  }
  if (!finalResponse) {
    throw new Error("agent stream completed without a final response");
  }
  if (!sawTextDelta && finalResponse.output_text) {
    onEvent?.({ type: "text.delta", delta: finalResponse.output_text });
  }
  return finalResponse;
}

export function agentResponseFailureMessage(response: AgentResponse) {
  const details: string[] = [];
  if (response.id) details.push(response.id);
  if (response.model) details.push(`model=${response.model}`);
  const label = details.length > 0 ? `Agent response ${details.join(" ")}` : "Agent response";
  const message = response.error?.message || "agent run failed";
  const code = response.error?.code || response.error?.type;
  return code ? `${label} failed: ${message} (${code})` : `${label} failed: ${message}`;
}

function withOutputText(response: AgentResponse): AgentResponse {
  if (response.output_text !== undefined) {
    return response;
  }
  const outputText = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return { ...response, output_text: outputText };
}

export function agentTurnEventFromStreamEvent(event: ResponseStreamEvent): AgentTurnEvent | null {
  const responseID = event.response?.id;
  switch (event.type) {
    case "response.created":
    case "response.in_progress":
      return { type: "response.started", responseID };
    case "response.output_text.delta":
      return event.delta ? { type: "text.delta", delta: event.delta } : null;
    case "response.completed":
      return { type: "response.completed", responseID };
    case "response.failed":
      return { type: "response.failed", message: event.error?.message || "agent run failed" };
    case "response.reasoning.started":
      return { type: "reasoning.started" };
    case "response.reasoning.stopped":
      return { type: "reasoning.stopped", thought: event.thought };
    case "response.reasoning.search_queries":
      return { type: "reasoning.search_queries", queries: event.queries ?? [] };
    case "response.reasoning.search_results":
      return { type: "reasoning.search_results", count: event.results?.length ?? 0 };
    case "response.reasoning.fetch_url_queries":
      return { type: "reasoning.fetch_url_queries", urls: event.urls ?? [] };
    case "response.reasoning.fetch_url_results":
      return { type: "reasoning.fetch_url_results", count: event.contents?.length ?? 0 };
    case "response.tool.invocation.completed":
      return {
        type: "tool.completed",
        name: event.tool_result?.tool_name || "tool",
        status: event.tool_result?.status,
      };
    case "response.model.requested":
      return {
        type: "model.requested",
        model: event.model_call?.model,
        provider: event.model_call?.provider,
      };
    case "response.model.completed":
      return {
        type: "model.completed",
        model: event.model_call?.model,
        provider: event.model_call?.provider,
      };
    case "response.model.failed":
      return {
        type: "model.failed",
        model: event.model_call?.model,
        provider: event.model_call?.provider,
      };
    case "response.step.completed":
      return { type: "step.completed", stepType: event.step?.step_type };
    case "response.step.failed":
      return { type: "step.failed", stepType: event.step?.step_type };
    default:
      return { type: "raw", eventType: event.type };
  }
}

function emitAgentTurnEvent(event: ResponseStreamEvent, onEvent?: (event: AgentTurnEvent) => void) {
  if (!onEvent) return;
  const mapped = agentTurnEventFromStreamEvent(event);
  if (mapped) onEvent(mapped);
}

export async function resolveAgentRequestTools(
  client: PresetToolCatalogClient,
  preset?: string,
  tools?: readonly Tool[],
  options: ResolveAgentRequestToolsOptions = {},
): Promise<Tool[] | undefined> {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  if (!preset) {
    return [...tools];
  }
  if (options.baseURL) {
    const ttl = options.cacheTTLMS ?? defaultCatalogCacheTTLMS;
    const [presets, toolCatalog] = await Promise.all([
      cachedPresetCatalog(options.baseURL, ttl, () => client.presets.list()),
      cachedToolCatalog(options.baseURL, ttl, () => client.tools.list()),
    ]);
    const resolved = resolvePresetToolsFromCatalog({
      preset,
      tools,
      presets: presets.data,
      toolCatalog: toolCatalog.data,
    });
    return resolved.tools;
  }
  const resolved = await resolvePresetTools(client, { preset, tools });
  return resolved.tools;
}

export function clearPresetToolCatalogCache(baseURL?: string): void {
  if (!baseURL) {
    presetCatalogCache.clear();
    toolCatalogCache.clear();
    return;
  }
  const key = catalogCacheKey(baseURL);
  presetCatalogCache.delete(key);
  toolCatalogCache.delete(key);
}

async function cachedPresetCatalog(
  baseURL: string,
  ttl: number,
  load: () => Promise<PresetListResponse>,
): Promise<PresetListResponse> {
  return cachedCatalog(presetCatalogCache, baseURL, ttl, load);
}

async function cachedToolCatalog(
  baseURL: string,
  ttl: number,
  load: () => Promise<ToolListResponse>,
): Promise<ToolListResponse> {
  return cachedCatalog(toolCatalogCache, baseURL, ttl, load);
}

async function cachedCatalog<T>(
  cache: Map<string, CacheEntry<T>>,
  baseURL: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const key = catalogCacheKey(baseURL);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }
  const promise = load().catch((error) => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, { expiresAt: now + Math.max(0, ttl), promise });
  return promise;
}

function catalogCacheKey(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

async function buildInput(options: AgentRunOptions) {
  const chunks: string[] = [];
  const promptText = options.promptParts.join(" ");
  if (options.promptParts.length > 0) {
    chunks.push(promptText);
  }
  if (options.file) {
    chunks.push(await readFile(options.file, "utf8"));
  }
  if (options.stdin || chunks.length === 0) {
    const piped = await readStdinIfAvailable();
    if (piped.trim()) chunks.push(piped);
  }
  if (chunks.length === 0) {
    throw new Error("Prompt is required. Pass text, --file, or pipe stdin.");
  }
  if (shouldUseLocalTools(options)) {
    chunks.push("Local operations are available through the `local_workdir`, `local_shell`, and `local_pause` function tools. Use `local_workdir` for local file inspection and edits. Use `local_shell` for commands, tests, builds, package managers, and git. Use `local_pause` only for bounded waits on external state such as CI, deployment rollout, rate-limit cooldown, or file sync. Do not encode local edits, commands, or waits in the final answer when a tool call is needed.");
    chunks.push(await buildWorkdirContextBlock({
      path: options.workdir || process.cwd(),
      query: options.contextQuery,
      maxFiles: options.maxContextFiles,
      maxBytes: options.maxContextBytes,
    }));
  }
  if (options.localKnowledge && promptText.trim()) {
    const context = await options.localKnowledge.contextForPrompt({
      query: promptText,
      scope: localKnowledgeScope(options),
    });
    if (context) {
      chunks.push(formatLocalKnowledgeContext(context));
    }
  }
  return chunks.join("\n\n");
}

async function prepareLocalKnowledge(options: AgentRunOptions) {
  if (!options.localKnowledge?.ingestWorkdir) return;
  if (!shouldUseLocalTools(options)) return;
  try {
    await options.localKnowledge.ingestWorkdir({
      root: options.workdir || process.cwd(),
      scope: localKnowledgeScope(options),
    });
  } catch {
    // Local knowledge is opportunistic; normal agent turns should not fail if indexing is unavailable.
  }
}

function localKnowledgeScope(options: AgentRunOptions): LocalKnowledgeScope {
  return {
    conversationId: options.conversation,
    workspaceId: options.workspaceId,
    profile: options.profile,
    workdir: options.workdir || process.cwd(),
  };
}

async function prepareLocalWorkdirTools(options: AgentRunOptions): Promise<{
  registry: LocalToolRegistryBundle;
  instructions: string;
} | null> {
  if (!shouldUseLocalTools(options)) {
    return null;
  }
  const service = await openWorkdir({ path: options.workdir || process.cwd() });
  const registry = createLocalWorkdirToolRegistry(service.workdir, {
    accessMode: localToolAccessMode(options),
  });
  const shellRegistry = createLocalShellToolRegistry({
    accessMode: localToolAccessMode(options),
    workdir: service.workdir,
    ...localShellIsolationOptions(options.shellIsolation),
  } as Parameters<typeof createLocalShellToolRegistry>[0]);
  const pauseRegistry = createLocalPauseToolRegistry({
    maxDurationMs: options.localPause?.maxDurationMs,
    onPauseStart: options.localPause?.onPauseStart,
    onPauseEnd: options.localPause?.onPauseEnd,
  });
  return {
    registry: combineLocalToolRegistries(registry, shellRegistry, pauseRegistry),
    instructions: [
      localWorkdirToolInstructions(),
      localShellToolInstructions({
        accessMode: localToolAccessMode(options),
        cwd: service.workdir.root,
        ...localShellIsolationOptions(options.shellIsolation),
      } as Parameters<typeof localShellToolInstructions>[0]),
      localPauseToolInstructions({ maxDurationMs: options.localPause?.maxDurationMs }),
      "Use local_workdir for selected local workdir operations. Prefer summarize/list/search/grep before read/read_lines. Prefer preview_edits/apply_edits for source edits. Use local_shell for command/process tasks. Use local_pause only when there is a concrete external wait. In approval mode, local actions return requires_approval and must be explained to the user instead of retried blindly.",
    ].join("\n\n"),
  };
}

async function prepareLocalContext(options: AgentRunOptions): Promise<LocalExecutionContext | null> {
  const localWorkdir = await prepareLocalWorkdirTools(options);
  const localSkills = await prepareLocalSkills(options);
  const localKnowledge = options.localKnowledge
    ? createLocalKnowledgeToolRegistry(scopedLocalKnowledgeService(options.localKnowledge, localKnowledgeScope(options)))
    : null;
  if (!localWorkdir && localSkills.length === 0 && !localKnowledge) {
    return null;
  }
  return {
    registry: combineLocalToolRegistries(
      ...(localWorkdir ? [localWorkdir.registry] : []),
      ...(localKnowledge ? [localKnowledge] : []),
    ),
    instructions: localWorkdir?.instructions,
    localSkills,
  };
}

function scopedLocalKnowledgeService(
  service: LocalKnowledgeService,
  scope: LocalKnowledgeScope,
): LocalKnowledgeService {
  return {
    ...service,
    search(params) {
      return service.search({
        ...params,
        scope: {
          ...scope,
          ...params.scope,
        },
      });
    },
    contextForPrompt(params) {
      return service.contextForPrompt({
        ...params,
        scope: {
          ...scope,
          ...params.scope,
        },
      });
    },
  };
}

async function prepareLocalSkills(options: AgentRunOptions): Promise<LocalSkillDescriptor[]> {
  const explicitPaths = (options.localSkillPaths ?? []).map((item) => item.trim()).filter(Boolean);
  const shouldDiscover = options.discoverLocalSkills !== false && shouldUseLocalTools(options);
  if (explicitPaths.length === 0 && !shouldDiscover) {
    return [];
  }
  await runtime.ensure();
  const skills: LocalSkillDescriptor[] = [];
  for (const skillPath of explicitPaths) {
    skills.push(await localSkillFromDirectory(skillPath));
  }
  if (shouldDiscover) {
    skills.push(...await runtime.skills.discover({
      roots: [options.workdir || process.cwd()],
      recursive: true,
      maxDepth: 3,
    }));
  }
  return dedupeLocalSkills(skills);
}

function dedupeLocalSkills(skills: LocalSkillDescriptor[]): LocalSkillDescriptor[] {
  const out = new Map<string, LocalSkillDescriptor>();
  for (const skill of skills) {
    const key = skill.skill_ref || `${skill.local_skill_id}:${skill.digest || skill.root_hint || ""}`;
    if (!out.has(key)) {
      out.set(key, skill);
    }
  }
  return [...out.values()];
}

function shouldUseLocalTools(options: AgentRunOptions) {
  if (options.accessMode === "off") return false;
  return Boolean(options.includeLocalContext || options.workdir || options.accessMode === "approval" || options.accessMode === "full");
}

function localToolAccessMode(options: AgentRunOptions): "approval" | "full" {
  return options.accessMode === "full" ? "full" : "approval";
}

interface LocalToolRegistryBundle {
  toolName?: string;
  definitions(): Tool[];
  execute(name: string, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<Record<string, unknown>>;
  has(name: string): boolean;
}

interface LocalExecutionContext {
  registry: LocalToolRegistryBundle;
  instructions?: string;
  localSkills: LocalSkillDescriptor[];
}

function emptyLocalToolRegistry(): LocalToolRegistryBundle {
  return {
    definitions: () => [],
    execute: async (name) => {
      throw new Error(`no local handler registered for function ${name}`);
    },
    has: () => false,
  };
}

type LocalRegistryLike = Pick<LocalToolRegistryBundle, "definitions" | "toolName"> & {
  execute(name: string, args: Record<string, unknown>, context?: unknown): Promise<Record<string, unknown>>;
  has?(name: string): boolean;
};

function combineLocalToolRegistries(...registries: LocalRegistryLike[]): LocalToolRegistryBundle {
  return {
    definitions: () => [
      ...registries.flatMap((registry) => registry.definitions()),
    ],
    execute: async (name, args, abortSignal) => {
      const registry = registries.find((item) => item.toolName === name || item.has?.(name));
      if (registry) return await registry.execute(name, args, { signal: abortSignal });
      throw new Error(`no local handler registered for function ${name}`);
    },
    has: (name) => registries.some((registry) => registry.toolName === name || registry.has?.(name)),
  };
}

async function executeLocalFunctionCalls(
  response: AgentResponse,
  registry: LocalToolRegistryBundle,
  skipCallIDs: Set<string>,
  abortSignal?: AbortSignal,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<{
  outputs: FunctionCallOutputInput[];
  approvalRequested?: LocalToolApprovalRequest;
}> {
  const outputs: FunctionCallOutputInput[] = [];
  for (const call of pendingFunctionCalls(response)) {
    // Yield before each tool call so render timers, resize/input listeners,
    // and other event-loop observers can run between tight local batches.
    await yieldToEventLoop();
    throwIfAborted(abortSignal);
    if (skipCallIDs.has(call.call_id)) {
      continue;
    }
    let args: Record<string, unknown> = {};
    let result: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {};
      if (!registry.has(call.name)) {
        throw new Error(`no local handler registered for function ${call.name}`);
      }
      onEvent?.({
        type: "local_tool.started",
        name: call.name,
        action: typeof args.action === "string" ? args.action : undefined,
        arguments: localToolDisplayArguments(call.name, args),
      });
      result = await registry.execute(call.name, args, abortSignal);
    } catch (error) {
      throwIfAborted(abortSignal);
      result = localToolExecutionErrorResult(call.name, args, error);
    }
    throwIfAborted(abortSignal);
    const action = typeof result.action === "string"
      ? result.action
      : typeof args.action === "string"
        ? args.action
        : undefined;
    if (result.requires_approval === true) {
      const approvalRequested = {
        name: call.name,
        action,
        arguments: args,
        preview: result.preview,
        callID: call.call_id,
        responseID: response.id,
      };
      onEvent?.({
        type: "local_tool.approval_requested",
        ...approvalRequested,
      });
      return { outputs, approvalRequested };
    }
    outputs.push(functionCallOutputInput(call.call_id, result));
    onEvent?.({
      type: "local_tool.completed",
      name: call.name,
      action,
      arguments: localToolDisplayArguments(call.name, args),
      result: localToolDisplayResult(call.name, result),
      requiresApproval: false,
    });
  }
  return { outputs };
}

async function executeLocalSkillCalls(
  response: AgentResponse,
  localSkills: LocalSkillDescriptor[],
  abortSignal?: AbortSignal,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<FunctionCallOutputInput[]> {
  if (localSkills.length === 0 || pendingLocalSkillCalls(response).length === 0) {
    return [];
  }
  throwIfAborted(abortSignal);
  const outputs = await runLocalSkillHandlers(response, localSkills);
  for (const call of pendingLocalSkillCalls(response)) {
    onEvent?.({
      type: "local_tool.completed",
      name: call.name,
      action: "focus",
      requiresApproval: false,
    });
  }
  return outputs;
}

export function localToolExecutionErrorResult(
  toolName: string,
  args: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> {
  return {
    ok: false,
    tool: toolName,
    action: typeof args.action === "string" ? args.action : undefined,
    error: {
      message: userFacingError(error),
      name: error instanceof Error ? error.name : undefined,
      code: errorCode(error),
    },
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("Agent turn aborted.");
}

/**
 * Yields control back to the Node.js event loop by scheduling a macrotask
 * continuation via setImmediate.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function requestAbortOptions(signal?: AbortSignal): RequestOptions | undefined {
  return signal ? { signal } : undefined;
}

function localApprovalMessage(approval: { name: string; action?: string }) {
  return [
    `Local action requires approval: ${approval.name}${approval.action ? `.${approval.action}` : ""}.`,
    "Review it in the workbench, then use /apply to execute it or /reject to discard it.",
  ].join("\n");
}

async function readStdinIfAvailable(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
