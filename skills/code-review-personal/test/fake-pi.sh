#!/bin/bash
# Stub for pi used by the tests (set CODE_REVIEW_PERSONAL_PI_BIN to this file).
# Behavior per model comes from "$FAKE_PI_DIR/<slug>.behavior"; default is "ok".
# Every call is logged to "$FAKE_PI_DIR/calls.log" as "<model>|<message>".

model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ]; then model="$arg"; fi
  prev="$arg"
done
message="${*: -1}"
slug=$(printf '%s' "$model" | sed 's/[^A-Za-z0-9._-]/_/g')

printf '%s|%s\n' "$model" "$message" >> "$FAKE_PI_DIR/calls.log"
echo $$ > "$FAKE_PI_DIR/$slug.pid"
count_file="$FAKE_PI_DIR/$slug.count"
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$count_file"

behavior=$(cat "$FAKE_PI_DIR/$slug.behavior" 2>/dev/null || echo ok)

ok_output() {
  echo "Reviewed the diff."
  echo '```json'
  echo "{\"findings\": [{\"logaf\": \"H\", \"category\": \"correctness\", \"title\": \"Off-by-one in $model\", \"file\": \"src/a.js\", \"line\": 3, \"evidence\": \"e\", \"suggested_fix\": \"f\", \"confidence\": \"high\"}]}"
  echo '```'
}

case "$behavior" in
  ok) ok_output ;;
  empty) printf '```json\n{"findings": []}\n```\n' ;;
  verdicts) printf '```json\n{"verdicts": [{"id": "R1-1", "fixed": true, "note": ""}, {"id": "R1-2", "fixed": false, "note": "still fails"}], "findings": []}\n```\n' ;;
  multi)
    printf '```json\n{"findings": [{"title": "first"}]}\n```\n'
    printf 'More text.\n```json\n{"findings": [{"title": "last"}]}\n```\n'
    ;;
  slow_ok) sleep 3; ok_output ;;
  timeout|hang) sleep 60 ;;
  invalid_then_ok)
    if [ "$count" -eq 1 ]; then echo "I found nothing, no JSON here."; else ok_output; fi
    ;;
  invalid) echo "never any JSON" ;;
  exit1_valid) ok_output; exit 1 ;;
  crash) echo "boom" >&2; exit 2 ;;
esac
