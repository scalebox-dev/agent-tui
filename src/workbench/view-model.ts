import type { RenderMode, WorkbenchMessage } from "../tui/workbench.js";

export type TranscriptLine = {
  id: string;
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
};

export interface TranscriptViewModel {
  lines: TranscriptLine[];
  visibleLines: TranscriptLine[];
  maxOffset: number;
  offset: number;
  viewportHeight: number;
}

export function buildTranscriptViewModel(input: {
  activeAssistantMessageId: string | null;
  busy: boolean;
  messages: WorkbenchMessage[];
  offset: number;
  renderMode: RenderMode;
  spinnerFrame: number;
  viewportHeight: number;
  width: number;
}): TranscriptViewModel {
  const lines = buildTranscriptLines(input.messages, {
    activeAssistantMessageId: input.activeAssistantMessageId,
    busy: input.busy,
    renderMode: input.renderMode,
    spinnerFrame: input.spinnerFrame,
    width: input.width,
  });
  const maxOffset = Math.max(0, lines.length - input.viewportHeight);
  const offset = Math.min(input.offset, maxOffset);
  const start = Math.max(0, lines.length - input.viewportHeight - offset);
  return {
    lines,
    visibleLines: lines.slice(start, start + input.viewportHeight),
    maxOffset,
    offset,
    viewportHeight: input.viewportHeight,
  };
}

export function buildTranscriptLines(
  messages: WorkbenchMessage[],
  options: {
    activeAssistantMessageId: string | null;
    busy: boolean;
    renderMode: RenderMode;
    spinnerFrame: number;
    width: number;
  },
) {
  const lines: TranscriptLine[] = [];
  for (const message of messages) {
    const waiting = message.role === "assistant" && options.busy && message.id === options.activeAssistantMessageId && !message.text;
    lines.push({
      id: `${message.id}:role`,
      text: roleLabel(message.role),
      color: roleColor(message.role),
    });
    const content = message.text || (waiting ? `${spinnerGlyph(options.spinnerFrame)} thinking ${elapsedDots(options.spinnerFrame)}` : "");
    const rendered = options.renderMode === "raw"
      ? rawTranscriptLines(content, options.width)
      : markdownTranscriptLines(content, options.width);
    rendered.forEach((line, index) => {
      lines.push({
        ...line,
        id: `${message.id}:line:${index}`,
      });
    });
    if (message.role !== "system") {
      lines.push({ id: `${message.id}:space`, text: "" });
    }
  }
  return lines;
}

export function spinnerGlyph(frame: number) {
  return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame % 10];
}

export function elapsedDots(frame: number) {
  return ".".repeat((Math.floor(frame / 4) % 3) + 1);
}

function rawTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  return source.flatMap((line) => wrapTranscriptText(line, width).map((text) => ({ text })));
}

function markdownTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  const lines: Omit<TranscriptLine, "id">[] = [];
  let inCode = false;
  for (const sourceLine of source) {
    if (/^\s*```/.test(sourceLine)) {
      inCode = !inCode;
      lines.push(...wrapTranscriptText(sourceLine, width).map((line) => ({ text: line, color: "gray" })));
      continue;
    }
    lines.push(...markdownTranscriptLine(sourceLine, { code: inCode, width }));
  }
  return lines;
}

function markdownTranscriptLine(line: string, options: { code: boolean; width: number }): Omit<TranscriptLine, "id">[] {
  if (line === "") return [{ text: "" }];
  if (options.code) return wrapTranscriptText(line, options.width).map((text) => ({ text, color: "gray" }));
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const color = heading[1].length <= 2 ? "cyan" : "blue";
    return wrapTranscriptText(heading[2], options.width).map((text) => ({ text, bold: true, color }));
  }
  if (/^\s*---+\s*$/.test(line)) return [{ text: "─".repeat(Math.min(48, options.width)), color: "gray" }];
  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);
  if (bullet) return wrapTranscriptText(`${bullet[1]}• ${bullet[2]}`, options.width).map((text) => ({ text }));
  const numbered = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
  if (numbered) return wrapTranscriptText(`${numbered[1]}${numbered[2]} ${numbered[3]}`, options.width).map((text) => ({ text }));
  const quote = /^\s*>\s?(.+)$/.exec(line);
  if (quote) return wrapTranscriptText(`│ ${quote[1]}`, options.width).map((text) => ({ text, color: "gray" }));
  return wrapTranscriptText(line, options.width).map((text) => ({ text }));
}

function wrapTranscriptText(text: string, width: number): string[] {
  const max = Math.max(12, width);
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const hard = rest.slice(0, max);
    const softBreak = Math.max(hard.lastIndexOf(" "), hard.lastIndexOf("\t"));
    const index = softBreak > Math.floor(max * 0.45) ? softBreak : max;
    lines.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  lines.push(rest);
  return lines;
}

function roleLabel(role: WorkbenchMessage["role"]) {
  if (role === "user") return "You";
  if (role === "assistant") return "Agent";
  return "System";
}

function roleColor(role: WorkbenchMessage["role"]) {
  if (role === "user") return "green";
  if (role === "assistant") return "cyan";
  return "gray";
}
