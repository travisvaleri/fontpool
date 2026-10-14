#!/usr/bin/env bash
# Package Fontpool into a .mcpb bundle.
#
# Why this exists: the server that Claude actually runs is the *installed
# extension*, not this directory. Editing server.mjs here and restarting
# Claude changes nothing, because a restart re-launches the installed copy.
# Every edit has to be repackaged and reinstalled, or dev-pushed with --dev.
#
#   ./build.sh          package to ~/Downloads/fontpool.mcpb
#   ./build.sh --dev    also copy server.mjs straight into the installed
#                       extension (fast iteration; still needs a Claude restart)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HOME/Downloads/fontpool.mcpb}"
EXT="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.travis.fontpool"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

node --check "$SRC/server.mjs"
VERSION="$(node -p "require('$SRC/manifest.json').version")"
PKGVER="$(node -p "require('$SRC/package.json').version")"
if [ "$VERSION" != "$PKGVER" ]; then
  echo "version mismatch: manifest.json $VERSION vs package.json $PKGVER" >&2
  exit 1
fi
# The version the server reports over the wire is a separate literal, so it
# drifts silently unless it is checked too.
SRVVER="$(sed -n 's/.*new McpServer({ *name: *"fontpool", *version: *"\([^"]*\)".*/\1/p' "$SRC/server.mjs")"
if [ "$SRVVER" != "$VERSION" ]; then
  echo "version mismatch: server.mjs $SRVVER vs manifest.json $VERSION" >&2
  exit 1
fi

# server.json is the MCP registry's copy and ships nothing into the bundle, but
# a registry entry pointing at the wrong npm version is its own kind of broken.
# It carries the version twice, and neither copy is covered above.
REGVER="$(node -p "require('$SRC/server.json').version")"
REGPKGVER="$(node -p "require('$SRC/server.json').packages[0].version")"
if [ "$REGVER" != "$VERSION" ] || [ "$REGPKGVER" != "$VERSION" ]; then
  echo "version mismatch: server.json $REGVER / packages[0] $REGPKGVER vs manifest.json $VERSION" >&2
  exit 1
fi

mkdir -p "$STAGE/server"
cp "$SRC/manifest.json" "$STAGE/manifest.json"
cp "$SRC/server.mjs" "$STAGE/server/server.mjs"
cp "$SRC/package.json" "$STAGE/server/package.json"
cp -R "$SRC/node_modules" "$STAGE/server/node_modules"

rm -f "$OUT"
(cd "$STAGE" && zip -q -r -X "$OUT" manifest.json server)
echo "built $OUT  (v$VERSION, $(du -h "$OUT" | cut -f1))"
echo "sha256 $(shasum -a256 "$OUT" | cut -d' ' -f1)"

if [ "${1:-}" = "--dev" ]; then
  if [ -d "$EXT/server" ]; then
    cp "$SRC/server.mjs" "$EXT/server/server.mjs"
    echo "dev-pushed server.mjs into the installed extension"
    echo "restart Claude Desktop for it to take effect"
  else
    echo "installed extension not found at $EXT" >&2
  fi
fi

echo
echo "To install: open Claude Desktop → Settings → Extensions → install $OUT"
echo "A restart alone will NOT pick up source edits."
