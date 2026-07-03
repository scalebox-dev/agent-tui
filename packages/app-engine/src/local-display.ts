export function localToolDisplayArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== "local_workdir") return args;
  const action = typeof args.action === "string" ? args.action : undefined;
  if (action === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    return {
      ...args,
      content: content ? textSummary(content) : args.content,
    };
  }
  if (action === "apply_edits" || action === "preview_edits") {
    return {
      ...args,
      edits: Array.isArray(args.edits) ? args.edits.map(displayEdit) : args.edits,
      replacement: typeof args.replacement === "string" ? textSummary(args.replacement) : args.replacement,
    };
  }
  return args;
}

export function localToolDisplayResult(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "local_shell") {
    return summarizeStringFields(result, new Set(["stdout", "stderr", "output"]));
  }
  if (toolName === "local_workdir") {
    return summarizeStringFields(result, new Set(["content", "preview", "diff"]));
  }
  return summarizeStringFields(result);
}

export function formatDisplayPreview(preview: unknown) {
  if (typeof preview === "string") return truncateText(preview);
  try {
    return truncateText(JSON.stringify(preview, null, 2));
  } catch {
    return truncateText(String(preview));
  }
}

function displayEdit(edit: unknown): unknown {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
  const record = edit as Record<string, unknown>;
  return {
    ...record,
    replacement: typeof record.replacement === "string" ? textSummary(record.replacement) : record.replacement,
  };
}

function summarizeStringFields(value: Record<string, unknown>, keys?: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === "string" && (!keys || keys.has(key)) && item.length > 2_000
      ? textSummary(item)
      : item,
  ]));
}

function textSummary(value: string) {
  return {
    object: "text_summary",
    bytes: Buffer.byteLength(value, "utf8"),
    characters: value.length,
    lines: value ? value.split(/\r\n|\r|\n/).length : 0,
    preview: truncateText(value, 600),
  };
}

function truncateText(value: string, maxLength = 4_000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...truncated ${value.length - maxLength} characters...`;
}
