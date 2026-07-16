#!/bin/bash
# Run every e2e suite. Needs Node >= 18 and curl; no real logins, no network
# beyond localhost mocks. Suites run sequentially (each owns a port).
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
FAILED=0
for t in meters pricing codex-usage discord effort-echo history statusline analytics model-families; do
  echo "=== $t ==="
  if ! bash "$DIR/$t.test.sh"; then
    FAILED=1
    echo "*** $t FAILED"
  fi
done
[ $FAILED -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $FAILED
