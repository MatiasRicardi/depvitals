#!/usr/bin/env bash
set -euo pipefail

# The caller supplies a fresh output path outside the scanned project.
report_dir="${1:?Supply a fresh report directory}"
mkdir -- "$report_dir"

set +e
./node_modules/.bin/depvitals --format json \
  > "$report_dir/depvitals-report.json" \
  2> "$report_dir/depvitals-diagnostics.txt"
scan_status=$?
set -e
printf '%s\n' "$scan_status" > "$report_dir/depvitals-status.txt"
