#!/usr/bin/env bash
# After an Edit or Write of a TypeScript file: a type check. It never blocks (exit 0): it only reports errors, so Claude can fix
# them. Other files (docs, JSON, CSS) skip it, so the hook stays fast.
set -u
input=$(cat)
case "$input" in
  *'.ts"'* | *'.tsx"'*) ;;
  *) exit 0 ;;
esac
[ -f package.json ] || exit 0
command -v pnpm >/dev/null 2>&1 || exit 0
out=$(pnpm -s typecheck 2>&1 | tail -n 30)
if [ -n "$out" ]; then
  echo "[post-edit] typecheck:"
  echo "$out"
fi
exit 0
