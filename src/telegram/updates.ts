import { answerCallbackQuery } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: { file_id: string }[];
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: { file_id: string; duration: number };
  media_group_id?: string;
  date: number;
}

export interface TelegramCallbackQuery {
  id: string;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface AssembledMessage {
  chatId: number;
  text: string;
  messageId: number;
  date: number;
  photo?: { fileId: string; caption: string };
  document?: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
    caption: string;
  };
  voice?: { fileId: string; durationSeconds: number };
  callbackData?: string;
}

type MessageHandler = (msg: AssembledMessage) => Promise<void>;

// ---------------------------------------------------------------------------
// Dedup cache — 3-tier, 5 min TTL, max 2000 entries
// ---------------------------------------------------------------------------

const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 2000;

interface DedupEntry {
  expiresAt: number;
}

const dedupCache = new Map<string, DedupEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of dedupCache) {
    if (entry.expiresAt <= now) {
      dedupCache.delete(key);
    }
  }
}

function evictOldest(): void {
  while (dedupCache.size > DEDUP_MAX_ENTRIES) {
    const firstKey = dedupCache.keys().next().value;
    /* v8 ignore next -- defensive: Map.keys().next() always has value when size > 0 */
    if (firstKey !== undefined) {
      dedupCache.delete(firstKey);
    }
  }
}

export function isDuplicate(update: TelegramUpdate): boolean {
  evictExpired();

  const keys: string[] = [];

  // Tier 1: update_id
  keys.push(`update:${update.update_id}`);

  // Tier 2: callback query ID
  if (update.callback_query) {
    keys.push(`callback:${update.callback_query.id}`);
  }

  // Tier 3: (chat_id, message_id)
  const msg = update.message ?? update.callback_query?.message;
  if (msg) {
    keys.push(`message:${msg.chat.id}:${msg.message_id}`);
  }

  const now = Date.now();
  for (const key of keys) {
    if (dedupCache.has(key)) {
      return true;
    }
  }

  // Mark all keys as seen
  for (const key of keys) {
    dedupCache.set(key, { expiresAt: now + DEDUP_TTL_MS });
  }

  evictOldest();
  return false;
}

/** Visible for testing only. */
export function clearDedupCache(): void {
  dedupCache.clear();
}

// ---------------------------------------------------------------------------
// Per-chat sequential queue
// ---------------------------------------------------------------------------

const chatQueues = new Map<string, Promise<void>>();

export function enqueue(chatId: string, fn: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  chatQueues.set(
    chatId,
    prev.then(fn).catch((err) => {
      console.error("Telegram enqueue error:", err);
    })
  );
}

/** Visible for testing only. Returns the queue promise for a chat. */
export function getQueuePromise(chatId: string): Promise<void> | undefined {
  return chatQueues.get(chatId);
}

// ---------------------------------------------------------------------------
// Text fragment buffer
// ---------------------------------------------------------------------------

const FRAGMENT_TIMEOUT_MS = 1500;
const FRAGMENT_START_THRESHOLD = 4000;
const FRAGMENT_HARD_CAP = 50_000;

interface FragmentBuffer {
  chatId: number;
  senderId: number;
  fragments: string[];
  lastMessageId: number;
  lastTimestamp: number;
  firstMessageId: number;
  firstDate: number;
  timer: ReturnType<typeof setTimeout>;
}

const fragmentBuffers = new Map<string, FragmentBuffer>();

function fragmentKey(chatId: number, senderId: number): string {
  return `${chatId}:${senderId}`;
}

function totalLength(fragments: string[]): number {
  return fragments.reduce((sum, f) => sum + f.length, 0);
}

function flushFragment(key: string, handler: MessageHandler): void {
  const buf = fragmentBuffers.get(key);
  /* v8 ignore next -- defensive: only called when key exists */
  if (!buf) return;
  clearTimeout(buf.timer);
  fragmentBuffers.delete(key);

  const text = buf.fragments.join("\n");
  enqueue(String(buf.chatId), () =>
    handler({
      chatId: buf.chatId,
      text,
      messageId: buf.firstMessageId,
      date: buf.firstDate,
    })
  );
}

function tryBufferFragment(
  msg: TelegramMessage,
  handler: MessageHandler
): boolean {
  /* v8 ignore next -- msg.text always set when called from processUpdate */
  const text = msg.text ?? "";
  const senderId = msg.from?.id ?? 0;
  const key = fragmentKey(msg.chat.id, senderId);
  const existing = fragmentBuffers.get(key);
  const now = Date.now();

  // Append to existing buffer?
  if (existing) {
    const isConsecutive = msg.message_id === existing.lastMessageId + 1;
    const withinWindow = now - existing.lastTimestamp < FRAGMENT_TIMEOUT_MS;
    const underCap = totalLength(existing.fragments) + text.length <= FRAGMENT_HARD_CAP;

    if (isConsecutive && withinWindow && underCap) {
      existing.fragments.push(text);
      existing.lastMessageId = msg.message_id;
      existing.lastTimestamp = now;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushFragment(key, handler), FRAGMENT_TIMEOUT_MS);
      return true;
    }

    // Gap detected — flush existing buffer first
    flushFragment(key, handler);
  }

  // Start new buffer only if message is long enough to be a fragment
  if (text.length >= FRAGMENT_START_THRESHOLD) {
    const timer = setTimeout(() => flushFragment(key, handler), FRAGMENT_TIMEOUT_MS);
    fragmentBuffers.set(key, {
      chatId: msg.chat.id,
      senderId,
      fragments: [text],
      lastMessageId: msg.message_id,
      lastTimestamp: now,
      firstMessageId: msg.message_id,
      firstDate: msg.date,
      timer,
    });
    return true;
  }

  return false;
}

