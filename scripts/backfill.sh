#!/usr/bin/env bash
# Backfill historical daily_kpi rows, one day per request (weekends auto-skipped
# server-side). Runs each day sequentially to stay within the Hobby 60s limit.
#
# Usage:
#   BASE_URL="https://<your-test-deployment>.vercel.app" \
#   CRON_SECRET="<your-secret>" \
#   ./scripts/backfill.sh 2026-06-01 2026-06-30
#
# Requires: bash, curl, and GNU date (Linux/Git-Bash/WSL).

set -euo pipefail

START="${1:?Usage: backfill.sh START_DATE END_DATE (YYYY-MM-DD)}"
END="${2:?Usage: backfill.sh START_DATE END_DATE (YYYY-MM-DD)}"
: "${BASE_URL:?Set BASE_URL env to your deployment origin}"
: "${CRON_SECRET:?Set CRON_SECRET env}"

d="$START"
while [[ "$d" < "$END" || "$d" == "$END" ]]; do
  echo -n "Snapshotting $d ... "
  curl -sS -X GET "$BASE_URL/api/snapshot?date=$d&secret=$CRON_SECRET" \
    -H "Content-Type: application/json"
  echo ""
  d="$(date -u -d "$d + 1 day" +%F)"
  sleep 1   # be gentle on Zoho rate limits
done

echo "Backfill complete: $START to $END"
