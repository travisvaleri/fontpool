#!/usr/bin/env node
/**
 * Fontpool — find a font across providers, download it, wire up the CSS.
 *
 *   npm install unifont @modelcontextprotocol/sdk zod
 *
 * Providers: fontshare, fontsource, google, bunny, npm, adobe.
 * Everything except adobe yields real files on disk. Adobe is CDN-only by
 * licence, so it is deliberately left out below.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createUnifont, providers } from "unifont";
import { mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import {
  join,
  basename,
  dirname,
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
    providers.bunny(),
  ]).catch((err) => {
    // Don't cache the rejection — the next call deserves a fresh attempt.
    _unifont = undefined;
    throw err;
  }));

const server = new McpServer({ name: "fontpool", version: "1.1.0" });

const exists = (p) => access(p).then(() => true, () => false);

const FACE_RULE = /@font-face\s*\{[^}]*\}/g;
// Identity of an @font-face rule: every descriptor except src, whitespace-blind.
const faceKey = (rule) =>
  rule
    .replace(/(^|[{;])\s*src\s*:[^;}]*;?/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();

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

/* ---------------------------------------------------------------- search */

server.registerTool(
  "list_fonts",
  {
    title: "List available font families",
    description:
      "Lists every font family available across the configured providers " +
      "(fontshare, fontsource, google, bunny). Returns family names only — " +
      "use font_properties for details on a specific one.",
    inputSchema: {
      provider: z
        .enum(["fontshare", "fontsource", "google", "bunny"])
        .optional()
        .describe("Restrict to one provider. Omit for all."),
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on the family name."),
    },
  },
  async ({ provider, filter }) => {
    const unifont = await getUnifont();
    const names = (await unifont.listFonts(provider ? [provider] : undefined)) ?? [];
    // unifont swallows a provider's own failures and just contributes nothing
    // to the catalog, so an unreachable network looks like success with zero
    // results. No provider legitimately returns an empty catalog, so say so.
    if (!names.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `No provider returned a catalog${provider ? ` for ${provider}` : ""}. ` +
              `The network is probably unreachable, or the provider API is down.`,
          },
        ],
        isError: true,
      };
    }
    const hits = filter
      ? names.filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
      : names;
    return {
      content: [
        {
          type: "text",
          text:
            `${hits.length} families${provider ? ` from ${provider}` : ""}:\n` +
            hits.join("\n"),
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
      "Returns the weights, styles, subsets, available formats, and serving " +
      "provider for one font family. Variable fonts report weight as a " +
      "range like '100 900'.",
    inputSchema: { family: z.string() },
  },
  async ({ family }) => {
    const unifont = await getUnifont();
    const props = await unifont.getFontProperties(family);
    if (!props) {
      return {
        content: [
          { type: "text", text: `No provider knows '${family}'.` },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(props, null, 2) }],
    };
  }
);

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
      family: z.string().describe("Exact family name from list_fonts"),
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
            "inside the workspace root."
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
          "Public URL path the files will be served from. Defaults to '/fonts'."
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
    const resolved = await unifont.resolveFont(family, {
      weights,
      styles,
      subsets,
      formats: ["woff2"],
    });

    if (!resolved?.fonts?.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `Could not resolve '${family}'. Check the spelling against ` +
              `list_fonts, or the requested weights may not exist — run ` +
              `font_properties first.`,
          },
        ],
        isError: true,
      };
    }

    await mkdir(targetDir, { recursive: true });
    const blocks = [];
    const written = [];

    for (const face of resolved.fonts) {
      const remotes = face.src.filter((s) => "url" in s && s.url);
      const remote = remotes.find((s) => s.format === "woff2") ?? remotes[0];
      if (!remote) continue; // local-only source, nothing to download

      // Fontshare serves protocol-relative URLs ("//cdn.fontshare.com/..."),
      // which fetch rejects; resolve them against https.
      const url = remote.url.startsWith("//") ? `https:${remote.url}` : remote.url;

      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Download failed for ${url}: ${err.message}` },
          ],
          isError: true,
        };
      }
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Download failed for ${url} (HTTP ${res.status}).`,
            },
          ],
          isError: true,
        };
      }
      const buf = Buffer.from(await res.arrayBuffer());

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
      if (!(await exists(dest))) await writeFile(dest, buf);
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
    let sheet = (await exists(cssPath)) ? await readFile(cssPath, "utf8") : "";
    const fresh = [];
    let updated = 0;
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
    const skipped = blocks.length - fresh.length - updated;

    const fallbacks = resolved.fallbacks?.length
      ? `, ${resolved.fallbacks.join(", ")}`
      : "";

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
            `Make sure ${basename(targetDir)} is served at ${urlPrefix}.`,
        },
      ],
    };
  }
);

await server.connect(new StdioServerTransport());
