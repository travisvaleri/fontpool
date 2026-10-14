// Drive server.mjs the way a client does: a real child process, real stdio,
// real JSON-RPC. Nothing here imports the server as a module, because the
// things worth testing (startup order, the roots handshake) only exist over
// the wire.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

// Live provider APIs and font downloads. Set to skip them offline.
export const SKIP_NETWORK = !!process.env.FONTPOOL_SKIP_NETWORK_TESTS;

/**
 * Spawn the server and complete the MCP handshake.
 * @param {{root?: string, nodeArgs?: string[]}} opts
 *   root     - advertise this directory as the client's workspace root
 *   nodeArgs - extra argv for node, before the server path (e.g. --import)
 */
export async function startServer({ root, nodeArgs = [] } = {}) {
  const client = new Client(
    { name: "fontpool-test", version: "1.0.0" },
    { capabilities: root ? { roots: {} } : {} }
  );
  if (root) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(root).href, name: "workspace" }],
    }));
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArgs, SERVER],
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (d) => stderr.push(String(d)));

  await client.connect(transport);

  return {
    client,
    stderr: () => stderr.join(""),
    /** Call a tool and flatten the result to { isError, text }. */
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return {
        isError: !!r.isError,
        text: (r.content ?? []).map((c) => c.text ?? `<${c.type}>`).join("\n"),
      };
    },
    close: () => client.close(),
  };
}

/** A fresh workspace directory, plus the paths install_font writes into. */
export async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "fontpool-test-"));
  return {
    dir,
    fonts: join(dir, "public", "fonts"),
    css: join(dir, "src", "fonts.css"),
    read: () => readFile(join(dir, "src", "fonts.css"), "utf8"),
  };
}

/** The @font-face rules in a stylesheet, in source order. */
export const rules = (css) => css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

/** Everything but the src descriptor: what makes two rules the same face. */
export const faceKey = (rule) =>
  rule
    .replace(/(^|[{;])\s*src\s*:[^;}]*;?/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
