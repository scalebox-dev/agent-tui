import {
  createInitialWorkbenchState,
  workbenchReducer,
  type WorkbenchAction,
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
}

export function createWorkbenchEngine(options: WorkbenchEngineOptions): WorkbenchEngine {
  let state = createInitialWorkbenchState(options);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
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
    dispatch(action) {
      const next = workbenchReducer(state, action);
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
  };
}
