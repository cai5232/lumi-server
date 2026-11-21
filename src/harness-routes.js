import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createHarnessRoutes(path, config, env = process.env) {
  let queue = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  }
  return {
    async model(id) { return (await read())[id]?.model || config.model; },
    async selection(id) { const entry = (await read())[id]; return (typeof entry === 'string' ? entry : entry?.runtime) || (env.LUMI_CHAT_RUNTIME === 'kimi-harness' ? 'kimi-harness' : 'api'); },
    async route(id) {
      const selection = await this.selection(id);
      if (selection === 'kimi-acp') {
        if (env.LUMI_ACP_ENABLED !== 'true') throw Object.assign(new Error('Kimi ACP 尚未启用'), {statusCode:503});
        return {provider:'custom',model:config.model,customProvider:{runtime:'kimi-acp',url:config.baseURL,key:'native-oauth',apiFormat:'anthropic'}};
      }
      if (selection !== 'kimi-harness') return null;
      // A selected but disabled/unconfigured route must fail, never fall back.
      if (!config.enabled || !config.key) throw Object.assign(new Error('所选 Kimi Harness 尚未启用或 Key 未配置'), { statusCode: 503 });
      return { provider: 'custom', model: await this.model(id),
        customProvider: { runtime: 'kimi-harness', url: config.baseURL, key: config.key, apiFormat: 'anthropic', chatPath: '/v1/messages' } };
    },
    async save(id, runtime, model) {
      if (model !== undefined && !['k3','kimi-for-coding'].includes(model)) throw Object.assign(new Error('invalid_sdk_model'),{statusCode:400});
      if (!['api', 'kimi-harness', 'kimi-acp'].includes(runtime)) throw new Error('invalid_chat_runtime');
      if (runtime === 'kimi-acp' && env.LUMI_ACP_ENABLED !== 'true') throw Object.assign(new Error('Kimi ACP 尚未启用'), {statusCode:503});
      if (runtime === 'kimi-harness' && (!config.enabled || !config.key)) throw Object.assign(new Error('Kimi Harness 尚未启用或 Key 未配置'), { statusCode: 503 });
      const operation = queue.catch(() => {}).then(async () => {
        const all = await read(); const previous = all[id];
        const selectedModel = model || (typeof previous === 'object' ? previous?.model : undefined);
        all[id] = selectedModel ? {runtime,model:selectedModel} : runtime;
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(all), { mode: 0o600 }); await rename(temp, path);
      });
      queue = operation;
      await operation;
    },
  };
}
