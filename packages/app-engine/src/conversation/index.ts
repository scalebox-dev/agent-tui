import type { ConversationState } from "../config.js";
import {
  activeProfile,
  createConversationID,
  loadConversationConfiguration,
  saveConversationConfiguration,
} from "../config.js";

export function conversationKey(profile: string, name: string) {
  return `${profile}:${name}`;
}

export async function resolvePreviousResponseID(options: {
  profile?: string;
  conversation?: string;
  continueConversation?: boolean;
  restartConversation?: boolean;
  previousResponseId?: string;
}) {
  if (options.previousResponseId) return options.previousResponseId;
  if (options.restartConversation || !options.conversation) return undefined;
  if (!options.continueConversation) return undefined;
  const profile = await activeProfile(options.profile);
  const config = await loadConversationConfiguration();
  return config.conversations[conversationKey(profile.name, options.conversation)]?.previousResponseId;
}

export async function updateConversation(options: {
  profile?: string;
  conversation?: string;
}, responseID: string) {
  if (!options.conversation) return;
  const profile = await activeProfile(options.profile);
  const config = await loadConversationConfiguration();
  const key = conversationKey(profile.name, options.conversation);
  const existing = config.conversations[key];
  const now = Math.floor(Date.now() / 1000);
  config.conversations[conversationKey(profile.name, options.conversation)] = {
    id: existing?.id ?? createConversationID(),
    name: options.conversation,
    profile: profile.name,
    previousResponseId: responseID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveConversationConfiguration(config);
}

export async function ensureConversation(name: string, profileName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const key = conversationKey(profile.name, name);
  const existing = config.conversations[key];
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  const conversation: ConversationState = {
    id: createConversationID(),
    name,
    profile: profile.name,
    createdAt: now,
    updatedAt: now,
  };
  config.conversations[key] = conversation;
  await saveConversationConfiguration(config);
  return conversation;
}

export async function startFreshConversation(name: string, profileName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const conversation: ConversationState = {
    id: createConversationID(),
    name,
    profile: profile.name,
    createdAt: now,
    updatedAt: now,
  };
  config.conversations[conversationKey(profile.name, name)] = conversation;
  await saveConversationConfiguration(config);
  return conversation;
}

export async function listConversations(profileName?: string): Promise<ConversationState[]> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  return Object.values(config.conversations)
    .filter((conversation) => conversation.profile === profile.name)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(name: string, profileName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  const conversation = config.conversations[conversationKey(profile.name, name)];
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

export async function deleteConversation(name: string, profileName?: string): Promise<void> {
  const profile = await activeProfile(profileName);
  const config = await loadConversationConfiguration();
  delete config.conversations[conversationKey(profile.name, name)];
  await saveConversationConfiguration(config);
}

export function conversationSummary(conversation: ConversationState) {
  const updated = new Date(conversation.updatedAt * 1000).toISOString();
  const response = conversation.previousResponseId ? ` response=${conversation.previousResponseId}` : "";
  return `${conversation.name}\t${conversation.profile}\t${updated}\t${conversation.id}${response}`;
}
