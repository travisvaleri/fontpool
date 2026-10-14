// The metadata layer: the normalisation tables, which are pure and run
// offline, and the enrichment itself, which needs the catalog APIs.
//
// Importing server.mjs is safe here because it only opens a transport when it
// is the process entry point — see `invokedDirectly` at the bottom of the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, SKIP_NETWORK } from "./helpers.mjs";
import { foldTag, stripHtml, normName, tightName, CATEGORIES, AXIS_NAMES } from "../server.mjs";

const net = { skip: SKIP_NETWORK && "FONTPOOL_SKIP_NETWORK_TESTS is set" };

test("tag folding collapses the duplicates Fontshare actually ships", () => {
  // 'Poster' (26) and 'Posters' (27) were separate terms, as were 'Logo' (6)
  // and 'Logos' (23). A client cannot filter on a vocabulary like that.
  for (const [a, b] of [
    ["Poster", "Posters"],
    ["Logo", "Logos"],
    ["Headline", "Headlines"],
    ["Book", "Books"],
    ["Comic", "Comics"],
    ["Programming", "Coding"],
  ]) {
    assert.equal(foldTag(a), foldTag(b), `${a} and ${b} should fold together`);
  }
});

test("tag folding normalises case and spacing", () => {
  assert.equal(foldTag("Editorial"), "editorial");
  assert.equal(foldTag("  friendly "), "friendly");
  assert.equal(foldTag("Album Covers"), "album-cover");
  assert.equal(foldTag(""), null);
  assert.equal(foldTag(undefined), null);
});

test("stripHtml flattens the markup Fontshare embeds in `story`", () => {
  // Some records are wrapped in a <div>, others carry <br> and entities.
  assert.equal(stripHtml("<div>Satoshi is a <b>modernist</b> sans.</div>"), "Satoshi is a modernist sans.");
  assert.equal(stripHtml("a&amp;b"), "a&b");
  assert.equal(stripHtml("one<br>two"), "one two");
  assert.equal(stripHtml("it&rsquo;s"), "it’s");
  assert.equal(stripHtml("<script>bad()</script>text"), "text");
  assert.equal(stripHtml(null), "");
});

test("name normalisation is case-, space- and punctuation-blind", () => {
  assert.equal(normName("  JetBrains   Mono "), "jetbrains mono");
  assert.equal(tightName("Open Sans"), tightName("OpenSans"));
  assert.equal(tightName("iA Writer Duo"), "iawriterduo");
});

test("the category vocabulary is the documented set", () => {
  for (const c of ["sans-serif", "serif", "slab-serif", "display", "handwriting", "monospace", "icons", "other"]) {
    assert.ok(CATEGORIES.includes(c), `missing category ${c}`);
  }
});

test("font_properties carries category, foundry and the foundry's description", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Satoshi" });
    assert.equal(r.isError, false, r.text);
    const p = JSON.parse(r.text);
    assert.equal(p.family, "Satoshi");
    assert.deepEqual(p.categories, ["sans-serif"]);
    assert.equal(p.foundry, "Indian Type Foundry");
    assert.ok(p.tags?.length, "expected use-case tags");
    assert.match(p.description, /sans serif/i);
    // The description is sales copy and has to be labelled as such.
    assert.match(p.descriptionSource, /marketing copy/);
  } finally {
    await s.close();
  }
});

test("a family only Fontsource knows still gets a category", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Apfel Grotezk" });
    assert.equal(r.isError, false, r.text);
    const p = JSON.parse(r.text);
    assert.deepEqual(p.categories, ["sans-serif"]);
    assert.deepEqual(p.availableFrom, ["fontsource"]);
  } finally {
    await s.close();
  }
});

test("metadata is an enhancement, not a precondition", async () => {
  // With every fetch failing there is no catalog at all, so the tools must
  // report that plainly rather than throwing a stack trace at the client.
  const s = await startServer({
    nodeArgs: ["--import", join(dirname(fileURLToPath(import.meta.url)), "fixtures", "no-network.mjs")],
  });
  try {
    const r = await s.call("list_fonts", { filter: "inter" });
    assert.equal(r.isError, true);
    assert.match(r.text, /network is probably unreachable|provider APIs are down/);
  } finally {
    await s.close();
  }
});

test("the axis table labels the five registered axes", () => {
  // Lowercase tags are OpenType-registered; uppercase ones are foundry-defined.
  assert.equal(AXIS_NAMES.wght, "Weight");
  assert.equal(AXIS_NAMES.wdth, "Width");
  assert.equal(AXIS_NAMES.slnt, "Slant");
  assert.equal(AXIS_NAMES.ital, "Italic");
  assert.equal(AXIS_NAMES.opsz, "Optical Size");
  // A sample of the expressive ones the catalog actually uses.
  assert.equal(AXIS_NAMES.CASL, "Casual");
  assert.equal(AXIS_NAMES.MONO, "Monospace");
  assert.equal(AXIS_NAMES.WONK, "Wonky");
});

test("font_properties reports every variable axis, not just weight", net, async () => {
  // /v1/fonts says `variable: true` and stops; the axes live on /v1/variable.
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Recursive" });
    assert.equal(r.isError, false, r.text);
    const ax = JSON.parse(r.text).variableAxes;
    assert.ok(ax, "expected variableAxes");
    assert.deepEqual(Object.keys(ax).sort(), ["CASL", "CRSV", "MONO", "slnt", "wght"]);
    assert.equal(ax.wght.name, "Weight");
    assert.equal(ax.wght.min, 300);
    assert.equal(ax.wght.max, 1000);
    assert.equal(ax.CASL.name, "Casual");
    // A step of 1 is the uninformative default and is dropped; 0.01 is not.
    assert.equal(ax.wght.step, undefined);
    assert.equal(ax.CASL.step, 0.01);
  } finally {
    await s.close();
  }
});

test("a Fontshare-only family still reports its weight axis", net, async () => {
  // The variable endpoint only covers Fontsource, so without reading
  // Fontshare's own axes the 65 non-Google families had no axis data at all.
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Satoshi" });
    const ax = JSON.parse(r.text).variableAxes;
    assert.deepEqual(Object.keys(ax), ["wght"]);
    assert.equal(ax.wght.min, 300);
    assert.equal(ax.wght.max, 900);
  } finally {
    await s.close();
  }
});

test("duplicate Fontshare axis entries merge without inventing a default", net, async () => {
  // Gambetta reports wght twice — once per variable style — with the same
  // range and defaults of 460 and 380. Picking either would be arbitrary.
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Gambetta" });
    const ax = JSON.parse(r.text).variableAxes;
    assert.equal(ax.wght.min, 300);
    assert.equal(ax.wght.max, 700);
    assert.equal(ax.wght.default, undefined, "disagreeing defaults should be dropped");
  } finally {
    await s.close();
  }
});

test("a non-variable family reports no axes at all", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Chunk Five" });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).variableAxes, undefined);
  } finally {
    await s.close();
  }
});
