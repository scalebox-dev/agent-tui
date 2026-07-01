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
      for (let start = 0; start < line.length; start += width) {
        const text = line.slice(start, start + width);
        segments.push({ text, start: offset + start, end: offset + start + text.length });
      }
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
  const column = cursor - current.start;
  return Math.min(next.start + column, next.end);
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
