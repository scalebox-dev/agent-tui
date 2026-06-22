import type { WorkbenchAction } from "../tui/workbench.js";
import type { WorkbenchRuntimeEffect } from "./engine.js";

export interface WorkbenchRuntimeController {
  dispose(): void;
  flushTextDeltaBuffer(): void;
  runEffects(effects: WorkbenchRuntimeEffect[], assistantId: string): void;
}

export interface WorkbenchRuntimeControllerOptions {
  dispatch(action: WorkbenchAction): void;
  flushDelayMs?: number;
}

export function createWorkbenchRuntimeController(options: WorkbenchRuntimeControllerOptions): WorkbenchRuntimeController {
  let textDeltaBuffer: { id: string; text: string } | null = null;
  let textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDelayMs = options.flushDelayMs ?? 80;

  return {
    dispose() {
      if (textDeltaFlushTimer) {
        clearTimeout(textDeltaFlushTimer);
        textDeltaFlushTimer = null;
      }
      textDeltaBuffer = null;
    },

    flushTextDeltaBuffer,

    runEffects(effects, assistantId) {
      for (const effect of effects) {
        switch (effect.type) {
          case "append_text_delta":
            appendTextDeltaBuffered(assistantId, effect.delta);
            break;
          case "set_active_response_id":
            break;
          case "flush_text_delta_buffer":
            flushTextDeltaBuffer();
            break;
        }
      }
    },
  };

  function appendTextDeltaBuffered(id: string, delta: string) {
    if (!delta) return;
    if (!textDeltaBuffer || textDeltaBuffer.id !== id) {
      flushTextDeltaBuffer();
      textDeltaBuffer = { id, text: delta };
    } else {
      textDeltaBuffer.text += delta;
    }
    if (textDeltaFlushTimer) return;
    textDeltaFlushTimer = setTimeout(() => {
      textDeltaFlushTimer = null;
      flushTextDeltaBuffer();
    }, flushDelayMs);
  }

  function flushTextDeltaBuffer() {
    if (textDeltaFlushTimer) {
      clearTimeout(textDeltaFlushTimer);
      textDeltaFlushTimer = null;
    }
    if (!textDeltaBuffer || !textDeltaBuffer.text) return;
    const buffered = textDeltaBuffer;
    textDeltaBuffer = null;
    options.dispatch({ type: "message.append", id: buffered.id, delta: buffered.text });
  }
}
