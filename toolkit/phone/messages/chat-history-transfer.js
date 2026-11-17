/**
 * 单角色聊天记录导出 / 导入
 * @module phone/messages/chat-history-transfer
 *
 * @description
 * 只处理一个角色（联系人）的聊天消息数组，不包含联系人、记忆、预设或 API 配置。
 * 导出文件是纯 JSON，可在同一角色的聊天设置页重新导入。
 * 导入按消息 ID 合并，重复消息跳过；不会删除当前聊天记录。
 */

export const CHAT_TRANSFER_FORMAT = 'acsus-phone-chat';
export const CHAT_TRANSFER_VERSION = 1;
export const MAX_CHAT_TRANSFER_BYTES = 32 * 1024 * 1024;
export const MAX_CHAT_TRANSFER_MESSAGES = 50000;

const MAX_VALUE_DEPTH = 12;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_SENDERS = new Set(['user', 'contact', 'system']);

/**
 * @typedef {Object} ChatTransferCharacter
 * @property {string} id
 * @property {string} name
 * @property {string} avatar
 */

/**
 * @typedef {Object} ChatTransferPackage
 * @property {string} format
 * @property {number} version
 * @property {string} exportedAt
 * @property {ChatTransferCharacter} character
 * @property {number} messageCount
 * @property {Array<Object>} messages
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * JSON 安全克隆；同时拒绝异常深层结构和原型污染键。
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
function cloneJsonValue(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('消息中包含无效数字');
    return value;
  }
  if (depth > MAX_VALUE_DEPTH) throw new TypeError('消息嵌套层级过深');
  if (Array.isArray(value)) {
    return value.map(item => cloneJsonValue(item, depth + 1));
  }
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError('消息中包含不支持的数据类型');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('消息结构不是普通对象');

  const result = {};
  for (const key of Object.keys(value)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (value[key] === undefined) continue;
    result[key] = cloneJsonValue(value[key], depth + 1);
  }
  return result;
}

/**
 * 把任意字符串变成适合做 ID / 文件名的片段。
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 */
function safeKeyPart(value, fallback) {
  const text = String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return text || fallback;
}

function normalizeCharacter(character) {
  if (!isRecord(character)) throw new TypeError('导出文件缺少角色信息');
  const id = typeof character.id === 'string' ? character.id.trim() : '';
  const name = typeof character.name === 'string' ? character.name.trim() : '';
  if (!id) throw new TypeError('导出文件缺少角色 ID');
  if (!name) throw new TypeError('导出文件缺少角色名称');
  return {
    id,
    name,
    avatar: typeof character.avatar === 'string' ? character.avatar : '',
  };
}

/**
 * 给缺失 ID 的消息生成稳定的导出 ID。
 * @param {Object} message
 * @param {string} contactId
 * @param {number} index
 * @returns {string}
 */
function ensureExportMessageId(message, contactId, index) {
  if (typeof message.id === 'string' && message.id.trim()) return message.id;
  const time = isFiniteNumber(message.time) ? Math.floor(message.time) : 0;
  return `msg_export_${safeKeyPart(contactId, 'chat')}_${index}_${time}`;
}

/**
 * 构造某角色的聊天导出包。
 *
 * @param {Object} options
 * @param {Object} options.contact - 联系人对象（只读取 id / name / avatar 快照）
 * @param {Array<Object>} options.messages - 当前聊天消息数组
 * @param {string} [options.exportedAt] - ISO 时间；测试时可固定
 * @returns {ChatTransferPackage}
 */
export function createChatTransfer({ contact, messages, exportedAt = new Date().toISOString() }) {
  if (!isRecord(contact)) throw new TypeError('缺少角色信息');
  if (!Array.isArray(messages)) throw new TypeError('缺少聊天消息数组');
  if (messages.length > MAX_CHAT_TRANSFER_MESSAGES) {
    throw new RangeError(`聊天消息超过 ${MAX_CHAT_TRANSFER_MESSAGES} 条，无法一次导出`);
  }

  const character = normalizeCharacter({
    id: contact.id,
    name: contact.name,
    avatar: contact.avatar,
  });

  const cleanedMessages = messages.map((message, index) => {
    if (!isRecord(message)) throw new TypeError(`第 ${index + 1} 条消息不是对象`);
    const cleaned = /** @type {Object} */ (cloneJsonValue(message));
    cleaned.id = ensureExportMessageId(cleaned, character.id, index);
    if (typeof cleaned.sender !== 'string' || !ALLOWED_SENDERS.has(cleaned.sender)) {
      throw new TypeError(`第 ${index + 1} 条消息的发送者无效`);
    }
    if (typeof cleaned.type !== 'string' || !cleaned.type.trim()) {
      throw new TypeError(`第 ${index + 1} 条消息缺少类型`);
    }
    if (!isFiniteNumber(cleaned.time)) {
      throw new TypeError(`第 ${index + 1} 条消息缺少有效时间`);
    }
    return cleaned;
  });

  return {
    format: CHAT_TRANSFER_FORMAT,
    version: CHAT_TRANSFER_VERSION,
    exportedAt,
    character,
    messageCount: cleanedMessages.length,
    messages: cleanedMessages,
  };
}

