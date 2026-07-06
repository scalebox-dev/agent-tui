export type {
  AgentEngineApp,
  AgentEngineAppOptions,
  AgentEngineLifecycleOptions,
} from "./engine/agent-engine.js";
export {
  createAgentEngine,
} from "./engine/agent-engine.js";
export type {
  AgentEngineClient,
} from "./engine/client.js";
export {
  agentEngineClientFromApp,
  createInProcessAgentEngineClient,
} from "./engine/client.js";
export type {
  AgentEngineLineTransportOptions,
  AgentEngineRpcConnection,
} from "./engine/line-transport.js";
export {
  bindLineDelimitedAgentEngineRpcHandler,
  createLineDelimitedAgentEngineRpcTransport,
} from "./engine/line-transport.js";
export type {
  AgentEngineRpcError,
  AgentEngineRpcEvent,
  AgentEngineRpcHandler,
  AgentEngineRpcId,
  AgentEngineRpcMethod,
  AgentEngineRpcParamsByMethod,
  AgentEngineRpcRequest,
  AgentEngineRpcResponse,
  AgentEngineRpcResultByMethod,
  AgentEngineRpcTransport,
} from "./engine/rpc.js";
export {
  agentEngineRpcProtocolVersion,
  createAgentEngineRpcClient,
  createAgentEngineRpcHandler,
} from "./engine/rpc.js";
export type {
  AutomaticContinuationPause,
  AutomaticContinuationState,
  AgentRunOptions,
  AgentTurnEvent,
  AgentTurnResult,
  LocalPauseHandle,
  LocalPauseHooks,
  LocalPauseRequest,
  LocalPauseResult,
  LocalToolApprovalRequest,
  WorkdirAccessMode,
} from "./agent.js";
export {
  agentResponseFailureMessage,
  agentTurnEventFromStreamEvent,
  clearPresetToolCatalogCache,
  conversationSummary,
  deleteConversation,
  deleteWorkspaceConversation,
  ensureConversation,
  getConversation,
  isAvailablePreset,
  listAvailablePresets,
  listConversations,
  localToolExecutionErrorResult,
  resolveAgentRequestTools,
  resumeAgentAfterAutomaticContinuation,
  resumeAgentAfterLocalApproval,
  runAgent,
  runAgentTurn,
  startFreshConversation,
} from "./agent.js";
export type { ChatOptions } from "./chat-options.js";
export { normalizeChatOptions } from "./chat-options.js";
export type { AgentEngineServices } from "./engine/services.js";
export { defaultBaseURL } from "./config.js";
export type {
  AuthProfile,
  ConversationRunSettings,
  ConversationState,
  Profile,
  WorkbenchPreferences,
} from "./config.js";
export {
  activeProfile,
  loadAppConfiguration,
  loadConfig,
  loadConversationConfiguration,
  loadWorkbenchPreferences,
  redactSecret,
  saveAppConfiguration,
  saveConfig,
  saveConversationConfiguration,
  updateWorkbenchPreferences,
} from "./config.js";
export type {
  AuthStatus,
  CurrentWorkspaceIdentity,
  RuntimeProfile,
  WorkspaceInfo,
} from "./profile.js";
export {
  AuthSessionUnavailableError,
  AuthSessionExpiredError,
  browserAccessTokenExpiresWithin,
  deleteProfile,
  formatDeviceUserCode,
  getAuthStatus,
  getCurrentWorkspaceIdentity,
  listProfileWorkspaces,
  listProfiles,
  loginWithAPIKey,
  loginWithBrowser,
  openBrowserURL,
  profileSummary,
  refreshActiveProfileIfNeeded,
  refreshBrowserSession,
  refreshIfNeeded,
  resolveRuntimeProfile,
  saveBrowserProfile,
  startBrowserAuthChallenge,
  switchBrowserWorkspace,
  useProfile,
  waitForBrowserAuthChallenge,
} from "./profile.js";
export {
  appVersion,
  configureAgentAppRuntime,
  currentAgentAppRuntime,
  defaultAppAuthor,
  defaultAppName,
  defaultAppVersion,
  ensureRuntime,
  runtime,
} from "./runtime/index.js";
export type {
  AgentAppRuntimeContext,
  AgentAppRuntimeOptions,
} from "./runtime/index.js";
export {
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  globalUpdateInstallPlan,
  installUpdate,
  localUpdateInstallPlan,
} from "./update.js";
export type {
  UpdateCheckResult,
  UpdateInstallPlan,
  UpdateInstallResult,
} from "./update.js";
export type {
  WorkdirContextOptions,
  WorkdirOptions,
  WorkdirService,
} from "./workdir/index.js";
export {
  buildWorkdirContextBlock,
  openWorkdir,
} from "./workdir/index.js";
