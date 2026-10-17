// Provider timings use different units; public episode captions always use seconds.
export function miniMaxCaptions(raw) {
  if (!Array.isArray(raw)) return [];
  return validCaptions(raw.map(item => ({ text: String(item.text || '').trim(), start: Number(item.time_begin) / 1000, end: Number(item.time_end) / 1000 })));
}

export function validCaptions(captions) {
  return captions.filter(item => /[\p{L}\p{N}]/u.test(item.text) && Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start)
    .sort((a, b) => a.start - b.start);
}

export function elevenLabsCaptions(alignment) {
  const characters = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  const captions = [];
  let text = '', start = 0, end = 0;
  const flush = () => { if (text.trim()) captions.push({ text: text.trim(), start, end }); text = ''; };
  for (let i = 0; i < characters.length; i += 1) {
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i])) continue;
    if (!text) start = starts[i];
    text += characters[i]; end = ends[i];
    if (/[。！？!?；;\n]/u.test(characters[i]) || (text.length >= 32 && /[，,、]/u.test(characters[i])) || text.length >= 70) flush();
  }
  flush();
  return validCaptions(captions);
}

// Count MPEG Layer III frames, including encoder padding, to preserve offsets
// when concatenating multiple MP3 responses. ID3 tags are skipped, not timed.
export function mp3Duration(audio) {
  let seconds = 0, frames = 0;
  for (let offset = 0; offset + 4 <= audio.length;) {
    if (audio.toString('ascii', offset, offset + 3) === 'ID3' && offset + 10 <= audio.length) {
      const size = ((audio[offset + 6] & 127) << 21) | ((audio[offset + 7] & 127) << 14) | ((audio[offset + 8] & 127) << 7) | (audio[offset + 9] & 127);
      offset += 10 + size + ((audio[offset + 5] & 16) ? 10 : 0); continue;
    }
    const header = audio.readUInt32BE(offset);
    const version = (header >>> 19) & 3, layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15, rateIndex = (header >>> 10) & 3;
    if ((header >>> 21) !== 2047 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) { offset += 1; continue; }
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex] * 1000;
    const sampleRate = [44100,48000,32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((header >>> 9) & 1);
    if (offset + length > audio.length) break;
    seconds += (version === 3 ? 1152 : 576) / sampleRate;
    frames += 1; offset += length;
  }
  return frames ? seconds : 0;
}
