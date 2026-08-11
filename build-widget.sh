#!/usr/bin/env bash
#
# Package Lead Performance 360 as a Zoho CRM widget (Zoho Extension Toolkit).
#
# The app files stay at the repo root so GitHub Pages keeps serving them from
# the root URL. This stages a copy into the layout ZET expects — a
# plugin-manifest.json beside an app/ directory — and packs that instead, so
# the two delivery paths never fight over the same folder.
#
# Two zips come out, because the two upload paths want different layouts:
#
#   build/LeadPerformance360-widget.zip
#       Flat — index.html at the zip root. This is the one for
#       CRM Setup > Developer Hub > Widgets, hosted "Zoho".
#       Page path there is:  /index.html
#
#   build/LeadPerformance360/dist/LeadPerformance360.zip
#       ZET layout — files under app/, same as your other widget projects.
#       For the Sigma extension flow. Page path is:  /app/index.html
#
# Usage:  ./build-widget.sh
#
set -euo pipefail
cd "$(dirname "$0")"

NAME="LeadPerformance360"
STAGE="build/$NAME"

command -v zet >/dev/null 2>&1 || {
  echo "zet not found. Install it with: npm i -g zoho-extension-toolkit" >&2
  exit 1
}

rm -rf build
mkdir -p "$STAGE/app"

cp index.html style.css script.js "$STAGE/app/"

cat > "$STAGE/plugin-manifest.json" <<'EOF'
{
  "service": "CRM"
}
EOF

( cd "$STAGE" && zet pack )

# Flat zip for the CRM Widgets uploader: index.html must sit at the root, so
# zip from inside app/ rather than zipping the folder itself.
( cd "$STAGE/app" && zip -q -r "../../$NAME-widget.zip" index.html style.css script.js )

echo
echo "Packages:"
echo "  CRM Widgets upload (page path /index.html):"
echo "    build/$NAME-widget.zip"
echo "  ZET / Sigma (page path /app/index.html):"
find "$STAGE/dist" -name '*.zip' -print 2>/dev/null | sed 's/^/    /'
