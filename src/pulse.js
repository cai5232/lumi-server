import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const minute = 60_000;
const day = 24 * 60 * minute;
const sampleInterval = 5 * minute;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, places = 0) => Number(value.toFixed(places));

const feelings = {
  bright: { match: /好开心|开心|好耶|太棒了|哈哈|[😂😄🎉]/gu, bpm: 9, celsius: 0.12, breath: 0.5, halfLife: 12, chord: "Gmaj7", event: "心跳轻快了一点。" },
  tense: { match: /吓死|吓到|紧张|害怕|生气|[😨😤]/gu, bpm: 19, celsius: 0.13, breath: 2, halfLife: 16, chord: "Dm7", event: "心跳提了上来，呼吸也跟着变快。" },
  low: { match: /不开心|难过|伤心|委屈|好累|[😢🥺]/gu, bpm: -5, celsius: -0.08, breath: -0.3, halfLife: 45, chord: "Am7", event: "心跳慢了些，余波还在。" },
  calm: { match: /放松|慢慢呼吸|深呼吸|安心|别怕|没事了|[😌]/gu, bpm: -7, celsius: 0, breath: -1.6, halfLife: 10, chord: "Cmaj7", event: "呼吸慢慢拉长。" }
};
const senses = {
  touch: { label: "触觉", match: /抱抱|拥抱|抱紧|牵手|摸摸|拍拍|[🫂]/gu, halfLife: 7, event: "刚刚的触感还留了一会儿。" },
  smell: { label: "嗅觉", match: /闻到|闻起来|香气|花香|咖啡香/gu, halfLife: 5, event: "注意力落在气味上。" },
  taste: { label: "味觉", match: /尝到|尝一口|喝一口|甜味|苦味|酸味/gu, halfLife: 4, event: "味道在注意力里停了一下。" },
  sound: { label: "听觉", match: /听到|雨声|风声|音乐响|敲门声/gu, halfLife: 5, event: "注意力转向了声音。" }
};
const signals = { ...feelings, ...senses };
const lightClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23"
});

function hasSignal(text, match) {
  for (const hit of text.matchAll(match)) {
    const before = text.slice(Math.max(0, hit.index - 8), hit.index).split(/[，。！？、,.!?;；\n]/u).at(-1);
    if (!/没有|不要|别|没|不|未/u.test(before.slice(-4))) return true;
  }
  return false;
}

function detect(text) {
  const message = text.slice(0, 2000);
  const state = Object.keys(feelings).find(key => hasSignal(message, feelings[key].match));
  return [...(state ? [state] : []), ...Object.keys(senses).filter(key => hasSignal(message, senses[key].match))];
}

function level(entry, halfLife, now) {
  const age = Math.max(0, now - entry.at);
  return (0.25 + 0.75 * (1 - Math.exp(-age / 7500))) * 2 ** (-age / (halfLife * minute));
}

export function pulseSnapshot({ now, sleeping = false, drives = {}, impulses = [] }) {
  const hour = Number(lightClock.format(now));
  const phase = hour < 6 || hour >= 21 ? "night" : hour < 9 ? "morning" : hour < 18 ? "day" : "evening";
  const quiet = phase === "night" || phase === "morning";
  const time = now / 1000;
  const rhythm = Math.sin(time / 27) * 1.15 + Math.sin(time / 91) * 0.85;
  const values = Object.fromEntries(Object.keys(signals).map(key => [key, 0]));
  const comfortAt = impulses.findLast(item => item.keys.includes("bright") || item.keys.includes("calm"))?.at || 0;
  for (const entry of impulses) {
    for (const key of entry.keys) {
      const soothed = (key === "low" || key === "tense") && comfortAt > entry.at;
      const extraDecay = soothed ? 2 ** (-3 * Math.max(0, now - comfortAt) / (signals[key].halfLife * minute)) : 1;
      values[key] += level(entry, signals[key].halfLife, now) * extraDecay;
    }
  }
  for (const key of Object.keys(values)) values[key] = clamp(values[key], 0, 1);
  const drive = key => clamp(Number(drives[key]) || 0, 0, 1);
  let bpm = (sleeping ? 57 : quiet ? 64 : 70) + rhythm + drive("attachment") * 5 - drive("fatigue") * 5 + drive("anger") * 6 + 6 * values.touch;
  let celsius = (sleeping ? 36.42 : quiet ? 36.54 : 36.65) + rhythm * 0.018 + 0.14 * values.touch;
  let breathOffset = 0;
  for (const [key, feeling] of Object.entries(feelings)) {
    const strength = values[key] * (sleeping ? 0.25 : 1);
    bpm += strength * feeling.bpm;
    celsius += strength * feeling.celsius;
    breathOffset += strength * feeling.breath;
  }
  bpm = round(clamp(bpm, 48, 160));
  celsius = round(clamp(celsius, 35.5, 40), 1);
  const breathsPerMinute = round(clamp((sleeping ? 12 : 15) + (bpm - 70) * 0.15 + breathOffset, 8, 35));
  const breathing = breathsPerMinute < 12 ? "深长" : breathsPerMinute <= 17 ? "平稳" : breathsPerMinute < 23 ? "偏浅" : "急促";
  const dominant = Object.keys(feelings).reduce((a, b) => values[a] >= values[b] ? a : b);
  const chord = sleeping ? "Em7"
    : values[dominant] >= 0.45 ? feelings[dominant].chord
    : values.touch >= 0.35 || (bpm >= 79 && celsius >= 36.7) ? "Fmaj7"
    : bpm < 66 && breathsPerMinute < 15 ? "C6" : "Gmaj7";
  return {
    time: new Date(now).toISOString(), bpm, celsius, breathsPerMinute, breathing, chord, sleeping, phase,
    senses: Object.entries(senses).map(([id, sense]) => ({
      id, label: sense.label,
      value: round(clamp(values[id] * 0.8 + (id === "touch" || id === "sound" ? Math.max(0, bpm - 84) / 130 : 0), 0, 1), 2)
    }))
  };
}

