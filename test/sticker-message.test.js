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

test('AI can select one shared sticker; unknown IDs and external URLs cannot attach images', async () => {
  const {sharedStickerContext,extractStickerReply}=await import('../src/stickers.js');
  const sticker={id:'12345678-1234-1234-1234-123456789abc',name:'抱抱',image:'/v1/stickers/assets/12345678-1234-1234-1234-123456789abc.png'};
  assert.ok(sharedStickerContext([sticker]).includes(sticker.id));
  assert.equal(sharedStickerContext([]),'');
  assert.deepEqual(extractStickerReply(`抱抱你\n[发送表情:${sticker.id}]`,[sticker]),{content:'抱抱你',sticker});
  assert.deepEqual(extractStickerReply('嘿嘿[发送表情:https://example.com/a.png]',[sticker]),{content:'嘿嘿',sticker:null});
  assert.equal(extractStickerReply('[发送表情:00000000-0000-0000-0000-000000000000]',[sticker]).sticker,null);
});
