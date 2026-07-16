#!/usr/bin/env bash
# Prints a JSON array of Untie issues that are ready to work on:
# open, no status:* label, and every "Depends on:" issue is closed.
# Sorted by issue number, which matches the plan's build order.
set -euo pipefail

repo="sort-box/untie"

open_json=$(gh issue list --repo "$repo" --state open --limit 100 --json number,title,body,labels)
closed_json=$(gh issue list --repo "$repo" --state closed --limit 100 --json number --jq '[.[].number]')

jq --argjson closed "$closed_json" '
  [ .[]
    | {
        number,
        title,
        labels: [.labels[].name],
        deps: ( .body // ""
                | [scan("Depends on:[^\n]*")]
                | (first // "")
                | [scan("#(\\d+)") | .[0] | tonumber] )
      }
    | select(.labels | map(startswith("status:")) | any | not)
    | select((.deps - $closed) == [])
  ] | sort_by(.number)
' <<<"$open_json"
