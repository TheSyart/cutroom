#!/usr/bin/env bash
set -euo pipefail

# Some Homebrew FFmpeg builds omit the libass subtitles filter.
has_subtitles() {
  ffmpeg -hide_banner -filters 2>/dev/null | grep -E '[[:space:]]subtitles[[:space:]]' >/dev/null
}

if ! command -v ffprobe >/dev/null || ! has_subtitles; then
  brew install ffmpeg-full
  media_bin="$(brew --prefix ffmpeg-full)/bin"
  export PATH="$media_bin:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$media_bin" >> "$GITHUB_PATH"
  fi
fi

has_subtitles
ffmpeg -version
ffprobe -version
