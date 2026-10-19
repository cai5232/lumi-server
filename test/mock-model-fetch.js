// Route the frontend's HTTPS custom-model preset to each test's local fake relay.
// This keeps tests aligned with production's requirement that chats carry a
// self-contained custom route, without weakening URL validation in the server.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const target = process.env.LUMI_TEST_MODEL_TARGET;
  if (url.hostname === 'model.test' && target) {
    return realFetch(new URL(url.pathname + url.search, target), init);
  }
  return realFetch(input, init);
};
