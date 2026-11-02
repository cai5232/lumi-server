import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/xiaohongshu.js';

test('extracts note, comments and allowed image URLs without altering text', () => {
  const html = `<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"title":"undefined 的含义","desc":"正文","user":{"nickName":"作者"},"imageList":[{"url":"http://sns-webpic-qc.xhscdn.com/pic"}]},"commentData":{"comments":[{"user":{"nickname":"读者"},"content":"评论"}]}},"optional":undefined}}</script>`;
  const note = parseNote(html, 'https://www.xiaohongshu.com/discovery/item/1');
  assert.equal(note.title, 'undefined 的含义');
  assert.equal(note.author, '作者');
  assert.deepEqual(note.images, ['https://sns-webpic-qc.xhscdn.com/pic']);
  assert.deepEqual(note.comments, [{ user: '读者', content: '评论' }]);
});

test('rejects pages with no usable state', () => {
  assert.throws(() => parseNote('<html>blocked</html>', 'https://www.xiaohongshu.com/'));
});

test('does not silently omit images from an untrusted host', () => {
  const html = `<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"title":"x","imageList":[{"url":"https://evil.example/a"}]}}}}</script>`;
  assert.throws(() => parseNote(html, 'https://www.xiaohongshu.com/'));
});
