import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usageActivity, cacheInputTokens} from '../src/usage-activity.js';
test('monthly data uses Beijing dates, excludes invalid/future rows and retains every daily metric', () => {
 const records = [
  {createdAt:'2026-09-30T16:10:00Z',status:200,inputTokens:10,outputTokens:5,cachedTokens:80,durationMs:200,responseJSON:JSON.stringify({usage:{input_tokens:10,cache_read_input_tokens:80,cache_creation_input_tokens:10}})},
  {createdAt:'2026-10-01T02:00:00Z',status:500,inputTokens:100,outputTokens:0,cachedTokens:20,durationMs:400,cacheInputTokens:100},
  {createdAt:'invalid',status:200}, {createdAt:'2026-10-03T00:00:00Z',status:200}
 ];
 const result=usageActivity(records,new Date('2026-10-02T00:00:00Z'));
 assert.equal(result.firstDate,'2026-10-01');assert.equal(result.retainedRequests,2);
 assert.deepEqual(result.days,[{date:'2026-10-01',requests:2,tokens:115,inputTokens:110,outputTokens:5,cachedTokens:100,cacheInputTokens:200,estimatedCacheRequests:0,durationMs:600,errors:1}]);
});
test('cache denominator handles both provider formats and marks unknown historical cache estimates', () => {
 assert.equal(cacheInputTokens({responseJSON:'{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80}}}'}),100);
 assert.equal(cacheInputTokens({responseJSON:'{"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}}'}),100);
 const result=usageActivity([{createdAt:'2026-10-01T00:00:00Z',status:200,inputTokens:10,cachedTokens:90}],new Date('2026-10-02T00:00:00Z'));
 assert.equal(result.days[0].estimatedCacheRequests,1);assert.equal(result.days[0].cacheInputTokens,90);
 assert.deepEqual(usageActivity([],new Date('2026-10-02T00:00:00Z')).days,[]);
});

test('normalized cache totals persist in the lightweight index across restart', async () => {
 const {mkdtemp, readFile, rm} = await import('node:fs/promises');
 const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
 const {createModelRequestStore} = await import('../src/model-request-store.js');
 const directory = await mkdtemp(join(tmpdir(), 'lumi-usage-index-'));
 try {
  const store = createModelRequestStore(directory);
  await store.append({id:'cache',createdAt:new Date().toISOString(),inputTokens:10,cachedTokens:80,requestJSON:'private prompt',responseJSON:'{"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}}'});
  const index=JSON.parse(await readFile(join(directory,'model-request-index.json'),'utf8'));
  assert.equal(index.requests[0].cacheInputTokens,100);
  assert.ok(!JSON.stringify(index).includes('private prompt'));
  assert.equal((await createModelRequestStore(directory).read())[0].cacheInputTokens,100);
 } finally {await rm(directory,{recursive:true,force:true});}
});
