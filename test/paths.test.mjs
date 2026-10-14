// Where install_font is and isn't allowed to write. None of these reach the
// providers: every check happens before the font is resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, workspace } from "./helpers.mjs";

const NO_NETWORK = [
  "--import",
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "no-network.mjs"),
];

test("relative paths without a workspace root error cleanly", async () => {
  const s = await startServer({ nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: "./public/fonts",
      cssPath: "./src/fonts.css",
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /Relative paths need a workspace root/);
  } finally {
    await s.close();
  }
});

test("cssPath outside the root is rejected", async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir, nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: ws.fonts,
      cssPath: join(ws.dir, "..", "escaped.css"),
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /cssPath .* is outside the workspace root/);
  } finally {
    await s.close();
  }
});

test("a relative path that climbs out of the root is rejected", async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir, nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: "../../etc/fontpool",
      cssPath: "./src/fonts.css",
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /outside the workspace root/);
  } finally {
    await s.close();
  }
});

test("a symlink out of the root is rejected", async () => {
  const ws = await workspace();
  const outside = await workspace();
  await mkdir(join(ws.dir, "public"), { recursive: true });
  await symlink(outside.dir, join(ws.dir, "public", "fonts"));
  const s = await startServer({ root: ws.dir, nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: "./public/fonts",
      cssPath: "./src/fonts.css",
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /outside the workspace root/);
    assert.deepEqual(await readdir(outside.dir), []);
  } finally {
    await s.close();
  }
});

test("an absolute path inside the root is accepted", async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir, nodeArgs: NO_NETWORK });
  try {
    // Gets past the path checks and fails at the (stubbed) network instead,
    // which is how we know confinement let it through.
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: ws.fonts,
      cssPath: ws.css,
    });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /outside the workspace root/);
    assert.match(s.stderr(), /\[fetch blocked\]/);
  } finally {
    await s.close();
  }
});

test("writes are still unconfined when the client advertises no root", async () => {
  // Documented behavior, not an oversight: with no root there is nothing to
  // confine against, so an absolute path is taken at face value.
  const ws = await workspace();
  await mkdir(dirname(ws.css), { recursive: true });
  await writeFile(ws.css, "");
  const s = await startServer({ nodeArgs: NO_NETWORK });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: ws.fonts,
      cssPath: ws.css,
    });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /outside the workspace root/);
    assert.match(s.stderr(), /\[fetch blocked\]/);
  } finally {
    await s.close();
  }
});
