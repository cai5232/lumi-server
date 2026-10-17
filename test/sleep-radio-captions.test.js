import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { miniMaxCaptions, elevenLabsCaptions, mp3Duration } from '../src/sleep-radio-captions.js';

test('MiniMax converts milliseconds and filters malformed or pause-only captions', () => {
  assert.deepEqual(miniMaxCaptions([{ text: '晚安。', time_begin: 500, time_end: 2000 }, { text: '……', time_begin: 0, time_end: 100 }, { text: '无效', time_begin: -1, time_end: 100 }]), [{ text: '晚安。', start: 0.5, end: 2 }]);
});

test('ElevenLabs character timings form readable sentence cues', () => {
  assert.deepEqual(elevenLabsCaptions({ characters: ['晚','安','。','好','梦','。'], character_start_times_seconds: [0,0.5,1,2,2.5,3], character_end_times_seconds: [0.5,1,1.5,2.5,3,3.5] }), [{ text: '晚安。', start: 0, end: 1.5 }, { text: '好梦。', start: 2, end: 3.5 }]);
});

test('MP3 duration ignores ID3 tags and includes each complete frame', () => {
  const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9000);
  const id3 = Buffer.from([73,68,51,4,0,0,0,0,0,0]);
  assert.ok(Math.abs(mp3Duration(Buffer.concat([id3, frame, frame])) - 2304/44100) < 1e-9);
  assert.equal(mp3Duration(Buffer.from('invalid')), 0);
});

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function synthesizeSpeech(text, settings) {');
const synth = source.slice(start, source.indexOf('\nasync function readSleepRadioSettings()', start));
for (const provider of ['minimax', 'elevenlabs']) {
  test(`${provider}: chunk captions retain cumulative audio offsets`, async () => {
    const requests = [];
    const context = {
      spokenReply: value => value, splitCallSpeech: value => value.match(/.{1,200}/gu),
      miniMaxCaptions, elevenLabsCaptions, mp3Duration,
      ttsModels: ['test'], elevenLabsModels: ['test'], ttsTimeoutMs: 1000,
      Buffer, URL, AbortSignal, console,
      fetch: async (url, options) => {
        const endpoint = String(url);
        if (endpoint.startsWith('https://captions.example/')) return { ok: true, json: async () => [{ text: '安静的夜。', time_begin: 0, time_end: 1000 }] };
        requests.push({ url: endpoint, body: JSON.parse(options.body) });
        if (provider === 'minimax') return { ok: true, json: async () => ({ data: { audio: Buffer.from('audio').toString('hex'), subtitle_file: 'https://captions.example/test' }, extra_info: { audio_length: 1000 } }) };
        return { ok: true, arrayBuffer: async () => Buffer.from('audio'), json: async () => ({ audio_base64: Buffer.from('audio').toString('base64'), alignment: { characters: ['晚','安','。'], character_start_times_seconds: [0,0.3,0.6], character_end_times_seconds: [0.3,0.6,1] } }) };
      }
    };
    vm.createContext(context); vm.runInContext(synth, context);
    const speech = await context.synthesizeSpeech('静'.repeat(500), { provider, model: 'test', voiceID: 'voice', apiKey: 'fake-test', includeSubtitles: true });
    assert.equal(speech.duration, 3);
    assert.deepEqual(Array.from(speech.subtitles, cue => cue.start), [0,1,2]);
    assert.deepEqual(Array.from(speech.subtitles, cue => cue.end), [1,2,3]);
    assert.equal(requests.length, 3);
    if (provider === 'minimax') assert.ok(requests.every(request => request.body.subtitle_enable === true));
    else assert.ok(requests.every(request => request.url.includes('/with-timestamps?')));
    requests.length = 0;
    const normal = await context.synthesizeSpeech('晚安。', { provider, model: 'test', voiceID: 'voice', apiKey: 'fake-test' });
    assert.equal(normal.audioBase64, Buffer.from('audio').toString('base64'));
    assert.equal(normal.subtitles, undefined);
    assert.ok(!requests[0].body.subtitle_enable);
    assert.ok(!requests[0].url.includes('/with-timestamps'));

  });
}
