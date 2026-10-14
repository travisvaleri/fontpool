# fontpool-mcp

An MCP server for working with type. It searches four font providers as one
catalog, downloads the actual `woff2` files into your project, and writes the
matching `@font-face` rules.

Fonts end up **self-hosted** — no CDN request at runtime, nothing to break when
a third party changes a URL. Built on [unifont](https://github.com/unjs/unifont).

## Providers

| Provider   | What it brings |
| ---------- | -------------- |
| Fontshare  | ITF's own releases — Satoshi, Switzer, General Sans |
| Fontsource | Open-source families packaged per subset, with `unicode-range` |
| Google     | The Google Fonts catalog |
| Bunny      | Bunny Fonts, a privacy-first Google Fonts mirror |

They are consulted in that order and the first provider that knows a family
wins, so `Satoshi` resolves to the real ITF release rather than a lookalike.

**Adobe Fonts is deliberately excluded.** Adobe's terms require their fonts be
loaded from Adobe's own CDN through a kit embed, so they cannot be downloaded
into a project. A tool that promises self-hosted files cannot honestly serve
them, so Adobe is left out rather than half-supported.

## Install

Needs Node 20 or newer. No API keys, no accounts.

```bash
npx -y fontpool-mcp
```

That is also the command to put in a client config.

### Claude Code

```bash
claude mcp add fontpool -- npx -y fontpool-mcp
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "fontpool": {
      "command": "npx",
      "args": ["-y", "fontpool-mcp"]
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
      "args": ["-y", "fontpool-mcp"]
    }
  }
}
```

## Tools

### `list_fonts`

Family names only, across every provider or just one.

```json
{ "provider": "fontshare", "filter": "sans" }
```

```
8 families from fontshare:
General Sans
Bespoke Sans
Work Sans
Spline Sans
Fira Sans
...
```

`provider` is one of `fontshare`, `fontsource`, `google`, `bunny`; omit it to
search all four. `filter` is a case-insensitive substring match.

### `font_properties`

What a family actually offers, before you commit to installing it.

```json
{ "family": "Inter" }
```

```json
{
  "formats": ["woff2", "woff", "ttf"],
  "styles": ["italic", "normal"],
  "subsets": ["cyrillic", "cyrillic-ext", "greek", "greek-ext", "latin", "latin-ext", "vietnamese"],
  "weights": ["100", "200", "300", "400", "500", "600", "700", "800", "900", "100 900"],
  "provider": "fontsource"
}
```

Variable fonts report their weight as a range, like `"100 900"` — pass that
same string to `install_font` to get one variable file instead of several
static ones.

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

Two details worth knowing:

- **`urlPrefix` is the public path, not the disk path.** Files land in
  `targetDir`; the CSS references them at `urlPrefix`. If your static root is
  `public/`, then `targetDir: "./public/fonts"` pairs with
  `urlPrefix: "/fonts"`.
- **Re-installing is safe.** Filenames carry a content hash, and a rule is
  recognised as the same face when every descriptor but `src` matches, so a
  second install updates rules in place instead of stacking duplicates.

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
