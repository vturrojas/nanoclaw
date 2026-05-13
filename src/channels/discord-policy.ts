import type { Attachment } from 'chat';

type BotMessageMode = 'ignore' | 'mentions' | 'all';
export type TranscriptionBackend = 'openai' | 'local' | 'disabled';

export interface DiscordPolicyConfig {
  agentChannelIds?: Set<string>;
  ignoredMentionIds?: Set<string>;
  disableAutoThreads?: boolean;
  disableDms?: boolean;
  allowBotMessages?: BotMessageMode;
  transcriptionBackend?: TranscriptionBackend;
  openAiApiKey?: string;
  now?: () => number;
}

export interface DiscordPolicyEnv {
  DISCORD_AGENT_CHANNEL_IDS?: string;
  DISCORD_IGNORED_MENTION_IDS?: string;
  DISCORD_DISABLE_AUTO_THREADS?: string;
  DISCORD_DISABLE_DMS?: string;
  DISCORD_ALLOW_BOT_MESSAGES?: string;
  TRANSCRIPTION_BACKEND?: string;
}

export interface DiscordInboundDecisionInput {
  text: string;
  isDm?: boolean;
  isMention: boolean;
  isBot?: boolean | 'unknown';
  isMe?: boolean;
  authorId?: string;
  channelId?: string;
}

export type DiscordInboundDecision = { forward: true } | { forward: false; reason: string };

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.webm']);
const SNOWFLAKE_RE = /^\d{15,22}$/;
const DM_REQUEST_RE = /\b(dm me|send this privately|send it privately|direct message me)\b/i;
const START_THREAD_RE = /\bstart (a )?thread\b/i;
const ACK_ONLY_RE = /^(ok|okay|thanks|thank you|done|ack|acknowledged|sounds good|got it)[.! ]*$/i;
const DIRECT_TASK_RE =
  /\bnanoclaw\b.*\b(please|review|check|fix|summarize|transcribe|look|answer|help|do|run|tell|ask)\b/i;

