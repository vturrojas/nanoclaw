# Discord Setup

NanoClaw's Discord adapter uses the Chat SDK bridge and keeps Discord-specific coordination in the Discord channel layer.

## Developer Portal

Enable these bot intents in the Discord Developer Portal:

- Message Content Intent
- Server Members Intent, if you want NanoClaw to resolve display names or usernames to numeric Discord user IDs

## Permissions

Required bot permissions:

- View Channels
- Send Messages
- Read Message History

Optional permissions:

- Attach Files, only if NanoClaw should upload files
- Send Messages in Threads, only if you intentionally enable thread behavior
- Change Nickname, only if agents should use `set_discord_nickname`

## Recommended Environment

```env
DISCORD_BOT_TOKEN=<bot_token>
DISCORD_PUBLIC_KEY=<application_public_key>
DISCORD_APPLICATION_ID=<application_id>
DISCORD_AGENT_CHANNEL_IDS=<channel_id>
DISCORD_DISABLE_AUTO_THREADS=true
DISCORD_DISABLE_DMS=true
DISCORD_ALLOW_BOT_MESSAGES=mentions
TRANSCRIPTION_BACKEND=disabled
```

`OPENAI_API_KEY` is read only from the process environment when `TRANSCRIPTION_BACKEND=openai`. Do not store it in code.

## Channel Behavior

NanoClaw replies inline in the current Discord channel by default. It does not create a thread unless the user explicitly asks to "start a thread". It does not DM the user unless explicitly instructed with language such as "DM me" or "send this privately".

Bot messages are ignored unless NanoClaw is directly mentioned, or the message is in `DISCORD_AGENT_CHANNEL_IDS` and contains a direct task/request to NanoClaw. NanoClaw also suppresses repeated ambient bot replies from the same bot for 60 seconds to avoid loops.

## Attachments

Image attachments are detected by `image/*` MIME types or `.png`, `.jpg`, `.jpeg`, and `.webp` filenames. If the current backend is not configured for vision, NanoClaw replies with:

```text
I received the image, but this backend is not configured for vision analysis.
```

Audio attachments are detected by `audio/*` MIME types or `.ogg`, `.mp3`, `.wav`, `.m4a`, and `.webm` filenames. Transcription is disabled by default. If transcription is unavailable, NanoClaw replies with:

```text
I received the voice/audio message, but transcription is not configured.
```

Set `TRANSCRIPTION_BACKEND=openai` and provide `OPENAI_API_KEY` in the process environment to enable OpenAI transcription.

## Mentions

Discord mentions must use numeric IDs:

```text
<@USER_ID>
```

Do not send literal name mentions such as `<@Hermes>` or `<@bot-name>`. When name resolution is needed, enable Server Members Intent so NanoClaw can resolve display names and usernames to numeric IDs, then send messages with an `allowed_mentions.users` payload limited to those numeric user IDs.
