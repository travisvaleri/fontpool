// The download phase, offline. These are the cases a live provider will not
// produce on request: an error page served under HTTP 200, a 503, a socket
// that dies mid-fetch, and sixteen files wanted at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadAll, describeBytes, isWoff2 } from "../server.mjs";

/** A plausible woff2 payload: the magic number and some filler. */
const woff2 = (fill = 0) => {
  const buf = Buffer.alloc(64, fill);
  buf.write("wOF2", 0, "latin1");
  return buf;
};

const body = (buf) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new Uint8Array(buf).buffer,
});

/** Swap in a stub fetch for the duration of fn. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("payloads come back in input order, not completion order", async () => {
  const urls = ["a", "b", "c"];
  const results = await withFetch(
    async (url) => {
      // 'a' finishes last, so anything that resolves in completion order
      // hands the caller 'a' under 'c'.
      await sleep(url === "a" ? 30 : 1);
      return body(woff2(url.charCodeAt(0)));
    },
    () => downloadAll(urls)
  );
  assert.deepEqual(
    results.map((r) => r.buf[4]),
    ["a", "b", "c"].map((u) => u.charCodeAt(0))
  );
});

test("an error page under HTTP 200 is a failure, not a font file", async () => {
  // The case the magic-number check exists for: this used to be written out
  // as a .woff2, given an @font-face rule, and reported as a success.
  const [r] = await withFetch(
    async () => body(Buffer.from("<!DOCTYPE html><title>404</title>", "latin1")),
    () => downloadAll(["https://cdn.example/gone.woff2"])
  );
  assert.equal(r.buf, undefined);
  assert.match(r.error, /HTML or JSON response/);
});

test("a woff1 or ttf payload is named for what it is", async () => {
  const results = await withFetch(
    async (url) =>
      body(
        url === "woff"
          ? Buffer.from("wOFFrest", "latin1")
          : Buffer.from([0x00, 0x01, 0x00, 0x00, 0x09])
      ),
    () => downloadAll(["woff", "ttf"])
  );
  assert.match(results[0].error, /woff \(not woff2\)/);
  assert.match(results[1].error, /\.ttf/);
});

test("a non-ok status reports its code", async () => {
  const [r] = await withFetch(
    async () => ({ ok: false, status: 503 }),
    () => downloadAll(["https://cdn.example/x.woff2"])
  );
  assert.equal(r.error, "HTTP 503");
});

test("a dead socket is reported, not thrown", async () => {
  const results = await withFetch(
    async (url) => {
      if (url === "bad") throw new Error("ENETDOWN (simulated)");
      return body(woff2());
    },
    () => downloadAll(["bad", "good"])
  );
  assert.match(results[0].error, /ENETDOWN/);
  assert.ok(isWoff2(results[1].buf), "one bad URL must not abandon the rest");
});

test("no more than the concurrency cap is ever in flight", async () => {
  let live = 0;
  let peak = 0;
  const urls = Array.from({ length: 16 }, (_, i) => `f${i}`);
  const results = await withFetch(
    async () => {
      peak = Math.max(peak, ++live);
      await sleep(5);
      live--;
      return body(woff2());
    },
    () => downloadAll(urls, 6)
  );
  assert.equal(results.length, 16);
  assert.ok(results.every((r) => isWoff2(r.buf)));
  assert.equal(peak, 6, `peak in flight was ${peak}`);
});

test("describeBytes and isWoff2 agree about what a font is", async () => {
  assert.ok(isWoff2(woff2()));
  assert.equal(isWoff2(Buffer.from("wOF", "latin1")), false, "a truncated magic is not woff2");
  assert.equal(isWoff2(Buffer.alloc(0)), false);
  assert.equal(describeBytes(Buffer.from("OTTOx", "latin1")), "an OpenType (.otf) file");
  assert.match(describeBytes(Buffer.from('  {"error":1}', "latin1")), /HTML or JSON/);
  assert.match(describeBytes(Buffer.alloc(12, 7)), /12 bytes that are not a font/);
});
