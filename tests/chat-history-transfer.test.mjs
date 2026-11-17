import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_TRANSFER_FORMAT,
  CHAT_TRANSFER_VERSION,
  createChatTransfer,
  mergeChatHistory,
  parseChatTransferText,
  validateChatTransfer,
} from '../toolkit/phone/messages/chat-history-transfer.js';

const contact = { id: 'tavern_alice', name: 'Alice', avatar: 'alice.png' };
const message = (overrides = {}) => ({
  id: 'msg_1',
  sender: 'user',
  type: 'text',
  content: 'hello',
  time: 100,
  ...overrides,
});
const payload = (messages, extra = {}) => ({
  format: CHAT_TRANSFER_FORMAT,
  version: CHAT_TRANSFER_VERSION,
  exportedAt: '2026-11-17T00:00:00.000Z',
  character: { ...contact },
  messageCount: messages.length,
  messages,
  ...extra,
});

test('creates a single-character export with stable metadata', () => {
  const transfer = createChatTransfer({
    contact,
    messages: [message()],
    exportedAt: '2026-11-17T00:00:00.000Z',
  });

  assert.equal(transfer.format, CHAT_TRANSFER_FORMAT);
  assert.equal(transfer.version, 1);
  assert.deepEqual(transfer.character, { id: 'tavern_alice', name: 'Alice', avatar: 'alice.png' });
  assert.equal(transfer.messageCount, 1);
  assert.equal(transfer.messages[0].content, 'hello');
  assert.equal(transfer.messages[0].id, 'msg_1');
});

test('fills missing message ids without changing the source message', () => {
  const source = message({ id: undefined });
  const transfer = createChatTransfer({ contact, messages: [source] });
  assert.equal(source.id, undefined);
  assert.match(transfer.messages[0].id, /^msg_export_tavern_alice_0_100$/);
});

test('drops undefined fields while retaining message data', () => {
  const transfer = createChatTransfer({
    contact,
    messages: [message({ emojiName: undefined, quote: { id: 'q1', content: undefined } })],
  });
  assert.equal('emojiName' in transfer.messages[0], false);
  assert.deepEqual(transfer.messages[0].quote, { id: 'q1' });
});

test('rejects malformed source messages before export', () => {
  assert.throws(() => createChatTransfer({ contact, messages: [message({ sender: 'developer' })] }), /发送者无效/);
  assert.throws(() => createChatTransfer({ contact, messages: [message({ time: '100' })] }), /有效时间/);
  assert.throws(() => createChatTransfer({ contact, messages: [message({ type: '' })] }), /缺少类型/);
  assert.throws(() => createChatTransfer({ contact, messages: [null] }), /不是对象/);
});

test('parses a generated file back to the same message count', () => {
  const transfer = createChatTransfer({
    contact,
    messages: [message(), message({ id: 'msg_2', time: 200, content: 'second' })],
    exportedAt: '2026-11-17T00:00:00.000Z',
  });
  const parsed = parseChatTransferText(JSON.stringify(transfer));

  assert.deepEqual(parsed.character, { id: 'tavern_alice', name: 'Alice', avatar: 'alice.png' });
  assert.equal(parsed.messageCount, 2);
  assert.deepEqual(parsed.messages.map(item => item.content), ['hello', 'second']);
});

test('rejects other backup formats and broken packages', () => {
  assert.throws(
    () => parseChatTransferText(JSON.stringify({ ...payload([message()]), format: 'acsus-phone-standalone' })),
    /不是聊天记录导出文件/,
  );
  assert.throws(
    () => parseChatTransferText(JSON.stringify(payload([message()], { messageCount: 2 }))),
    /消息数量/,
  );
  assert.throws(
    () => parseChatTransferText(JSON.stringify(payload([message({ sender: 'bot' })]))),
    /发送者无效/,
  );
  assert.throws(() => parseChatTransferText(JSON.stringify(payload([message()], { version: 2 }))), /不支持/);
  assert.throws(() => parseChatTransferText('not json'), /不是有效的 JSON/);
});

test('imports files whose messages have no ids with stable generated ids', () => {
  const imported = validateChatTransfer(payload([message({ id: undefined })]));
  assert.match(imported.messages[0].id, /^msg_import_tavern_alice_2026-11-17T00_00_00_000Z_0$/);

  const second = validateChatTransfer(payload([message({ id: undefined })]));
  assert.equal(imported.messages[0].id, second.messages[0].id);
});

test('drops prototype pollution keys from imported messages', () => {
  const unsafe = JSON.parse('{"id":"msg_1","sender":"user","type":"text","time":100,"content":"ok","__proto__":{"polluted":true},"nested":{"constructor":{"bad":true},"safe":"yes"}}');
  const imported = validateChatTransfer(payload([unsafe]));

  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(imported.messages[0], '__proto__'), false);
  assert.equal(Object.hasOwn(imported.messages[0].nested, 'constructor'), false);
  assert.equal(imported.messages[0].nested.safe, 'yes');
});

test('merges by message id and keeps chronological order', () => {
  const current = [message({ id: 'msg_old', time: 100, content: 'old' }), message({ id: 'msg_current', time: 300 })];
  const imported = [
    message({ id: 'msg_new', time: 200, content: 'new' }),
    message({ id: 'msg_current', time: 300, content: 'duplicate' }),
    message({ id: 'msg_newer', time: 400, content: 'newer' }),
  ];
  const result = mergeChatHistory(current, imported);

  assert.equal(result.addedCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(result.messages.map(item => item.id), ['msg_old', 'msg_new', 'msg_current', 'msg_newer']);
  assert.equal(result.messages[2].content, 'hello');
});

test('does not claim success when every imported message already exists', () => {
  const result = mergeChatHistory([message()], [message({ content: 'duplicate' })]);
  assert.equal(result.addedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.messages.length, 1);
});

test('rejects invalid merge arguments', () => {
  assert.throws(() => mergeChatHistory(null, []), /当前聊天记录不是数组/);
  assert.throws(() => mergeChatHistory([], null), /导入聊天记录不是数组/);
  assert.throws(() => mergeChatHistory([], [{ sender: 'user' }]), /缺少 ID/);
});
