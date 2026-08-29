#!/bin/sh
set -eu

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  echo "usage: $0 <YYYY-MM-DD.N> [output-directory]" >&2
  exit 2
}

release=$1
output_dir=${2:-"$HOME/.local/share/buildparty/releases"}
printf '%s\n' "$release" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$' || {
  echo "release must use YYYY-MM-DD.N (for example 2026-09-02.1)" >&2
  exit 2
}

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
image="buildparty:$release"
archive="$output_dir/buildparty-$release-linux-amd64.tar"
checksum="$archive.sha256"
[ ! -e "$archive" ] && [ ! -e "$checksum" ] || {
  echo "release already exists: $release" >&2
  exit 2
}
mkdir -p "$output_dir"

echo "Building $image for linux/amd64..."
docker buildx build --platform linux/amd64 --load \
  --label "org.opencontainers.image.version=$release" \
  -t "$image" "$root"
[ "$(docker image inspect --format '{{.Architecture}}/{{.Os}}' "$image")" = "amd64/linux" ] || {
  echo "built image is not linux/amd64" >&2
  exit 1
}

tmp="$archive.tmp"
trap 'rm -f "$tmp"' EXIT INT TERM
docker image save -o "$tmp" "$image"
mv "$tmp" "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  hash=$(sha256sum "$archive" | awk '{print $1}')
else
  hash=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
printf '%s  %s\n' "$hash" "$(basename "$archive")" > "$checksum"
printf 'Created %s\nChecksum %s\n' "$archive" "$checksum"
