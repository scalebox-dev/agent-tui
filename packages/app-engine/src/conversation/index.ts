import type { ConversationState } from "../config.js";
import {
  activeProfile,
  createConversationID,
  loadConversationConfiguration,
  saveConversationConfiguration,
} from "../config.js";

export function conversationKey(profile: string, name: string, workspaceId?: string) {
  return workspaceId ? `${profile}:${workspaceId}:${name}` : `${profile}:${name}`;
}

export async function resolvePreviousResponseID(options: {
  profile?: string;
  conversation?: string;
  workspaceId?: string;
  continueConversation?: boolean;
  restartConversation?: boolean;
  previousResponseId?: string;
}) {
  if (options.previousResponseId) return options.previousResponseId;
  if (options.restartConversation || !options.conversation) return undefined;
  if (!options.continueConversation) return undefined;
  const profile = await activeProfile(options.profile);
  const config = await loadConversationConfiguration();
  return config.conversations[conversationKey(profile.name, options.conversation, options.workspaceId)]?.previousResponseId
    ?? (options.workspaceId ? undefined : config.conversations[conversationKey(profile.name, options.conversation)]?.previousResponseId);
}

export async function updateConversation(options: {
  profile?: string;
  conversation?: string;
  workspaceId?: string;
  workspaceName?: string;
}, responseID: string) {
  if (!options.conversation) return;
  const profile = await activeProfile(options.profile);
  const config = await loadConversationConfiguration();
  const key = conversationKey(profile.name, options.conversation, options.workspaceId);
  const existing = config.conversations[key];
  const now = Math.floor(Date.now() / 1000);
  config.conversations[key] = {
    id: existing?.id ?? createConversationID(),
    name: options.conversation,
    profile: profile.name,
    workspaceId: options.workspaceId,
    workspaceName: options.workspaceName,
    previousResponseId: responseID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveConversationConfiguration(config);
}

export async function ensureConversation(name: string, profileName?: string, workspaceId?: string, workspaceName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const key = conversationKey(profile.name, name, workspaceId);
  const existing = config.conversations[key];
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  const conversation: ConversationState = {
    id: createConversationID(),
    name,
    profile: profile.name,
    workspaceId,
    workspaceName,
    createdAt: now,
    updatedAt: now,
  };
  config.conversations[key] = conversation;
  await saveConversationConfiguration(config);
  return conversation;
}

export async function startFreshConversation(name: string, profileName?: string, workspaceId?: string, workspaceName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const conversation: ConversationState = {
    id: createConversationID(),
    name,
    profile: profile.name,
    workspaceId,
    workspaceName,
    createdAt: now,
    updatedAt: now,
  };
  config.conversations[conversationKey(profile.name, name, workspaceId)] = conversation;
  await saveConversationConfiguration(config);
  return conversation;
}

export async function listConversations(profileName?: string, workspaceId?: string): Promise<ConversationState[]> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  return Object.values(config.conversations)
    .filter((conversation) => conversation.profile === profile.name && (workspaceId ? conversation.workspaceId === workspaceId : true))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(name: string, profileName?: string, workspaceId?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const conversation = config.conversations[conversationKey(profile.name, name, workspaceId)];
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

export async function renameConversation(
  name: string,
  nextName: string,
  profileName?: string,
  workspaceId?: string,
): Promise<ConversationState> {
  const current = name.trim();
  const next = nextName.trim();
  if (!current) throw new Error("Conversation name is required.");
  if (!next) throw new Error("New conversation name is required.");
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const currentKey = conversationKey(profile.name, current, workspaceId);
  const nextKey = conversationKey(profile.name, next, workspaceId);
  const existing = config.conversations[currentKey];
  if (!existing) throw new Error(`Conversation not found: ${current}`);
  if (currentKey !== nextKey && config.conversations[nextKey]) {
    throw new Error(`Conversation already exists: ${next}`);
  }
  const renamed: ConversationState = {
    ...existing,
    name: next,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  delete config.conversations[currentKey];
  config.conversations[nextKey] = renamed;
  await saveConversationConfiguration(config);
  return renamed;
}

export async function deleteConversation(name: string, profileName?: string): Promise<void> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  delete config.conversations[conversationKey(profile.name, name)];
  await saveConversationConfiguration(config);
}

export async function deleteWorkspaceConversation(name: string, profileName?: string, workspaceId?: string): Promise<void> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  delete config.conversations[conversationKey(profile.name, name, workspaceId)];
  await saveConversationConfiguration(config);
}

export function conversationSummary(conversation: ConversationState) {
  const updated = new Date(conversation.updatedAt * 1000).toISOString();
  const response = conversation.previousResponseId ? ` response=${conversation.previousResponseId}` : "";
  const workspace = conversation.workspaceId ? `\t${conversation.workspaceId}` : "";
  return `${conversation.name}\t${conversation.profile}${workspace}\t${updated}\t${conversation.id}${response}`;
}
