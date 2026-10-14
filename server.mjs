#!/usr/bin/env node
/**
 * Fontpool — find a font across providers, download it, wire up the CSS.
 *
 *   npm install unifont @modelcontextprotocol/sdk zod
 *
 * Providers: fontshare, fontsource, google.
 * Everything here yields real files on disk. Adobe is deliberately left out:
 * its licence requires serving from Adobe's own CDN through a kit embed, so a
 * tool that promises self-hosted files cannot honestly offer it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createUnifont, providers } from "unifont";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  access,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import {
  join,
  basename,
  dirname,
  extname,
  isAbsolute,
  resolve,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Order matters: unifont consults providers in sequence and takes the first
// that knows the family. Fontshare first means Satoshi resolves to the real
// ITF release rather than a lookalike.
//
// Bunny was dropped in 1.3.0 and cost nothing to drop. It carried no unique
// families — wholly contained in fontsource, which sits ahead of it, so it had
// never been the provider that actually served an install — and the 26 retired
// Google names it kept alive (Source Sans Pro, Material Symbols, the Big
// Shoulders family) all turn out to be in fontsource too. The catalog is 2168
// families before and after.
//
// Google stays for the one reason bunny was kept until now: unifont swallows a
// provider's own catalog failure, so if fontsource — and with it jsDelivr — is
// unreachable, google still covers ~1950 families. It contributes no unique
// families either, only that fallback.
//
// Built lazily, and on purpose: createUnifont() fetches four catalog APIs.
// Doing that at module scope put the network between spawn and
// server.connect(), so a dead network made `initialize` never return and the
// client hung; a good one still cost every cold start a second. Deferred to
// first tool call, startup is instant and a network failure becomes an
// ordinary per-tool error.
let _unifont;
const getUnifont = () =>
  (_unifont ??= createUnifont([
    providers.fontshare(),
    providers.fontsource(),
    providers.google(),
  ]).catch((err) => {
    // Don't cache the rejection — the next call deserves a fresh attempt.
    _unifont = undefined;
    throw err;
  }));

const PROVIDERS = ["fontshare", "fontsource", "google"];

const server = new McpServer({ name: "fontpool", version: "1.4.1" });

const exists = (p) => access(p).then(() => true, () => false);

const FACE_RULE = /@font-face\s*\{[^}]*\}/g;
// Identity of an @font-face rule: every descriptor except src, whitespace-blind.
const faceKey = (rule) =>
  rule
    .replace(/(^|[{;])\s*src\s*:[^;}]*;?/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();

/* -------------------------------------------------------------- metadata */

// A family name on its own is not something a client can choose between.
// "Zodiak" means nothing; "Zodiak — serif, by Indian Type Foundry, sturdy
// serifs, optimal for running text" is a candidate. That description exists
// upstream and unifont already fetches it: its fontshare provider pulls the
// complete font objects — category, tags, the foundry's own prose — and then
// uses them for exactly one thing, picking `serif` or `sans-serif` as a CSS
// fallback keyword. Rather than fork unifont to get at its cache, the two
// catalogs are fetched again here, which costs one request each.
//
// Two sources cover everything. Fontshare's 100 families and Fontsource's 2103
// union to exactly the 2168 that the providers expose between them, because
// google is itself a subset of fontsource. So there is no third fetch worth
// making, and no Google API key to want — Google's public
// API carries category and nothing else anyway.
const FONTSHARE_API = "https://api.fontshare.com/v2/fonts?limit=100&offset=0";
const FONTSOURCE_API = "https://api.fontsource.org/v1/fonts";
// A separate Fontsource endpoint, and the only place the real variable axes
// live: /v1/fonts says `variable: true` and stops there, so a family's width,
// optical-size or expressive axes were invisible. All 573 of its families join
// onto the catalog by name with nothing left over.
const FONTSOURCE_VARIABLE_API = "https://api.fontsource.org/v1/variable";

// One vocabulary over two that disagree. Fontshare says 'Sans' and comma-joins
// multiples ('Serif, Display'); Fontsource says 'sans-serif' and picks one.
const CATEGORY = {
  sans: "sans-serif",
  "sans-serif": "sans-serif",
  serif: "serif",
  slab: "slab-serif",
  "slab-serif": "slab-serif",
  display: "display",
  script: "handwriting",
  handwritten: "handwriting",
  handwriting: "handwriting",
  blackletter: "blackletter",
  mono: "monospace",
  monospace: "monospace",
  monospaced: "monospace",
  icons: "icons",
  other: "other",
};

export const CATEGORIES = [...new Set(Object.values(CATEGORY))];

const toCategories = (raw) => [
  ...new Set(
    String(raw ?? "")
      .split(",")
      .map((c) => CATEGORY[c.trim().toLowerCase()])
      .filter(Boolean)
  ),
];

// Fontshare's tags are free text and show it: 'Poster' and 'Posters' are
// separate terms, so are 'Logo' and 'Logos', casing is inconsistent, and one
// family is tagged with the name of an unrelated font. Folded here so a client
// can filter on a vocabulary it is able to enumerate — a `tag` parameter whose
// valid values cannot be discovered is unusable.
const TAG_FOLD = {
  posters: "poster",
  logos: "logo",
  logotype: "logo",
  headlines: "headline",
  comics: "comic",
  apps: "app",
  children: "kids",
  readable: "legible",
  reading: "legible",
  magazines: "magazine",
  newspapers: "news",
  books: "book",
  websites: "website",
  films: "film",
  titles: "title",
  products: "product",
  programming: "code",
  coding: "code",
  monospaced: "monospace",
  funny: "fun",
  handwritten: "handwriting",
  signboards: "signage",
  "album covers": "album-cover",
  invitation: "invitation",
};