/**
 * 解析并校验聊天导出文本。只接受本功能生成的格式。
 *
 * @param {string} text
 * @returns {ChatTransferPackage}
 */
export function parseChatTransferText(text) {
  if (typeof text !== 'string') throw new TypeError('导入文件不是文本');
  if (text.length > MAX_CHAT_TRANSFER_BYTES) {
    throw new RangeError('导入文件超过 32 MiB');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyntaxError('文件不是有效的 JSON');
  }

  return validateChatTransfer(parsed);
}

/**
 * 校验已经解析的聊天导出对象。
 *
 * @param {*} parsed
 * @returns {ChatTransferPackage}
 */
export function validateChatTransfer(parsed) {
  if (!isRecord(parsed)) throw new TypeError('聊天导出文件必须是 JSON 对象');
  if (parsed.format !== CHAT_TRANSFER_FORMAT) {
    throw new TypeError('不是聊天记录导出文件；请选择本功能导出的 JSON');
  }
  if (parsed.version !== CHAT_TRANSFER_VERSION) {
    throw new TypeError(`不支持的聊天记录版本：${parsed.version}`);
  }
  if (typeof parsed.exportedAt !== 'string' || !parsed.exportedAt.trim()) {
    throw new TypeError('导出文件缺少导出时间');
  }

  const character = normalizeCharacter(parsed.character);
  if (!Array.isArray(parsed.messages)) throw new TypeError('导出文件缺少消息数组');
  if (parsed.messages.length > MAX_CHAT_TRANSFER_MESSAGES) {
    throw new RangeError(`聊天消息超过 ${MAX_CHAT_TRANSFER_MESSAGES} 条`);
  }
  if (parsed.messageCount !== undefined && parsed.messageCount !== parsed.messages.length) {
    throw new TypeError('消息数量与 messageCount 不一致，文件可能不完整');
  }

  const fileKey = safeKeyPart(parsed.exportedAt, 'import');
  const messages = parsed.messages.map((message, index) => {
    if (!isRecord(message)) throw new TypeError(`第 ${index + 1} 条消息不是对象`);
    const cleaned = /** @type {Object} */ (cloneJsonValue(message));

    if (!isFiniteNumber(cleaned.time)) throw new TypeError(`第 ${index + 1} 条消息缺少有效时间`);
    if (typeof cleaned.sender !== 'string' || !ALLOWED_SENDERS.has(cleaned.sender)) {
      throw new TypeError(`第 ${index + 1} 条消息的发送者无效`);
    }
    if (typeof cleaned.type !== 'string' || !cleaned.type.trim()) {
      throw new TypeError(`第 ${index + 1} 条消息缺少类型`);
    }
    if (typeof cleaned.id !== 'string' || !cleaned.id.trim()) {
      cleaned.id = `msg_import_${safeKeyPart(character.id, 'chat')}_${fileKey}_${index}`;
    }
    return cleaned;
  });

  return {
    format: CHAT_TRANSFER_FORMAT,
    version: CHAT_TRANSFER_VERSION,
    exportedAt: parsed.exportedAt,
    character,
    messageCount: messages.length,
    messages,
  };
}

function messageTime(message) {
  return isFiniteNumber(message?.time) ? message.time : Number.MAX_SAFE_INTEGER;
}

/**
 * 把导入消息合并进当前聊天。已有相同 ID 的消息会被跳过。
 * 合并结果按消息时间升序排列，时间相同的消息保持原有先后。
 *
 * @param {Array<Object>} currentMessages
 * @param {Array<Object>} importedMessages
 * @returns {{ messages: Array<Object>, addedCount: number, skippedCount: number }}
 */
export function mergeChatHistory(currentMessages, importedMessages) {
  if (!Array.isArray(currentMessages)) throw new TypeError('当前聊天记录不是数组');
  if (!Array.isArray(importedMessages)) throw new TypeError('导入聊天记录不是数组');

  const seenIds = new Set();
  const indexed = currentMessages.map((message, index) => {
    if (message && typeof message.id === 'string' && message.id) seenIds.add(message.id);
    return { message, index };
  });

  const additions = [];
  let skippedCount = 0;
  for (const message of importedMessages) {
    if (!isRecord(message)) throw new TypeError('导入消息不是对象');
    if (typeof message.id !== 'string' || !message.id) throw new TypeError('导入消息缺少 ID');
    if (seenIds.has(message.id)) {
      skippedCount += 1;
      continue;
    }
    seenIds.add(message.id);
    additions.push({ message, index: indexed.length + additions.length });
  }

  const merged = [...indexed, ...additions].sort((left, right) => {
    const timeDifference = messageTime(left.message) - messageTime(right.message);
    return timeDifference || left.index - right.index;
  });

  return {
    messages: merged.map(item => item.message),
    addedCount: additions.length,
    skippedCount,
  };
}
