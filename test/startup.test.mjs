// Startup must not depend on the network. createUnifont() fetches four
// catalog APIs; when that ran at module scope, a dead network meant unifont
// retried with backoff before server.connect() was ever reached and the
// client's `initialize` never returned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, workspace } from "./helpers.mjs";

const NO_NETWORK = [
  "--import",
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "no-network.mjs"),
];

test("initialize completes with the network dead", async () => {
  const started = Date.now();
  const s = await startServer({ nodeArgs: NO_NETWORK });
  try {
    assert.equal(s.client.getServerVersion()?.name, "fontpool");
    // Generous, but a hang is the failure mode being guarded against: the
    // old module-scope await took the full retry budget or never finished.
    assert.ok(Date.now() - started < 10_000, "handshake took too long");
  } finally {
    await s.close();
  }
});

test("tools are advertised with the network dead", async () => {
  const s = await startServer({ nodeArgs: NO_NETWORK });
  try {
    const { tools } = await s.client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["font_properties", "install_font", "list_fonts"]
    );
  } finally {
    await s.close();
  }
});

test("a dead network is a per-tool error, not a hang", async () => {
  const s = await startServer({ nodeArgs: NO_NETWORK });
  try {
    // unifont retries with backoff, so allow time; the point is that it
    // returns at all, and as an error rather than a crash.
    const r = await s.call("list_fonts", { filter: "inter" });
    assert.equal(r.isError, true);
    assert.match(r.text, /No provider returned a catalog/);
    // The server is still alive and answering afterwards.
    const { tools } = await s.client.listTools();
    assert.equal(tools.length, 3);
  } finally {
    await s.close();
  }
});

test("install_font rejects a path outside the root before touching the network", async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir, nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: "/tmp/fontpool-escape",
      cssPath: join(ws.dir, "src", "fonts.css"),
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /outside the workspace root/);
    assert.doesNotMatch(s.stderr(), /\[fetch blocked\]/);
  } finally {
    await s.close();
  }
});
