// The CSS-writing path, against live providers and real downloads. These are
// the regressions that mattered: re-installing a family must update its rules
// in place rather than stacking duplicates, and the replacement must be
// literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startServer, workspace, rules, faceKey, SKIP_NETWORK } from "./helpers.mjs";

const net = { skip: SKIP_NETWORK && "FONTPOOL_SKIP_NETWORK_TESTS is set" };

// Fontshare serves Satoshi with no subsets, so 400 + 700 is exactly two faces.
const SATOSHI = { family: "Satoshi", weights: ["400", "700"], styles: ["normal"] };

test("a single install writes files and one rule per face", net, async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);
    assert.equal(rules(await ws.read()).length, 2);
    const files = await readdir(ws.fonts);
    assert.equal(files.filter((f) => f.endsWith(".woff2")).length, 2);
  } finally {
    await s.close();
  }
});

test("three identical installs produce exactly 2 rules", net, async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
      assert.equal(r.isError, false, r.text);
    }
    const found = rules(await ws.read());
    assert.equal(found.length, 2);
    assert.equal(new Set(found.map(faceKey)).size, 2);
  } finally {
    await s.close();
  }
});

test("a urlPrefix containing $& survives the update path literally", net, async () => {
  // The update path used sheet.replace(existing, block). With `block` as a
  // string, `$&` in it expanded to the whole matched rule and the stylesheet
  // ate itself.
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    let r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);

    r = await s.call("install_font", {
      ...SATOSHI,
      targetDir: ws.fonts,
      cssPath: ws.css,
      urlPrefix: "/$&/$1/fonts",
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /2 updated/);

    const css = await ws.read();
    assert.equal(rules(css).length, 2);
    assert.equal(css.match(/url\('\/\$&\/\$1\/fonts\//g)?.length, 2);
    // A corrupted sheet shows up as a rule swallowed into a src value.
    assert.doesNotMatch(css, /src:[^;]*@font-face/);
  } finally {
    await s.close();
  }
});

test("a single-line @font-face is deduped, not duplicated", net, async () => {
  // faceKey only stripped `src` when it sat on its own line, so a rule
  // written by hand (or by a formatter) on one line never matched and the
  // install appended a second copy of the same face.
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    let r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);

    const collapsed = rules(await ws.read())
      .map((rule) => rule.replace(/\s+/g, " "))
      .join("\n");
    await writeFile(ws.css, `${collapsed}\n`);
    assert.equal(rules(await ws.read()).length, 2);

    r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /0 rule\(s\) added/);

    const found = rules(await ws.read());
    assert.equal(found.length, 2);
    assert.equal(new Set(found.map(faceKey)).size, 2);
  } finally {
    await s.close();
  }
});

test("multi-subset faces stay distinct across a re-install", net, async () => {
  // Inter comes with per-subset unicode-ranges: 2 weights x 2 subsets = 4
  // faces that differ only in weight and unicode-range. They must neither
  // collapse into each other nor duplicate on a second install.
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  const args = {
    family: "Inter",
    weights: ["400", "700"],
    styles: ["normal"],
    subsets: ["latin", "latin-ext"],
    targetDir: ws.fonts,
    cssPath: ws.css,
  };
  try {
    let r = await s.call("install_font", args);
    assert.equal(r.isError, false, r.text);
    let found = rules(await ws.read());
    assert.equal(found.length, 4);
    assert.equal(new Set(found.map(faceKey)).size, 4);

    r = await s.call("install_font", args);
    assert.equal(r.isError, false, r.text);
    found = rules(await ws.read());
    assert.equal(found.length, 4);
    assert.equal(new Set(found.map(faceKey)).size, 4);
  } finally {
    await s.close();
  }
});

test("an unresolvable family is an error, not an empty install", net, async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", {
      family: "Nonexistent Family XYZ",
      targetDir: ws.fonts,
      cssPath: ws.css,
    });
    assert.equal(r.isError, true);
    // Wording changed in 1.2.0: the old message was "Could not resolve X",
    // which conflated an unknown name with an unavailable weight.
    assert.match(r.text, /No provider knows 'Nonexistent Family XYZ'/);
    // Nothing should have been written on the way to failing.
    await assert.rejects(ws.read());
  } finally {
    await s.close();
  }
});

test("a wrong weight blames the weight, not the family name", net, async () => {
  // This used to return "Could not resolve 'Satoshi'", which sent clients back
  // to re-check a name that was already correct. Satoshi has no 350.
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", {
      family: "Satoshi",
      targetDir: ws.fonts,
      cssPath: ws.css,
      weights: ["350"],
    });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /Could not resolve/);
    assert.match(r.text, /'Satoshi' exists, but not in the combination/);
    assert.match(r.text, /It has weights .*\b400\b/);
  } finally {
    await s.close();
  }
});

test("an unknown family in install_font suggests near matches", net, async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", {
      family: "Satosi",
      targetDir: ws.fonts,
      cssPath: ws.css,
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /No provider knows 'Satosi'/);
    assert.match(r.text, /Did you mean:.*Satoshi/);
  } finally {
    await s.close();
  }
});

test("install_font accepts the family name as a human typed it", net, async () => {
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", {
      family: "switzer",
      targetDir: ws.fonts,
      cssPath: ws.css,
      weights: ["400"],
    });
    assert.equal(r.isError, false, r.text);
    // The canonical spelling has to reach the stylesheet, not the typed one.
    assert.match(r.text, /Installed Switzer/);
    assert.match(await ws.read(), /font-family: 'Switzer'/);
  } finally {
    await s.close();
  }
});

test("a stylesheet nothing imports is reported, not silently shipped", net, async () => {
  // The failure that looks exactly like success: files land, rules are right,
  // and the page still renders in Helvetica.
  const ws = await workspace();
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Nothing under the workspace root references fonts\.css/);
  } finally {
    await s.close();
  }
});

test("a stylesheet something imports draws no warning", net, async () => {
  const ws = await workspace();
  await mkdir(join(ws.dir, "src"), { recursive: true });
  await writeFile(join(ws.dir, "src", "index.css"), "@import './fonts.css';\n");
  const s = await startServer({ root: ws.dir });
  try {
    const r = await s.call("install_font", { ...SATOSHI, targetDir: ws.fonts, cssPath: ws.css });
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /Nothing under the workspace root references/);
  } finally {
    await s.close();
  }
});
