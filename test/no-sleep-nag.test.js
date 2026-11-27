import test from 'node:test';
import assert from 'node:assert/strict';
import { sleepNagViolations, sleepRequested, createSleepNagGuard, assertNoSleepNag } from '../src/no-sleep-nag.js';

test('PDF Chinese, Japanese and English nag/goodnight phrases are blocked without an invitation',()=>{
  for(const reply of ['嗯，累了一整天。晚安。','早点睡。','闭上眼睛。','身体在关机了。','おやすみ。','早く寝なさい。','休んでください。','Good night.','go to bed','you should get some sleep','lights out','put your phone down',"your body's shutting down"]){
    assert.ok(sleepNagViolations(reply,'今天聊得好开心').length,reply);
  }
});

test('only this turn’s explicit user sleep intent allows goodnight, not negated wishes',()=>{
  for(const user of ['我要睡了，晚安','我先睡了','困了','もう寝る','眠い',"I'm going to bed",'heading to sleep','I need some rest','good night']){
    assert.equal(sleepRequested(user),true,user);assert.deepEqual(sleepNagViolations('晚安。',user),[],user);
  }
  for(const user of ['我不困了','我没说我要睡了','我不想睡觉','眠くない',"I'm not going to sleep","don't say good night"]){
    assert.equal(sleepRequested(user),false,user);
  }
});

test('PDF negation behavior is retained; quotations/meta discussion do not exempt positive nag phrases',()=>{
  for(const reply of ['我不说晚安。','おやすみはまだ言わない。',"No need to go to bed."]){assert.deepEqual(sleepNagViolations(reply),[],reply);}
  assert.ok(sleepNagViolations('只是引用一句：“早点睡”。').length);
  assert.ok(sleepNagViolations('我不会催你早点睡。').length,'hard phrases retain the PDF’s strict matching');
  assert.deepEqual(sleepNagViolations('我们继续聊星星吧。'),[]);
});

test('private memory/control payloads and thinking are not visible nags; spoken/HTML messages are checked',()=>{
  assert.deepEqual(sleepNagViolations('<thinking>不能说晚安</thinking><memory>记得我们道过晚安。</memory>陪你。'),[]);
  assert.deepEqual(sleepNagViolations('[[LUMI_SILENT_WAKE]]<sentinel_decision>{"action":"none"}</sentinel_decision>'),[]);
  assert.ok(sleepNagViolations('<speech>早点睡</speech>').length);
  assert.ok(sleepNagViolations('<html><p>晚<b>安</b></p></html>').length);
  assert.ok(sleepNagViolations('<p>晚&#x5b89;</p>').length);
});

test('Stop requests one rewrite, then final delivery fails closed instead of looping',async()=>{
  const g=createSleepNagGuard({userText:'想继续聊'});
  const first=await g.stop({stop_hook_active:false,last_assistant_message:'早点睡。'});
  assert.equal(first.decision,'block');assert.equal(g.rewrites,1);
  assert.deepEqual(await g.stop({stop_hook_active:true,last_assistant_message:'晚安。'}),{});
  assert.deepEqual(await g.stop({stop_hook_active:false,last_assistant_message:'晚安。'}),{});
  assert.throws(()=>g.validate('晚安。'),e=>e.code==='sleep_nag_blocked'&&e.statusCode===422);
  assert.doesNotThrow(()=>g.validate('那陪你继续聊。'));
  assert.equal(g.diagnostic().rewrites,1);assert.equal(g.diagnostic().checks,3);
  assert.ok(!JSON.stringify(g.diagnostic()).includes('想继续聊'),'diagnostics contain no private messages');
});

test('explicit sleep permission is per run and cannot bleed into autonomous wake',async()=>{
  const bedtime=createSleepNagGuard({userText:'我要睡了'}),wake=createSleepNagGuard({userText:''});
  assert.deepEqual(await bedtime.stop({last_assistant_message:'晚安。'}),{});
  assert.equal((await wake.stop({last_assistant_message:'晚安。'})).decision,'block');
  assert.throws(()=>assertNoSleepNag('晚安。','继续聊'),/禁催睡/);
});
