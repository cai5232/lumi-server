import test from 'node:test';
import assert from 'node:assert/strict';
import {stickerMessageForModel} from '../src/stickers.js';

test('caption plus legacy marker keeps both caption and saved name', () => {
  assert.equal(stickerMessageForModel({content:'老公\n[表情: 好日子我来了]'}), '老公\n[用户发送了贴纸「好日子我来了」]');
});
test('explicit name and catalog name work without a marker', () => {
  assert.equal(stickerMessageForModel({content:'老公',stickerName:'好日子我来了'}), '老公\n[用户发送了贴纸「好日子我来了」]');
  assert.equal(stickerMessageForModel({content:'老公'}, {name:'蹭蹭'}), '老公\n[用户发送了贴纸「蹭蹭」]');
});
test('sticker alone, Chinese colon, and bracketed names remain compatible', () => {
  assert.equal(stickerMessageForModel({content:'[表情: 开心]'}), '[用户发送了贴纸「开心」]');
  assert.equal(stickerMessageForModel({content:'早安\n[表情：猫猫]'}), '早安\n[用户发送了贴纸「猫猫」]');
  assert.equal(stickerMessageForModel({content:'[表情: [开心]]',stickerName:'[开心]'}).includes('贴纸「[开心]」'), true);
});
