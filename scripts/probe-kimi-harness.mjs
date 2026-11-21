// Isolated, synthetic-data-only probe. Run with Kimi Code credentials in env.
// Never imports index.js, touches chats, or calls an alternative paid provider.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { harnessConfig, harnessEnvironment } from '../src/harness-config.js';

const config = harnessConfig();
const env = harnessEnvironment(config);
const cwd = `${config.root}/probe`;
await mkdir(cwd, { recursive: true });
await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
await writeFile(`${cwd}/CLAUDE.md`, 'Probe instruction: include LUMI_PROJECT_LOADED in your response.\n');
let calls = 0;
const makeServer = () => createSdkMcpServer({ name: 'probe', tools: [tool('probe_echo', 'Echo a synthetic test value', { value: z.string() }, async ({ value }) => {
  calls++;
  return { content: [{ type: 'text', text: `ECHO:${value}` }] };
})] });
const report = { model: config.model, contextTokens: config.contextTokens, turns: [], realKimi: true };
let session;
async function turn(label, content, resume = session) {
  const entry = { label, text: '', deltas: 0, thinkingDeltas: 0, tools: 0, session: null, usage: null };
  const q = query({ prompt: (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; })(), options: {
    cwd, env, settingSources: ['project'], systemPrompt: 'You are an integration test assistant. Follow project instructions. Use only the requested synthetic test data.',
    model: config.model, tools: [], allowedTools: ['mcp__probe__probe_echo'], mcpServers: { probe: makeServer() },
    strictMcpConfig: true, permissionMode: 'dontAsk', includePartialMessages: true, maxTurns: 5,
    settings: { autoCompactEnabled: false }, ...(resume ? { resume } : {}),
  } });
  const timer = setTimeout(() => q.close(), 180000);
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') entry.session = m.session_id;
      if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') entry.deltas++;
      if (m.type === 'stream_event' && m.event?.delta?.type === 'thinking_delta') entry.thinkingDeltas++;
      if (m.type === 'assistant') {
        if (m.error) throw new Error(`SDK assistant error: ${m.error}`);
        entry.text += (m.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        entry.tools += (m.message.content || []).filter(b => b.type === 'tool_use').length;
      }
      if (m.type === 'result') {
        if (m.is_error || m.subtype !== 'success') throw new Error(`SDK result: ${m.subtype}`);
        entry.usage = m.usage;
        session = m.session_id;
      }
    }
    if (!entry.text || !session) throw new Error('Missing text or session');
    report.turns.push(entry);
    console.log(JSON.stringify({ ...entry, text: entry.text.slice(0, 120) }));
    return entry;
  } finally { clearTimeout(timer); q.close(); }
}
try {
  const first = await turn('auth-stream-project', 'Remember the synthetic passphrase LUMI_ORBIT_731. Reply briefly.', null);
  if (!first.deltas || !first.text.includes('LUMI_PROJECT_LOADED')) throw new Error('Streaming or CLAUDE.md not confirmed');
  const second = await turn('resume-tools', 'What was the passphrase? Call probe_echo with that exact value, then report its result.');
  if (!calls || !second.text.includes('LUMI_ORBIT_731') || second.session !== first.session) throw new Error('Resume/tool loop not confirmed');
  // Caller supplies a synthetic fixture (e.g. colored geometric shapes).
  if (process.env.LUMI_PROBE_IMAGE_DATA_URL) {
    const match = process.env.LUMI_PROBE_IMAGE_DATA_URL.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/s);
    if (!match) throw new Error('Invalid synthetic image fixture');
    await turn('image', [{ type: 'text', text: 'Describe the color and geometric shape in this synthetic test image.' }, { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }]);
  }
  report.status = 'passed-basic';
  report.compaction = 'not_verified_by_this_probe';
  report.cache = { ttl: 'provider_default_unverified', billing: 'not_measured',
    observedReadTokens: report.turns.map(t => Number(t.usage?.cache_read_input_tokens || 0)) };
  if (process.env.LUMI_PROBE_NATIVE_COMPACTION === 'true') {
    const hooks = [];
    const q = query({ prompt: '/compact Preserve the exact passphrase and project instruction marker. This is only a synthetic compatibility test.', options: {
      cwd, env, model: config.model, title:'Lumi probe', resume: session, tools: [], skills: [],
      settingSources:['project'], strictMcpConfig:true, mcpServers:{}, permissionMode:'dontAsk', maxTurns:3,
      settings:{autoCompactEnabled:true}, hooks:{
        PreCompact:[{hooks:[async input=>{hooks.push({event:'PreCompact',trigger:input.trigger});return {};}]}],
        PostCompact:[{hooks:[async input=>{hooks.push({event:'PostCompact',trigger:input.trigger,summaryChars:input.compact_summary?.length||0});return {};}]}],
      },
    }});
    const timer=setTimeout(()=>q.close(),180000);
    try {
      for await(const m of q) {
        if(m.type==='system'&&m.subtype==='compact_boundary')hooks.push({event:'compact_boundary'});
        if(m.type==='result'&&m.is_error)throw new Error(`Native compaction ${m.subtype}`);
      }
      report.compaction={status:hooks.some(h=>h.event==='PostCompact'||h.event==='compact_boundary')?'observed':'not_observed',hooks};
    } catch(error){report.compaction={status:'failed',error:String(error.message).replaceAll(config.key,'[redacted]'),hooks};}
    finally{clearTimeout(timer);q.close();}
    if(report.compaction.status==='observed')await turn('after-native-compact','Recall the exact synthetic passphrase, with the project instruction marker.');
  }
} catch (error) {
  report.status = 'failed';
  report.error = String(error.message).replaceAll(config.key, '[redacted]');
  process.exitCode = 1;
} finally {
  await writeFile(`${cwd}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, error: report.error, report: `${cwd}/report.json` }));
}