export const foldTag = (raw) => {
  const t = String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return TAG_FOLD[t] ?? t.replace(/ /g, "-");
};

// Google's axis registry, verbatim: 56 tags, which is every axis the catalog
// currently uses and then some. Hardcoded rather than fetched — the registry
// lives inside a 2.7MB metadata payload whose other 2.68MB is the Google font
// list, and it changes about once a year. A tag added after this was written
// simply passes through unlabelled, which is still useful: the range alone
// tells a client what it can do.
//
// Lowercase tags are the five OpenType-registered axes; uppercase ones are
// foundry-defined and mean whatever that typeface decided they mean.
export const AXIS_NAMES = {
  wght: "Weight",
  wdth: "Width",
  slnt: "Slant",
  ital: "Italic",
  opsz: "Optical Size",
  ARRR: "AR Retinal Resolution",
  BLED: "Bleed",
  BNCE: "Bounce",
  CASL: "Casual",
  CRSV: "Cursive",
  CTRS: "Contrast",
  EDPT: "Extrusion Depth",
  EHLT: "Edge Highlight",
  ELGR: "Element Grid",
  ELSH: "Element Shape",
  ELXP: "Element Expansion",
  ENLA: "Enlarge",
  FILL: "Fill",
  FLAR: "Flare",
  GDOP: "Guides Opacity",
  GEOM: "Geometric Form",
  GRAD: "Grade",
  HEXP: "Hyper Expansion",
  INFM: "Informality",
  JITT: "Jitter",
  MONO: "Monospace",
  MORF: "Morph",
  ROND: "Roundness",
  SCAN: "Scanlines",
  SHLN: "Shadow Length",
  SHRP: "Sharpness",
  SOFT: "Softness",
  SPAC: "Spacing",
  SZP1: "Size of Paint 1",
  SZP2: "Size of Paint 2",
  VOLM: "Volume",
  WONK: "Wonky",
  XELA: "Horizontal Element Alignment",
  XOPQ: "Thick Stroke",
  XPN1: "Horizontal Position of Paint 1",
  XPN2: "Horizontal Position of Paint 2",
  XROT: "Rotation in X",
  XTRA: "Counter Width",
  YEAR: "Year",
  YELA: "Vertical Element Alignment",
  YEXT: "Vertical Extension",
  YOPQ: "Thin Stroke",
  YPN1: "Vertical Position of Paint 1",
  YPN2: "Vertical Position of Paint 2",
  YROT: "Rotation in Y",
  YTAS: "Ascender Height",
  YTDE: "Descender Depth",
  YTFI: "Figure Height",
  YTLC: "Lowercase Height",
  YTUC: "Uppercase Height",
  ZROT: "Rotation in Z",
};

// Fontsource reports every bound as a string. Numbers are what a client wants
// to reason over, so they are parsed here, and `step` is dropped when it is the
// uninformative default of 1.
const toAxis = (tag, raw) => {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const axis = {
    name: AXIS_NAMES[tag] ?? undefined,
    min: num(raw?.min),
    max: num(raw?.max),
    default: num(raw?.default),
  };
  const step = num(raw?.step);
  if (step !== undefined && step !== 1) axis.step = step;
  for (const k of Object.keys(axis)) if (axis[k] === undefined) delete axis[k];
  return axis;
};

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&mdash;": "—",
  "&ndash;": "–",
};

