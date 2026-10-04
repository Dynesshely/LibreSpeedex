#!/usr/bin/env bash
#
# HTTP-level test for the LibreSpeedex telemetry endpoints.
#
# Starts a throwaway container from the pre-built librespeedex:local image with
# THIS repository bind-mounted at /speedtest (the image entrypoint builds the
# webroot from /speedtest, so the edits under test are the ones served), drives
# results/telemetry.php, results/mine.php and results/admin_api.php with curl,
# then removes the container again.
#
# Usage: bash .scratch/telemetry-test/http-test.sh
# Output is also saved next to this script as http-output.txt when redirected.

set -u

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HARNESS_DIR/../.." && pwd)"
OUT="$HARNESS_DIR/http-artifacts"
BASE=http://127.0.0.1:18199
PROBE=telemetry-probe
COOKIES="$OUT/cookies.txt"

rm -rf "$OUT"
mkdir -p "$OUT"

section() {
    echo
    echo "======================================================================"
    echo "== $*"
    echo "======================================================================"
}

probe_start() {
    docker rm -f "$PROBE" >/dev/null 2>&1 || true
    # The image defaults WEBPORT to 8080; pin it to 80 so the documented
    # "-p 18199:80" mapping serves Apache.
    docker run --rm -d --name "$PROBE" -p 18199:80 -v "$REPO":/speedtest \
        -e MODE=standalone -e TELEMETRY=true -e WEBPORT=80 -e PASSWORD="$1" librespeedex:local
    for _ in $(seq 1 60); do
        code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/results/mine.php" 2>/dev/null || true)
        if [ -n "$code" ] && [ "$code" != "000" ]; then
            return 0
        fi
        sleep 0.5
    done
    echo "apache did not come up"
    docker logs "$PROBE" 2>&1 | tail -20
    return 1
}

probe_stop() {
    docker rm -f "$PROBE" >/dev/null 2>&1 || true
}

trap probe_stop EXIT

section "start probe container (bind mount, TELEMETRY=true, PASSWORD=testpw)"
probe_start testpw
docker ps --filter "name=$PROBE" --format 'running: {{.Names}} {{.Ports}} {{.Image}}'
docker logs "$PROBE" 2>&1 | grep -E "MODE:|Done, Starting APACHE" | head -5

section "0. telemetry settings inside the served webroot (env-injected values present)"
docker exec "$PROBE" grep -n "telemetry_rate_limit_writes_per_hour\|telemetry_rate_limit_writes_per_hour_ip\|telemetry_retention_days\|telemetry_cache_dir" /var/www/html/results/telemetry_settings.php

section "1. POST results/telemetry.php (client probeClientAAA1, row 1: full payload)"
curl -i -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode 'dl=91.20' \
    --data-urlencode 'ul=42.10' \
    --data-urlencode 'ping=12.40' \
    --data-urlencode 'jitter=1.20' \
    --data-urlencode 'log=timestamp;dl;91.20' \
    --data-urlencode 'ispinfo={"processedString":"Probe ISP (NL) - 5 km","hostname":"probe.example"}' \
    --data-urlencode 'extra={"probe":1}' \
    --data-urlencode 'client_id=probeClientAAA1' \
    --data-urlencode 'params={"time_dl_max":"12","telemetry_level":"basic"}' \
    | tee "$OUT/telemetry-insert-1.txt"

section "2. POST results/telemetry.php (client probeClientAAA1, row 2)"
curl -i -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode 'dl=33.30' \
    --data-urlencode 'ul=22.20' \
    --data-urlencode 'ping=30.00' \
    --data-urlencode 'jitter=3.00' \
    --data-urlencode 'log=second run' \
    --data-urlencode 'ispinfo={"processedString":"Probe ISP (NL) - 6 km"}' \
    --data-urlencode 'client_id=probeClientAAA1' \
    --data-urlencode 'params={"time_dl_max":"8"}' > "$OUT/telemetry-insert-2.txt"
