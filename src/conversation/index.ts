import type { ConversationState } from "../config.js";
import { activeProfile, loadConfig, saveConfig } from "../config.js";

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
  const config = await loadConfig();
  return config.conversations[conversationKey(profile.name, options.conversation)]?.previousResponseId;
}

export async function updateConversation(options: {
  profile?: string;
  conversation?: string;
}, responseID: string) {
  if (!options.conversation) return;
  const profile = await activeProfile(options.profile);
  const config = await loadConfig();
  config.conversations[conversationKey(profile.name, options.conversation)] = {
    name: options.conversation,
    profile: profile.name,
    previousResponseId: responseID,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await saveConfig(config);
}

export async function listConversations(profileName?: string): Promise<ConversationState[]> {
  const profile = await activeProfile(profileName);
  const config = await loadConfig();
  return Object.values(config.conversations)
    .filter((conversation) => conversation.profile === profile.name)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(name: string, profileName?: string): Promise<ConversationState> {
  const profile = await activeProfile(profileName);
  const config = await loadConfig();
  const conversation = config.conversations[conversationKey(profile.name, name)];
  if (!conversation) throw new Error(`Conversation not found: ${name}`);
  return conversation;
}

export async function deleteConversation(name: string, profileName?: string): Promise<void> {
  const profile = await activeProfile(profileName);
  const config = await loadConfig();
  delete config.conversations[conversationKey(profile.name, name)];
  await saveConfig(config);
}

export function conversationSummary(conversation: ConversationState) {
  const updated = new Date(conversation.updatedAt * 1000).toISOString();
  const response = conversation.previousResponseId ? ` response=${conversation.previousResponseId}` : "";
  return `${conversation.name}\t${conversation.profile}\t${updated}${response}`;
}
