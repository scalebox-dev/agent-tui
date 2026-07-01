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
import type { WorkbenchEngine, WorkbenchRuntimeEffect } from "./engine.js";
import type { WorkbenchAction, WorkbenchState } from "./state.js";

export interface WorkbenchTurnController {
  startPrompt(prompt: string): Promise<void>;
  continueAfterLocalApproval(input: {
    approval: LocalToolApprovalRequest;
    result: string | Record<string, unknown>;
    accessMode: WorkdirAccessMode;
  }): Promise<void>;
  continueAfterAutomaticContinuation(input: {
    continuation: AutomaticContinuationState;
    bypassAutomaticContinuationLimit: boolean;
  }): Promise<void>;
  abort(reason: string): Promise<void>;
  resumeTimedPause(message?: string): boolean;
}

export interface WorkbenchTurnControllerOptions {
  engine: WorkbenchEngine;
  baseOptions: AgentRunOptions;
  dispatch(action: WorkbenchAction): void;
  getState(): WorkbenchState;
  runRuntimeEffects(effects: WorkbenchRuntimeEffect[], assistantId: string): void;
  flushTextDeltaBuffer(): void;
  runAgentTurnImpl?: typeof runAgentTurn;
  resumeAgentAfterLocalApprovalImpl?: typeof resumeAgentAfterLocalApproval;
  resumeAgentAfterAutomaticContinuationImpl?: typeof resumeAgentAfterAutomaticContinuation;
  resolveRuntimeProfileImpl?: typeof resolveRuntimeProfile;
}

export function createWorkbenchTurnController(options: WorkbenchTurnControllerOptions): WorkbenchTurnController {
  const runAgentTurnImpl = options.runAgentTurnImpl ?? runAgentTurn;
  const resumeAgentAfterLocalApprovalImpl = options.resumeAgentAfterLocalApprovalImpl ?? resumeAgentAfterLocalApproval;
  const resumeAgentAfterAutomaticContinuationImpl = options.resumeAgentAfterAutomaticContinuationImpl ?? resumeAgentAfterAutomaticContinuation;
  const resolveRuntimeProfileImpl = options.resolveRuntimeProfileImpl ?? resolveRuntimeProfile;
  let activeAbortController: AbortController | null = null;
  let activeLocalPause: LocalPauseHandle | null = null;
  let activeResponseID: string | null = null;
  const cancelledResponseIDs = new Set<string>();

  return {
    async startPrompt(prompt) {
      const state = options.getState();
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      activeAbortController = abortController;
      activeResponseID = null;
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "message.add", role: "user", text: prompt });
      options.dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
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
            conversation: state.currentConversation,
            includeLocalContext: state.contextEnabled,
            accessMode: state.accessMode,
            discoverLocalSkills: state.localSkillsEnabled,
            memory: memoryOptions(state),
            skillTool: state.workspaceSkillsEnabled ? { tenant_search: true } : undefined,
            shellIsolation: state.shellIsolation,
            automaticContinuationLimit: effectiveAutomaticContinuationLimit(state),
            restartConversation: false,
            abortSignal: abortController.signal,
            localPause: localPauseHooks(),
          },
          (event) => handleAgentEvent(event, assistantId),
        );
        options.dispatch({
          type: "activity.add",
          level: result.paused ? "warning" : "success",
          text: result.responseID
            ? `Agent turn ${result.paused ? "paused" : "completed"}: ${result.responseID}`
            : `Agent turn ${result.paused ? "paused" : "completed"}`,
        });
      } catch (error) {
        handleTurnError(error);
      } finally {
        finishTurn(abortController);
      }
    },

    async continueAfterLocalApproval(input) {
      const state = options.getState();
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      activeAbortController = abortController;
      activeResponseID = null;
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
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
            conversation: state.currentConversation,
            includeLocalContext: state.contextEnabled,
            accessMode: input.accessMode,
            discoverLocalSkills: state.localSkillsEnabled,
            memory: memoryOptions(state),
            skillTool: state.workspaceSkillsEnabled ? { tenant_search: true } : undefined,
            shellIsolation: state.shellIsolation,
            automaticContinuationLimit: effectiveAutomaticContinuationLimit(state),
            restartConversation: false,
            abortSignal: abortController.signal,
            localPause: localPauseHooks(),
          },
          input.approval,
          input.result,
          (event) => handleAgentEvent(event, assistantId),
        );
        options.dispatch({
          type: "activity.add",
          level: continuation.paused ? "warning" : "success",
          text: continuation.responseID
            ? `Agent turn ${continuation.paused ? "paused" : "continued"}: ${continuation.responseID}`
            : `Agent turn ${continuation.paused ? "paused" : "continued"}`,
        });
      } catch (error) {
        handleTurnError(error);
      } finally {
        finishTurn(abortController);
      }
    },

    async continueAfterAutomaticContinuation(input) {
      const state = options.getState();
      const assistantId = `assistant-${Date.now()}`;
      const abortController = new AbortController();
      activeAbortController = abortController;
      activeResponseID = null;
      options.dispatch({ type: "busy.set", busy: true });
      options.dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
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
            conversation: state.currentConversation,
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
            localPause: localPauseHooks(),
          },
          input.continuation,
          (event) => handleAgentEvent(event, assistantId),
        );
        options.dispatch({
          type: "activity.add",
          level: continuation.paused ? "warning" : "success",
          text: continuation.responseID
            ? `Automatic workflow ${continuation.paused ? "paused" : "continued"}: ${continuation.responseID}`
            : `Automatic workflow ${continuation.paused ? "paused" : "continued"}`,
        });
      } catch (error) {
        handleTurnError(error);
      } finally {
        finishTurn(abortController);
      }
    },

    async abort(reason) {
      const state = options.getState();
      if (!state.busy && !activeAbortController && !activeResponseID) {
        options.dispatch({ type: "message.add", role: "system", text: "No agent turn is running." });
        return;
      }
      activeAbortController?.abort();
      options.dispatch({ type: "activity.add", level: "warning", text: reason });
      if (!activeResponseID) {
        options.dispatch({ type: "message.add", role: "system", text: "Abort requested. No remote response ID is available yet." });
        return;
      }
      if (cancelledResponseIDs.has(activeResponseID)) return;
      const responseID = activeResponseID;
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

    resumeTimedPause(message) {
      if (!activeLocalPause) return false;
      activeLocalPause.resume(message);
      return true;
    },
  };

  function handleAgentEvent(event: AgentTurnEvent, assistantId: string) {
    const result = options.engine.handleAgentEvent(event);
    for (const effect of result.effects) {
      if (effect.type === "set_active_response_id") {
        activeResponseID = effect.responseID;
      }
    }
    options.runRuntimeEffects(result.effects, assistantId);
  }

  function finishTurn(abortController: AbortController) {
    options.flushTextDeltaBuffer();
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    activeLocalPause = null;
    activeResponseID = null;
    options.dispatch({ type: "busy.set", busy: false });
    options.dispatch({ type: "assistant.active", id: null });
  }

  function localPauseHooks(): NonNullable<AgentRunOptions["localPause"]> {
    return {
      onPauseStart(handle) {
        activeLocalPause = handle;
        options.dispatch({
          type: "activity.add",
          level: "warning",
          text: `Local pause started: ${handle.request.durationMs}ms`,
        });
      },
      onPauseEnd(result) {
        activeLocalPause = null;
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

  function handleTurnError(error: unknown) {
    const message = userFacingError(error);
    const aborted = /aborted/i.test(message);
    options.dispatch({
      type: "message.add",
      role: "system",
      text: aborted ? "Agent turn aborted." : message,
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

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
