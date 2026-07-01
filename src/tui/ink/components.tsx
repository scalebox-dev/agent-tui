import React from "react";
import { Box, Text } from "ink";
import {
  activityColor,
  busySpinner,
  type TranscriptLine,
  type WorkbenchRenderModel,
} from "@agent-api/app-engine/terminal";
import {
  authMethods,
  type AuthGateState,
  type RenderMode,
} from "@agent-api/app-engine/workbench";

export function InkWorkbenchScreen({
  renderModel,
  spinnerFrame,
}: {
  renderModel: WorkbenchRenderModel;
  spinnerFrame: number;
}) {
  const activity = (
    <Box flexDirection="column" width={renderModel.layout === "wide" ? "28%" : "100%"} height={renderModel.activityHeight} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate">Activity</Text>
      {renderModel.visibleActivities.map((activity) => (
        <Text color={activityColor(activity.level)} key={activity.id} wrap="truncate">
          {new Date(activity.timestamp).toLocaleTimeString()} {activity.text}
        </Text>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Header
        contextEnabled={renderModel.header.contextEnabled}
        conversation={renderModel.header.conversation}
        conversationId={renderModel.header.conversationId}
        conversationPreviousResponseId={renderModel.header.conversationPreviousResponseId}
        conversationStatus={renderModel.header.conversationStatus}
        model={renderModel.header.model}
        accessMode={renderModel.header.accessMode}
        pendingLocalLabel={renderModel.header.pendingLocalLabel}
        preset={renderModel.header.preset}
        profile={renderModel.header.profile}
        renderMode={renderModel.header.renderMode}
        workdir={renderModel.header.workdir}
      />
      <Box height={renderModel.viewportHeight} flexDirection={renderModel.layout === "wide" ? "row" : "column"}>
        <Box flexDirection="column" width={renderModel.layout === "wide" ? "72%" : "100%"} paddingRight={renderModel.layout === "wide" ? 1 : 0}>
          {renderModel.transcript.visibleLines.map((line) => (
            <TranscriptText key={line.id} line={line} />
          ))}
          {renderModel.transcript.visibleLines.length === 0 && <Text color="gray">No transcript lines.</Text>}
        </Box>
        {activity}
      </Box>
      <Box borderStyle="single" borderColor={renderModel.input.busy ? "yellow" : "green"} paddingX={1} flexDirection="column">
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

function TranscriptText({ line }: { line: TranscriptLine }) {
  if (!line.spans || line.spans.length === 0) {
    return (
      <Text bold={line.bold} color={line.color} inverse={line.inverse} wrap="truncate">
        {line.text || " "}
      </Text>
    );
  }
  return (
    <Text bold={line.bold} color={line.color} inverse={line.inverse} wrap="truncate">
      {line.spans.map((span, index) => (
        <Text bold={span.bold} color={span.color} inverse={span.inverse} key={index}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
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
    <Box borderStyle="single" borderColor="green" paddingX={1} marginTop={1}>
      <Text color="green">{label}: </Text>
      <Text>
        {value}
        <Cursor visible={cursorVisible} />
      </Text>
    </Box>
  );
}

function Header({
  contextEnabled,
  conversation,
  conversationId,
  conversationPreviousResponseId,
  conversationStatus,
  accessMode,
  model,
  pendingLocalLabel,
  preset,
  profile,
  renderMode,
  workdir,
}: {
  contextEnabled: boolean;
  conversation: string;
  conversationId: string;
  conversationPreviousResponseId: string;
  conversationStatus: "fresh" | "continued" | "unknown";
  accessMode: string;
  model: string;
  pendingLocalLabel: string;
  preset: string;
  profile: string;
  renderMode: RenderMode;
  workdir: string;
}) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold>Agent API Workbench</Text>
      <Text color="gray" wrap="truncate">
        profile={profile} conversation={conversation} id={conversationId} preset={preset} model={model}
      </Text>
      <Text color={conversationStatus === "continued" ? "yellow" : conversationStatus === "fresh" ? "green" : "gray"} wrap="truncate">
        conversation_state={conversationStatus}{conversationPreviousResponseId ? ` previous=${conversationPreviousResponseId}` : ""}
      </Text>
      <Text color="gray" wrap="truncate">
        workdir={workdir} access={accessMode} local_tools={contextEnabled ? "on" : "off"} render={renderMode} pending={pendingLocalLabel}
      </Text>
    </Box>
  );
}

function Cursor({ text = " ", visible }: { text?: string; visible: boolean }) {
  return visible ? <Text inverse>{text}</Text> : <Text>{text}</Text>;
}
