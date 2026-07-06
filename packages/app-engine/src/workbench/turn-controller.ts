import {
  resolveRuntimeProfile,
} from "../profile.js";
import {
  resumeAgentAfterAutomaticContinuation,
  resumeAgentAfterLocalApproval,
  runAgentTurn,
  type AutomaticContinuationState,
  type AgentRunOptions,
  type AgentTurnEvent,
  type LocalPauseHandle,
  type LocalToolApprovalRequest,
  type WorkdirAccessMode,
} from "../agent.js";
import type { WorkbenchEngine, WorkbenchRunContext, WorkbenchRuntimeEffect } from "./engine.js";
import type { WorkbenchAction, WorkbenchState } from "./state.js";

export interface WorkbenchTurnController {
  startPrompt(prompt: string): Promise<void>;
  continueAfterLocalApproval(input: {
    approval: LocalToolApprovalRequest;
    result: string | Record<string, unknown>;
    accessMode: WorkdirAccessMode;
    sourceRunId?: string;
  }): Promise<void>;
  continueAfterAutomaticContinuation(input: {
    continuation: AutomaticContinuationState;
    bypassAutomaticContinuationLimit: boolean;
    sourceRunId?: string;
  }): Promise<void>;
  abort(reason: string, runId?: string): Promise<void>;
  resumeTimedPause(message?: string, runId?: string): boolean;
}

export interface WorkbenchTurnControllerOptions {
  engine: WorkbenchEngine;
  baseOptions: AgentRunOptions;
  dispatch(action: WorkbenchAction): void;
  getState(): WorkbenchState;
  runRuntimeEffects(effects: WorkbenchRuntimeEffect[], assistantId: string, runContext?: WorkbenchRunContext): void;
  flushTextDeltaBuffer(): void;
  runAgentTurnImpl?: typeof runAgentTurn;
  resumeAgentAfterLocalApprovalImpl?: typeof resumeAgentAfterLocalApproval;
  resumeAgentAfterAutomaticContinuationImpl?: typeof resumeAgentAfterAutomaticContinuation;
  resolveRuntimeProfileImpl?: typeof resolveRuntimeProfile;
}

interface ActiveRunHandle {
  abortController: AbortController;
  assistantId: string;
  localPause?: LocalPauseHandle | null;
  responseID?: string;
  runContext: WorkbenchRunContext;
}