cat "$OUT/telemetry-insert-2.txt"

section "3. POST results/telemetry.php (other client probeClientBBB2)"
curl -i -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode 'dl=7.70' \
    --data-urlencode 'ul=8.80' \
    --data-urlencode 'ping=50.00' \
    --data-urlencode 'jitter=5.00' \
    --data-urlencode 'log=other client' \
    --data-urlencode 'ispinfo={"processedString":"Other ISP (DE) - 2 km"}' \
    --data-urlencode 'client_id=probeClientBBB2' > "$OUT/telemetry-insert-3.txt"
cat "$OUT/telemetry-insert-3.txt"

section "4. POST results/telemetry.php with an INVALID client_id and non-object params (both must be dropped)"
curl -i -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode 'dl=1.00' \
    --data-urlencode 'ul=2.00' \
    --data-urlencode 'ping=3.00' \
    --data-urlencode 'jitter=0.10' \
    --data-urlencode 'log=invalid client id and params' \
    --data-urlencode 'client_id=short' \
    --data-urlencode 'params=[1,2,3]' > "$OUT/telemetry-insert-invalid.txt"
cat "$OUT/telemetry-insert-invalid.txt"

section "5. POST results/telemetry.php with a 40000 byte log (must be clamped to 32768)"
python3 -c "print('L' * 40000, end='')" > "$OUT/big-log.txt"
curl -i -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode "log@$OUT/big-log.txt" \
    --data-urlencode 'dl=4.00' \
    --data-urlencode 'ul=5.00' \
    --data-urlencode 'ping=6.00' \
    --data-urlencode 'jitter=0.20' \
    --data-urlencode 'client_id=probeClientAAA1' > "$OUT/telemetry-insert-biglog.txt"
cat "$OUT/telemetry-insert-biglog.txt"

section "6. GET results/mine.php?client_id=bad  (expect 400)"
curl -i -s "$BASE/results/mine.php?client_id=bad" | tee "$OUT/mine-bad-client.txt"

section "7. GET results/mine.php?client_id=probeClientAAA1 (expect 200, 3 rows, no log/ua)"
curl -i -s "$BASE/results/mine.php?client_id=probeClientAAA1" | tee "$OUT/mine-list.txt" > /dev/null
python3 - "$OUT/mine-list.txt" <<'PY'
import json, sys
raw = open(sys.argv[1], 'rb').read()
body = raw.split(b'\r\n\r\n', 1)[1].decode()
data = json.loads(body)
print('total =', data['total'])
print('row count =', len(data['results']))
print('ids =', [r['id'] for r in data['results']])
print('dl  =', [r['dl'] for r in data['results']])
print('isp =', [r['isp'] for r in data['results']])
print('params of newest =', json.dumps(data['results'][0]['params']))
raw = json.dumps(data)
print('contains "log" key =', '"log"' in raw)
print('contains "ua" key  =', '"ua"' in raw)
PY
echo "--- raw body ---"
sed -n '/^{/p' "$OUT/mine-list.txt"

section "8. GET results/mine.php?client_id=probeClientBBB2&id=<probeClientAAA1 row 1> (expect 404)"
curl -i -s "$BASE/results/mine.php?client_id=probeClientBBB2&id=1" | tee "$OUT/mine-foreign-id.txt"

section "9. GET results/mine.php?client_id=probeClientAAA1&id=1 (expect 200, one row)"
curl -i -s "$BASE/results/mine.php?client_id=probeClientAAA1&id=1" | tee "$OUT/mine-own-id.txt"

section "10. GET results/mine.php?client_id=probeClientAAA1&limit=1&offset=1 (expect 200, total 3, one row)"
curl -i -s "$BASE/results/mine.php?client_id=probeClientAAA1&limit=1&offset=1" | tee "$OUT/mine-page.txt"

section "11. GET results/mine.php without client_id (expect 400)"
curl -i -s "$BASE/results/mine.php" | tee "$OUT/mine-missing-client.txt"