export function discordPolicyFromEnv(
  env: DiscordPolicyEnv,
): Required<Omit<DiscordPolicyConfig, 'openAiApiKey' | 'now'>> {
  return {
    agentChannelIds: new Set(
      (env.DISCORD_AGENT_CHANNEL_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    ignoredMentionIds: new Set(
      (env.DISCORD_IGNORED_MENTION_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    disableAutoThreads: env.DISCORD_DISABLE_AUTO_THREADS === 'true',
    disableDms: env.DISCORD_DISABLE_DMS === 'true',
    allowBotMessages:
      env.DISCORD_ALLOW_BOT_MESSAGES === 'all' || env.DISCORD_ALLOW_BOT_MESSAGES === 'ignore'
        ? env.DISCORD_ALLOW_BOT_MESSAGES
        : 'mentions',
    transcriptionBackend:
      env.TRANSCRIPTION_BACKEND === 'openai' || env.TRANSCRIPTION_BACKEND === 'local'
        ? env.TRANSCRIPTION_BACKEND
        : 'disabled',
  };
}

export function createDiscordInboundPolicy(config: DiscordPolicyConfig = {}) {
  const lastBotResponse = new Map<string, number>();
  const now = config.now ?? Date.now;

  return {
    shouldForward(input: DiscordInboundDecisionInput): DiscordInboundDecision {
      if (input.isMe) return { forward: false, reason: 'own_message' };

      if (!input.isMention && isIgnoredMentionTarget(input.text, config)) {
        return { forward: false, reason: 'ignored_mention_target' };
      }

      if (config.disableDms && input.isDm && !DM_REQUEST_RE.test(input.text)) {
        return { forward: false, reason: 'dm_disabled' };
      }

      const isBot = input.isBot === true;
      if (isBot) {
        if (ACK_ONLY_RE.test(input.text.trim())) return { forward: false, reason: 'bot_ack' };
        if (config.allowBotMessages === 'ignore') return { forward: false, reason: 'bot_messages_disabled' };
        if (config.allowBotMessages !== 'all' && !input.isMention && !isTaskInAgentChannel(input, config)) {
          return { forward: false, reason: 'ambient_bot_chatter' };
        }
        if (!input.isMention && input.authorId) {
          const previous = lastBotResponse.get(input.authorId);
          if (previous !== undefined && now() - previous < 60_000) {
            return { forward: false, reason: 'bot_loop_guard' };
          }
          lastBotResponse.set(input.authorId, now());
        }
      }

      return { forward: true };
    },

    normalizeThreadId(input: { text: string; threadId: string | null }): string | null {
      if (!config.disableAutoThreads) return input.threadId;
      return START_THREAD_RE.test(input.text) ? input.threadId : null;
    },
  };
}

function isIgnoredMentionTarget(text: string, config: DiscordPolicyConfig): boolean {
  const ids = config.ignoredMentionIds ?? new Set<string>();
  if (ids.size === 0) return false;
  for (const match of text.matchAll(/<@!?(\d{15,22})>/g)) {
    const id = match[1];
    if (id && ids.has(id)) return true;
  }
  return false;
}

function isTaskInAgentChannel(input: DiscordInboundDecisionInput, config: DiscordPolicyConfig): boolean {
  const ids = config.agentChannelIds ?? new Set<string>();
  return input.channelId !== undefined && ids.has(input.channelId) && DIRECT_TASK_RE.test(input.text);
}

export function classifyDiscordAttachment(
  att: Partial<Pick<Attachment, 'mimeType' | 'name' | 'type'>>,
): 'image' | 'audio' | 'file' {
  const mimeType = att.mimeType?.toLowerCase() ?? '';
  const name = att.name?.toLowerCase() ?? '';
  if (mimeType.startsWith('image/') || hasAnyExtension(name, IMAGE_EXTENSIONS)) return 'image';
  if (mimeType.startsWith('audio/') || hasAnyExtension(name, AUDIO_EXTENSIONS)) return 'audio';
  return 'file';
}

function hasAnyExtension(filename: string, extensions: Set<string>): boolean {
  return [...extensions].some((ext) => filename.endsWith(ext));
}

export async function enrichDiscordAttachments(
  attachments: Array<Record<string, unknown>>,
  config: Pick<DiscordPolicyConfig, 'transcriptionBackend' | 'openAiApiKey'> = {},
): Promise<string[]> {
  const notes: string[] = [];
  for (const att of attachments) {
    const kind = classifyDiscordAttachment({
      mimeType: typeof att.mimeType === 'string' ? att.mimeType : undefined,
      name: typeof att.name === 'string' ? att.name : undefined,
      type: typeof att.type === 'string' ? (att.type as Attachment['type']) : undefined,
    });
    att.type = kind;
    if (kind === 'image') {
      notes.push('I received the image, but this backend is not configured for vision analysis.');
    }
    if (kind === 'audio') {
      const transcript = await transcribeDiscordAudio(att, config);
      if (transcript) notes.push(`Transcribed Discord audio: ${transcript}`);
      else notes.push('I received the voice/audio message, but transcription is not configured.');
    }
  }
  return notes;
}

async function transcribeDiscordAudio(
  att: Record<string, unknown>,
  config: Pick<DiscordPolicyConfig, 'transcriptionBackend' | 'openAiApiKey'>,
): Promise<string | null> {
  if (config.transcriptionBackend !== 'openai' || !config.openAiApiKey || typeof att.data !== 'string') return null;
  const bytes = Buffer.from(att.data, 'base64');
  const filename = typeof att.name === 'string' && att.name ? att.name : 'discord-audio.ogg';
  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([bytes]), filename);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openAiApiKey}` },
    body: form,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { text?: unknown };
  return typeof json.text === 'string' && json.text.trim() ? json.text.trim() : null;
}

export interface DiscordGuildLike {
  members?: unknown;
}

export function resolve_discord_mention(
  targetNameOrId: string,
  guild?: DiscordGuildLike | null,
): { id: string; mention: string } | null {
  const normalized = targetNameOrId
    .trim()
    .replace(/^<@!?(\d+)>$/, '$1')
    .replace(/^@/, '');
  if (SNOWFLAKE_RE.test(normalized)) return { id: normalized, mention: `<@${normalized}>` };

  for (const member of flattenMembers(guild?.members)) {
    const id = stringField(member, 'id') ?? stringField(objectField(member, 'user'), 'id');
    if (!id || !SNOWFLAKE_RE.test(id)) continue;
    const names = [
      stringField(member, 'displayName'),
      stringField(member, 'nickname'),
      stringField(objectField(member, 'user'), 'username'),
      stringField(objectField(member, 'user'), 'globalName'),
      stringField(objectField(member, 'user'), 'global_name'),
    ]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());
    if (names.includes(normalized.toLowerCase())) return { id, mention: `<@${id}>` };
  }

  return null;
}

function flattenMembers(members: unknown): unknown[] {
  if (Array.isArray(members)) return members;
  if (members && typeof members === 'object') {
    const maybeCache = objectField(members, 'cache');
    if (maybeCache instanceof Map) return [...maybeCache.values()];
    if (members instanceof Map) return [...members.values()];
  }
  return [];
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

export function buildAllowedMentionsPayload(userIds: string[]): { users: string[] } {
  return { users: userIds.filter((id) => SNOWFLAKE_RE.test(id)) };
}
