import { describe, expect, it } from 'vitest';

import {
  buildAllowedMentionsPayload,
  classifyDiscordAttachment,
  createDiscordInboundPolicy,
  discordPolicyFromEnv,
  enrichDiscordAttachments,
  resolve_discord_mention,
} from './discord-policy.js';

describe('classifyDiscordAttachment', () => {
  it('detects image attachments by MIME type and filename', () => {
    expect(classifyDiscordAttachment({ mimeType: 'image/png', name: 'upload.bin' })).toBe('image');
    expect(classifyDiscordAttachment({ mimeType: 'application/octet-stream', name: 'screenshot.WEBP' })).toBe('image');
  });

  it('detects audio attachments by MIME type and filename', () => {
    expect(classifyDiscordAttachment({ mimeType: 'audio/ogg', name: 'voice.dat' })).toBe('audio');
    expect(classifyDiscordAttachment({ mimeType: 'application/octet-stream', name: 'clip.M4A' })).toBe('audio');
  });
});

describe('enrichDiscordAttachments', () => {
  it('adds graceful unsupported context for image and audio attachments by default', async () => {
    const attachments: Array<Record<string, unknown>> = [
      { mimeType: 'image/png', name: 'screenshot.png' },
      { mimeType: 'audio/ogg', name: 'voice.ogg' },
    ];

    await expect(enrichDiscordAttachments(attachments)).resolves.toEqual([
      'I received the image, but this backend is not configured for vision analysis.',
      'I received the voice/audio message, but transcription is not configured.',
    ]);
    expect(attachments.map((a) => a.type)).toEqual(['image', 'audio']);
  });
});

describe('createDiscordInboundPolicy', () => {
  it('suppresses DMs unless the user explicitly asks for a private reply', () => {
    const policy = createDiscordInboundPolicy({ disableDms: true });
    expect(policy.shouldForward({ text: 'hello', isDm: true, isMention: true, authorId: 'u1', isBot: false })).toEqual({
      forward: false,
      reason: 'dm_disabled',
    });
    expect(
      policy.shouldForward({ text: 'DM me the answer', isDm: true, isMention: true, authorId: 'u1', isBot: false }),
    ).toEqual({ forward: true });
  });

  it('suppresses auto-threading unless the user explicitly asks to start a thread', () => {
    const policy = createDiscordInboundPolicy({ disableAutoThreads: true });
    expect(policy.normalizeThreadId({ text: 'answer inline', threadId: 'discord:g:c:t' })).toBeNull();
    expect(policy.normalizeThreadId({ text: 'start a thread for this', threadId: 'discord:g:c:t' })).toBe(
      'discord:g:c:t',
    );
  });

  it('rate-limits ambient bot replies but allows direct mentions', () => {
    const now = 1_000;
    const policy = createDiscordInboundPolicy({
      allowBotMessages: 'mentions',
      agentChannelIds: new Set(['chan-1']),
      now: () => now,
    });
    expect(
      policy.shouldForward({
        text: 'NanoClaw please review this',
        isMention: false,
        authorId: 'bot-1',
        isBot: true,
        channelId: 'chan-1',
      }),
    ).toEqual({ forward: true });
    expect(
      policy.shouldForward({
        text: 'NanoClaw please do another thing',
        isMention: false,
        authorId: 'bot-1',
        isBot: true,
        channelId: 'chan-1',
      }),
    ).toEqual({ forward: false, reason: 'bot_loop_guard' });

    expect(policy.shouldForward({ text: 'do another thing', isMention: true, authorId: 'bot-1', isBot: true })).toEqual(
      {
        forward: true,
      },
    );
  });

  it('drops messages explicitly addressed to configured non-self bots', () => {
    const policy = createDiscordInboundPolicy({
      ignoredMentionIds: new Set(['1502035240690913310', '1502065442515058708']),
    });

    expect(
      policy.shouldForward({
        text: '<@1502035240690913310> acknowledge inline check.',
        isMention: false,
        authorId: 'human-1',
        isBot: false,
        channelId: 'chan-1',
      }),
    ).toEqual({ forward: false, reason: 'ignored_mention_target' });

    expect(
      policy.shouldForward({
        text: '<@1490150963464503377> acknowledge inline check.',
        isMention: true,
        authorId: 'human-1',
        isBot: false,
        channelId: 'chan-1',
      }),
    ).toEqual({ forward: true });
  });
});

describe('discordPolicyFromEnv', () => {
  it('parses Discord coordination env vars with disabled transcription by default', () => {
    const config = discordPolicyFromEnv({
      DISCORD_AGENT_CHANNEL_IDS: '111, 222',
      DISCORD_DISABLE_AUTO_THREADS: 'true',
      DISCORD_DISABLE_DMS: 'true',
      DISCORD_ALLOW_BOT_MESSAGES: 'mentions',
      DISCORD_IGNORED_MENTION_IDS: '333, 444',
    });

    expect(config.agentChannelIds).toEqual(new Set(['111', '222']));
    expect(config.disableAutoThreads).toBe(true);
    expect(config.disableDms).toBe(true);
    expect(config.allowBotMessages).toBe('mentions');
    expect(config.transcriptionBackend).toBe('disabled');
    expect(config.ignoredMentionIds).toEqual(new Set(['333', '444']));
  });
});

describe('resolve_discord_mention', () => {
  const guild = {
    members: [
      { id: '123456789012345678', displayName: 'Hermes', user: { username: 'hermes-bot', bot: true } },
      { id: '222222222222222222', displayName: 'Laura', user: { username: 'laura' } },
    ],
  };

  it('uses numeric Discord snowflakes directly', () => {
    expect(resolve_discord_mention('123456789012345678', guild)).toEqual({
      id: '123456789012345678',
      mention: '<@123456789012345678>',
    });
  });

  it('resolves display names and usernames to numeric mentions', () => {
    expect(resolve_discord_mention('@Hermes', guild)).toEqual({
      id: '123456789012345678',
      mention: '<@123456789012345678>',
    });
    expect(resolve_discord_mention('laura', guild)).toEqual({
      id: '222222222222222222',
      mention: '<@222222222222222222>',
    });
  });
});

describe('buildAllowedMentionsPayload', () => {
  it('permits only the resolved numeric user ids', () => {
    expect(buildAllowedMentionsPayload(['123456789012345678'])).toEqual({
      users: ['123456789012345678'],
    });
  });
});