// Fontshare's `story` is HTML more often than not — some records are wrapped
// in a <div>, others carry <br> and <p>. Flattened to one paragraph of prose.
export const stripHtml = (s) =>
  String(s ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();

/** Two keys per family: space-collapsed, and punctuation-stripped. */
export const normName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
export const tightName = (s) => normName(s).replace(/[^a-z0-9]/g, "");

let _meta;
const getMeta = () =>
  (_meta ??= loadMeta().catch((err) => {
    _meta = undefined;
    throw err;
  }));

// Metadata is an enhancement, never a precondition: if one of these two APIs
// is down, discovery still has to work with whatever the other returned. Hence
// allSettled and a per-source try — a 503 from Fontshare must not take
// list_fonts with it.
async function loadMeta() {
  const byName = new Map();
  const put = (family, patch) => {
    const key = normName(family);
    const prev = byName.get(key);
    // Fontshare wins on conflict: it is the upstream foundry for its 100
    // families, and Fontsource repackages 35 of them second-hand. Axes are the
    // exception — Fontshare only ever reports a weight range, so the variable
    // endpoint's richer record is kept where both describe the same family.
    const merged = prev ? { ...patch, ...prev } : { family, ...patch };
    if (prev?.axes && patch.axes) {
      merged.axes =
        Object.keys(patch.axes).length > Object.keys(prev.axes).length ? patch.axes : prev.axes;
    }
    byName.set(key, merged);
  };

  const grab = (url) =>
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
  const [share, source, variable] = await Promise.allSettled([
    grab(FONTSHARE_API),
    grab(FONTSOURCE_API),
    grab(FONTSOURCE_VARIABLE_API),
  ]);

  if (source.status === "fulfilled" && Array.isArray(source.value)) {
    for (const f of source.value) {
      if (!f?.family) continue;
      put(f.family, {
        categories: toCategories(f.category),
        license: f.license || undefined,
        variable: !!f.variable,
      });
    }
  }

  // Third, so neither of the others can clobber `axes` — and last because it
  // only ever adds a field to families the other two have already named.
  if (variable.status === "fulfilled" && variable.value && typeof variable.value === "object") {
    for (const entry of Object.values(variable.value)) {
      if (!entry?.family || !entry.axes) continue;
      const axes = {};
      for (const [tag, raw] of Object.entries(entry.axes)) axes[tag] = toAxis(tag, raw);
      if (Object.keys(axes).length) put(entry.family, { axes, variable: true });
    }
  }

  if (share.status === "fulfilled" && Array.isArray(share.value?.fonts)) {
    for (const f of share.value.fonts) {
      if (!f?.name) continue;
      const tags = [
        ...new Set((f.font_tags ?? []).map((t) => foldTag(t?.name ?? t)).filter(Boolean)),
      ];
      const description = stripHtml(f.story);
      // Fontshare lists one axis entry per variable style, so a family with a
      // variable roman and a variable italic reports `wght` twice with the
      // same range and different defaults (Gambetta: 300-700, default 460 and
      // 380). Merged on the property, and `default` is dropped when the
      // entries disagree rather than picking one arbitrarily.
      const axes = {};
      for (const a of f.axes ?? []) {
        const tag = a?.property;
        if (!tag || !Number.isFinite(a.range_left) || !Number.isFinite(a.range_right)) continue;
        const prev = axes[tag];
        if (!prev) {
          axes[tag] = toAxis(tag, {
            min: a.range_left,
            max: a.range_right,
            default: a.range_default,
          });
          continue;
        }
        prev.min = Math.min(prev.min, a.range_left);
        prev.max = Math.max(prev.max, a.range_right);
        if (prev.default !== a.range_default) delete prev.default;
      }
      put(f.name, {
        ...(Object.keys(axes).length ? { axes } : {}),
        categories: toCategories(f.category),
        tags,
        foundry: f.publisher?.name || undefined,
        designers: (f.designers ?? []).map((d) => d?.name).filter(Boolean),
        description: description.length > 700 ? `${description.slice(0, 700)}…` : description || undefined,
        isNew: !!f.is_new,
        variable: (f.styles ?? []).some((s) => s?.is_variable) || undefined,
      });
    }
  }

  // A tag that is itself the name of a font is a data-entry slip, not a
  // descriptor (one Fontshare family is tagged 'Poppins'). Dropped by
  // comparing against the catalog rather than by blacklisting the name, so the
  // next such slip is handled without a code change.
  const families = new Set([...byName.keys()].map(tightName));
  const vocabulary = new Map();
  for (const rec of byName.values()) {
    if (!rec.tags) continue;
    rec.tags = rec.tags.filter((t) => !families.has(tightName(t)));
    for (const t of rec.tags) vocabulary.set(t, (vocabulary.get(t) ?? 0) + 1);
  }

  return {
    byName,
    vocabulary: [...vocabulary.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    partial:
      share.status === "rejected" ||
      source.status === "rejected" ||
      variable.status === "rejected",
  };
}

/* ---------------------------------------------------------------- catalog */

let _catalog;

/**
 * Every family unifont can serve, deduped, with the providers that carry it.
 * unifont's own listFonts() concatenates per-provider catalogs without
 * deduping, which returned 6124 lines for 2168 families — 65% of the payload
 * was the same names two to four times over, about 20k tokens to say very
 * little. Collapsed here, once per process.
 */
async function getCatalog() {
  if (_catalog) return _catalog;
  const unifont = await getUnifont();
  const byName = new Map();
  for (const p of PROVIDERS) {
    let names;
    try {
      names = (await unifont.listFonts([p])) ?? [];
    } catch {
      names = []; // a single provider failing must not empty the catalog
    }
    for (const name of names) {
      const key = normName(name);
      const rec = byName.get(key);
      if (rec) {
        if (!rec.providers.includes(p)) rec.providers.push(p);
      } else {
        byName.set(key, { family: name, providers: [p] });
      }
    }
  }
  if (!byName.size) return { byName, tight: new Map(), empty: true };

  const tight = new Map();
  for (const [key, rec] of byName) tight.set(tightName(key), rec);

  // Only a non-empty catalog is worth caching; an empty one means the network
  // was down and the next call deserves a fresh attempt.
  _catalog = { byName, tight, empty: false };
  return _catalog;
}

/** Bounded edit distance — enough to rank suggestions, cheap enough for 2168. */
function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1; // whole row already too far
    prev = row;
  }
  return prev[b.length];
}

/**
 * Resolve whatever the client typed to the family name unifont knows.
 *
 * Clients arrive with the name a human typed, so 'inter', 'INTER', 'Inter '
 * and 'Jetbrains Mono' all have to land on the real family. Exact first, then
 * case- and spacing-insensitive, then punctuation-insensitive, and only then a
 * miss — with suggestions, because "No provider knows 'satoshi'" on its own
 * sends a client back to re-check a name that was almost right.
 *
 * @returns {{family: string, providers: string[]} | {miss: true, suggestions: string[]}}
 */
