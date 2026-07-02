export interface TextSegment {
  end: number;
  start: number;
  text: string;
}

export function inputLineSegments(draft: string, maxColumns: number): TextSegment[] {
  if (!draft) return [{ text: "", start: 0, end: 0 }];
  const width = editorColumns(maxColumns);
  const segments: TextSegment[] = [];
  let offset = 0;
  const hardLines = draft.split("\n");
  for (let lineIndex = 0; lineIndex < hardLines.length; lineIndex += 1) {
    const line = hardLines[lineIndex] ?? "";
    if (!line) {
      segments.push({ text: "", start: offset, end: offset });
    } else {
      segments.push(...displayWidthSegments(line, offset, width));
    }
    offset += line.length;
    if (lineIndex < hardLines.length - 1) offset += 1;
  }
  return segments;
}

export function moveCursorVisualRow(draft: string, cursor: number, viewportColumns: number, delta: -1 | 1) {
  const segments = inputLineSegments(draft, viewportColumns);
  const index = findCursorSegmentIndex(segments, cursor);
  const current = segments[index];
  if (!current) return cursor;
  const next = segments[index + delta];
  if (!next) return cursor;
  const column = displayColumnAtIndex(current.text, cursor - current.start);
  return next.start + indexAtDisplayColumn(next.text, column);
}

export function moveCursorVisualLineBoundary(draft: string, cursor: number, viewportColumns: number, boundary: "start" | "end") {
  const segments = inputLineSegments(draft, viewportColumns);
  const current = segments[findCursorSegmentIndex(segments, cursor)];
  if (!current) return cursor;
  return boundary === "start" ? current.start : current.end;
}

export function findCursorSegmentIndex(segments: readonly TextSegment[], cursor: number) {
  if (segments.length === 0) return 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    if (cursor < segment.end) return index;
    if (cursor === segment.end) {
      const next = segments[index + 1];
      if (next && next.start === cursor) return index + 1;
      return index;
    }
  }
  return segments.length - 1;
}

function editorColumns(maxColumns: number) {
  return Math.max(8, Math.floor(maxColumns));
}

function displayWidthSegments(line: string, offset: number, width: number): TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;
  let column = 0;
  for (let index = 0; index < line.length;) {
    const char = codePointChar(line, index);
    const charWidth = displayWidth(char);
    if (column > 0 && column + charWidth > width) {
      const text = line.slice(start, index);
      segments.push({ text, start: offset + start, end: offset + index });
      start = index;
      column = 0;
    }
    column += charWidth;
    index += char.length;
  }
  if (start < line.length) {
    const text = line.slice(start);
    segments.push({ text, start: offset + start, end: offset + line.length });
  }
  return segments;
}

export function displayColumnAtIndex(text: string, targetIndex: number) {
  let column = 0;
  for (let index = 0; index < text.length && index < targetIndex;) {
    const char = codePointChar(text, index);
    column += displayWidth(char);
    index += char.length;
  }
  return column;
}

export function indexAtDisplayColumn(text: string, targetColumn: number) {
  let column = 0;
  let previousIndex = 0;
  for (let index = 0; index < text.length;) {
    const char = codePointChar(text, index);
    const nextColumn = column + displayWidth(char);
    if (nextColumn > targetColumn) return previousIndex;
    previousIndex = index + char.length;
    column = nextColumn;
    index += char.length;
  }
  return text.length;
}

export function displayWidth(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if (char === "\t") return 4;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function codePointChar(text: string, index: number) {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}
