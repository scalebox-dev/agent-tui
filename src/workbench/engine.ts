import {
  createInitialWorkbenchState,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchCommand,
  type WorkbenchState,
} from "../tui/workbench.js";
import type { WorkdirAccessMode } from "../agent.js";

export interface WorkbenchEngineOptions {
  contextEnabled: boolean;
  accessMode?: WorkdirAccessMode;
  conversation?: string;
}

export interface WorkbenchEngine {
  snapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
  submit(input: string): WorkbenchSubmission;
}

export type WorkbenchSubmission =
  | { kind: "command"; command: WorkbenchCommand }
  | { kind: "prompt"; prompt: string }
  | { kind: "handled" };

export function createWorkbenchEngine(options: WorkbenchEngineOptions): WorkbenchEngine {
  let state = createInitialWorkbenchState(options);
  let pendingApprovalInvalidInputs = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const dispatch = (action: WorkbenchAction) => {
    if (action.type === "local_tool.pending.set" || action.type === "local_tool.pending.clear") {
      pendingApprovalInvalidInputs = 0;
    }
    const next = workbenchReducer(state, action);
    if (Object.is(next, state)) return;
    state = next;
    notify();
  };

  return {
    snapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    submit(input) {
      const trimmed = input.trim();
      if (!trimmed) return { kind: "handled" };
      if (state.pendingLocalTool) {
        const command = parsePendingApprovalCommand(trimmed);
        if (command) {
          pendingApprovalInvalidInputs = 0;
          return { kind: "command", command };
        }
        handleInvalidPendingApprovalInput();
        return { kind: "handled" };
      }
      const command = parseWorkbenchCommand(trimmed);
      if (command) return { kind: "command", command };
      return { kind: "prompt", prompt: trimmed };
    },
  };

  function handleInvalidPendingApprovalInput() {
    pendingApprovalInvalidInputs += 1;
    const attempts = pendingApprovalInvalidInputs;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      dispatch({
        type: "message.add",
        role: "system",
        text: "Local approval aborted after too many invalid inputs. The pending action was not executed.",
      });
      dispatch({ type: "activity.add", level: "warning", text: "Local approval aborted" });
      dispatch({ type: "local_tool.pending.clear" });
      pendingApprovalInvalidInputs = 0;
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: `Local approval is pending. Enter /apply or /yes to execute once, /apply-all or /yes-all to allow future local actions, or /reject or /no to discard. Invalid input ${attempts}/${maxAttempts}.`,
    });
    dispatch({ type: "activity.add", level: "warning", text: "Waiting for local approval command" });
  }
}
