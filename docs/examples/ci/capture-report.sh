#!/usr/bin/env bash
set -euo pipefail

# Validate the optional mode before creating any artifacts.
if [[ $# -lt 1 || $# -gt 2 || -z "$1" ]]; then
  printf 'Usage: capture-report.sh <fresh-report-directory> [--diagnostics]\n' >&2
  exit 2
fi
if [[ $# -eq 2 && "$2" != --diagnostics ]]; then
  printf 'Expected the literal optional argument --diagnostics.\n' >&2
  exit 2
fi
scan_args=(--format json)
if [[ $# -eq 2 ]]; then
  scan_args+=("--diagnostics")
fi

# The caller supplies a fresh output path outside the scanned project.
report_dir="$1"
mkdir -- "$report_dir"

set +e
./node_modules/.bin/depvitals "${scan_args[@]}" \
  > "$report_dir/depvitals-report.json" \
  2> "$report_dir/depvitals-diagnostics.txt"
scan_status=$?
set -e
printf '%s\n' "$scan_status" > "$report_dir/depvitals-status.txt"
