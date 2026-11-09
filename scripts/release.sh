#!/usr/bin/env bash
# Builds the macOS app on this Mac and publishes it as the GitHub release of the checked-out tag.
# Replaces the old release workflow: GitHub's Apple Silicon runners were too often unavailable.
#
#   git checkout vX.Y.Z && scripts/release.sh            # publish
#   scripts/release.sh --draft                           # create a draft to review first
#
# Needs: a clean checkout at the tag vX.Y.Z, Rust + pnpm (see README), and `gh` signed in.
set -euo pipefail
cd "$(dirname "$0")/.."

draft=()
[ "${1:-}" = "--draft" ] && draft=(--draft)

v=$(node -p "require('./frontend/package.json').version")
cargo_v=$(sed -n 's/^version = "\(.*\)"$/\1/p' backend/Cargo.toml | sed -n 1p)
tauri_v=$(node -p "require('./backend/tauri.conf.json').version")
[ "$v" = "$cargo_v" ] && [ "$v" = "$tauri_v" ] || { echo "Version mismatch: package.json=$v Cargo.toml=$cargo_v tauri.conf.json=$tauri_v" >&2; exit 1; }
tag="v$v"
[ "$(git describe --tags --exact-match HEAD 2>/dev/null)" = "$tag" ] || { echo "HEAD is not tagged $tag; check out the tag first." >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "The checkout has uncommitted changes." >&2; exit 1; }
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || { echo "Push the tag first: git push origin $tag" >&2; exit 1; }
heading=$(grep -m 1 "^## \[$v\]" docs/CHANGELOG.md || true)
[ -n "$heading" ] || { echo "No CHANGELOG section for $v" >&2; exit 1; }

(cd frontend && pnpm install --frozen-lockfile && pnpm tauri build)

out=$(mktemp -d)
app="backend/target/release/bundle/macos/ICF Control Center.app"
# Not notarized: an ad-hoc signature, as for every release (users allow the first launch).
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict --verbose=2 "$app"
zip="ICF-Control-Center-$v-macOS-arm64.zip"
ditto -c -k --keepParent "$app" "$out/$zip"
(cd "$out" && shasum -a 256 "$zip" | tee "$zip.sha256")

subtitle=${heading##*· }
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
docs="https://github.com/$repo/blob/$tag/docs"
{
  echo "## ICF Control Center $v · $subtitle"
  echo
  # This version's CHANGELOG section; relative doc links made absolute for the release page.
  awk -v h="$heading" '$0 == h {on = 1; next} on && /^## \[/ {exit} on' docs/CHANGELOG.md |
    sed -E "s#\]\(([A-Za-z0-9_./-]+\.md)\)#](${docs}/\1)#g"
  echo
  echo "Full list: [CHANGELOG.md]($docs/CHANGELOG.md)"
  echo
  echo "---"
  echo
  echo "### ⬇️ Install"
  echo "1. Download **\`$zip\`** below and unzip it."
  echo "2. Move **ICF Control Center.app** to **Applications**, replacing the older version."
  echo "3. The app is not notarized by Apple, so macOS blocks the first launch. Allow it once:"
  echo "   - **System Settings → Privacy & Security → Open Anyway**, or"
  echo "   - Terminal: \`xattr -dr com.apple.quarantine \"/Applications/ICF Control Center.app\"\`"
  echo
  echo "**Requirements:** an Apple Silicon Mac with macOS 13+, and an Informatics (DICE) account with ICF access."
  echo
  echo "**SHA-256** \`$zip\`:"
  echo "\`$(cut -d ' ' -f 1 "$out/$zip.sha256")\`"
} > "$out/notes.md"

gh release create "$tag" "$out/$zip" "$out/$zip.sha256" ${draft[@]+"${draft[@]}"} --verify-tag \
  --title "ICF Control Center $v — $subtitle" --notes-file "$out/notes.md"
echo "Release files kept in $out"
