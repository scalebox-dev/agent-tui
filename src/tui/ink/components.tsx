import React from "react";
import { Box, Text } from "ink";
import { authMethods, type AuthGateState } from "../../workbench/auth-gate-controller.js";
import { busySpinner, type WorkbenchRenderModel } from "../../workbench/render-model.js";
import {
  activityColor,
  type RenderMode,
} from "../workbench.js";

export function InkWorkbenchScreen({
  renderModel,
  spinnerFrame,
}: {
  renderModel: WorkbenchRenderModel;
  spinnerFrame: number;
}) {
  return (
    <Box flexDirection="column">
      <Header
        contextEnabled={renderModel.header.contextEnabled}
        conversation={renderModel.header.conversation}
        model={renderModel.header.model}
        accessMode={renderModel.header.accessMode}
        pendingLocalLabel={renderModel.header.pendingLocalLabel}
        preset={renderModel.header.preset}
        profile={renderModel.header.profile}
        renderMode={renderModel.header.renderMode}
        workdir={renderModel.header.workdir}
      />
      <Box marginTop={1} height={renderModel.viewportHeight}>
        <Box flexDirection="column" width="72%" paddingRight={1}>
          {renderModel.transcript.visibleLines.map((line) => (
            <Text bold={line.bold} color={line.color} inverse={line.inverse} key={line.id} wrap="truncate">
              {line.text || " "}
            </Text>
          ))}
          {renderModel.transcript.visibleLines.length === 0 && <Text color="gray">No transcript lines.</Text>}
        </Box>
        <Box flexDirection="column" width="28%" height={renderModel.activityHeight} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold wrap="truncate">Activity</Text>
          {renderModel.visibleActivities.map((activity) => (
            <Text color={activityColor(activity.level)} key={activity.id} wrap="truncate">
              {new Date(activity.timestamp).toLocaleTimeString()} {activity.text}
            </Text>
          ))}
        </Box>
      </Box>
      <Box borderStyle="single" borderColor={renderModel.input.busy ? "yellow" : "green"} paddingX={1}>
        {renderModel.input.fullAccess && (
          <Text color="red" bold inverse>
            FULL ACCESS
          </Text>
        )}
        {renderModel.input.fullAccess && <Text> </Text>}
        <Text color={renderModel.input.busy ? "yellow" : "green"}>{renderModel.input.label} </Text>
        {renderModel.input.busy ? (
          <Text wrap="truncate">
            <Text color="yellow">{busySpinner(spinnerFrame)}</Text> {renderModel.input.waitingText}
          </Text>
        ) : (
          <Text wrap="truncate">
            {renderModel.input.draft}
            <Cursor visible />
          </Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color="gray" wrap="truncate">{renderModel.footerText}</Text>
      </Box>
    </Box>
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
        profile={profile} conversation={conversation} preset={preset} model={model}
      </Text>
      <Text color="gray" wrap="truncate">
        workdir={workdir} access={accessMode} local_tools={contextEnabled ? "on" : "off"} render={renderMode} pending={pendingLocalLabel}
      </Text>
    </Box>
  );
}

function Cursor({ visible }: { visible: boolean }) {
  return visible ? <Text inverse> </Text> : <Text> </Text>;
}
