#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

TMP="dist.tmp"
mkdir -p "$TMP"
rm -f "$TMP/index.js"

# The runtime loads the package entry as source: "./index.tsx" is the only entry
# that reconciles (opencode 2.2.5). This script never writes package.json, so a
# failed or stale build cannot move the entry off the source file.
entry=$(bun -e '
const fs = require("node:fs")
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
process.stdout.write(String(pkg?.exports?.["./tui"] ?? ""))
' 2>/dev/null || true)
if [ "$entry" != "./index.tsx" ]; then
  echo "package.json entry is \"$entry\"; it must stay \"./index.tsx\" (the runtime loads the source entry)" >&2
  exit 1
fi

if ! bun build index.tsx \
  --target node \
  --outfile "$TMP/index.js" \
  --external @opencode/plugin/tui \
  --external solid-js \
  --external @opentui/solid \
  --external @opentui/core; then
  echo "build failed; dist/index.js and package.json were not changed" >&2
  exit 1
fi

fail() {
  echo "build validation failed: $1; dist/index.js and package.json were not changed" >&2
  exit 1
}

grep -q "(() => ({}))" "$TMP/index.js" && fail "browser empty polyfill found"
grep -q "TextAttributes" "$TMP/index.js" && fail "TextAttributes reference found"
grep -q "glyph is not defined" "$TMP/index.js" && fail "undefined glyph reference found"
grep -q "node:fs/promises" "$TMP/index.js" || fail "node:fs/promises missing"
grep -q "node:os" "$TMP/index.js" || fail "node:os missing"
grep -q "displayStatus" "$TMP/index.js" || fail "plugin entry missing"

mkdir -p dist
mv -f "$TMP/index.js" dist/index.js
rmdir "$TMP" 2>/dev/null || true

echo "built dist/index.js and validated entries"
