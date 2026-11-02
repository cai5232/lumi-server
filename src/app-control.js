import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Restrictions affect an app only after its iPhone automation is configured.
export function createAppControlStore(directory, now = Date.now) {
  const file = join(directory, 'app-control.json');
  let queue = Promise.resolve();
  const normalizeName = name => typeof name === 'string' ? name.trim().slice(0, 80) : '';
  const transact = (fn, write = false) => {
    const result = queue.then(async () => {
      let state;
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; state = { apps: [], blocked: {}, autonomous: false }; }
      state.apps = Array.isArray(state.apps) ? state.apps : [];
      state.blocked = state.blocked && typeof state.blocked === 'object' ? state.blocked : {};
      state.autonomous = state.autonomous === true;
      const result = await fn(state);
      if (write) {
        await mkdir(directory, { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
        await rename(tmp, file);
      }
      return result;
    });
    queue = result.catch(() => {});
    return result;
  };
  const snapshot = state => ({ apps: state.apps, blocked: state.apps.filter(app => state.blocked[app] && (!state.blocked[app].until || Date.parse(state.blocked[app].until) > now())), autonomous: state.autonomous });
  return {
    get: () => transact(snapshot),
    configure: ({ apps, autonomous }) => transact(state => {
      if (!Array.isArray(apps) || apps.length > 500 || apps.some(app => !normalizeName(app))) throw new Error('invalid_apps');
      state.apps = [...new Set(apps.map(normalizeName))];
      state.blocked = Object.fromEntries(Object.entries(state.blocked).filter(([app]) => state.apps.includes(app)));
      if (typeof autonomous === 'boolean') state.autonomous = autonomous;
      return snapshot(state);
    }, true),
    set: ({ app, blocked, minutes = null }, { autonomous = false } = {}) => transact(state => {
      app = normalizeName(app);
      if (!app || ['__proto__', 'constructor', 'prototype'].includes(app)) throw new Error('invalid_app');
      if (autonomous && !state.autonomous) throw new Error('autonomous_control_disabled');
      if (typeof blocked !== 'boolean') throw new Error('blocked_must_be_boolean');
      if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)) throw new Error('invalid_duration');
      if (blocked && !state.apps.includes(app)) { if (state.apps.length >= 500) throw new Error('too_many_apps'); state.apps.push(app); }
      if (blocked) state.blocked[app] = { until: minutes == null ? null : new Date(now() + minutes * 60000).toISOString() };
      else delete state.blocked[app];
      return snapshot(state);
    }, true),
    clear: () => transact(state => { state.blocked = {}; return snapshot(state); }, true),
    check: app => transact(state => ({ blocked: snapshot(state).blocked.includes(normalizeName(app)) }))
  };
}
