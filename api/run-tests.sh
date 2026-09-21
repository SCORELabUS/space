#!/usr/bin/env bash
set -euo pipefail

test_files=$(find src/test -name "*.test.ts" -print)
command=""

for file in $test_files; do
  if [ -z "$command" ]; then
    command="vitest --run $file"
  else
    command="$command && vitest --run $file"
  fi
done

eval "$command"
