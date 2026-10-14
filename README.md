# Fontpool

An MCP server for working with type. It searches three font providers as one
catalog, tells you what each family actually *is* — category, use-case tags,
the foundry's own description, every variable axis — downloads the real `woff2`
files into your project, and writes the matching `@font-face` rules.

Fonts end up **self-hosted** — no CDN request at runtime, nothing to break when
a third party changes a URL. Built on [unifont](https://github.com/unjs/unifont).

The point is not convenience. An AI asked to style a page reaches for `Inter`
or `Roboto` almost every time, partly because they are the most probable names
and partly because they are the ones it knows it can load. Fontpool exists so
that there is something to consult instead: 2,168 families, with the category,
use-case tags and the foundry's own description of each, of which **218 are not
in Google's catalog**.

## Providers

| Provider   | What it brings |
| ---------- | -------------- |
| Fontshare  | ITF's own releases — Satoshi, Switzer, General Sans, Clash Display. 65 families nothing else carries |
| Fontsource | Open-source families packaged per subset, with `unicode-range`. 127 families nothing else carries |
| Google     | The Google Fonts catalog |

They are consulted in that order and the first provider that knows a family
wins, so `Satoshi` resolves to the real ITF release rather than a lookalike.

Google carries **no unique families** — it is wholly contained in Fontsource,
which sits ahead of it, so it has never been the provider that actually served
an install. It is kept only as a fallback: unifont swallows a provider's own
catalog failure, so if Fontsource — and with it jsDelivr — is unreachable,
Google still covers about 1,950 families.

**Bunny was removed in 1.3.0.** It was a Google Fonts mirror and cost nothing
to drop: the catalog is 2,168 families with or without it. The 26 retired
Google names it was keeping alive — `Source Sans Pro`, `Material Symbols`, the
`Big Shoulders` family — are all in Fontsource too, so nothing became
unreachable. Its "privacy-first" pitch was never relevant here either: fontpool
downloads the file and self-hosts it, so no request reaches any CDN at runtime.

One caveat on the 218 figure: it counts families Google's API does not
*currently* carry, about 26 of which Google once shipped and has since retired
rather than never having had. The families that were never Google's number
roughly 192.

**Adobe Fonts is deliberately excluded.** Adobe's terms require their fonts be
loaded from Adobe's own CDN through a kit embed, so they cannot be downloaded
into a project. A tool that promises self-hosted files cannot honestly serve
them, so Adobe is left out rather than half-supported.

## Install

Needs Node 20 or newer. No API keys, no accounts.

```bash
npx -y fontpool
```

That is also the command to put in a client config.

### Claude Code

```bash
claude mcp add fontpool -- npx -y fontpool
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "fontpool": {
      "command": "npx",
      "args": ["-y", "fontpool"]
    }
  }
}
```

### Cursor / Windsurf / Zed and other stdio clients

Same shape, in that client's MCP config:

```json
{
  "mcpServers": {
    "fontpool": {
      "command": "npx",
      "args": ["-y", "fontpool"]
    }
  }
}
```

### The skill

[`SKILL.md`](SKILL.md) ships alongside the server. The tools are no use if the
model never thinks to call them, and nothing about writing CSS naturally
prompts a pause to go looking — so the skill is what puts a step between "this
needs a sans-serif" and typing a font name. Copy it wherever your client reads
skills from, or point your agent at it directly.

## Tools

### `list_fonts`

Search the catalog. Called with no arguments it describes the catalog's shape
rather than dumping 2,168 names, which is how you discover the tag vocabulary:

```json
{}
```

```
2168 families:

By category:
  sans-serif: 824
  display: 500
  serif: 379
  handwriting: 369
  monospace: 72
  other: 17
  icons: 8
  slab-serif: 4
  blackletter: 1

Not carried by Google: 218 families (exclude: ["google"] to see only these).

Tags: poster (53), magazine (50), book (37), logo (31), website (29),
banners (28), editorial (23), branding (20), headline (18), app (11),
legible (11), packaging (9), screen (8), code (5), fun (5), …

Variable axes: wght [Weight] (614), ital [Italic] (185), wdth [Width] (97),
opsz [Optical Size] (32), slnt [Slant] (23), ELSH [Element Shape] (15),
CRSV [Cursive] (14), GRAD [Grade] (8), MONO [Monospace] (3), …30 rarer axes

Narrow with category, tag, filter or exclude — listing all 2168 names at
once is rarely the useful answer.
```

With filters you get a shortlist worth choosing between:

```json
{ "category": "serif", "tag": "editorial" }
```

```
6 families (category: serif, tag: editorial):
Bespoke Serif — serif · fontshare · Indian Type Foundry · magazine, poster, book, branding, editorial
Crimson Pro — serif · fontshare+fontsource+google · magazine, publishing, editorial
Gambarino — serif · fontshare · Indian Type Foundry · magazine, poster, book, editorial
Karma — serif · fontshare+fontsource+google · Indian Type Foundry · banners, editorial
Rowan — serif · fontshare · Indian Type Foundry · book, text, legible, editorial
Zodiak — serif · fontshare · Indian Type Foundry · editorial, magazine, book
```

| Parameter | Effect |
| --------- | ------ |
| `provider` | One of `fontshare`, `fontsource`, `google` |
| `filter` | Case-insensitive substring match on the family name |
| `category` | `sans-serif`, `serif`, `slab-serif`, `display`, `handwriting`, `monospace`, `blackletter`, `icons`, `other` |
| `tag` | Use-case tag — `editorial`, `branding`, `legible`, `code`, … |
| `exclude` | Drop families these providers carry. `["google"]` leaves the 218 Google's API does not carry |
| `variableOnly` | Only families with a variable axis |
| `hasAxis` | Only families carrying this axis — `wdth`, `opsz`, `slnt`, or an expressive one like `CASL`. Case-blind |
| `limit` | Maximum families returned. Defaults to 100, max 500 |

Results are deduplicated. unifont's own catalog returns the same family once
per provider that carries it — 6,124 lines for 2,168 families, about 20k tokens
of mostly repetition — so they are collapsed here, with the providers listed
per family instead.

### `font_properties`

What a family actually offers, and what it *is*, before you commit to it.
Family names are matched case- and spacing-insensitively, so `satoshi` and
`jetbrains mono` both resolve.

```json
{ "family": "Satoshi" }
```

```json
{
  "family": "Satoshi",
  "formats": ["woff2", "woff", "ttf"],
  "styles": ["normal", "italic"],
  "weights": ["300", "400", "500", "700", "900", "300 900"],
  "provider": "fontshare",
  "availableFrom": ["fontshare"],
  "categories": ["sans-serif"],
  "tags": ["logo", "magazine", "branding"],
  "foundry": "Indian Type Foundry",
  "designers": ["Deni Anggara"],
  "description": "Satoshi is a modernist sans serif typeface. Its design combines typically grotesk-style letterforms, with some characters that are quite geometrically-designed…",
  "descriptionSource": "Indian Type Foundry (marketing copy)",
  "variableAxes": {
    "wght": { "name": "Weight", "min": 300, "max": 900, "default": 780 }
  }
}
```

Variable fonts report their weight as a range, like `"300 900"` — pass that
same string to `install_font` to get one variable file instead of several
static ones.

`variableAxes` lists every axis the family carries, not just weight, which is
often the reason to choose one font over another:

```json
{
  "family": "Recursive",
  "variableAxes": {
    "wght": { "name": "Weight",     "min": 300, "max": 1000, "default": 400 },
    "slnt": { "name": "Slant",      "min": -15, "max": 0,    "default": 0 },
    "CASL": { "name": "Casual",     "min": 0,   "max": 1,    "default": 0,   "step": 0.01 },
    "CRSV": { "name": "Cursive",    "min": 0,   "max": 1,    "default": 0.5, "step": 0.1 },
    "MONO": { "name": "Monospace",  "min": 0,   "max": 1,    "default": 0,   "step": 0.01 }
  }
}
```

Lowercase tags are the five OpenType-registered axes; uppercase ones are
foundry-defined and mean whatever that typeface decided they mean. `step` is
omitted when it is the uninformative default of 1. Filter on any of them with
`list_fonts { hasAxis: "wdth" }` — 97 of the 2,168 families have a width axis,
which is not a thing you can find by reading names.

`description` is the foundry's own copy, fetched from the provider's catalog
and flagged as such. It is reliable about the design and enthusiastic about its
merits; weigh it accordingly. A miss suggests near matches rather than only
reporting failure:

```
No provider knows 'Intar'. Did you mean: Inter, NTR, Anta, Inder, Zina?
```

### `install_font`

Downloads the files and writes the CSS.

```json
{
  "family": "Inter",
  "targetDir": "./public/fonts",
  "cssPath": "./src/fonts.css",
  "weights": ["400", "700"],
  "styles": ["normal"],
  "subsets": ["latin", "latin-ext"],
  "urlPrefix": "/fonts"
}
```

```
Installed Inter from fontsource.

Files in /Users/you/app/public/fonts:
  inter-400-normal-latin-68f645c6.woff2 (23.1 KB)
  inter-700-normal-latin-5197a7ae.woff2 (23.8 KB)
  inter-400-normal-latin-ext-1bf1f837.woff2 (34.2 KB)
  inter-700-normal-latin-ext-c8d55506.woff2 (35.4 KB)

CSS in /Users/you/app/src/fonts.css: 4 rule(s) added, 0 updated, 0 already
present. Import it, then use:
  font-family: 'Inter', sans-serif;

Make sure fonts is served at /fonts.
```

Only `family`, `targetDir` and `cssPath` are required. The rest default to
weights `400` and `700`, style `normal`, subsets `latin` and `latin-ext`, and
a `urlPrefix` of `/fonts`.

Three details worth knowing:

- **`urlPrefix` is the public path, not the disk path.** Files land in
  `targetDir`; the CSS references them at `urlPrefix`. If your static root is
  `public/`, then `targetDir: "./public/fonts"` pairs with
  `urlPrefix: "/fonts"`.
- **A stylesheet nothing imports is reported.** Creating `fonts.css` that no
  file references is the one failure that looks exactly like success — the
  files land, the rules are right, and the page still renders in Helvetica. If
  the new stylesheet is unreferenced anywhere under the workspace root, the
  result says so and tells you what to add. Prefer a `cssPath` the project
  already imports.
- **Re-installing is safe.** Filenames carry a content hash, and a rule is
  recognised as the same face when every descriptor but `src` matches, so a
  second install updates rules in place instead of stacking duplicates.

A family that exists but lacks the weights you asked for says so, rather than
blaming the name:

```
'Satoshi' exists, but not in the combination you asked for (weights 350;
styles normal; subsets latin, latin-ext). It has weights 300, 400, 500, 700,
900, 300 900; styles normal, italic.
```

## Where metadata comes from

Categories, tags, foundries and descriptions are read from two catalog APIs —
[Fontshare's](https://api.fontshare.com/v2/fonts) 100 families and
[Fontsource's](https://api.fontsource.org/v1/fonts) 2,103 — which between them
cover the whole catalog, because Google is itself a subset of Fontsource.
Google's public API carries category and nothing else, so it is not
consulted.

Variable axes come from a third endpoint,
[Fontsource's `/v1/variable`](https://api.fontsource.org/v1/variable), whose
573 families join onto the catalog by name with nothing left over. Fontshare
publishes its own axes too, which is the only way the 65 families unique to it
report a weight range at all — it lists one entry per variable style, so a
family with a variable roman and italic reports `wght` twice; those are merged
on the range, and `default` is dropped when the entries disagree rather than
picking one arbitrarily.

Axis display names are Google's
[axis registry](https://fonts.google.com/variablefonts#axis-definitions), 56
tags, hardcoded rather than fetched: the registry lives inside a 2.7MB payload
whose other 2.68MB is the Google font list, and it changes about once a year. A
tag added after that was copied passes through unlabelled, with its range
intact.

unifont already fetches the two catalog APIs and keeps the full records, then
uses them for one thing: choosing `serif` or `sans-serif` as a CSS fallback.
Rather than fork it, fontpool fetches them again, which costs one request each
at first use — three in total, in parallel, on the first tool call.

Fontshare's tags are free text, so they are folded before being exposed —
`Poster` and `Posters` are one term, casing is normalised, and a tag that is
itself the name of a font in the catalog is dropped as a data-entry slip.
Metadata is an enhancement, never a precondition: if any of the three
endpoints is unreachable, search still works and the result says the metadata
is incomplete.

## Where it is allowed to write

`install_font` creates directories and appends to a stylesheet, so its reach
is limited to the project:

- When the client advertises a workspace root (most do), relative paths
  resolve against that root and **both paths must stay inside it** —
  symlinks included. Anything that escapes is refused with an error.
- When the client advertises **no** root, there is nothing to confine against:
  relative paths are refused outright, and absolute paths are taken at face
  value and written wherever they point.

## Development

```bash
npm install
npm test
```

The suite drives the server as a child process over real stdio JSON-RPC. Most
of it hits the live provider APIs and downloads real fonts; set
`FONTPOOL_SKIP_NETWORK_TESTS=1` to run only the offline tests.

`./build.sh` packages the same server as a Claude Desktop `.mcpb` extension
in `~/Downloads`, and `./build.sh --dev` pushes `server.mjs` straight into an
already-installed copy.

## Licence

MIT © Travis Valeri
