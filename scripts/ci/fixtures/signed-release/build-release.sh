#!/usr/bin/env bash
# A signing build script; scripts/ci/check-unsigned-release.mjs must refuse
# it (REL-05 test 1, negative fixture). Never run.
set -euo pipefail
security import "$RUNNER_TEMP/certificate.p12" -k build.keychain -P "$KEY_PASSWORD"
codesign --force --options runtime --sign "Developer ID Application: Cutroom (ABCDE12345)" "desktop/dist/mac-arm64/Cutroom.app"
