import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveSnapshot,archiveChanges,archiveChangeBlocks} from '../src/harness-continuity.js';
import {historyFingerprint} from '../src/harness-state.js';
const message=(id,content,role='user')=>({id,role,content});
test('archive delta identifies appended turns, corrections and exclusions without replaying unchanged history',()=>{
 const old=[message('a','保留原话'),message('b','更正前'),message('c','移除前','assistant')];
 const current=[old[0],message('b','更正后'),message('d','另一个会话的新内容','assistant')];
 const changes=archiveChanges(archiveSnapshot(old),current,historyFingerprint(old),historyFingerprint(current));
 assert.deepEqual(changes.map(x=>x.action),['correct','remove','add']);
 assert.equal(changes[0].previous.content,'更正前');assert.equal(changes[0].current.content,'更正后');
 assert.equal(changes[1].previous.content,'移除前');assert.ok(!JSON.stringify(changes).includes('保留原话'));
 assert.match(archiveChangeBlocks(changes)[0].text,/引用资料/);
});
test('legacy checkpoints migrate from an archive prefix without resetting the session',()=>{
 const old=[message('a','原话')],current=[...old,message('b','醒来的消息','assistant')];
 assert.deepEqual(archiveChanges(undefined,current,historyFingerprint(old),historyFingerprint(current)).map(x=>x.action),['add']);
 assert.deepEqual(archiveChanges(undefined,old,historyFingerprint(old),historyFingerprint(old)),[]);
});
test('predicted assistant checkpoint matches its subsequently assigned archive ID',()=>{
 const old=[message('a','原话'),{role:'assistant',content:'回复'}];
 const current=[old[0],message('new-id','回复','assistant'),message('wake-id','自主消息','assistant')];
 const changes=archiveChanges(archiveSnapshot(old),current,historyFingerprint(old),historyFingerprint(current));
 assert.equal(changes.length,1);assert.equal(changes[0].message.id,'wake-id');
});