export function pulseContext(snapshot) {
  const activeSenses = snapshot.senses.filter(sense => sense.value >= 0.15).map(sense => sense.label).join("、");
  return `<lumi_pulse>当前模拟身体状态：心率 ${snapshot.bpm} bpm，体温 ${snapshot.celsius.toFixed(1)} °C，呼吸 ${snapshot.breathsPerMinute} 次/分（${snapshot.breathing}），和弦 ${snapshot.chord}，${snapshot.sleeping ? "睡眠中" : "清醒"}。${activeSenses ? `较活跃的感知：${activeSenses}。` : ""}根据对话自然使用这些数据。</lumi_pulse>`;
}

export function createPulseStore(path) {
  let state = { impulses: [], history: [], events: [], sleeping: null };
  let writes = Promise.resolve();
  let dirty = false;

  function save() {
    const payload = JSON.stringify(state);
    dirty = false;
    const temporary = `${path}.${randomUUID()}.tmp`;
    const operation = writes.then(async () => {
      try {
        await writeFile(temporary, payload);
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    writes = operation.catch(() => { dirty = true; });
    return operation;
  }

  function current({ now = Date.now(), drives, sleeping = state.sleeping === true } = {}) {
    return pulseSnapshot({ now, drives, sleeping, impulses: state.impulses });
  }

  function event(now, text) {
    state.events.push({ id: randomUUID(), time: new Date(now).toISOString(), text });
    state.events = state.events.slice(-30);
    dirty = true;
  }

  return {
    async load() {
      try {
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (Array.isArray(saved.impulses) && Array.isArray(saved.history) && Array.isArray(saved.events)) {
          state = {
            impulses: saved.impulses.filter(item => item && Number.isFinite(item.at) &&
              Array.isArray(item.keys) && item.keys.every(key => Object.hasOwn(signals, key))).slice(-150),
            history: saved.history.filter(item => Number.isFinite(Date.parse(item?.time)) && Number.isFinite(item?.bpm)).slice(-289),
            events: saved.events.filter(item => typeof item?.id === "string" && Number.isFinite(Date.parse(item.time)) && typeof item.text === "string").slice(-30),
            sleeping: typeof saved.sleeping === "boolean" ? saved.sleeping : null
          };
        }
      } catch (error) {
        if (error.code !== "ENOENT") console.warn(`Lumi pulse state unavailable: ${error.message}`);
      }
    },
    current,
    response(options) {
      const snapshot = current(options);
      const earliest = Date.parse(snapshot.time) - day;
      return {
        current: snapshot,
        history: state.history.filter(item => Date.parse(item.time) >= earliest),
        events: state.events.filter(item => Date.parse(item.time) >= earliest).slice(-12).reverse()
      };
    },
    async observe(text, id, now = Date.now()) {
      if (state.impulses.some(entry => entry.id === id)) {
        if (dirty) await save();
        return;
      }
      const keys = detect(text);
      if (!keys.length) return;
      state.impulses = [...state.impulses.filter(entry => entry.at >= now - day), { id, at: now, keys }].slice(-150);
      event(now, signals[keys[0]].event);
      await save();
    },
    async tick({ now = Date.now(), drives, sleeping }) {
      if (state.sleeping !== sleeping) {
        if (state.sleeping !== null) event(now, sleeping ? "进入睡眠，心跳和呼吸放慢。" : "醒过来了，心跳渐渐回到清醒时的节奏。");
        state.sleeping = sleeping;
        dirty = true;
      }
      const last = Date.parse(state.history.at(-1)?.time);
      if (!Number.isFinite(last) || now - last >= sampleInterval) {
        const { time, bpm } = current({ now, drives });
        state.history = [...state.history.filter(item => Date.parse(item.time) >= now - day), { time, bpm }].slice(-289);
        dirty = true;
      }
      if (dirty) await save();
    }
  };
}
