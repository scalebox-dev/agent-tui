import type { WorkbenchTerminalMouseEvent } from "@agent-api/app-engine/terminal";

export const enableMouseReporting = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const disableMouseReporting = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export function parseMouseEvent(input: string): WorkbenchTerminalMouseEvent | null {
  const match = /\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(input);
  if (!match) return null;
  const code = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (!Number.isFinite(code) || !Number.isFinite(column) || !Number.isFinite(row)) return null;
  if (code === 64) return { button: "wheel_up", column, kind: "wheel", row };
  if (code === 65) return { button: "wheel_down", column, kind: "wheel", row };
  if ((code & 32) === 32) {
    return {
      button: (code & 3) === 0 ? "left" : "unknown",
      column,
      kind: "motion",
      row,
    };
  }
  return {
    button: (code & 3) === 0 ? "left" : "unknown",
    column,
    kind: match[4] === "m" ? "release" : "press",
    row,
  };
}
