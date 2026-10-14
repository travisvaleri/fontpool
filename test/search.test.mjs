// list_fonts and font_properties against the live provider catalogs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, SKIP_NETWORK } from "./helpers.mjs";

const net = { skip: SKIP_NETWORK && "FONTPOOL_SKIP_NETWORK_TESTS is set" };

test("list_fonts filters across all providers", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { filter: "satoshi" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^\d+ families:/);
    assert.match(r.text, /Satoshi/);
  } finally {
    await s.close();
  }
});

test("list_fonts can be restricted to one provider", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { provider: "google", filter: "inter" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /families from google:/);
    assert.match(r.text, /Inter/);
  } finally {
    await s.close();
  }
});

test("font_properties reports weights, styles and provider", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Inter" });
    assert.equal(r.isError, false, r.text);
    const props = JSON.parse(r.text);
    assert.ok(props.weights?.length, "expected weights");
    assert.ok(props.styles?.includes("normal"));
  } finally {
    await s.close();
  }
});

test("font_properties on an unknown family is a clean error", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Nonexistent Family XYZ" });
    assert.equal(r.isError, true);
    assert.match(r.text, /No provider knows/);
  } finally {
    await s.close();
  }
});

test("list_fonts with no arguments describes the catalog instead of dumping it", net, async () => {
  // The unfiltered call used to return 6124 lines (~20k tokens) for 2168
  // families, which taught clients to stop calling discovery at all.
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", {});
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /By category:/);
    assert.match(r.text, /Not carried by Google: \d+ families/);
    assert.match(r.text, /Tags: /);
    assert.ok(r.text.split("\n").length < 60, `expected a summary, got ${r.text.split("\n").length} lines`);
  } finally {
    await s.close();
  }
});

test("a family several providers carry is listed once, with its providers", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { filter: "poppins" });
    assert.equal(r.isError, false, r.text);
    const lines = r.text.split("\n").filter((l) => l.startsWith("Poppins —"));
    assert.equal(lines.length, 1, `Poppins appeared ${lines.length} times`);
    assert.match(lines[0], /fontsource\+google/);
  } finally {
    await s.close();
  }
});

test("list_fonts filters by category and tag together", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { category: "serif", tag: "editorial" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /\(category: serif, tag: editorial\)/);
    assert.match(r.text, /Zodiak/);
    // Every row has to actually be a serif.
    for (const line of r.text.split("\n").slice(1).filter(Boolean)) {
      assert.match(line, / — [^·]*serif/, `not a serif: ${line}`);
    }
  } finally {
    await s.close();
  }
});

test("exclude drops the providers named, leaving what Google lacks", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { exclude: ["google"], category: "serif" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /excluding google/);
    // Roboto Slab and friends are Google's; Zodiak is not.
    assert.doesNotMatch(r.text, /^Roboto Slab —/m);
    assert.match(r.text, /^Zodiak —/m);
    for (const line of r.text.split("\n").filter((l) => l.includes(" — "))) {
      assert.doesNotMatch(line, /google/, `leaked a Google family: ${line}`);
    }
  } finally {
    await s.close();
  }
});

test("an unknown tag returns nothing rather than erroring", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { tag: "notarealtag" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^0 families/);
  } finally {
    await s.close();
  }
});

test("font_properties resolves a family whatever the casing or spacing", net, async () => {
  // 'inter', 'INTER', 'Inter ' and 'Jetbrains Mono' all used to fail: the
  // lookup was an exact string match, and the name usually reaches the server
  // the way a human typed it.
  const s = await startServer();
  try {
    for (const [input, expected] of [
      ["satoshi", "Satoshi"],
      ["INTER", "Inter"],
      ["Inter ", "Inter"],
      ["jetbrains mono", "JetBrains Mono"],
      ["OpenSans", "Open Sans"],
    ]) {
      const r = await s.call("font_properties", { family: input });
      assert.equal(r.isError, false, `${input}: ${r.text}`);
      assert.equal(JSON.parse(r.text).family, expected);
    }
  } finally {
    await s.close();
  }
});

test("a near-miss family name suggests the real one", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("font_properties", { family: "Intar" });
    assert.equal(r.isError, true);
    assert.match(r.text, /No provider knows 'Intar'/);
    assert.match(r.text, /Did you mean:.*\bInter\b/);
  } finally {
    await s.close();
  }
});

test("hasAxis narrows to families carrying that axis", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { hasAxis: "wdth", category: "serif" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /\(category: serif, axis: wdth\)/);
    for (const line of r.text.split("\n").filter((l) => l.includes(" — "))) {
      assert.match(line, /wdth/, `row without a width axis: ${line}`);
    }
  } finally {
    await s.close();
  }
});

test("hasAxis is case-blind but reports the font's own spelling", net, async () => {
  // Axis tags are case-significant by convention, so a client typing 'WDTH'
  // has to still find wdth.
  const s = await startServer();
  try {
    const upper = await s.call("list_fonts", { hasAxis: "WDTH" });
    const lower = await s.call("list_fonts", { hasAxis: "wdth" });
    assert.equal(upper.text.split("\n")[0], lower.text.split("\n")[0]);
    assert.match(upper.text, /axis: wdth/);
  } finally {
    await s.close();
  }
});

test("an unknown axis returns nothing rather than erroring", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", { hasAxis: "nope" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^0 families/);
  } finally {
    await s.close();
  }
});

test("the overview lists the axis vocabulary", net, async () => {
  const s = await startServer();
  try {
    const r = await s.call("list_fonts", {});
    assert.match(r.text, /Variable axes: /);
    assert.match(r.text, /wght \[Weight\] \(\d+\)/);
    assert.match(r.text, /wdth \[Width\]/);
  } finally {
    await s.close();
  }
});
