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
lock="$output_dir/.buildparty-$release.lock"
mkdir -p "$output_dir"
mkdir "$lock" 2>/dev/null || { echo "release is already built or building: $release" >&2; exit 2; }
tmp=""
checksum_tmp=""
owned_archive=false
owned_checksum=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$tmp" ] || rm -f "$tmp" "$checksum_tmp"
  [ "$status" -eq 0 ] || [ "$owned_checksum" != true ] || rm -f "$checksum"
  [ "$status" -eq 0 ] || [ "$owned_archive" != true ] || rm -f "$archive"
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tmp=$(mktemp "$output_dir/.buildparty-$release.XXXXXX.tar")
checksum_tmp="$tmp.sha256"
[ ! -e "$archive" ] && [ ! -e "$checksum" ] || {
  echo "release already exists: $release" >&2
  exit 2
}

echo "Building $image for linux/amd64..."
docker buildx build --platform linux/amd64 --load \
  --label "org.opencontainers.image.version=$release" \
  -t "$image" "$root"
[ "$(docker image inspect --format '{{.Architecture}}/{{.Os}}' "$image")" = "amd64/linux" ] || {
  echo "built image is not linux/amd64" >&2
  exit 1
}

docker image save -o "$tmp" "$image"
ln "$tmp" "$archive" || { echo "release archive appeared during build: $archive" >&2; exit 2; }
owned_archive=true
if command -v sha256sum >/dev/null 2>&1; then
  hash=$(sha256sum "$archive" | awk '{print $1}')
else
  hash=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
printf '%s  %s\n' "$hash" "$(basename "$archive")" > "$checksum_tmp"
ln "$checksum_tmp" "$checksum" || { echo "release checksum appeared during build: $checksum" >&2; exit 2; }
owned_checksum=true
printf 'Created %s\nChecksum %s\n' "$archive" "$checksum"
