// Preloaded with `node --import` ahead of server.mjs: the catalog APIs answer
// normally, but every font file comes back as an HTML error page under HTTP
// 200 — a CDN rewriting an expired URL, which is what the magic-number check
// in the download path exists for. Lets a test reach the download failure
// path without a provider having to be down.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/\.woff2(\?|$)/i.test(url)) {
    process.stderr.write(`[font blocked] ${url.slice(-60)}\n`);
    return new Response("<!DOCTYPE html><title>Not found</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }
  return real(input, init);
};
