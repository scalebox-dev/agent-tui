import type { WorkbenchAction } from "./state.js";
import type { WorkbenchRunContext, WorkbenchRuntimeEffect } from "./engine.js";
import { approximateStringBytes, logDiagnostic } from "../diagnostics.js";

export interface WorkbenchRuntimeController {
  dispose(): void;
  flushTextDeltaBuffer(): void;
  runEffects(effects: WorkbenchRuntimeEffect[], assistantId: string, runContext?: WorkbenchRunContext): void;
}

export interface WorkbenchRuntimeControllerOptions {
  dispatch(action: WorkbenchAction): void;
  flushDelayMs?: number;
}

export function createWorkbenchRuntimeController(options: WorkbenchRuntimeControllerOptions): WorkbenchRuntimeController {
  let textDeltaBuffer: { id: string; text: string; conversationId?: string } | null = null;
  let textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const startedMessageIds = new Set<string>();
  const flushDelayMs = options.flushDelayMs ?? 80;

  return {
    dispose() {
      if (textDeltaFlushTimer) {
        clearTimeout(textDeltaFlushTimer);
        textDeltaFlushTimer = null;
      }
      textDeltaBuffer = null;
      startedMessageIds.clear();
    },

    flushTextDeltaBuffer,

    runEffects(effects, assistantId, runContext) {
      for (const effect of effects) {
        switch (effect.type) {
          case "append_text_delta":
            appendTextDeltaBuffered(assistantId, effect.delta, runContext);
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

  function appendTextDeltaBuffered(id: string, delta: string, runContext?: WorkbenchRunContext) {
    if (!delta) return;
    if (!textDeltaBuffer || textDeltaBuffer.id !== id) {
      flushTextDeltaBuffer();
      if (!startedMessageIds.has(id)) {
        startedMessageIds.add(id);
        logDiagnostic("runtime.delta.first", {
          assistantId: id,
          conversationId: runContext?.conversationId,
          deltaBytes: approximateStringBytes(delta),
        });
        options.dispatch({ type: "message.add", id, role: "assistant", text: delta, conversationId: runContext?.conversationId });
        return;
      }
      textDeltaBuffer = { id, text: delta, conversationId: runContext?.conversationId };
    } else {
      textDeltaBuffer.text += delta;
    }
    if (textDeltaBuffer.text.length >= 32_000) {
      logDiagnostic("runtime.delta.buffer.large", {
        assistantId: id,
        conversationId: runContext?.conversationId,
        bufferedBytes: approximateStringBytes(textDeltaBuffer.text),
      });
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
    logDiagnostic("runtime.delta.flush", {
      assistantId: buffered.id,
      conversationId: buffered.conversationId,
      deltaBytes: approximateStringBytes(buffered.text),
    });
    options.dispatch({ type: "message.append", id: buffered.id, delta: buffered.text, conversationId: buffered.conversationId });
  }
}
