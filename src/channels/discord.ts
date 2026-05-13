/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createDiscordInboundPolicy, discordPolicyFromEnv, enrichDiscordAttachments } from './discord-policy.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
      'DISCORD_AGENT_CHANNEL_IDS',
      'DISCORD_IGNORED_MENTION_IDS',
      'DISCORD_DISABLE_AUTO_THREADS',
      'DISCORD_DISABLE_DMS',
      'DISCORD_ALLOW_BOT_MESSAGES',
      'TRANSCRIPTION_BACKEND',
    ]);
    if (!env.DISCORD_BOT_TOKEN) return null;
    if (env.DISCORD_DISABLE_AUTO_THREADS) {
      process.env.DISCORD_DISABLE_AUTO_THREADS = env.DISCORD_DISABLE_AUTO_THREADS;
    }
    const policyConfig = {
      ...discordPolicyFromEnv(env),
      openAiApiKey: process.env.OPENAI_API_KEY,
    };
    const inboundPolicy = createDiscordInboundPolicy(policyConfig);
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      inboundPolicy: ({ channelId, threadId, message, isMention, isGroup }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const author = message.author as any;
        const text = typeof message.text === 'string' ? message.text : '';
        const decision = inboundPolicy.shouldForward({
          text,
          isDm: !isGroup,
          isMention,
          isBot: author?.isBot,
          isMe: author?.isMe,
          authorId: author?.userId,
          channelId: extractDiscordChannelId(channelId),
        });
        if (!decision.forward) return decision;
        return {
          forward: true,
          threadId: inboundPolicy.normalizeThreadId({ text, threadId }),
        };
      },
      enrichAttachments: (attachments) => enrichDiscordAttachments(attachments, policyConfig),
      handleCustomOperation: async ({ platformId, threadId, content }) => {
        if (content.operation !== 'set_discord_nickname') return false;
        const nick = (content.nickname as string | undefined)?.trim();
        if (!nick) throw new Error('Nickname is required.');
        const guildId = extractDiscordGuildId(platformId, threadId);
        if (!guildId) throw new Error('Cannot infer Discord guild from this conversation.');
        await setDiscordBotNickname(env.DISCORD_BOT_TOKEN, guildId, nick);
        return true;
      },
      resolveOutboundThreadId: ({ platformId, threadId }) =>
        policyConfig.disableAutoThreads ? platformId : (threadId ?? platformId),
      supportsThreads: true,
    });
  },
});

function extractDiscordChannelId(platformId: string): string | undefined {
  const parts = platformId.split(':');
  if (parts[0] !== 'discord') return undefined;
  if (parts[1] === '@me') return parts[2];
  return parts[2];
}

function extractDiscordGuildId(platformId: string, threadId: string | null): string | null {
  // Encoded Discord ids look like:
  //   discord:<guildId>:<channelId>
  //   discord:<guildId>:<channelId>:<threadId>
  // DMs are encoded as discord:@me:<dmChannelId> and cannot set a guild nickname.
  const candidate = threadId?.startsWith('discord:') ? threadId : platformId;
  const parts = candidate.split(':');
  if (parts[0] !== 'discord' || parts[1] === '@me' || !/^\d+$/.test(parts[1] ?? '')) return null;
  return parts[1];
}

async function setDiscordBotNickname(botToken: string | undefined, guildId: string, nick: string): Promise<void> {
  if (!botToken) throw new Error('Discord bot token is unavailable; cannot change nickname.');
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/@me`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord nickname update failed: ${res.status} ${body}`);
  }
}
