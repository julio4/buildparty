#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir "$tmp/bin" "$tmp/releases"

cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
case "$1 $2" in
  "buildx build")
    [ -z "${MOCK_APPEAR_ARCHIVE:-}" ] || printf 'external\n' > "$MOCK_APPEAR_ARCHIVE"
    ;;
  "image inspect") printf 'amd64/linux\n' ;;
  "image save")
    shift 2
    [ "$1" = -o ]
    printf 'mock image\n' > "$2"
    ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$tmp/bin/docker"

PATH="$tmp/bin:$PATH" "$root/scripts/build-release.sh" 2026-09-03.9 "$tmp/releases" >/dev/null
archive="$tmp/releases/buildparty-2026-09-03.9-linux-amd64.tar"
[ "$(cat "$archive")" = "mock image" ]
(cd "$tmp/releases" && sha256sum -c "$(basename "$archive").sha256") >/dev/null
before=$(sha256sum "$archive")
if PATH="$tmp/bin:$PATH" "$root/scripts/build-release.sh" 2026-09-03.9 "$tmp/releases" >/dev/null 2>&1; then
  echo "existing release was overwritten" >&2
  exit 1
fi
[ "$(sha256sum "$archive")" = "$before" ]

raced="$tmp/releases/buildparty-2026-09-03.10-linux-amd64.tar"
if PATH="$tmp/bin:$PATH" MOCK_APPEAR_ARCHIVE="$raced" "$root/scripts/build-release.sh" 2026-09-03.10 "$tmp/releases" >/dev/null 2>&1; then
  echo "release created over an archive that appeared during the build" >&2
  exit 1
fi
[ "$(cat "$raced")" = external ]
[ ! -e "$raced.sha256" ]

mkdir "$tmp/releases/.buildparty-2026-09-03.11.lock"
if PATH="$tmp/bin:$PATH" "$root/scripts/build-release.sh" 2026-09-03.11 "$tmp/releases" >/dev/null 2>&1; then
  echo "concurrent release lock was ignored" >&2
  exit 1
fi

cat > "$tmp/bin/mktemp" <<'MOCK'
#!/bin/sh
exit 1
MOCK
chmod +x "$tmp/bin/mktemp"
if PATH="$tmp/bin:$PATH" "$root/scripts/build-release.sh" 2026-09-03.12 "$tmp/releases" >/dev/null 2>&1; then
  echo "mktemp failure unexpectedly succeeded" >&2
  exit 1
fi
[ ! -d "$tmp/releases/.buildparty-2026-09-03.12.lock" ]

echo "Release archive locking, cleanup, checksum, architecture, and no-overwrite behavior passes."
