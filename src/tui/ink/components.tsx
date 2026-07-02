import React from "react";
import { Box, Text } from "ink";
import {
  activityColor,
  busySpinner,
  type TranscriptLine,
  type WorkbenchPanelPosition,
  type WorkbenchPanelSelection,
  type WorkbenchRenderModel,
} from "@agent-api/app-engine/terminal";
import {
  authMethods,
  type AuthGateState,
  type RenderMode,
} from "@agent-api/app-engine/workbench";

export function InkWorkbenchScreen({
  activityCursor,
  activitySelection,
  focusedPanel,
  headerCursor,
  headerSelection,
  renderModel,
  spinnerFrame,
  transcriptCursor,
  transcriptSelection,
}: {
  activityCursor: WorkbenchPanelPosition;
  activitySelection: WorkbenchPanelSelection | null;
  focusedPanel: "activity" | "header" | "input" | "transcript";
  headerCursor: WorkbenchPanelPosition;
  headerSelection: WorkbenchPanelSelection | null;
  renderModel: WorkbenchRenderModel;
  spinnerFrame: number;
  transcriptCursor: WorkbenchPanelPosition;
  transcriptSelection: WorkbenchPanelSelection | null;
}) {
  const activity = (
    <Box
      borderColor={panelBorderColor(focusedPanel === "activity")}
      borderStyle="round"
      flexDirection="column"
      height={renderModel.activityHeight}
      marginLeft={renderModel.layout === "wide" ? 1 : 0}
      paddingX={1}
      width={renderModel.layout === "wide" ? "27%" : "100%"}
    >
      <Text bold color={focusedPanel === "activity" ? "cyan" : undefined} wrap="truncate">Activity</Text>
      {renderModel.visibleActivities.map((activity, index) => {
        const cursor = focusedPanel === "activity" && index === activityCursor.line;
        const text = `${new Date(activity.timestamp).toLocaleTimeString()} ${activity.text}`;
        return (
          <Text color={activityColor(activity.level)} key={activity.id} wrap="truncate">
            {cursor ? <Text color="cyan">› </Text> : <Text>  </Text>}
            <SelectableText
              cursorColumn={cursor && !activitySelection ? activityCursor.column : null}
              selection={lineSelection(index, activitySelection)}
              text={text || " "}
            />
          </Text>
        );
      })}
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Header
        focused={focusedPanel === "header"}
        cursor={headerCursor}
        selection={headerSelection}
        contextEnabled={renderModel.header.contextEnabled}
        conversation={renderModel.header.conversation}
        conversationId={renderModel.header.conversationId}
        conversationPreviousResponseId={renderModel.header.conversationPreviousResponseId}
        conversationStatus={renderModel.header.conversationStatus}
        lines={renderModel.header.lines}
        model={renderModel.header.model}
        accessMode={renderModel.header.accessMode}
        pendingLocalLabel={renderModel.header.pendingLocalLabel}
        preset={renderModel.header.preset}
        profile={renderModel.header.profile}
        renderMode={renderModel.header.renderMode}
        workdir={renderModel.header.workdir}
      />
      <Box height={renderModel.viewportHeight} flexDirection={renderModel.layout === "wide" ? "row" : "column"}>
        <Box
          borderStyle="round"
          borderColor={panelBorderColor(focusedPanel === "transcript")}
          flexDirection="column"
          height={renderModel.transcript.viewportHeight + 2}
          paddingX={1}
          width={renderModel.layout === "wide" ? "72%" : "100%"}
        >
          {renderModel.transcript.visibleLines.map((line, index) => (
            <TranscriptText
              cursorColumn={focusedPanel === "transcript" && renderModel.transcript.startLine + index - 1 === transcriptCursor.line && !transcriptSelection
                ? transcriptCursor.column
                : null}
              key={line.id}
              line={line}
              lineSelection={lineSelection(renderModel.transcript.startLine + index - 1, transcriptSelection)}
              lineCursor={focusedPanel === "transcript" && renderModel.transcript.startLine + index - 1 === transcriptCursor.line}
            />
          ))}
          {renderModel.transcript.visibleLines.length === 0 && <Text color="gray">No transcript lines.</Text>}
        </Box>
        {activity}
      </Box>
      <Box borderStyle="round" borderColor={panelBorderColor(focusedPanel === "input")} paddingX={1} flexDirection="column">
        <Box>
          {renderModel.input.fullAccess && (
            <Text color="red" bold inverse>
              FULL ACCESS
            </Text>
          )}
          {renderModel.input.fullAccess && <Text> </Text>}
          <Text color={renderModel.input.busy ? "yellow" : "green"}>{renderModel.input.label}</Text>
          {renderModel.input.statusText && (
            <Text color="yellow">  {busySpinner(spinnerFrame)} {renderModel.input.statusText}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          {renderModel.input.lines.map((line, index) => (
            <Text key={index} wrap="truncate">
              {line.spans.map((span, spanIndex) => (
                <Text inverse={span.inverse} key={spanIndex}>
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text color="gray" wrap="truncate">{renderModel.footerText}</Text>
      </Box>
    </Box>
  );
}

function TranscriptText({
  cursorColumn,
  line,
  lineCursor,
  lineSelection,
}: {
  cursorColumn: number | null;
  line: TranscriptLine;
  lineCursor: boolean;
  lineSelection: { end: number; start: number } | null;
}) {
  const anchor = lineCursor ? <Text color="cyan">› </Text> : line.anchor ? <Text color="cyan">▸ </Text> : <Text>  </Text>;
  if (!line.spans || line.spans.length === 0) {
    return (
      <Text bold={line.bold || lineCursor} color={line.color} inverse={line.inverse} wrap="truncate">
        {anchor}
        <SelectableText
          cursorColumn={cursorColumn}
          selection={lineSelection}
          text={line.text || " "}
        />
      </Text>
    );
  }
  return (
    <Text bold={line.bold || lineCursor} color={line.color} inverse={line.inverse} wrap="truncate">
      {anchor}
      {line.spans.map((span, index) => {
        const offset = line.spans?.slice(0, index).reduce((sum, item) => sum + item.text.length, 0) ?? 0;
        return (
          <SelectableText
            bold={span.bold}
            color={span.color}
            cursorColumn={cursorColumn}
            key={index}
            lineLength={line.text.length}
            offset={offset}
            selection={lineSelection}
            text={span.text}
          />
        );
      })}
    </Text>
  );
}

function SelectableText({
  bold,
  color,
  cursorColumn,
  lineLength,
  offset = 0,
  selection,
  text,
}: {
  bold?: boolean;
  color?: string;
  cursorColumn: number | null;
  lineLength?: number;
  offset?: number;
  selection: { end: number; start: number } | null;
  text: string;
}) {
  const pieces = selectablePieces(text, { cursorColumn, lineLength: lineLength ?? text.length, offset, selection });
  return (
    <>
      {pieces.map((piece, index) => (
        <Text bold={bold} color={color} inverse={piece.inverse} key={index}>
          {piece.text}
        </Text>
      ))}
    </>
  );
}

function lineSelection(line: number, selection: WorkbenchPanelSelection | null) {
  if (!selection || line < selection.start.line || line > selection.end.line) return null;
  if (selection.start.line === selection.end.line) {
    return selection.start.column === selection.end.column
      ? null
      : { start: selection.start.column, end: selection.end.column };
  }
  if (line === selection.start.line) return { start: selection.start.column, end: Number.POSITIVE_INFINITY };
  if (line === selection.end.line) return { start: 0, end: selection.end.column };
  return { start: 0, end: Number.POSITIVE_INFINITY };
}

function selectablePieces(
  text: string,
  options: {
    cursorColumn: number | null;
    lineLength: number;
    offset: number;
    selection: { end: number; start: number } | null;
  },
) {
  const textLength = text.length;
  const selection = options.selection
    ? {
      start: clamp(options.selection.start - options.offset, 0, textLength),
      end: clamp(options.selection.end - options.offset, 0, textLength),
    }
    : null;
  const segmentEnd = options.offset + textLength;
  const cursorInSegment = options.cursorColumn != null
    && options.cursorColumn >= options.offset
    && (
      options.cursorColumn < segmentEnd
      || (options.cursorColumn === options.lineLength && segmentEnd === options.lineLength)
    );
  const cursor = cursorInSegment ? clamp((options.cursorColumn ?? 0) - options.offset, 0, textLength) : null;
  const boundaries = new Set([0, textLength]);
  if (selection && selection.start !== selection.end) {
    boundaries.add(selection.start);
    boundaries.add(selection.end);
  }
  if (cursor !== null) {
    boundaries.add(cursor);
    boundaries.add(Math.min(textLength, cursor + 1));
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const pieces: { inverse?: boolean; text: string }[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index] ?? 0;
    const end = sorted[index + 1] ?? start;
    if (end <= start) continue;
    const selected = Boolean(selection && start >= selection.start && end <= selection.end);
    const cursorAtPiece = cursor !== null && start >= cursor && start < cursor + 1;
    pieces.push({ text: text.slice(start, end), inverse: selected || cursorAtPiece });
  }
  if (cursor === textLength) pieces.push({ text: " ", inverse: true });
  return pieces.length ? pieces : [{ text }];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function InkAuthGate({ cursorVisible, state }: { cursorVisible: boolean; state: AuthGateState }) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold>Agent API Workbench</Text>
        <Text color="gray">Authentication required before starting the conversation UI.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={state.error ? "red" : "gray"}>{state.error || state.message}</Text>
        {state.status === "checking" && <Text color="yellow">Checking...</Text>}
        {state.status === "select" && (
          <Box flexDirection="column" marginTop={1}>
            {authMethods.map((method, index) => (
              <Text color={index === state.selectedMethod ? "green" : "gray"} key={method.method}>
                {index === state.selectedMethod ? "›" : " "} {method.label} - {method.description}
              </Text>
            ))}
            <Text color="gray">Use ↑/↓ and Enter.</Text>
          </Box>
        )}
        {state.status === "api_profile" && <AuthPrompt cursorVisible={cursorVisible} label="Profile" value={state.profile} />}
        {state.status === "api_base_url" && <AuthPrompt cursorVisible={cursorVisible} label="Base URL" value={state.baseURL} />}
        {state.status === "api_key" && <AuthPrompt cursorVisible={cursorVisible} label="API key" value={state.apiKey ? "•".repeat(Math.min(state.apiKey.length, 32)) : ""} />}
        {state.status === "browser_profile" && <AuthPrompt cursorVisible={cursorVisible} label="Profile" value={state.profile} />}
        {state.status === "browser_base_url" && <AuthPrompt cursorVisible={cursorVisible} label="Base URL" value={state.baseURL} />}
        {state.status === "browser_waiting" && (
          <Box flexDirection="column" marginTop={1}>
            {state.browserURL && <Text>URL: {state.browserURL}</Text>}
            {state.browserCode && <Text>Code: {state.browserCode}</Text>}
            <Text color="yellow">Waiting for browser approval...</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AuthPrompt({ cursorVisible, label, value }: { cursorVisible: boolean; label: string; value: string }) {
  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} marginTop={1}>
      <Text color="green">{label}: </Text>
      <Text>
        {value}
        <Cursor visible={cursorVisible} />
      </Text>
    </Box>
  );
}

function Header({
  cursor,
  focused,
  selection,
  contextEnabled,
  conversation,
  conversationId,
  conversationPreviousResponseId,
  conversationStatus,
  lines,
  accessMode,
  model,
  pendingLocalLabel,
  preset,
  profile,
  renderMode,
  workdir,
}: {
  cursor: WorkbenchPanelPosition;
  focused: boolean;
  selection: WorkbenchPanelSelection | null;
  contextEnabled: boolean;
  conversation: string;
  conversationId: string;
  conversationPreviousResponseId: string;
  conversationStatus: "fresh" | "continued" | "unknown";
  lines: string[];
  accessMode: string;
  model: string;
  pendingLocalLabel: string;
  preset: string;
  profile: string;
  renderMode: RenderMode;
  workdir: string;
}) {
  const renderedLines = [
    { bold: true, text: lines[0] ?? "Agent API Workbench" },
    { color: "gray", text: lines[1] ?? `profile=${profile} conversation=${conversation} id=${conversationId} preset=${preset} model=${model}` },
    {
      color: conversationStatus === "continued" ? "yellow" : conversationStatus === "fresh" ? "green" : "gray",
      text: lines[2] ?? `conversation_state=${conversationStatus}${conversationPreviousResponseId ? ` previous=${conversationPreviousResponseId}` : ""}`,
    },
    { color: "gray", text: lines[3] ?? `workdir=${workdir} access=${accessMode} local_tools=${contextEnabled ? "on" : "off"} render=${renderMode} pending=${pendingLocalLabel}` },
  ];
  return (
    <Box borderStyle="round" borderColor={panelBorderColor(focused)} paddingX={1} flexDirection="column">
      {renderedLines.map((line, index) => (
        <Text bold={line.bold || (focused && index === cursor.line)} color={focused && index === 0 ? "cyan" : line.color} key={index} wrap="truncate">
          {focused && index === cursor.line ? <Text color="cyan">› </Text> : <Text>  </Text>}
          <SelectableText
            bold={line.bold}
            color={line.color}
            cursorColumn={focused && index === cursor.line && !selection ? cursor.column : null}
            selection={lineSelection(index, selection)}
            text={line.text}
          />
        </Text>
      ))}
    </Box>
  );
}

function panelBorderColor(focused: boolean) {
  return focused ? "cyan" : "gray";
}

function Cursor({ text = " ", visible }: { text?: string; visible: boolean }) {
  return visible ? <Text inverse>{text}</Text> : <Text>{text}</Text>;
}