export function createWorkbenchTurnController(options: WorkbenchTurnControllerOptions): WorkbenchTurnController {
  const runAgentTurnImpl = options.runAgentTurnImpl ?? runAgentTurn;
  const resumeAgentAfterLocalApprovalImpl = options.resumeAgentAfterLocalApprovalImpl ?? resumeAgentAfterLocalApproval;
  const resumeAgentAfterAutomaticContinuationImpl = options.resumeAgentAfterAutomaticContinuationImpl ?? resumeAgentAfterAutomaticContinuation;
  const resolveRuntimeProfileImpl = options.resolveRuntimeProfileImpl ?? resolveRuntimeProfile;
  const activeRuns = new Map<string, ActiveRunHandle>();
  const cancelledResponseIDs = new Set<string>();

  return {
    async startPrompt(prompt) {
      const state = options.getState();
      const runContext = runContextFromState(state, newRunId());
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "run.started", run: runSummaryFromContext(runContext, assistantId) });
      activeRuns.set(runContext.runId, {
        abortController,
        assistantId,
        runContext,
      });
      options.dispatch({ type: "message.add", role: "user", text: prompt, conversationId: runContext.conversationId });
      options.dispatch({ type: "assistant.active", id: assistantId });
      options.dispatch({ type: "activity.add", text: "Agent turn started" });
      try {
        const result = await runAgentTurnImpl(
          {
            ...options.baseOptions,
            preset: state.runPreset,
            model: state.runModel,
            promptParts: [prompt],
            stream: true,
            file: undefined,
            stdin: false,
            conversation: runContext.conversationName,
            workspaceId: runContext.workspaceId,
            workspaceName: runContext.workspaceName,
            includeLocalContext: state.contextEnabled,
            accessMode: state.accessMode,
            discoverLocalSkills: state.localSkillsEnabled,
            memory: memoryOptions(state),
            skillTool: state.workspaceSkillsEnabled ? { tenant_search: true } : undefined,
            shellIsolation: state.shellIsolation,
            automaticContinuationLimit: effectiveAutomaticContinuationLimit(state),
            restartConversation: false,
            abortSignal: abortController.signal,
            localPause: localPauseHooks(runContext.runId),
          },
          (event) => handleAgentEvent(event, assistantId, runContext),
        );
        options.dispatch({
          type: "activity.add",
          level: result.paused ? "warning" : "success",
          text: result.responseID
            ? `Agent turn ${result.paused ? "paused" : "completed"}: ${result.responseID}`
            : `Agent turn ${result.paused ? "paused" : "completed"}`,
        });
        options.dispatch({
          type: "run.status.set",
          runId: runContext.runId,
          status: result.paused ? "paused" : "completed",
          statusText: result.responseID,
        });
      } catch (error) {
        handleTurnError(error, runContext);
      } finally {
        finishTurn(abortController, runContext, assistantId);
      }
    },

    async continueAfterLocalApproval(input) {
      const state = options.getState();
      const runContext = continuationRunContext(state, input.sourceRunId, newRunId());
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "run.started", run: runSummaryFromContext(runContext, assistantId, "local approval continuation") });
      activeRuns.set(runContext.runId, {
        abortController,
        assistantId,
        runContext,
      });
      options.dispatch({ type: "assistant.active", id: assistantId });
      options.dispatch({ type: "activity.add", text: "Continuing agent turn" });
      try {
        const continuation = await resumeAgentAfterLocalApprovalImpl(
          {
            ...options.baseOptions,
            preset: state.runPreset,
            model: state.runModel,
            stream: true,
            file: undefined,
            stdin: false,
            conversation: runContext.conversationName,
            workspaceId: runContext.workspaceId,
            workspaceName: runContext.workspaceName,
            includeLocalContext: state.contextEnabled,
            accessMode: input.accessMode,
            discoverLocalSkills: state.localSkillsEnabled,
            memory: memoryOptions(state),
            skillTool: state.workspaceSkillsEnabled ? { tenant_search: true } : undefined,
            shellIsolation: state.shellIsolation,
            automaticContinuationLimit: effectiveAutomaticContinuationLimit(state),
            restartConversation: false,
            abortSignal: abortController.signal,
            localPause: localPauseHooks(runContext.runId),
          },
          input.approval,
          input.result,
          (event) => handleAgentEvent(event, assistantId, runContext),
        );
        options.dispatch({
          type: "activity.add",
          level: continuation.paused ? "warning" : "success",
          text: continuation.responseID
            ? `Agent turn ${continuation.paused ? "paused" : "continued"}: ${continuation.responseID}`
            : `Agent turn ${continuation.paused ? "paused" : "continued"}`,
        });
        options.dispatch({
          type: "run.status.set",
          runId: runContext.runId,
          status: continuation.paused ? "paused" : "completed",
          statusText: continuation.responseID,
        });
      } catch (error) {
        handleTurnError(error, runContext);
      } finally {
        finishTurn(abortController, runContext, assistantId);
      }
    },

    async continueAfterAutomaticContinuation(input) {
      const state = options.getState();
      const runContext = continuationRunContext(state, input.sourceRunId, newRunId());
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "run.started", run: runSummaryFromContext(runContext, assistantId, "automatic continuation") });
      activeRuns.set(runContext.runId, {
        abortController,
        assistantId,
        runContext,
      });
      options.dispatch({ type: "assistant.active", id: assistantId });
      options.dispatch({ type: "activity.add", text: "Continuing automatic workflow" });
      try {
        const continuation = await resumeAgentAfterAutomaticContinuationImpl(
          {
            ...options.baseOptions,
            preset: state.runPreset,
            model: state.runModel,
            stream: true,
            file: undefined,
            stdin: false,
            conversation: runContext.conversationName,
            workspaceId: runContext.workspaceId,
            workspaceName: runContext.workspaceName,
            includeLocalContext: state.contextEnabled,
            accessMode: state.accessMode,
            discoverLocalSkills: state.localSkillsEnabled,
            memory: memoryOptions(state),
            skillTool: state.workspaceSkillsEnabled ? { tenant_search: true } : undefined,
            shellIsolation: state.shellIsolation,
            automaticContinuationLimit: effectiveAutomaticContinuationLimit(state),
            restartConversation: false,
            bypassAutomaticContinuationLimit: input.bypassAutomaticContinuationLimit,
            abortSignal: abortController.signal,
            localPause: localPauseHooks(runContext.runId),
          },
          input.continuation,
          (event) => handleAgentEvent(event, assistantId, runContext),
        );
        options.dispatch({
          type: "activity.add",
          level: continuation.paused ? "warning" : "success",
          text: continuation.responseID
            ? `Automatic workflow ${continuation.paused ? "paused" : "continued"}: ${continuation.responseID}`
            : `Automatic workflow ${continuation.paused ? "paused" : "continued"}`,
        });
        options.dispatch({
          type: "run.status.set",
          runId: runContext.runId,
          status: continuation.paused ? "paused" : "completed",
          statusText: continuation.responseID,
        });
      } catch (error) {
        handleTurnError(error, runContext);
      } finally {
        finishTurn(abortController, runContext, assistantId);
      }
    },

    async abort(reason, runId) {
      const activeRun = activeRunForAbort(runId);
      if (!activeRun) {
        options.dispatch({ type: "message.add", role: "system", text: "No agent turn is running." });
        return;
      }
      activeRun.abortController.abort();
      options.dispatch({ type: "run.status.set", runId: activeRun.runContext.runId, status: "aborted", statusText: reason });
      options.dispatch({ type: "activity.add", level: "warning", text: reason });
      if (!activeRun.responseID) {
        options.dispatch({ type: "message.add", role: "system", text: "Abort requested. No remote response ID is available yet." });
        return;
      }
      if (cancelledResponseIDs.has(activeRun.responseID)) return;
      const responseID = activeRun.responseID;
      cancelledResponseIDs.add(responseID);
      try {
        const runtimeProfile = await resolveRuntimeProfileImpl(options.baseOptions.profile);
        const result = await runtimeProfile.client.responses.cancel(responseID);
        options.dispatch({
          type: "message.add",
          role: "system",
          text: result.interrupted
            ? `Abort requested for response ${responseID}.`
            : `Abort requested locally. Remote response ${responseID} was not actively interrupted.`,
        });
        options.dispatch({
          type: "activity.add",
          level: result.interrupted ? "success" : "warning",
          text: result.interrupted ? `Response cancel requested: ${responseID}` : `Response was not active: ${responseID}`,
        });
      } catch (error) {
        options.dispatch({ type: "message.add", role: "system", text: `Abort requested locally, but remote cancel failed: ${userFacingError(error)}` });
        options.dispatch({ type: "activity.add", level: "error", text: "Remote response cancel failed" });
      }
    },

    resumeTimedPause(message, runId) {
      const activeRun = activeRunForResume(runId);
      if (!activeRun?.localPause) return false;
      activeRun.localPause.resume(message);
      return true;
    },
  };

  function handleAgentEvent(event: AgentTurnEvent, assistantId: string, runContext: WorkbenchRunContext) {
    const result = options.engine.handleAgentEvent(event, runContext);
    for (const effect of result.effects) {
      if (effect.type === "set_active_response_id") {
        const activeRun = activeRuns.get(runContext.runId);
        if (activeRun) activeRun.responseID = effect.responseID;
      }
    }
    options.runRuntimeEffects(result.effects, assistantId, runContext);
  }

  function activeRunForAbort(runId?: string) {
    if (runId) return activeRuns.get(runId) ?? null;
    return latestActiveRun();
  }

  function activeRunForResume(runId?: string) {
    if (runId) return activeRuns.get(runId) ?? null;
    return [...activeRuns.values()].find((run) => run.localPause) ?? null;
  }

  function latestActiveRun() {
    return [...activeRuns.values()].at(-1) ?? null;
  }

  function finishTurn(abortController: AbortController, runContext: WorkbenchRunContext, assistantId: string) {
    options.flushTextDeltaBuffer();
    const activeRun = activeRuns.get(runContext.runId);
    if (activeRun?.abortController === abortController) {
      activeRuns.delete(runContext.runId);
    }
    if (options.getState().activeAssistantMessageId === assistantId) {
      options.dispatch({ type: "assistant.active", id: null });
    }
  }

  function localPauseHooks(runId: string): NonNullable<AgentRunOptions["localPause"]> {
    return {
      onPauseStart(handle) {
        const activeRun = activeRuns.get(runId);
        if (activeRun) activeRun.localPause = handle;
        options.dispatch({
          type: "activity.add",
          level: "warning",
          text: `Local pause started: ${handle.request.durationMs}ms`,
        });
      },
      onPauseEnd(result) {
        const activeRun = activeRuns.get(runId);
        if (activeRun) activeRun.localPause = null;
        options.dispatch({
          type: "activity.add",
          level: result.status === "cancelled" ? "warning" : "success",
          text: result.status === "cancelled"
            ? `Local pause resumed after ${result.elapsed_ms}ms`
            : `Local pause completed after ${result.elapsed_ms}ms`,
        });
      },
    };
  }

  function handleTurnError(error: unknown, runContext: WorkbenchRunContext) {
    const message = userFacingError(error);
    const aborted = /aborted/i.test(message);
    options.dispatch({
      type: "message.add",
      role: "system",
      text: aborted ? "Agent turn aborted." : message,
      conversationId: runContext.conversationId,
    });
    options.dispatch({
      type: "run.status.set",
      runId: runContext.runId,
      status: aborted ? "aborted" : "failed",
      statusText: message,
    });
    options.dispatch({
      type: "activity.add",
      level: aborted ? "warning" : "error",
      text: aborted ? "Agent turn aborted" : message,
    });
  }

  function effectiveAutomaticContinuationLimit(state: WorkbenchState) {
    if (state.automaticContinuationUnlocked) return Number.MAX_SAFE_INTEGER;
    if (options.baseOptions.automaticContinuationLimit !== undefined) {
      return options.baseOptions.automaticContinuationLimit;
    }
    if (state.automaticContinuationLimit === null) return Number.MAX_SAFE_INTEGER;
    return state.automaticContinuationLimit;
  }

  function memoryOptions(state: WorkbenchState): AgentRunOptions["memory"] {
    if (!state.memoryRead && !state.memoryWrite && !state.memoryTenantSearch) {
      return undefined;
    }
    const read = state.memoryRead || state.memoryTenantSearch;
    return {
      ...(read ? { read: true } : {}),
      ...(state.memoryWrite ? { write: true } : {}),
      ...(state.memoryTenantSearch ? { tenant_search: true } : {}),
    };
  }
}

function runContextFromState(state: WorkbenchState, runId: string): WorkbenchRunContext {
  return {
    runId,
    conversationId: state.conversationId,
    conversationName: state.currentConversation,
    workspaceId: state.currentWorkspaceId,
    workspaceName: state.currentWorkspaceName,
  };
}

function continuationRunContext(state: WorkbenchState, sourceRunId: string | undefined, runId: string): WorkbenchRunContext {
  const sourceRun = sourceRunId ? state.runs.find((run) => run.id === sourceRunId) : undefined;
  if (!sourceRun) return runContextFromState(state, runId);
  return {
    runId,
    conversationId: sourceRun.conversationId,
    conversationName: sourceRun.conversationName,
    workspaceId: sourceRun.workspaceId,
    workspaceName: sourceRun.workspaceName,
  };
}

function runSummaryFromContext(runContext: WorkbenchRunContext, assistantMessageId: string, statusText?: string) {
  return {
    id: runContext.runId,
    assistantMessageId,
    conversationId: runContext.conversationId,
    conversationName: runContext.conversationName,
    statusText,
    workspaceId: runContext.workspaceId,
    workspaceName: runContext.workspaceName,
  };
}

function newRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