/** Visible for testing only. */
export function clearFragmentBuffers(): void {
  for (const [, buf] of fragmentBuffers) {
    clearTimeout(buf.timer);
  }
  fragmentBuffers.clear();
}

// ---------------------------------------------------------------------------
// Media group buffer
// ---------------------------------------------------------------------------

const MEDIA_GROUP_TIMEOUT_MS = 500;

interface MediaGroupBuffer {
  chatId: number;
  captions: string[];
  firstMessageId: number;
  firstDate: number;
  timer: ReturnType<typeof setTimeout>;
}

const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();

function flushMediaGroup(groupId: string, handler: MessageHandler): void {
  const buf = mediaGroupBuffers.get(groupId);
  /* v8 ignore next -- defensive: only called when key exists */
  if (!buf) return;
  clearTimeout(buf.timer);
  mediaGroupBuffers.delete(groupId);

  const text = buf.captions.filter(Boolean).join("\n") || "[media group]";
  enqueue(String(buf.chatId), () =>
    handler({
      chatId: buf.chatId,
      text,
      messageId: buf.firstMessageId,
      date: buf.firstDate,
    })
  );
}

function bufferMediaGroup(
  groupId: string,
  msg: TelegramMessage,
  handler: MessageHandler
): void {
  const existing = mediaGroupBuffers.get(groupId);

  if (existing) {
    if (msg.caption) {
      existing.captions.push(msg.caption);
    }
    clearTimeout(existing.timer);
    existing.timer = setTimeout(
      () => flushMediaGroup(groupId, handler),
      MEDIA_GROUP_TIMEOUT_MS
    );
    return;
  }

  const timer = setTimeout(
    () => flushMediaGroup(groupId, handler),
    MEDIA_GROUP_TIMEOUT_MS
  );
  mediaGroupBuffers.set(groupId, {
    chatId: msg.chat.id,
    captions: msg.caption ? [msg.caption] : [],
    firstMessageId: msg.message_id,
    firstDate: msg.date,
    timer,
  });
}

/** Visible for testing only. */
export function clearMediaGroupBuffers(): void {
  for (const [, buf] of mediaGroupBuffers) {
    clearTimeout(buf.timer);
  }
  mediaGroupBuffers.clear();
}

// ---------------------------------------------------------------------------
// Message handler registration + processUpdate
// ---------------------------------------------------------------------------

let messageHandler: MessageHandler | null = null;

export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler;
}

/** Visible for testing only. */
export function clearMessageHandler(): void {
  messageHandler = null;
}

export function processUpdate(update: TelegramUpdate): void {
  if (isDuplicate(update)) return;

  const handler = messageHandler;
  if (!handler) return;

  // Callback query
  if (update.callback_query) {
    const cq = update.callback_query;
    void answerCallbackQuery(cq.id);

    if (cq.message && cq.data) {
      enqueue(String(cq.message.chat.id), () =>
        handler({
          chatId: cq.message!.chat.id,
          text: cq.data!,
          messageId: cq.message!.message_id,
          date: cq.message!.date,
          callbackData: cq.data!,
        })
      );
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // Voice message — process directly, no fragment/media buffering
  if (msg.voice) {
    enqueue(String(msg.chat.id), () =>
      handler({
        chatId: msg.chat.id,
        text: msg.caption ?? "",
        messageId: msg.message_id,
        date: msg.date,
        voice: {
          fileId: msg.voice!.file_id,
          durationSeconds: msg.voice!.duration,
        },
      })
    );
    return;
  }

  // Photo message (single) — OCR happens downstream
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    enqueue(String(msg.chat.id), () =>
      handler({
        chatId: msg.chat.id,
        text: msg.caption ?? "",
        messageId: msg.message_id,
        date: msg.date,
        photo: {
          fileId: largest.file_id,
          caption: msg.caption ?? "",
        },
      })
    );
    return;
  }

  // Document message — text extraction happens downstream
  if (msg.document) {
    const doc = msg.document;
    enqueue(String(msg.chat.id), () =>
      handler({
        chatId: msg.chat.id,
        text: msg.caption ?? "",
        messageId: msg.message_id,
        date: msg.date,
        document: {
          fileId: doc.file_id,
          fileName: doc.file_name,
          mimeType: doc.mime_type,
          caption: msg.caption ?? "",
        },
      })
    );
    return;
  }

  // Media group
  if (msg.media_group_id) {
    bufferMediaGroup(msg.media_group_id, msg, handler);
    return;
  }

  // Text message — try fragment buffering first
  if (msg.text) {
    if (tryBufferFragment(msg, handler)) return;

    // Normal text message
    enqueue(String(msg.chat.id), () =>
      handler({
        chatId: msg.chat.id,
        text: msg.text!,
        messageId: msg.message_id,
        date: msg.date,
      })
    );
  }
}
