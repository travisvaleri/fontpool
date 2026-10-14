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
    const r = await s.call("list_fonts", { provider: "bunny", filter: "inter" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /families from bunny:/);
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
