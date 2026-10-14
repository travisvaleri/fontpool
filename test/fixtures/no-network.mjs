// Preloaded with `node --import` ahead of server.mjs: every fetch fails
// immediately, the way it does with the network down (minus unifont's retry
// backoff). Startup must still complete the handshake.
globalThis.fetch = async (input) => {
  process.stderr.write(`[fetch blocked] ${String(input).slice(0, 80)}\n`);
  throw new Error("ENETDOWN (simulated)");
};
