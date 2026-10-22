import './mock-model-fetch.js';
const modelFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'mcp.test') return modelFetch(new URL('/mcp', process.env.LUMI_TEST_MODEL_TARGET).toString(), init);
  return modelFetch(input, init);
};
