#!/usr/bin/env bash
# End-to-end smoke test against a running small-cms.
#
#   ./scripts/smoke.sh https://small-cms.naoki-tomita.deno.net
#   ./scripts/smoke.sh                      # defaults to http://localhost:8000
#
# Creates a throwaway resource under a unique name, exercises every endpoint, and deletes it
# again. Existing resources are never touched.

set -uo pipefail

BASE="${1:-http://localhost:8000}"
RESOURCE="smoke-$(date +%s)"
FAILED=0

req() { # req METHOD PATH [BODY] -> prints body, sets STATUS
  local method="$1" path="$2" body="${3-}" out
  if [ -n "$body" ]; then
    out=$(curl -sS -X "$method" "$BASE$path" -H 'content-type: application/json' \
      -d "$body" -w '\n%{http_code}')
  else
    out=$(curl -sS -X "$method" "$BASE$path" -w '\n%{http_code}')
  fi
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

check() { # check LABEL EXPECTED_STATUS
  if [ "$STATUS" = "$2" ]; then
    printf '  \033[32mok\033[0m   %-46s %s\n' "$1" "$STATUS"
  else
    printf '  \033[31mFAIL\033[0m %-46s got %s, want %s\n' "$1" "$STATUS" "$2"
    printf '       %s\n' "$BODY"
    FAILED=$((FAILED + 1))
  fi
}

json() { printf '%s' "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

echo "small-cms smoke test → $BASE"
echo

echo "service"
req GET /_health;                                    check "GET /_health" 200
req GET /;                                           check "GET /" 200
req GET /__admin/resources;                          check "GET /__admin/resources" 200

echo
echo "resource lifecycle (as \"$RESOURCE\")"
req POST /__admin/resources "{\"name\":\"$RESOURCE\",\"fields\":{
  \"title\":{\"type\":\"string\",\"required\":true},
  \"body\":{\"type\":\"string\"},
  \"views\":{\"type\":\"number\",\"default\":0},
  \"published\":{\"type\":\"boolean\",\"default\":false},
  \"publishedAt\":{\"type\":\"datetime\"},
  \"meta\":{\"type\":\"json\"}}}"
check "POST /__admin/resources" 201
req POST "/__admin/resources" "{\"name\":\"$RESOURCE\",\"fields\":{\"a\":{\"type\":\"string\"}}}"
check "POST again → conflict" 409
req GET "/__admin/resources/$RESOURCE";              check "GET /__admin/resources/{name}" 200

echo
echo "records"
req POST "/$RESOURCE" '{"body":"本文","title":"はじめての記事","meta":{"tags":["a","b"]}}'
check "POST /{resource}" 201
ID=$(json "['id']")

# The record was posted with body before title; it must come back in the schema's order.
ORDER=$(printf '%s' "$BODY" | python3 -c "import sys,json;print(*json.load(sys.stdin))")
if [ "$ORDER" = "id createdAt updatedAt title body views published meta" ]; then
  printf '  \033[32mok\033[0m   %-46s %s\n' "fields returned in schema order" "$ORDER"
else
  printf '  \033[31mFAIL\033[0m %-46s %s\n' "fields returned in schema order" "$ORDER"
  FAILED=$((FAILED + 1))
fi

req GET "/$RESOURCE/$ID";                            check "GET /{resource}/{id}" 200
req GET "/$RESOURCE";                                check "GET /{resource}" 200
req PATCH "/$RESOURCE/$ID" '{"published":true}';     check "PATCH /{resource}/{id}" 200
req PUT "/$RESOURCE/$ID" '{"title":"書き直し"}';      check "PUT /{resource}/{id}" 200
req GET "/$RESOURCE?limit=1&offset=0&order=asc";     check "GET /{resource} paginated" 200

echo
echo "validation and routing"
req POST "/$RESOURCE" '{"body":"titleがない"}';       check "missing required field" 400
req POST "/$RESOURCE" '{"title":"ok","slug":"x"}';   check "unknown field" 400
req POST "/$RESOURCE" '{"title":42}';                check "wrong type" 400
req GET "/$RESOURCE?limit=999";                      check "limit out of range" 400
req GET /no-such-resource;                           check "unknown resource" 404
req DELETE "/$RESOURCE";                             check "method not allowed" 405

echo
echo "teardown"
req DELETE "/$RESOURCE/$ID";                         check "DELETE /{resource}/{id}" 204
req DELETE "/__admin/resources/$RESOURCE";           check "DELETE /__admin/resources/{name}" 204
req GET "/$RESOURCE";                                check "endpoint gone after delete" 404

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mall checks passed\033[0m\n'
else
  printf '\033[31m%d check(s) failed\033[0m\n' "$FAILED"
fi
exit "$FAILED"