section "12. GET results/admin_api.php?op=session (expect logged=false, configured=true)"
curl -i -s "$BASE/results/admin_api.php?op=session" | tee "$OUT/admin-session-anon.txt"

section "13. POST results/admin_api.php?op=login with the WRONG password (expect 401)"
curl -i -s -X POST "$BASE/results/admin_api.php?op=login" -d 'password=wrongpw' | tee "$OUT/admin-login-wrong.txt"

section "14. GET results/admin_api.php?op=list without a session (expect 401)"
curl -i -s "$BASE/results/admin_api.php?op=list" | tee "$OUT/admin-list-anon.txt"

section "15. POST results/admin_api.php?op=login with the right password (expect 200 + csrf)"
curl -i -s -c "$COOKIES" -X POST "$BASE/results/admin_api.php?op=login" -d 'password=testpw' | tee "$OUT/admin-login-ok.txt"
CSRF=$(sed -n '/^{/p' "$OUT/admin-login-ok.txt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
echo "CSRF token: $CSRF"

section "16. GET results/admin_api.php?op=session with the cookie (expect logged=true, csrf present)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=session" | tee "$OUT/admin-session-auth.txt"

section "17. GET results/admin_api.php?op=list (rows must carry client_id/params, never log)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=list&limit=500" > "$OUT/admin-list.txt"
head -1 "$OUT/admin-list.txt"
python3 - "$OUT/admin-list.txt" <<'PY'
import json, sys
raw = open(sys.argv[1], 'rb').read()
body = raw.split(b'\r\n\r\n', 1)[1].decode()
data = json.loads(body)
print('total =', data['total'], 'limit =', data['limit'], 'offset =', data['offset'])
for row in data['rows']:
    print(' id=%s client_id=%s dl=%s params=%s has_log=%s' % (
        row['id'], row['client_id'], row['dl'], json.dumps(row['params']), 'log' in row))
PY

section "18. GET results/admin_api.php?op=detail&id=1 (must include log, client_id, params)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=detail&id=1" | tee "$OUT/admin-detail.txt" > /dev/null
head -1 "$OUT/admin-detail.txt"
sed -n '/^{/p' "$OUT/admin-detail.txt" | head -c 600; echo

section "18b. GET results/admin_api.php?op=detail&id=<invalid client row id> (client_id/params must be null)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=detail&id=4" | tee "$OUT/admin-detail-invalid.txt"

section "18c. GET results/admin_api.php?op=detail&id=<big log row id> (log must be 32768 bytes)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=detail&id=5" > "$OUT/admin-detail-biglog.txt"
head -1 "$OUT/admin-detail-biglog.txt"
python3 - "$OUT/admin-detail-biglog.txt" <<'PY'
import json, sys
raw = open(sys.argv[1], 'rb').read()
body = raw.split(b'\r\n\r\n', 1)[1].decode()
row = json.loads(body)
print('log length =', len(row['log']))
PY

section "19. POST results/admin_api.php?op=delete&id=2 WITHOUT the CSRF header (expect 403)"
curl -i -s -b "$COOKIES" -X POST "$BASE/results/admin_api.php?op=delete" -d 'id=2' | tee "$OUT/admin-delete-nocsrf.txt"

section "20. POST results/admin_api.php?op=delete&id=2 WITH the CSRF header (expect deleted=1)"
curl -i -s -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/results/admin_api.php?op=delete" -d 'id=2' | tee "$OUT/admin-delete-ok.txt"

section "21. GET results/admin_api.php?op=stats (getSpeedtestStats shape)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=stats" | tee "$OUT/admin-stats.txt"

section "21b. GET results/index.php?id=1 (the PNG share image must keep working)"
curl -s -D "$OUT/index-headers.txt" -o "$OUT/index-image.png" "$BASE/results/index.php?id=1"
grep -E "^HTTP/|^Content-Type|^Content-Length" "$OUT/index-headers.txt"
python3 - "$OUT/index-image.png" <<'PY'
import sys
raw = open(sys.argv[1], 'rb').read()
print('bytes =', len(raw))
print('PNG magic =', raw[:8] == b'\x89PNG\r\n\x1a\n')
PY

section "21c. GET results/json.php?id=1 (existing JSON endpoint must keep working)"
curl -i -s "$BASE/results/json.php?id=1" | tee "$OUT/json-endpoint.txt"

section "21d. GET results/sanitycheck.php (legacy insertSpeedtestUser caller must still pass)"
curl -i -s "$BASE/results/sanitycheck.php" > "$OUT/sanitycheck.txt"
head -1 "$OUT/sanitycheck.txt"
echo "Failed spans: $(grep -c "class='Failed'" "$OUT/sanitycheck.txt" || true)"
grep -o "Insert into DB</td><td>[^<]*<span class='[A-Za-z]*'" "$OUT/sanitycheck.txt" | head -1
grep -o "Read from DB</td><td>[^<]*<span class='[A-Za-z]*'" "$OUT/sanitycheck.txt" | head -1

section "22. GET results/admin_api.php?op=export (text/csv attachment, RFC4180)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=export&limit=500" | tee "$OUT/admin-export.txt"

section "23. POST results/admin_api.php?op=purge before=2020-01-01 (expect deleted=0)"
curl -i -s -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/results/admin_api.php?op=purge" -d 'before=2020-01-01' | tee "$OUT/admin-purge-before.txt"

section "24. POST results/admin_api.php?op=purge all=1 (expect deleted=4: rows 1,3,4,5)"
curl -i -s -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/results/admin_api.php?op=purge" -d 'all=1' | tee "$OUT/admin-purge-all.txt"

section "25. POST results/admin_api.php?op=logout with CSRF (expect logged=false)"
curl -i -s -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/results/admin_api.php?op=logout" | tee "$OUT/admin-logout.txt"

section "26. GET results/admin_api.php?op=list after logout (expect 401)"
curl -i -s -b "$COOKIES" "$BASE/results/admin_api.php?op=list" | tee "$OUT/admin-list-after-logout.txt"

section "27. results/telemetry.php rate limit: 61 writes with the same client_id (expect 60 inserts + 429)"
RL_CLIENT=rateLimitProbe01
: > "$OUT/rate-limit-codes.txt"
for i in $(seq 1 61); do
    code=$(curl -s -o "$OUT/rl-body.txt" -w '%{http_code}' -X POST "$BASE/results/telemetry.php" \
        --data-urlencode "dl=$i" --data-urlencode 'ul=1.00' --data-urlencode 'ping=1.00' --data-urlencode 'jitter=0.10' \
        --data-urlencode "client_id=$RL_CLIENT")
    echo "$i $code $(cat "$OUT/rl-body.txt")" >> "$OUT/rate-limit-codes.txt"
done
head -3 "$OUT/rate-limit-codes.txt"
echo "..."
tail -3 "$OUT/rate-limit-codes.txt"
echo "2xx responses: $(awk '$2 ~ /^2/ {n++} END {print n+0}' "$OUT/rate-limit-codes.txt")"
echo "429 responses: $(awk '$2 == 429 {n++} END {print n+0}' "$OUT/rate-limit-codes.txt")"
grep -n -m1 '^[0-9]* 429 ' "$OUT/rate-limit-codes.txt"

section "28. stop the test probe container and prove it is gone"
probe_stop
echo "docker ps -a --filter name=$PROBE:"
docker ps -a --filter "name=$PROBE"
echo "(empty output above means the container is gone)"
echo "docker ps (all running containers):"
docker ps

section "29. start a fresh probe with PASSWORD=PASSWORD (placeholder must be refused)"
probe_start PASSWORD
docker ps --filter "name=$PROBE" --format 'running: {{.Names}} {{.Ports}}'
echo "--- op=session (expect configured=false) ---"
curl -i -s "$BASE/results/admin_api.php?op=session" | tee "$OUT/admin-placeholder-session.txt"
echo "--- op=login password=PASSWORD (expect 401 bad_password) ---"
curl -i -s -X POST "$BASE/results/admin_api.php?op=login" -d 'password=PASSWORD' | tee "$OUT/admin-placeholder-login.txt"
echo "--- op=list with the placeholder configured (expect 401) ---"
curl -i -s "$BASE/results/admin_api.php?op=list" | tee "$OUT/admin-placeholder-list.txt"
echo "--- op=logout with the placeholder configured (expect 401) ---"
curl -i -s -X POST "$BASE/results/admin_api.php?op=logout" | tee "$OUT/admin-placeholder-logout.txt"

section "30. remove the probe container and prove it is gone"
probe_stop
echo "docker ps -a --filter name=$PROBE:"
docker ps -a --filter "name=$PROBE"
echo "(empty output above means the container is gone)"
echo "docker ps:"
docker ps

section "31. probe with REDACT_IP_ADDRESSES=true (existing redaction behaviour preserved)"
docker rm -f "$PROBE" >/dev/null 2>&1 || true
docker run --rm -d --name "$PROBE" -p 18199:80 -v "$REPO":/speedtest \
    -e MODE=standalone -e TELEMETRY=true -e WEBPORT=80 -e PASSWORD=testpw \
    -e REDACT_IP_ADDRESSES=true librespeedex:local >/dev/null
for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/results/mine.php" 2>/dev/null || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
    sleep 0.5
done
docker exec "$PROBE" grep -n '^\$redact_ip_addresses' /var/www/html/results/telemetry_settings.php

curl -s -X POST "$BASE/results/telemetry.php" \
    --data-urlencode 'log=client 203.0.113.9 ran the test' \
    --data-urlencode 'ispinfo={"processedString":"Redact ISP (NL) - 1 km","hostname":"secret.example"}' \
    --data-urlencode 'dl=10.00' --data-urlencode 'ul=1.00' --data-urlencode 'ping=1.00' --data-urlencode 'jitter=0.10' \
    --data-urlencode 'client_id=redactProbe0001' | tee "$OUT/redact-insert.txt"
echo
curl -s -c "$OUT/redact-cookies.txt" -X POST "$BASE/results/admin_api.php?op=login" -d 'password=testpw' > "$OUT/redact-login.txt"
REDACT_CSRF=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["csrf"])' "$OUT/redact-login.txt")
curl -s -b "$OUT/redact-cookies.txt" "$BASE/results/admin_api.php?op=detail&id=1" > "$OUT/redact-detail.txt"
python3 - "$OUT/redact-detail.txt" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
print('stored ip      =', row['ip'])
print('stored log     =', row['log'])
print('stored ispinfo =', row['ispinfo'])
PY

section "31b. admin login rate limit: 10 attempts / 15 min per IP (one attempt already spent above)"
: > "$OUT/admin-login-codes.txt"
for i in $(seq 1 12); do
    code=$(curl -s -o "$OUT/login-body.txt" -w '%{http_code}' -X POST "$BASE/results/admin_api.php?op=login" -d 'password=wrongpw')
    echo "$i $code $(cat "$OUT/login-body.txt")" >> "$OUT/admin-login-codes.txt"
done
cat "$OUT/admin-login-codes.txt"
echo "401 responses: $(awk '$2 == 401 {n++} END {print n+0}' "$OUT/admin-login-codes.txt")"
echo "429 responses: $(awk '$2 == 429 {n++} END {print n+0}' "$OUT/admin-login-codes.txt")"

section "32. remove the redaction probe container and prove it is gone"
probe_stop
echo "docker ps -a --filter name=$PROBE:"
docker ps -a --filter "name=$PROBE"
echo "(empty output above means the container is gone)"
echo "docker ps:"
docker ps

echo
echo "HTTP TEST SCRIPT FINISHED"
