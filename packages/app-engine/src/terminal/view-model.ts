import type { ActivityLevel, RenderMode, WorkbenchMessage } from "../workbench/state.js";

export type TranscriptLine = {
  anchor?: boolean;
  id: string;
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
  spans?: TranscriptSpan[];
};

export type TranscriptSpan = {
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
};

export interface TranscriptViewModel {
  endLine: number;
  lines: TranscriptLine[];
  scrollPercent: number;
  startLine: number;
  totalLines: number;
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
  const visibleLines = lines.slice(start, start + input.viewportHeight).map((line, index) => ({
    ...line,
    anchor: offset > 0 && index === 0,
  }));
  const endLine = visibleLines.length ? start + visibleLines.length : 0;
  const scrollPercent = maxOffset === 0 ? 100 : Math.round(((maxOffset - offset) / maxOffset) * 100);
  return {
    endLine,
    lines,
    scrollPercent,
    startLine: visibleLines.length ? start + 1 : 0,
    totalLines: lines.length,
    visibleLines,
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

export function activityColor(level: ActivityLevel) {
  if (level === "success") return "green";
  if (level === "warning") return "yellow";
  if (level === "error") return "red";
  return "gray";
}

function rawTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  return source.flatMap((line) => wrapTranscriptText(normalizeTerminalText(line), width).map((text) => ({ text })));
}

function markdownTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  const lines: Omit<TranscriptLine, "id">[] = [];
  let inCode = false;
  for (const rawSourceLine of source) {
    const sourceLine = normalizeTerminalText(rawSourceLine);
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
  if (bullet) return wrapMarkdownInline(`${bullet[1]}• ${bullet[2]}`, options.width);
  const numbered = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
  if (numbered) return wrapMarkdownInline(`${numbered[1]}${numbered[2]} ${numbered[3]}`, options.width);
  const quote = /^\s*>\s?(.+)$/.exec(line);
  if (quote) return wrapMarkdownInline(`│ ${quote[1]}`, options.width).map((item) => ({ ...item, color: "gray" }));
  return wrapMarkdownInline(line, options.width);
}

function wrapMarkdownInline(text: string, width: number): Omit<TranscriptLine, "id">[] {
  return wrapTranscriptSpans(markdownInlineSpans(text), width);
}

function markdownInlineSpans(text: string): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  const pattern = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, index) });
    }
    if (match[2]) {
      spans.push({ text: match[2], bold: true });
    } else if (match[4]) {
      spans.push({ text: match[4], color: "cyan" });
      if (match[5]) spans.push({ text: ` (${match[5]})`, color: "gray" });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex) });
  }
  return spans.length > 0 ? spans : [{ text }];
}

function wrapTranscriptSpans(spans: TranscriptSpan[], width: number): Omit<TranscriptLine, "id">[] {
  const text = spans.map((span) => span.text).join("");
  const wrapped = wrapTranscriptText(text, width, { trimStart: false });
  const lines: Omit<TranscriptLine, "id">[] = [];
  let offset = 0;
  for (const line of wrapped) {
    const lineSpans = sliceSpans(spans, offset, line.length);
    offset += line.length;
    while (text[offset] === " ") offset += 1;
    lines.push({
      text: line,
      spans: lineSpans.length > 0 ? lineSpans : undefined,
    });
  }
  return lines;
}

function sliceSpans(spans: TranscriptSpan[], offset: number, length: number): TranscriptSpan[] {
  const output: TranscriptSpan[] = [];
  let position = 0;
  let remaining = length;
  for (const span of spans) {
    if (remaining <= 0) break;
    const spanEnd = position + span.text.length;
    if (spanEnd <= offset) {
      position = spanEnd;
      continue;
    }
    if (position >= offset + length) break;
    const start = Math.max(0, offset - position);
    const end = Math.min(span.text.length, start + remaining);
    const text = span.text.slice(start, end);
    if (text) {
      output.push({ ...span, text });
      remaining -= text.length;
    }
    position = spanEnd;
  }
  return output;
}

function wrapTranscriptText(text: string, width: number, options: { trimStart?: boolean } = {}): string[] {
  const max = Math.max(12, width);
  if (text.length === 0) return [""];
  if (displayWidth(text) <= max) return [text];
  const lines: string[] = [];
  let rest = text;
  while (displayWidth(rest) > max) {
    const hard = takeColumns(rest, max);
    const softBreak = Math.max(hard.text.lastIndexOf(" "), hard.text.lastIndexOf("\t"));
    const soft = softBreak > 0 ? hard.text.slice(0, softBreak) : "";
    const useSoftBreak = soft && displayWidth(soft) > Math.floor(max * 0.45);
    const chunk = useSoftBreak ? soft : hard.text;
    const index = useSoftBreak ? softBreak : hard.length;
    lines.push(chunk.trimEnd());
    rest = options.trimStart === false ? rest.slice(index) : rest.slice(index).trimStart();
  }
  lines.push(rest);
  return lines;
}

function takeColumns(text: string, maxColumns: number): { length: number; text: string } {
  let length = 0;
  let output = "";
  let columns = 0;
  for (const char of Array.from(text)) {
    const width = charWidth(char);
    if (output && columns + width > maxColumns) break;
    output += char;
    length += char.length;
    columns += width;
    if (columns >= maxColumns) break;
  }
  return { length, text: output };
}

function displayWidth(text: string) {
  let width = 0;
  for (const char of Array.from(text)) {
    width += charWidth(char);
  }
  return width;
}

function charWidth(char: string) {
  if (!char) return 0;
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (char === "\t") return 4;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (/^\p{Mark}$/u.test(char)) return 0;
  return isWideCodePoint(code) ? 2 : 1;
}

function normalizeTerminalText(text: string) {
  let output = "";
  for (const char of Array.from(text)) {
    if (char === "\t") {
      output += "    ";
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    output += char;
  }
  return output;
}

function isWideCodePoint(code: number) {
  return (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  );
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