async function resolveName(input) {
  const { byName, tight, empty } = await getCatalog();
  if (empty) return { miss: true, suggestions: [], offline: true };

  const hit = byName.get(normName(input)) ?? tight.get(tightName(input));
  if (hit) return hit;

  const q = tightName(input);
  const scored = [];
  for (const [key, rec] of tight) {
    if (!q || !key) continue;
    if (key.includes(q) || q.includes(key)) {
      scored.push([0, rec.family]);
      continue;
    }
    const d = editDistance(q, key);
    if (d <= 3) scored.push([d, rec.family]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return { miss: true, suggestions: scored.slice(0, 5).map(([, f]) => f) };
}

const didYouMean = (suggestions) =>
  suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";

/* ---------------------------------------------------------------- writing */

// The server's cwd is wherever the client happened to launch it, not the
// user's project, so relative paths resolve against the client's first
// workspace root. Without one, only absolute paths are accepted.
async function projectRoot() {
  if (!server.server.getClientCapabilities()?.roots) return null;
  try {
    const { roots } = await server.server.listRoots();
    const root = roots.find((r) => r.uri.startsWith("file://"));
    return root ? fileURLToPath(root.uri) : null;
  } catch {
    return null;
  }
}

// As much of a path as actually exists, resolved through symlinks, with the
// not-yet-created tail appended back. Comparing raw strings would both miss a
// symlink that points out of the workspace and reject honest paths on macOS,
// where a root like /tmp/x is really /private/tmp/x.
async function realish(p) {
  const abs = resolve(p);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      const real = await realpath(head);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // nothing along this path exists
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

// A stylesheet nobody imports is the one failure that looks exactly like
// success: the files land, the rules are correct, the tool reports four faces
// written, and the page still renders in Helvetica. Worth a cheap look for a
// reference to the file before claiming victory.
const SCANNED = new Set([
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".astro", ".vue", ".svelte",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mdx",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".cache", "vendor", "target", ".venv", "out",
]);

/**
 * Does anything under `root` mention this stylesheet?
 * Best-effort and deliberately bounded — never throws, never fails an install.
 * @returns {Promise<boolean|null>} null when it could not tell.
 */
async function stylesheetIsImported(root, cssPath, budget = 1500) {
  const name = basename(cssPath);
  const self = resolve(cssPath);
  let seen = 0;
  const walk = async (dir) => {
    if (seen >= budget) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (seen >= budget) return false;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (await walk(p)) return true;
        continue;
      }
      if (!e.isFile() || !SCANNED.has(extname(e.name))) continue;
      if (resolve(p) === self) continue; // the sheet cannot import itself
      seen++;
      try {
        const st = await stat(p);
        if (st.size > 512 * 1024) continue;
        if ((await readFile(p, "utf8")).includes(name)) return true;
      } catch {
        /* unreadable file, move on */
      }
    }
    return false;
  };
  try {
    const found = await walk(root);
    return found || (seen >= budget ? null : false);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- search */

server.registerTool(
  "list_fonts",
  {
    title: "Search available font families",
    description:
      "Searches every font family fontpool can install, deduplicated, with " +
      "the category, providers and use-case tags for each. Filter by " +
      "category or tag to get a shortlist worth choosing between; " +
      "exclude: ['google'] narrows to the families Google Fonts does not " +
      "carry, and hasAxis: 'wdth' to variable fonts with a width axis. Call " +
      "with no arguments to see the category counts, tag vocabulary and axis " +
      "vocabulary. Use font_properties for the full description of one family.",
    inputSchema: {
      provider: z
        .enum(["fontshare", "fontsource", "google"])
        .optional()
        .describe("Restrict to one provider. Omit for all."),
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on the family name."),
      category: z
        .enum([
          "sans-serif",
          "serif",
          "slab-serif",
          "display",
          "handwriting",
          "monospace",
          "blackletter",
          "icons",
          "other",
        ])
        .optional()
        .describe("Restrict to one category."),
      tag: z
        .string()
        .optional()
        .describe(
          "Use-case tag, e.g. 'editorial', 'branding', 'legible', 'code'. " +
            "Call with no arguments to list the vocabulary."
        ),
      exclude: z
        .array(z.enum(["fontshare", "fontsource", "google"]))
        .optional()
        .describe(
          "Drop families these providers carry. ['google'] leaves the 218 " +
            "families Google's API does not carry."
        ),
      variableOnly: z
        .boolean()
        .optional()
        .describe("Only families with a variable axis."),
      hasAxis: z
        .string()
        .optional()
        .describe(
          "Only families carrying this variable axis, e.g. 'wdth' (width), " +
            "'opsz' (optical size), 'slnt' (slant), or an expressive one like " +
            "'CASL'. Call with no arguments to list the axis vocabulary."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum families to return. Defaults to 100."),
    },
  },
  async ({ provider, filter, category, tag, exclude, variableOnly, hasAxis, limit = 100 }) => {
    const { byName, empty } = await getCatalog();
    // unifont swallows a provider's own failures and just contributes nothing
    // to the catalog, so an unreachable network looks like success with zero
    // results. No provider legitimately returns an empty catalog, so say so.
    if (empty) {
      return {
        content: [
          {
            type: "text",
            text:
              `No provider returned a catalog. The network is probably ` +
              `unreachable, or the provider APIs are down.`,
          },
        ],
        isError: true,
      };
    }

    // Metadata only narrows the result; losing it must not break the search.
    let meta = { byName: new Map(), vocabulary: [], partial: true };
    try {
      meta = await getMeta();
    } catch {
      /* fall through with no metadata */
    }

    const wantTag = tag ? foldTag(tag) : null;
    // Axis tags are case-significant by OpenType convention — lowercase for the
    // registered five, uppercase for foundry-defined ones — but a client that
    // types 'WDTH' means wdth, so the comparison is case-blind and the row
    // reports whatever the font actually calls it.
    const wantAxis = hasAxis ? hasAxis.trim().toLowerCase() : null;
    const axisOf = (axes) =>
      wantAxis && axes ? Object.keys(axes).find((t) => t.toLowerCase() === wantAxis) : undefined;
    let rows = [];
    for (const [key, rec] of byName) {
      if (provider && !rec.providers.includes(provider)) continue;
      if (exclude?.length && rec.providers.some((p) => exclude.includes(p))) continue;
      if (filter && !rec.family.toLowerCase().includes(filter.toLowerCase())) continue;
      const m = meta.byName.get(key) ?? {};
      if (category && !(m.categories ?? []).includes(category)) continue;
      if (wantTag && !(m.tags ?? []).includes(wantTag)) continue;
      if (variableOnly && !m.variable) continue;
      if (wantAxis && !axisOf(m.axes)) continue;
      rows.push({ ...rec, ...m });
    }
    rows.sort((a, b) => a.family.localeCompare(b.family));

    const narrowed = !!(
      provider ||
      filter ||
      category ||
      wantTag ||
      exclude?.length ||
      variableOnly ||
      wantAxis
    );

    // With no filters at all, the useful answer is the shape of the catalog,
    // not 2168 names: a client that asked "what is there?" can then ask a
    // question narrow enough to be worth answering.
    if (!narrowed) {
      const cats = new Map();
      const axisCounts = new Map();
      const vocab = meta.vocabulary.slice(0, 40).map(([t, c]) => `${t} (${c})`);
      for (const key of byName.keys()) {
        const m = meta.byName.get(key);
        for (const c of m?.categories ?? ["(uncategorised)"]) {
          cats.set(c, (cats.get(c) ?? 0) + 1);
        }
        for (const t of Object.keys(m?.axes ?? {})) {
          axisCounts.set(t, (axisCounts.get(t) ?? 0) + 1);
        }
      }
      const axisRanked = [...axisCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      );
      const axes = axisRanked
        .slice(0, 20)
        .map(([t, c]) => `${t}${AXIS_NAMES[t] ? ` [${AXIS_NAMES[t]}]` : ""} (${c})`);
      if (axisRanked.length > axes.length) {
        axes.push(`…${axisRanked.length - axes.length} rarer axes`);
      }
      const nonGoogle = [...byName.values()].filter(
        (r) => !r.providers.includes("google")
      ).length;
      return {
        content: [
          {
            type: "text",
            text:
              `${byName.size} families:\n\n` +
              `By category:\n` +
              [...cats.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([c, n]) => `  ${c}: ${n}`)
                .join("\n") +
              `\n\nNot carried by Google: ${nonGoogle} families ` +
              `(exclude: ["google"] to see only these).\n` +
              (vocab.length ? `\nTags: ${vocab.join(", ")}\n` : "") +
              (axes.length ? `\nVariable axes: ${axes.join(", ")}\n` : "") +
              `\nNarrow with category, tag, filter or exclude — listing all ` +
              `${byName.size} names at once is rarely the useful answer.`,
          },
        ],
      };
    }

    const shown = rows.slice(0, limit);
    const label = [
      category && `category: ${category}`,
      wantTag && `tag: ${wantTag}`,
      exclude?.length && `excluding ${exclude.join(", ")}`,
      variableOnly && "variable only",
      wantAxis && `axis: ${wantAxis}`,
    ]
      .filter(Boolean)
      .join(", ");

    const lines = shown.map((r) => {
      const tags = Object.keys(r.axes ?? {});
      // Shown when there is something to say: a lone wght axis is what every
      // variable font has, so it only earns a column when it was asked about.
      const showAxes = tags.length > 1 || ((variableOnly || wantAxis) && tags.length);
      const bits = [
        (r.categories ?? []).join("/") || "uncategorised",
        r.providers.join("+"),
        r.foundry,
        showAxes && tags.join("+"),
        (r.tags ?? []).slice(0, 5).join(", "),
      ].filter(Boolean);
      return `${r.family} — ${bits.join(" · ")}`;
    });

    return {
      content: [
        {
          type: "text",
          text:
            `${rows.length} families${provider ? ` from ${provider}` : ""}` +
            `${label ? ` (${label})` : ""}:\n` +
            lines.join("\n") +
            (rows.length > shown.length
              ? `\n\n…${rows.length - shown.length} more. Narrow the filters, ` +
                `or raise limit (max 500).`
              : "") +
            (meta.partial
              ? `\n\n(One metadata catalog was unreachable, so categories and ` +
                `tags may be incomplete.)`
              : ""),
        },
      ],
    };
  }
);

server.registerTool(
  "font_properties",
  {
    title: "Inspect a family",
    description:
      "Everything known about one family: weights, styles, subsets, formats " +
      "and serving provider, plus its category, use-case tags, foundry and " +
      "the foundry's own description of the design. Read this before " +
      "choosing — it is what distinguishes one name from another. Variable " +
      "fonts report weight as a range like '100 900', and list every axis " +
      "they carry under variableAxes — width, optical size, slant, and any " +
      "expressive axes the typeface defines.",
    inputSchema: { family: z.string() },
  },
  async ({ family }) => {
    const resolved = await resolveName(family);
    if (resolved.miss) {
      return {
        content: [
          {
            type: "text",
            text: resolved.offline
              ? `No provider returned a catalog, so '${family}' cannot be checked. ` +
                `The network is probably unreachable.`
              : `No provider knows '${family}'.${didYouMean(resolved.suggestions)}`,
          },
        ],
        isError: true,
      };
    }

    const unifont = await getUnifont();
    const props = await unifont.getFontProperties(resolved.family);
    if (!props) {
      return {
        content: [
          {
            type: "text",
            text:
              `'${resolved.family}' is in the catalog but no provider would ` +
              `describe it. The provider API may be failing.`,
          },
        ],
        isError: true,
      };
    }

    let m = {};
    try {
      m = (await getMeta()).byName.get(normName(resolved.family)) ?? {};
    } catch {
      /* metadata is optional */
    }

    const out = {
      family: resolved.family,
      ...props,
      availableFrom: resolved.providers,
    };
    if (m.categories?.length) out.categories = m.categories;
    if (m.tags?.length) out.tags = m.tags;
    if (m.foundry) out.foundry = m.foundry;
    if (m.designers?.length) out.designers = m.designers;
    if (m.license) out.license = m.license;
    if (m.isNew) out.isNew = true;
    if (m.axes && Object.keys(m.axes).length) out.variableAxes = m.axes;
    if (m.description) {
      out.description = m.description;
      // Flagged, because it is sales copy: accurate about the design in
      // practice, but written to make the font attractive.
      out.descriptionSource = `${m.foundry ?? "the foundry"} (marketing copy)`;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

/* -------------------------------------------------------------- download */

// What the first four bytes say the payload is. woff2 files start 'wOF2';
// anything else means the download is not what the URL promised, and the one
// case worth naming is an error page served under HTTP 200 — written out as a
// .woff2 with a matching @font-face rule, it makes an install that reports
// success and renders in the fallback, with nothing anywhere saying why.
const FONT_MAGIC = {
  wOF2: "woff2",
  wOFF: "a woff (not woff2) file",
  OTTO: "an OpenType (.otf) file",
  ttcf: "a TrueType collection",
  true: "a TrueType (.ttf) file",
  "\u0000\u0001\u0000\u0000": "a TrueType (.ttf) file",
};

/** What arrived, in words, for a payload that is not woff2. */
export const describeBytes = (buf) => {
  const named = FONT_MAGIC[buf.toString("latin1", 0, 4)];
  if (named) return named;
  if (/^[\s\ufeff]*[<{]/.test(buf.toString("latin1", 0, 32))) {
    return "an HTML or JSON response, not a font";
  }
  return `${buf.length} bytes that are not a font`;
};

export const isWoff2 = (buf) => buf.length >= 4 && buf.toString("latin1", 0, 4) === "wOF2";

// Downloads are where install_font spends its wall clock: four weights across
// two styles and two subsets is sixteen files, and fetched one after another
// that was sixteen round trips end to end. Six in flight is well within what
// these CDNs expect and collapses the common install to roughly one.
const DOWNLOAD_CONCURRENCY = 6;

/**
 * Fetch every URL, at most `concurrency` in flight, preserving input order.
 * Never throws: each slot resolves to {buf} or {error}, so one bad URL
 * reports itself instead of abandoning the rest mid-flight.
 */
export async function downloadAll(urls, concurrency = DOWNLOAD_CONCURRENCY) {
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) {
      try {
        const res = await fetch(urls[i]);
        if (!res.ok) {
          out[i] = { error: `HTTP ${res.status}` };
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        out[i] = isWoff2(buf) ? { buf } : { error: `returned ${describeBytes(buf)}` };
      } catch (err) {
        out[i] = { error: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/* --------------------------------------------------------------- install */

server.registerTool(
  "install_font",
  {
    title: "Download a font into the project",
    description:
      "Resolves the family, downloads the actual woff2 files into the " +
      "project, and appends @font-face rules to a CSS file. Self-hosted — " +
      "no CDN request at runtime. Returns the exact font-family name to use.",
    inputSchema: {
      family: z.string().describe("Family name, as list_fonts reports it"),
      targetDir: z
        .string()
        .describe(
          "Where the font files go, e.g. ./public/fonts. Relative paths " +
            "resolve against the client's workspace root, and must stay " +
            "inside it."
        ),
      cssPath: z
        .string()
        .describe(
          "CSS file to create or append to, e.g. ./src/fonts.css. Must be " +
            "inside the workspace root. Prefer a stylesheet the project " +
            "already imports; a new file has to be imported by hand."
        ),
      // These are .optional() rather than .default() on purpose. A default
      // surfaces in the advertised JSON Schema as a `default` keyword on a
      // property that is absent from `required`, and some clients convert
      // that shape back into a non-optional Zod schema, then reject any call
      // that omits the field ("expected nonoptional, received undefined")
      // before it ever reaches this server. Declaring them optional and
      // filling the defaults in the handler keeps the schema unambiguous.
      weights: z
        .array(z.string())
        .optional()
        .describe(
          "e.g. ['400','700']. For variable fonts use ['100 900']. " +
            "Defaults to ['400','700']."
        ),
      styles: z
        .array(z.enum(["normal", "italic"]))
        .optional()
        .describe("Defaults to ['normal']."),
      subsets: z
        .array(z.string())
        .optional()
        .describe("Defaults to ['latin','latin-ext']."),
      urlPrefix: z
        .string()
        .optional()
        .describe(
          "The public URL path the files will be served from — not a disk " +
            "path. Files land in targetDir; the CSS points at urlPrefix. If " +
            "your static root is public/, then targetDir './public/fonts' " +
            "pairs with urlPrefix '/fonts'. Defaults to '/fonts'."
        ),
    },
  },
  async ({
    family,
    targetDir,
    cssPath,
    weights = ["400", "700"],
    styles = ["normal"],
    subsets = ["latin", "latin-ext"],
    urlPrefix = "/fonts",
  }) => {
    // '/fonts/' and '/fonts' name the same place, but joined with the filename
    // the first produced url('/fonts//inter-400.woff2'): served by most static
    // hosts, cached under a different key by some, and simply the wrong URL in
    // a file whose whole job is correct URLs.
    urlPrefix = urlPrefix.replace(/\/+$/, "");

    const root = await projectRoot();
    if (!isAbsolute(targetDir) || !isAbsolute(cssPath)) {
      if (!root) {
        return {
          content: [
            {
              type: "text",
              text:
                `Relative paths need a workspace root, and the client didn't ` +
                `provide one. Pass absolute paths for targetDir and cssPath.`,
            },
          ],
          isError: true,
        };
      }
      targetDir = resolve(root, targetDir);
      cssPath = resolve(root, cssPath);
    }

    // This tool creates directories and overwrites a stylesheet, so an
    // absolute path must not be able to reach past the project. When the
    // client advertises a workspace root, both paths have to land inside it.
    // When it advertises none there is nothing to confine against, and
    // absolute paths are accepted anywhere, as they always have been.
    if (root) {
      const realRoot = await realish(root);
      for (const [label, p] of [
        ["targetDir", targetDir],
        ["cssPath", cssPath],
      ]) {
        if (!inside(realRoot, await realish(p))) {
          return {
            content: [
              {
                type: "text",
                text:
                  `${label} '${p}' is outside the workspace root ${root}. ` +
                  `Fontpool only writes inside the project.`,
              },
            ],
            isError: true,
          };
        }
      }
    }

    const unifont = await getUnifont();
    const match = await resolveName(family);
    if (match.miss) {
      return {
        content: [
          {
            type: "text",
            text: match.offline
              ? `No provider returned a catalog, so '${family}' cannot be ` +
                `resolved. The network is probably unreachable.`
              : `No provider knows '${family}'.${didYouMean(match.suggestions)}`,
          },
        ],
        isError: true,
      };
    }
    family = match.family;

    const resolved = await unifont.resolveFont(family, {
      weights,
      styles,
      subsets,
      formats: ["woff2"],
    });

    if (!resolved?.fonts?.length) {
      // The family is in the catalog, so the name is not the problem — saying
      // "could not resolve X" here sent clients back to re-check a name that
      // was already correct. Report what it actually has instead.
      const props = await unifont.getFontProperties(family).catch(() => null);
      const have = props
        ? [
            props.weights?.length && `weights ${props.weights.join(", ")}`,
            props.styles?.length && `styles ${props.styles.join(", ")}`,
            props.subsets?.length && `subsets ${props.subsets.join(", ")}`,
          ]
            .filter(Boolean)
            .join("; ")
        : null;
      return {
        content: [
          {
            type: "text",
            text:
              `'${family}' exists, but not in the combination you asked for ` +
              `(weights ${weights.join(", ")}; styles ${styles.join(", ")}; ` +
              `subsets ${subsets.join(", ")}).` +
              (have ? ` It has ${have}.` : ` Run font_properties for what it has.`),
          },
        ],
        isError: true,
      };
    }

    // Every face that has a file behind it. A local-only source — a provider
    // naming a font it expects to find on the machine — has nothing to fetch.
    const jobs = [];
    for (const face of resolved.fonts) {
      const remotes = face.src.filter((s) => "url" in s && s.url);
      const remote = remotes.find((s) => s.format === "woff2") ?? remotes[0];
      if (!remote) continue;

      // Fontshare serves protocol-relative URLs ("//cdn.fontshare.com/..."),
      // which fetch rejects; resolve them against https.
      jobs.push({
        face,
        url: remote.url.startsWith("//") ? `https:${remote.url}` : remote.url,
      });
    }

    if (!jobs.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `'${family}' resolved to ${resolved.fonts.length} face(s), but none ` +
              `of them names a file to download — every source is a reference to ` +
              `a local font. There is nothing here to self-host.`,
          },
        ],
        isError: true,
      };
    }

    // Nothing is written until every face is in hand. Downloading straight
    // into the target directory meant a fetch that failed halfway left the
    // files it had already written on disk with no rule naming them: orphans
    // indistinguishable from a font in use. Installing only the faces that did
    // arrive is no better — a family missing the weight that was asked for
    // looks exactly like success at the call site.
    const downloads = await downloadAll(jobs.map((j) => j.url));
    const failures = downloads
      .map((d, i) => (d.error ? `  ${jobs[i].url} — ${d.error}` : null))
      .filter(Boolean);
    if (failures.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `${failures.length} of ${jobs.length} font file(s) failed to ` +
              `download, so nothing was written:\n` +
              failures.slice(0, 5).join("\n") +
              (failures.length > 5 ? `\n  …and ${failures.length - 5} more.` : ""),
          },
        ],
        isError: true,
      };
    }

    await mkdir(targetDir, { recursive: true });
    const blocks = [];
    const written = [];
    // Only the files this call brought into existence, so a failure further in
    // can undo its own work without deleting a font that was already there.
    const created = [];
    const fresh = [];
    let updated = 0;
    let sheetExisted = false;

    try {
      for (const [i, { face }] of jobs.entries()) {
        const buf = downloads[i].buf;
        const weight = Array.isArray(face.weight)
          ? face.weight.join(" ")
          : face.weight ?? 400;
        const style = face.style ?? "normal";

        // Name files by what they contain. Not every provider reports a subset
        // (Fontshare doesn't), so weight and style do the describing and the
        // content hash keeps same-named faces from colliding.
        const hash = createHash("sha1").update(buf).digest("hex").slice(0, 8);
        const name =
          [family, String(weight), style, face.meta?.subset]
            .filter(Boolean)
            .join("-")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-") + `-${hash}.woff2`;

        const dest = join(targetDir, name);
        if (!(await exists(dest))) {
          await writeFile(dest, buf);
          created.push(dest);
        }
        written.push(`${name} (${(buf.length / 1024).toFixed(1)} KB)`);

        blocks.push(
          [
            `@font-face {`,
            `  font-family: '${family}';`,
            `  font-style: ${style};`,
            `  font-weight: ${weight};`,
            `  font-display: ${face.display ?? "swap"};`,
            `  src: url('${urlPrefix}/${name}') format('woff2');`,
            face.unicodeRange?.length
              ? `  unicode-range: ${face.unicodeRange.join(", ")};`
              : null,
            `}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      // Re-installing must not stack duplicate rules. A rule is the same face
      // when everything but its src matches; if one exists, swap its src in
      // place (the file may have changed upstream) instead of appending.
      await mkdir(dirname(cssPath), { recursive: true });
      sheetExisted = await exists(cssPath);
      let sheet = sheetExisted ? await readFile(cssPath, "utf8") : "";
      for (const block of blocks) {
        const existing = sheet.match(FACE_RULE)?.find((r) => faceKey(r) === faceKey(block));
        if (!existing) fresh.push(block);
        else if (existing !== block) {
          sheet = sheet.replace(existing, () => block);
          updated++;
        }
      }
      if (fresh.length) {
        const css = `/* ${family} — via ${resolved.provider} */\n${fresh.join("\n\n")}\n`;
        sheet = sheet ? `${sheet.replace(/\n*$/, "\n")}\n${css}` : css;
      }
      if (fresh.length || updated) await writeFile(cssPath, sheet);
    } catch (err) {
      // The same rule on the way out as on the way in: no half-installed
      // family. A stylesheet that could not be written would otherwise leave
      // woff2 files behind that nothing references.
      await Promise.all(created.map((p) => unlink(p).catch(() => {})));
      return {
        content: [
          {
            type: "text",
            text:
              `Writing into the project failed: ${err.message}. ` +
              `The ${created.length} file(s) this call had written were removed, ` +
              `so nothing is half-installed.`,
          },
        ],
        isError: true,
      };
    }
    const skipped = blocks.length - fresh.length - updated;

    const fallbacks = resolved.fallbacks?.length
      ? `, ${resolved.fallbacks.join(", ")}`
      : "";

    // Only worth checking for a sheet this call created: one that was already
    // there is presumably already wired in.
    let reachability = "";
    if (!sheetExisted && root) {
      const imported = await stylesheetIsImported(root, cssPath);
      if (imported === false) {
        reachability =
          `\n\nNothing under the workspace root references ` +
          `${basename(cssPath)}, so these rules will not reach the browser ` +
          `yet. Import it from a stylesheet or entry point that is already ` +
          `loaded — e.g. @import './${basename(cssPath)}'; — or re-run with ` +
          `cssPath set to a stylesheet the project already imports.`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Installed ${family} from ${resolved.provider}.\n\n` +
            `Files in ${targetDir}:\n  ${written.join("\n  ")}\n\n` +
            `CSS in ${cssPath}: ${fresh.length} rule(s) added, ${updated} updated, ` +
            `${skipped} already present. Import it, then use:\n` +
            `  font-family: '${family}'${fallbacks};\n\n` +
            `Make sure ${basename(targetDir)} is served at ${urlPrefix || "/"}.` +
            reachability,
        },
      ],
    };
  }
);

// Importing this file (the offline tests do) must not open a transport.
// Compared through realpath, not as strings: installed via npx, argv[1] is the
// bin symlink (node_modules/.bin/fontpool), so a string compare would never
// match and the published server would never connect.
const invokedDirectly = async () => {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = await Promise.all([
      realpath(process.argv[1]),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return a === b;
  } catch {
    return false;
  }
};

if (await invokedDirectly()) {
  await server.connect(new StdioServerTransport());
}
