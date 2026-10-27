# LibreSpeedex telemetry data layer + JSON APIs — test report

Date: 2026-10-04
Repo: `/home/dynesshely/dsh-workspaces/tools/speedtest`
PHP under test: `librespeedex:local` → PHP 8.5.11 (CLI), code kept PHP 7.4-syntax compatible.
DB actually exercised end-to-end: **sqlite** (the image has `pdo_sqlite`; see *Open questions* for mysql/pgsql/mssql).

## Files changed / created

| File | Change |
|---|---|
| `results/telemetry_db.php` | `ensureSchema()`, migration + index, `insertSpeedtestUser()` new signature (BC shim), `getSpeedtestUsersByClientId`, `getSpeedtestUsersFiltered`, `countSpeedtestUsers`, `getSpeedtestStats`, `getSpeedtestUserById` (extended SELECT + optional `$skipObfuscation`), `deleteSpeedtestUserById`, `purgeSpeedtestUsersBefore`, `purgeSpeedtestUsersAll` |
| `results/telemetry_guard.php` | **new** — `telemetryRateLimit`, `telemetryRetentionSweep`, `telemetryCacheDir`, `telemetryIsValidClientId`, `telemetryNormalizeParams`, `telemetryClampText` |
| `results/telemetry.php` | client_id/params ingestion + validation, payload clamping, rate limits, retention sweep; response contract unchanged |
| `results/mine.php` | **new** — per-client result list JSON endpoint |
| `results/admin_api.php` | **new** — session admin JSON API + CSV export |
| `results/telemetry_settings.php` | the four new optional settings appended |
| `results/telemetry_mysql.sql`, `telemetry_postgresql.sql`, `telemetry_mssql.sql` | `client_id` + `params` columns and the `client_id` index |
| `.scratch/telemetry-test/*` | harness (`lib.php`, `run.php`, `http-test.sh`) + captured outputs |

Every file above is mode `644`. Nothing outside this list was modified (`index.php`, `json.php`, `stats.php`, `idObfuscation.php`, `sanitycheck.php` and `docker/entrypoint.sh` are untouched).

## How the harness exercises the real code

`results/telemetry_db.php` hardcodes `TELEMETRY_SETTINGS_FILE = 'telemetry_settings.php'`, and PHP resolves that relative include against the include path, then the **current working directory**, then the including file's directory. So each case:

1. creates a fresh `.scratch/telemetry-test/tmp/<case>/` containing only a generated `telemetry_settings.php`,
2. `chdir()`s there and puts it first on the include path,
3. `require_once`s the **real** `results/telemetry_db.php` / `results/telemetry_guard.php` by absolute path.

The real `idObfuscation.php` still resolves from `results/` next to the real `telemetry_db.php`. Each case runs in its own child process (fresh function/constant scope), and the harness prints the sha256 of every real source file it loads — the outputs below show them, and they match the files on disk.

---

# 1. Exact commands and observed output

## 1.1 Syntax check (all changed PHP files)

```
$ cd /home/dynesshely/dsh-workspaces/tools/speedtest
$ for f in results/telemetry_db.php results/telemetry_guard.php results/telemetry.php results/mine.php results/admin_api.php results/telemetry_settings.php; do
    docker run --rm -v "$PWD":/src -w /src librespeedex:local php -l "$f"
  done
```
```
No syntax errors detected in results/telemetry_db.php
No syntax errors detected in results/telemetry_guard.php
No syntax errors detected in results/telemetry.php
No syntax errors detected in results/mine.php
No syntax errors detected in results/admin_api.php
No syntax errors detected in results/telemetry_settings.php
```

## 1.2 CLI functional harness

```
$ docker run --rm -v "$PWD":/src -w /src librespeedex:local php .scratch/telemetry-test/run.php
```

The container sees the repo root as `/src`, so the paths in the output below are the container view of `/home/dynesshely/dsh-workspaces/tools/speedtest`.

Full observed output (`164` `[PASS]`, `0` `[FAIL]`, exit code 0), also saved as `.scratch/telemetry-test/cli-output.txt`:

```
LibreSpeedex telemetry harness
php: 8.5.11
sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0  results/telemetry_db.php
sha256 ade96fe59bd2e8fed6ea9b14f088eef2c6b86450bcd34a916d08e226d94fac78  results/telemetry_guard.php
sha256 7807d599248d440107f8cb7cbe91ff04970ee31fc70dca266640ff2cf28982da  results/telemetry.php
sha256 2b07303a610ec13f6a9deb135c1624a42a5b108b029069db542d4772115b4fe1  results/mine.php
sha256 8c200c06e3a7d77dc625e319aa3ccca081895d42d8f94b15775921a9d84ae929  results/admin_api.php

================================================================
case: migrate
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/migrate
settings: /src/.scratch/telemetry-test/tmp/migrate/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] fixture starts from the OLD schema (no client_id/params)
[PASS] fixture has no client_id index yet
[PASS] getPdo() returns a PDO against the old database
[PASS] migration added client_id
[PASS] migration added params
[PASS] migration created the client_id index
[PASS] ensureSchema() reports success
[PASS] ensureSchema() is idempotent
[PASS] the pre-existing row is still readable
[PASS] legacy row ip survived
[PASS] legacy row ua survived
[PASS] legacy row log survived
[PASS] legacy row dl survived
[PASS] legacy row extra survived
[PASS] legacy row client_id is NULL
[PASS] legacy row params is NULL
[PASS] insert with client_id + params succeeds
[PASS] client_id round-trips through insert/select
[PASS] params round-trips through insert/select
[PASS] dl round-trips after migration
[PASS] count sees the migrated row
[PASS] both rows are present after migration

CASE migrate: ok

================================================================
case: queries
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/queries
settings: /src/.scratch/telemetry-test/tmp/queries/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] schema ready
[PASS] count without filters
[PASS] count scoped to client A
[PASS] count scoped to client B
[PASS] count of unknown client
[PASS] ip filter is exact
[PASS] q matches user agent
[PASS] q matches extra
[PASS] q matches ip
[PASS] q matches client_id
[PASS] q escapes LIKE wildcards
[PASS] q without match
[PASS] from date is inclusive of that day
[PASS] to date covers the whole day
[PASS] from/to datetime range
[PASS] invalid to date is ignored
[PASS] min_dl filter
[PASS] min_ul filter
[PASS] min_dl 0 keeps every row with a value
[PASS] filters combine
[PASS] getSpeedtestUsersByClientId returns only client A rows
[PASS] client A rows are newest first
[PASS] no client B row leaks into client A list
[PASS] limit/offset paging on getSpeedtestUsersByClientId
[PASS] list rows do not carry the log column
[PASS] id_formatted is present (obfuscation off)
[PASS] list rows carry client_id
[PASS] list rows carry params
[PASS] params is NULL when it was not submitted
[PASS] other client id cannot fetch client A row
[PASS] own id lookup returns exactly that row
[PASS] order oldest
[PASS] order dl
[PASS] order ul
[PASS] default order is newest first with offset
[PASS] filter + order combined

CASE queries: ok

================================================================
case: stats
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/stats
settings: /src/.scratch/telemetry-test/tmp/stats/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] schema ready
[PASS] getSpeedtestStats returns an array
[PASS] stats carries total
[PASS] stats carries unique_clients
[PASS] stats carries dl_avg
[PASS] stats carries dl_max
[PASS] stats carries ul_avg
[PASS] stats carries ul_max
[PASS] stats carries ping_avg
[PASS] stats carries jitter_avg
[PASS] stats carries per_day
[PASS] stats carries top_isp
[PASS] stats total
[PASS] stats unique_clients ignores NULL client_id
[PASS] stats dl_avg ignores empty values
[PASS] stats dl_max
[PASS] stats ul_avg
[PASS] stats ul_max
[PASS] stats ping_avg
[PASS] stats jitter_avg
[PASS] per_day only contains days with data (40 day old row excluded)
[PASS] per_day is ordered oldest first
[PASS] per_day yesterday count
[PASS] per_day yesterday dl_avg
[PASS] per_day yesterday ul_avg
[PASS] per_day today
[PASS] per_day today count
[PASS] per_day today dl_avg
[PASS] per_day today ul_avg
[PASS] top_isp by label
[PASS] top_isp count is an int
[PASS] scoped stats total
[PASS] scoped stats unique_clients
[PASS] scoped stats dl_avg
[PASS] scoped top_isp
[PASS] stats of empty filter set
[PASS] stats of empty filter set has no per_day
[PASS] stats of empty filter set has no top_isp

CASE stats: ok

================================================================
case: delete_purge
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/delete_purge
settings: /src/.scratch/telemetry-test/tmp/delete_purge/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] schema ready
[PASS] three fixture rows
[PASS] delete removes the right row
[PASS] two rows left
[PASS] deleting the same id again deletes 0
[PASS] deleted row is gone
[PASS] purge before 50 days removes the 100 day old row
[PASS] only the recent row remains
[PASS] the recent row is the surviving one
[PASS] purge is idempotent
[PASS] purge with an empty timestamp refuses
[PASS] purge all removes everything left
[PASS] table is empty
[PASS] purge on an empty table deletes 0

CASE delete_purge: ok

================================================================
case: ratelimit
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/ratelimit
settings: /src/.scratch/telemetry-test/tmp/ratelimit/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] rate limit blocks the 4th call in the window
[PASS] a different key is unaffected
[PASS] limit 0 disables the limit
[PASS] window 0 disables the limit
[PASS] counter file is created in the cache dir
[PASS] counter file contains windowStart:count
[PASS] stale window resets the counter
[PASS] counter was rewritten for the current window
[PASS] unusable cache dir fails open
[PASS] cache dir setting is honoured
[PASS] telemetryCacheDir creates the configured directory
[PASS] GC removes counters older than two windows
[PASS] GC keeps fresh counters
[PASS] telemetryCacheDir derives <dbdir>/cache from the settings
[PASS] telemetryCacheDir creates the directory

CASE ratelimit: ok

================================================================
case: retention
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/retention
settings: /src/.scratch/telemetry-test/tmp/retention/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] schema ready
[PASS] retention 0 is always a no-op
[PASS] retention(90) actually sweeps within 500 calls (1 in 50 gate)
[PASS] the sweep deleted exactly the expired row
[PASS] the recent row survived
[PASS] the surviving row is the recent one
[PASS] at least one call was allowed to run

CASE retention: ok

================================================================
case: validators
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/validators
settings: /src/.scratch/telemetry-test/tmp/validators/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] schema ready
[PASS] valid minimum length client id
[PASS] valid maximum length client id
[PASS] valid alphabet for client id
[PASS] too short client id rejected
[PASS] too long client id rejected
[PASS] space rejected
[PASS] slash rejected
[PASS] empty client id rejected
[PASS] null client id rejected
[PASS] array client id rejected
[PASS] valid params object accepted
[PASS] empty params object accepted
[PASS] JSON array rejected
[PASS] JSON scalar rejected
[PASS] malformed JSON rejected
[PASS] empty params rejected
[PASS] null params rejected
[PASS] oversized params rejected
[PASS] params of exactly 4096 bytes accepted
[PASS] clamp leaves short text alone
[PASS] clamp respects the byte budget
[PASS] clamp does not split a multibyte character
[PASS] clamp truncates to the byte budget
[PASS] legacy 11-argument call still inserts
[PASS] legacy boolean 11th argument is not stored as client_id
[PASS] new 13-argument call still inserts
[PASS] client_id is stored for the 13-argument call
[PASS] getPdo fails when the sqlite directory is missing
[PASS] insert returns an Exception when asked (legacy signature)
[PASS] insert returns an Exception when asked (new signature)
[PASS] insert returns false by default on failure

CASE validators: ok

ALL CASES PASSED (7 cases)
```

## 1.3 HTTP harness (real Apache, repo bind-mounted)

```
$ bash .scratch/telemetry-test/http-test.sh
```

The script starts `librespeedex:local` as `telemetry-probe` with the repo mounted at `/speedtest` (the entrypoint builds the webroot from that mount, so the edits under test are what is served):

```
docker run --rm -d --name telemetry-probe -p 18199:80 -v "$REPO":/speedtest \
    -e MODE=standalone -e TELEMETRY=true -e WEBPORT=80 -e PASSWORD=testpw librespeedex:local
```

> Note: `-e WEBPORT=80` is required. The image defaults `WEBPORT=8080`, so the documented `-p 18199:80` mapping alone leaves Apache listening on 8080 (and every curl returned an empty body). No other deviation from the documented probe command.

Full output: `.scratch/telemetry-test/http-output.txt`.

---

# 2. Functional evidence

## 2.1 `ensureSchema()` migrates an existing pre-change sqlite DB

Case `migrate` starts from a database created with the **old** `CREATE TABLE` (no `client_id`/`params`) containing one row, then boots the real `telemetry_db.php` and calls `getPdo()`:

```
case: migrate
================================================================
sandbox: /src/.scratch/telemetry-test/tmp/migrate
settings: /src/.scratch/telemetry-test/tmp/migrate/telemetry_settings.php
source: /src/results/telemetry_db.php (sha256 6d5675c3fcae66d57431814f4f4c3ebc4532755efcfbb476a86083c371ab44e0)
[PASS] fixture starts from the OLD schema (no client_id/params)
[PASS] fixture has no client_id index yet
[PASS] getPdo() returns a PDO against the old database
[PASS] migration added client_id
[PASS] migration added params
[PASS] migration created the client_id index
[PASS] ensureSchema() reports success
[PASS] ensureSchema() is idempotent
[PASS] the pre-existing row is still readable
[PASS] legacy row ip survived
[PASS] legacy row ua survived
[PASS] legacy row log survived
[PASS] legacy row dl survived
[PASS] legacy row extra survived
[PASS] legacy row client_id is NULL
[PASS] legacy row params is NULL
[PASS] insert with client_id + params succeeds
[PASS] client_id round-trips through insert/select
[PASS] params round-trips through insert/select
[PASS] dl round-trips after migration
[PASS] count sees the migrated row
[PASS] both rows are present after migration

CASE migrate: ok
```

(see the `case: migrate` block in the full CLI output above). Checks that prove it:

* `fixture starts from the OLD schema (no client_id/params)` and `fixture has no client_id index yet`
* `migration added client_id`, `migration added params`, `migration created the client_id index`, `ensureSchema() reports success` + `is idempotent`
* the pre-existing row is intact field-by-field (`ip`, `ua`, `log`, `dl`, `extra` all `[PASS]`) and its new columns are `NULL`
* `insert with client_id + params succeeds` and `client_id round-trips through insert/select`, `params round-trips through insert/select`

## 2.2 Client isolation, filters and counts

Case `queries` (5 fixture rows, 3 for client A, 2 for client B, fixed timestamps):

* `getSpeedtestUsersByClientId('aaaaaaaaaaaa1111')` → exactly 3 rows, `no client B row leaks into client A list`, `client A rows are newest first`, `limit/offset paging` works.
* `countSpeedtestUsers` verified for every filter: `client_id`, `ip` (exact), `q` over `ua`/`extra`/`ip`/`client_id`, `from`/`to` day widening, datetime range, `min_dl`/`min_ul`, combined filters, and `q escapes LIKE wildcards` (a literal `100%_literal` search does **not** match a row containing `100Xliteral`).
* Ownership scoping used by `mine.php`: `other client id cannot fetch client A row` + `own id lookup returns exactly that row`.
* `order` newest/oldest/dl/ul all checked; list rows do **not** carry `log` and do carry `client_id`/`params`.

## 2.3 `getSpeedtestStats` sanity

Case `stats` (5 rows, one with empty metrics, one with `NULL client_id`, one 40 days old):

* `total=5`, `unique_clients=3` (the `NULL` client_id is not counted)
* `dl_avg=47.5`, `dl_max=100`, `ul_avg=16.25`, `ul_max=30`, `ping_avg=11.5`, `jitter_avg=1.15` — empty strings are ignored, not counted as zero
* `per_day` = exactly 2 entries (yesterday `count=2 dl_avg=30 ul_avg=30`, today `count=2 dl_avg=75 ul_avg=15`); the 40-day-old row is excluded; zero-count days are absent
* `top_isp` = `[ISP One:2, ISP Two:1]`; scoped stats for client A return `[ISP One:2]`
* an empty filter set returns the zeroed shape with `per_day=[]`, `top_isp=[]`

## 2.4 delete / purge

Case `delete_purge`:

* `deleteSpeedtestUserById()` → `1` for the right raw id, `0` on repeat, row is gone
* `purgeSpeedtestUsersBefore(now-50d)` → `1`, deletes only the 100-day-old row, recent row survives, second call → `0`
* `purgeSpeedtestUsersBefore('')` → `false` (refuses)
* `purgeSpeedtestUsersAll()` → `1`, table empty, subsequent purge → `0`

## 2.5 `telemetryRateLimit` blocks after N and fails open

Case `ratelimit` (plus the live HTTP proof below):

* 4 calls with `limit=3` → `[true,true,true,false]`; a different key is unaffected; `limit=0` / `window=0` disable the limit
* counter file exists in `telemetryCacheDir()` and contains exactly `windowStart:count`
* a counter file written for a stale window resets to `1` (rollover)
* **fail open**: `telemetry_cache_dir` pointed under a regular file (mkdir impossible) → 5/5 calls allowed, nothing logged to the user
* GC removes counters older than two windows and keeps fresh ones
* the default `''` cache dir resolves to `<dir of $Sqlite_db_file>/cache` and is created on demand

## 2.6 `telemetryRetentionSweep`

Case `retention`:

* `telemetryRetentionSweep(0)` → `false`, 50/50 calls (disabled)
* `telemetryRetentionSweep(90)` in a loop actually sweeps within 500 calls (the `random_int(1,50)===1` gate), deletes exactly the 100-day-old row and keeps the recent one; skipped calls return `false`

## 2.7 `mine.php` over real HTTP

```
== 6. GET results/mine.php?client_id=bad  (expect 400)
======================================================================
HTTP/1.1 400 Bad Request
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store
Content-Length: 29
Connection: close
Content-Type: application/json; charset=utf-8

{"error":"invalid_client_id"}
======================================================================

== 7. GET results/mine.php?client_id=probeClientAAA1 (expect 200, 3 rows, no log/ua)
======================================================================
total = 3
row count = 3
ids = ['5', '2', '1']
dl  = ['4.00', '33.30', '91.20']
isp = ['', 'Probe ISP (NL) - 6 km', 'Probe ISP (NL) - 5 km']
params of newest = null
contains "log" key = False
contains "ua" key  = False
--- raw body ---
{"total":3,"results":[{"id":"5","id_formatted":"5","timestamp":"2026-10-04 02:55:26","dl":"4.00","ul":"5.00","ping":"6.00","jitter":"0.20","ip":"172.17.0.1","isp":"","params":null},{"id":"2","id_formatted":"2","timestamp":"2026-10-04 02:55:26","dl":"33.30","ul":"22.20","ping":"30.00","jitter":"3.00","ip":"172.17.0.1","isp":"Probe ISP (NL) - 6 km","params":{"time_dl_max":"8"}},{"id":"1","id_formatted":"1","timestamp":"2026-10-04 02:55:26","dl":"91.20","ul":"42.10","ping":"12.40","jitter":"1.20","ip":"172.17.0.1","isp":"Probe ISP (NL) - 5 km","params":{"time_dl_max":"12","telemetry_level":"basic"}}]}
======================================================================

== 8. GET results/mine.php?client_id=probeClientBBB2&id=<probeClientAAA1 row 1> (expect 404)
======================================================================
HTTP/1.1 404 Not Found
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store
Content-Length: 21
Content-Type: application/json; charset=utf-8

{"error":"not_found"}
======================================================================

== 9. GET results/mine.php?client_id=probeClientAAA1&id=1 (expect 200, one row)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store
Content-Length: 248
Content-Type: application/json; charset=utf-8

{"total":3,"results":[{"id":"1","id_formatted":"1","timestamp":"2026-10-04 02:55:26","dl":"91.20","ul":"42.10","ping":"12.40","jitter":"1.20","ip":"172.17.0.1","isp":"Probe ISP (NL) - 5 km","params":{"time_dl_max":"12","telemetry_level":"basic"}}]}
======================================================================

== 10. GET results/mine.php?client_id=probeClientAAA1&limit=1&offset=1 (expect 200, total 3, one row)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store
Content-Length: 221
Content-Type: application/json; charset=utf-8

{"total":3,"results":[{"id":"2","id_formatted":"2","timestamp":"2026-10-04 02:55:26","dl":"33.30","ul":"22.20","ping":"30.00","jitter":"3.00","ip":"172.17.0.1","isp":"Probe ISP (NL) - 6 km","params":{"time_dl_max":"8"}}]}
======================================================================

== 11. GET results/mine.php without client_id (expect 400)
======================================================================
HTTP/1.1 400 Bad Request
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store
Content-Length: 29
Connection: close
Content-Type: application/json; charset=utf-8

{"error":"invalid_client_id"}
======================================================================
```

## 2.8 `admin_api.php` over real HTTP

```
== 12. GET results/admin_api.php?op=session (expect logged=false, configured=true)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=934c617b1c78411e9ed24a4b47236646; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 46
Content-Type: application/json; charset=utf-8

{"logged":false,"configured":true,"csrf":null}
======================================================================

== 13. POST results/admin_api.php?op=login with the WRONG password (expect 401)
======================================================================
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=f29e39a3f5315f64c1d84c329c80b489; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 24
Content-Type: application/json; charset=utf-8

{"error":"bad_password"}
======================================================================

== 14. GET results/admin_api.php?op=list without a session (expect 401)
======================================================================
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=7e3f2012acafd2a6502a566943c22a12; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 25
Content-Type: application/json; charset=utf-8

{"error":"not_logged_in"}
======================================================================

== 15. POST results/admin_api.php?op=login with the right password (expect 200 + csrf)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=284ae7a94f213e96e3256ce2dfd14261; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 89
Content-Type: application/json; charset=utf-8

{"logged":true,"csrf":"8c47c6b5cf44dab35fc3ac8e7adf1736ba525fbb708f20c74dfb026f1d4063b4"}CSRF token: 8c47c6b5cf44dab35fc3ac8e7adf1736ba525fbb708f20c74dfb026f1d4063b4

======================================================================

== 16. GET results/admin_api.php?op=session with the cookie (expect logged=true, csrf present)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 107
Content-Type: application/json; charset=utf-8

{"logged":true,"configured":true,"csrf":"8c47c6b5cf44dab35fc3ac8e7adf1736ba525fbb708f20c74dfb026f1d4063b4"}
======================================================================

== 17. GET results/admin_api.php?op=list (rows must carry client_id/params, never log)
======================================================================
HTTP/1.1 200 OK
total = 5 limit = 500 offset = 0
 id=5 client_id=probeClientAAA1 dl=4.00 params=null has_log=False
 id=4 client_id=None dl=1.00 params=null has_log=False
 id=3 client_id=probeClientBBB2 dl=7.70 params=null has_log=False
 id=2 client_id=probeClientAAA1 dl=33.30 params={"time_dl_max": "8"} has_log=False
 id=1 client_id=probeClientAAA1 dl=91.20 params={"time_dl_max": "12", "telemetry_level": "basic"} has_log=False

======================================================================

== 18. GET results/admin_api.php?op=detail&id=1 (must include log, client_id, params)
======================================================================
HTTP/1.1 200 OK
{"id":"1","id_formatted":"1","timestamp":"2026-10-04 02:55:26","ip":"172.17.0.1","isp":"Probe ISP (NL) - 5 km","ispinfo":"{\"processedString\":\"Probe ISP (NL) - 5 km\",\"hostname\":\"probe.example\"}","ua":"curl/8.18.0","lang":"","dl":"91.20","ul":"42.10","ping":"12.40","jitter":"1.20","extra":"{\"probe\":1}","client_id":"probeClientAAA1","params":{"time_dl_max":"12","telemetry_level":"basic"},"log":"timestamp;dl;91.20"}

======================================================================

== 18b. GET results/admin_api.php?op=detail&id=<invalid client row id> (client_id/params must be null)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 265
Content-Type: application/json; charset=utf-8

{"id":"4","id_formatted":"4","timestamp":"2026-10-04 02:55:26","ip":"172.17.0.1","isp":"","ispinfo":"","ua":"curl/8.18.0","lang":"","dl":"1.00","ul":"2.00","ping":"3.00","jitter":"0.10","extra":"","client_id":null,"params":null,"log":"invalid client id and params"}
======================================================================

== 18c. GET results/admin_api.php?op=detail&id=<big log row id> (log must be 32768 bytes)
======================================================================
HTTP/1.1 200 OK
log length = 32768

======================================================================

== 19. POST results/admin_api.php?op=delete&id=2 WITHOUT the CSRF header (expect 403)
======================================================================
HTTP/1.1 403 Forbidden
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 20
Content-Type: application/json; charset=utf-8

{"error":"bad_csrf"}
======================================================================

== 20. POST results/admin_api.php?op=delete&id=2 WITH the CSRF header (expect deleted=1)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 13
Content-Type: application/json; charset=utf-8

{"deleted":1}
======================================================================

== 21. GET results/admin_api.php?op=stats (getSpeedtestStats shape)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 293
Content-Type: application/json; charset=utf-8

{"total":4,"unique_clients":2,"dl_avg":25.98,"dl_max":91.2,"ul_avg":14.48,"ul_max":42.1,"ping_avg":17.85,"jitter_avg":1.63,"per_day":[{"date":"2026-10-04","count":4,"dl_avg":25.98,"ul_avg":14.48}],"top_isp":[{"isp":"Probe ISP (NL) - 5 km","count":1},{"isp":"Other ISP (DE) - 2 km","count":1}]}
======================================================================

== 22. GET results/admin_api.php?op=export (text/csv attachment, RFC4180)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Disposition: attachment; filename="librespeedex-results-20261004-0255.csv"
Content-Length: 480
Content-Type: text/csv; charset=utf-8

id,timestamp,ip,dl,ul,ping,jitter,isp,client_id,params
6,"2026-10-04 02:55:26",172.17.0.1,,,,,,,
5,"2026-10-04 02:55:26",172.17.0.1,4.00,5.00,6.00,0.20,,probeClientAAA1,
4,"2026-10-04 02:55:26",172.17.0.1,1.00,2.00,3.00,0.10,,,
3,"2026-10-04 02:55:26",172.17.0.1,7.70,8.80,50.00,5.00,"Other ISP (DE) - 2 km",probeClientBBB2,
1,"2026-10-04 02:55:26",172.17.0.1,91.20,42.10,12.40,1.20,"Probe ISP (NL) - 5 km",probeClientAAA1,"{""time_dl_max"":""12"",""telemetry_level"":""basic""}"

======================================================================

== 23. POST results/admin_api.php?op=purge before=2020-01-01 (expect deleted=0)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 13
Content-Type: application/json; charset=utf-8

{"deleted":0}
======================================================================

== 24. POST results/admin_api.php?op=purge all=1 (expect deleted=4: rows 1,3,4,5)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 13
Content-Type: application/json; charset=utf-8

{"deleted":5}
======================================================================

== 25. POST results/admin_api.php?op=logout with CSRF (expect logged=false)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 16
Content-Type: application/json; charset=utf-8

{"logged":false}
======================================================================

== 26. GET results/admin_api.php?op=list after logout (expect 401)
======================================================================
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 25
Content-Type: application/json; charset=utf-8

{"error":"not_logged_in"}
======================================================================
```

## 2.9 `telemetry.php` validation, clamping and rate limiting over HTTP

```
== 1. POST results/telemetry.php (client probeClientAAA1, row 1: full payload)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0
Cache-Control: post-check=0, pre-check=0
Pragma: no-cache
Content-Length: 4
Content-Type: text/html; charset=UTF-8

id 1
======================================================================

== 4. POST results/telemetry.php with an INVALID client_id and non-object params (both must be dropped)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0
Cache-Control: post-check=0, pre-check=0
Pragma: no-cache
Content-Length: 4
Content-Type: text/html; charset=UTF-8

id 4
======================================================================

== 5. POST results/telemetry.php with a 40000 byte log (must be clamped to 32768)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0
Cache-Control: post-check=0, pre-check=0
Pragma: no-cache
Content-Length: 4
Content-Type: text/html; charset=UTF-8

id 5
======================================================================

== 27. results/telemetry.php rate limit: 61 writes with the same client_id (expect 60 inserts + 429)
======================================================================
1 200 id 7
2 200 id 8
3 200 id 9
...
59 200 id 65
60 200 id 66
61 429 rate_limited
2xx responses: 60
429 responses: 1
61:61 429 rate_limited

======================================================================
```

## 2.10 Placeholder password is refused on every auth route

```
== 29. start a fresh probe with PASSWORD=PASSWORD (placeholder must be refused)
======================================================================
2870c3ac76c8e5aaa314b73f01f07afec2d191d14f003454d0493d5bc402e12b
running: telemetry-probe 8080/tcp, 0.0.0.0:18199->80/tcp, [::]:18199->80/tcp
--- op=session (expect configured=false) ---
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:28 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=2d4ae4d5a30adc8df078b7b3a1f4f4e0; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 47
Content-Type: application/json; charset=utf-8

{"logged":false,"configured":false,"csrf":null}--- op=login password=PASSWORD (expect 401 bad_password) ---
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:28 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=41cc032c15a44363df2ce019b7f5082f; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 24
Content-Type: application/json; charset=utf-8

{"error":"bad_password"}--- op=list with the placeholder configured (expect 401) ---
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:28 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=d9b54394d3b2c2f6e98ac45721fe0ef6; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 25
Content-Type: application/json; charset=utf-8

{"error":"not_logged_in"}--- op=logout with the placeholder configured (expect 401) ---
HTTP/1.1 401 Unauthorized
Date: Sun, 04 Oct 2026 02:55:28 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Set-Cookie: PHPSESSID=16bdc00b15e841c67a1c29d49ee382dc; path=/; HttpOnly; SameSite=Strict
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store
Pragma: no-cache
Content-Length: 25
Content-Type: application/json; charset=utf-8

{"error":"not_logged_in"}
======================================================================

== 30. remove the probe container and prove it is gone
======================================================================
docker ps -a --filter name=telemetry-probe:
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
(empty output above means the container is gone)
docker ps:
CONTAINER ID   IMAGE                    COMMAND                  CREATED        STATUS                  PORTS                                                                                          NAMES
f36d570be298   zoetrope/hub:dev         "docker-entrypoint.s…"   3 hours ago    Up 3 hours                                                                                                             zoetrope-hub
bbb09bf1357f   1e4bd292299d             "docker-php-entrypoi…"   4 hours ago    Up 4 hours (healthy)    80/tcp, 0.0.0.0:18100->8080/tcp                                                                dsh-librespeedex
8d1a21a3c201   caddy:2-alpine           "caddy run --config …"   25 hours ago   Up 25 hours                                                                                                            zoetrope-tls
bb38998d43b8   hydro-dev-app:latest     "/usr/local/bin/hydr…"   35 hours ago   Up 35 hours             0.0.0.0:2333->2333/tcp                                                                         hydro-dev-app-1
a78e18cbfb5c   mongo:4.4                "docker-entrypoint.s…"   35 hours ago   Up 35 hours (healthy)   27017/tcp                                                                                      hydro-dev-mongo-1
acf6a3c32c33   qq-ai-bot:latest         "/app/qqbot"             36 hours ago   Up 36 hours (healthy)   0.0.0.0:8080->8080/tcp                                                                         qq-ai-bot
02f6e3dcf4c7   64851868f601             "sh start.sh"            5 days ago     Up 5 days               8000/tcp                                                                                       xenodochial_dhawan
9cc1f97e0eaf   caddy:alpine             "caddy run --config …"   2 weeks ago    Up 2 weeks              80/tcp, 443/tcp, 2019/tcp, 443/udp, 0.0.0.0:49107->49107/tcp, [::]:49107->49107/tcp            triggermall-caddy-dev
cedb67cda770   postgres:15              "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              0.0.0.0:49102->5432/tcp, [::]:49102->5432/tcp                                                  triggermall-db
ab53ede94f8a   minio/minio:latest       "/usr/bin/docker-ent…"   2 weeks ago    Up 2 weeks              0.0.0.0:49104->9000/tcp, [::]:49104->9000/tcp, 0.0.0.0:49105->9001/tcp, [::]:49105->9001/tcp   triggermall-minio
d228b322e318   postgis/postgis:16-3.4   "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              127.0.0.1:55432->5432/tcp                                                                      fellowearth-pg
ec6af5cd3c14   caddy:latest             "caddy run --config …"   3 weeks ago    Up 2 weeks                                                                                                             caddy-dsh

======================================================================

== 31. probe with REDACT_IP_ADDRESSES=true (existing redaction behaviour preserved)
======================================================================
10:$redact_ip_addresses = true;
id 1
stored ip      = 0.0.0.0
stored log     = client 0.0.0.0 ran the test
stored ispinfo = {"processedString":"Redact ISP (NL) - 1 km","hostname":"REDACTED"}

======================================================================

== 31b. admin login rate limit: 10 attempts / 15 min per IP (one attempt already spent above)
======================================================================
1 401 {"error":"bad_password"}
2 401 {"error":"bad_password"}
3 401 {"error":"bad_password"}
4 401 {"error":"bad_password"}
5 401 {"error":"bad_password"}
6 401 {"error":"bad_password"}
7 401 {"error":"bad_password"}
8 401 {"error":"bad_password"}
9 401 {"error":"bad_password"}
10 429 {"error":"rate_limited"}
11 429 {"error":"rate_limited"}
12 429 {"error":"rate_limited"}
401 responses: 9
429 responses: 3

======================================================================
```

`configured=false`, `login` with the literal `PASSWORD` → `401 {"error":"bad_password"}` (the placeholder never reaches `hash_equals`), `list`/`logout` → `401 {"error":"not_logged_in"}`.

## 2.11 Existing endpoints keep working

```
== 21b. GET results/index.php?id=1 (the PNG share image must keep working)
======================================================================
HTTP/1.1 200 OK
Content-Type: image/png
bytes = 14594
PNG magic = True

======================================================================

== 21c. GET results/json.php?id=1 (existing JSON endpoint must keep working)
======================================================================
HTTP/1.1 200 OK
Date: Sun, 04 Oct 2026 02:55:26 GMT
Server: Apache/2.4.68 (Debian)
X-Powered-By: PHP/8.5.11
Content-Length: 116
Content-Type: application/json; charset=utf-8

{"timestamp":"2026-10-04 02:55:26","download":"91.2","upload":"42.1","ping":"12.4","jitter":"1.20","ispinfo":"5 km"}
======================================================================

== 21d. GET results/sanitycheck.php (legacy insertSpeedtestUser caller must still pass)
======================================================================
HTTP/1.1 200 OK
Failed spans: 0

======================================================================
```

## 2.12 Telemetry settings contract in the served webroot

The entrypoint's environment injection writes/duplicates the four settings by exact variable name. My lines 38-44 are the shipped defaults; lines 47-49 are the entrypoint's appended overrides (same names, same values, harmless re-assignment).

```
== 0. telemetry settings inside the served webroot (env-injected values present)
======================================================================
38:$telemetry_rate_limit_writes_per_hour    = 60;
40:$telemetry_rate_limit_writes_per_hour_ip = 240;
42:$telemetry_retention_days                = 90;
44:$telemetry_cache_dir                     = '';
47:$telemetry_retention_days = 90;
48:$telemetry_rate_limit_writes_per_hour = 60;
49:$telemetry_rate_limit_writes_per_hour_ip = 240;

======================================================================
```

---

# 3. Probe container lifecycle (must be gone afterwards)

```
== 28. stop the test probe container and prove it is gone
======================================================================
docker ps -a --filter name=telemetry-probe:
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
(empty output above means the container is gone)
docker ps (all running containers):
CONTAINER ID   IMAGE                    COMMAND                  CREATED        STATUS                  PORTS                                                                                          NAMES
f36d570be298   zoetrope/hub:dev         "docker-entrypoint.s…"   3 hours ago    Up 3 hours                                                                                                             zoetrope-hub
bbb09bf1357f   1e4bd292299d             "docker-php-entrypoi…"   4 hours ago    Up 4 hours (healthy)    80/tcp, 0.0.0.0:18100->8080/tcp                                                                dsh-librespeedex
8d1a21a3c201   caddy:2-alpine           "caddy run --config …"   25 hours ago   Up 25 hours                                                                                                            zoetrope-tls
bb38998d43b8   hydro-dev-app:latest     "/usr/local/bin/hydr…"   35 hours ago   Up 35 hours             0.0.0.0:2333->2333/tcp                                                                         hydro-dev-app-1
a78e18cbfb5c   mongo:4.4                "docker-entrypoint.s…"   35 hours ago   Up 35 hours (healthy)   27017/tcp                                                                                      hydro-dev-mongo-1
acf6a3c32c33   qq-ai-bot:latest         "/app/qqbot"             36 hours ago   Up 36 hours (healthy)   0.0.0.0:8080->8080/tcp                                                                         qq-ai-bot
02f6e3dcf4c7   64851868f601             "sh start.sh"            5 days ago     Up 5 days               8000/tcp                                                                                       xenodochial_dhawan
9cc1f97e0eaf   caddy:alpine             "caddy run --config …"   2 weeks ago    Up 2 weeks              80/tcp, 443/tcp, 2019/tcp, 443/udp, 0.0.0.0:49107->49107/tcp, [::]:49107->49107/tcp            triggermall-caddy-dev
cedb67cda770   postgres:15              "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              0.0.0.0:49102->5432/tcp, [::]:49102->5432/tcp                                                  triggermall-db
ab53ede94f8a   minio/minio:latest       "/usr/bin/docker-ent…"   2 weeks ago    Up 2 weeks              0.0.0.0:49104->9000/tcp, [::]:49104->9000/tcp, 0.0.0.0:49105->9001/tcp, [::]:49105->9001/tcp   triggermall-minio
d228b322e318   postgis/postgis:16-3.4   "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              127.0.0.1:55432->5432/tcp                                                                      fellowearth-pg
ec6af5cd3c14   caddy:latest             "caddy run --config …"   3 weeks ago    Up 2 weeks                                                                                                             caddy-dsh

======================================================================

== 32. remove the redaction probe container and prove it is gone
======================================================================
docker ps -a --filter name=telemetry-probe:
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
(empty output above means the container is gone)
docker ps:
CONTAINER ID   IMAGE                    COMMAND                  CREATED        STATUS                  PORTS                                                                                          NAMES
f36d570be298   zoetrope/hub:dev         "docker-entrypoint.s…"   3 hours ago    Up 3 hours                                                                                                             zoetrope-hub
bbb09bf1357f   1e4bd292299d             "docker-php-entrypoi…"   4 hours ago    Up 4 hours (healthy)    80/tcp, 0.0.0.0:18100->8080/tcp                                                                dsh-librespeedex
8d1a21a3c201   caddy:2-alpine           "caddy run --config …"   25 hours ago   Up 25 hours                                                                                                            zoetrope-tls
bb38998d43b8   hydro-dev-app:latest     "/usr/local/bin/hydr…"   35 hours ago   Up 35 hours             0.0.0.0:2333->2333/tcp                                                                         hydro-dev-app-1
a78e18cbfb5c   mongo:4.4                "docker-entrypoint.s…"   35 hours ago   Up 35 hours (healthy)   27017/tcp                                                                                      hydro-dev-mongo-1
acf6a3c32c33   qq-ai-bot:latest         "/app/qqbot"             36 hours ago   Up 36 hours (healthy)   0.0.0.0:8080->8080/tcp                                                                         qq-ai-bot
02f6e3dcf4c7   64851868f601             "sh start.sh"            5 days ago     Up 5 days               8000/tcp                                                                                       xenodochial_dhawan
9cc1f97e0eaf   caddy:alpine             "caddy run --config …"   2 weeks ago    Up 2 weeks              80/tcp, 443/tcp, 2019/tcp, 443/udp, 0.0.0.0:49107->49107/tcp, [::]:49107->49107/tcp            triggermall-caddy-dev
cedb67cda770   postgres:15              "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              0.0.0.0:49102->5432/tcp, [::]:49102->5432/tcp                                                  triggermall-db
ab53ede94f8a   minio/minio:latest       "/usr/bin/docker-ent…"   2 weeks ago    Up 2 weeks              0.0.0.0:49104->9000/tcp, [::]:49104->9000/tcp, 0.0.0.0:49105->9001/tcp, [::]:49105->9001/tcp   triggermall-minio
d228b322e318   postgis/postgis:16-3.4   "docker-entrypoint.s…"   2 weeks ago    Up 2 weeks              127.0.0.1:55432->5432/tcp                                                                      fellowearth-pg
ec6af5cd3c14   caddy:latest             "caddy run --config …"   3 weeks ago    Up 2 weeks                                                                                                             caddy-dsh

HTTP TEST SCRIPT FINISHED
```

`dsh-librespeedex` (port 18100) is still running and was never touched.

---

# 4. Open questions / risks

1. **Only sqlite is proven end-to-end.** The image ships `pdo_mysql` and `pdo_pgsql` but no database server is available here, and it has **no `pdo_sqlsrv` at all**, so the mysql/postgresql/mssql branches of `ensureSchema()` (introspection, `ALTER TABLE`, index creation), the mssql `sys.indexes` guard and the three `.sql` files are written per driver but **not executed**. Type mapping worth reviewing: mysql `client_id text` + index prefix `client_id(64)`; mssql `client_id nvarchar(64)` (indexable) while `params` is `nvarchar(max)`; pg/sqlite plain `TEXT`.
2. **`deleteSpeedtestUserById()` takes the raw numeric id**, not the obfuscated `id_formatted`. `admin_api.php?op=delete` therefore requires digits (`400 bad_id` otherwise). To keep `index.php`/`json.php` behaviour (they pass obfuscated ids) I added an optional third parameter `getSpeedtestUserById($id, $returnExceptionOnError = false, $skipObfuscation = false)`; `admin_api.php?op=detail` passes `true` for numeric ids. The signature is backwards compatible, but this is an addition beyond the spec.
3. **Extra filter keys.** Beyond the specified `q/ip/from/to/min_dl/min_ul/order`, `getSpeedtestUsersFiltered()`/`countSpeedtestUsers()` also accept `client_id` (allowed by the spec) and `id` (my addition, used by `mine.php` for the "belongs to this client" lookup). Additive only; unknown keys are ignored.
4. **Return values on DB failure.** `countSpeedtestUsers()` returns `0` and `getSpeedtestStats()` returns the zeroed shape instead of `false`, so the JSON APIs always have a renderable value; `delete*`/`purge*`/`getSpeedtestUsers*` return `false` as specified. `getSpeedtestStats()` rounds the averages to 2 decimals (`*_max` is raw).
5. **`top_isp` labelling.** SQL groups by the raw `ispinfo` (top 200 groups) and PHP then merges identical `processedString` labels and takes 8. An ISP whose stored JSON differs on every run (e.g. changing hostname) can still be fragmented beyond the 200 groups, and rows with no label are shown as `(unknown)`. Rows whose `ispinfo` is unparseable JSON yield an empty `isp` (deliberately never the raw blob).
6. **CSV export honours the spec'd `limit`** (default 50, max 500) plus `offset`, so a full export must be paged; there is no "export everything" default. `fputcsv(..., ',', '"', '')` is used for strict RFC4180 quoting; the 5th argument requires PHP ≥ 7.4.
7. **Retention is probabilistic** (`random_int(1,50)`), so on a quiet instance a sweep may not run for a long time; the spec asked for exactly this gate. A sweep failure returns `false` and is otherwise silent.
8. **`mine.php` 120 req/h per IP is not driven over HTTP** (it would need 121 requests); the shared `telemetryRateLimit()` primitive is covered by the CLI case and by a live `telemetry.php` 429 (60 allowed writes, then `429 rate_limited`). The admin login limit *is* driven live (10 allowed, then `429`).
9. **Obfuscation-enabled paths were not exercised** (`$enable_id_obfuscation` stayed `false`) to avoid writing `results/idObfuscation_salt.php` from a test. The existing obfuscation code paths are untouched apart from the relabelled row-shaping helper.
10. **`params` is validated as a JSON object string ≤ 4096 bytes** and stored verbatim; it is not re-encoded or schema-checked. `client_id` must match `/^[A-Za-z0-9_-]{8,64}$/`, otherwise it is stored as `NULL` (the write still succeeds).
11. **`results/admin.html`** appeared in the working tree during this task (mode `600`) — it is not one of my files and I did not touch it; flagging it only because it is a new file in `results/` and mode 600 is exactly the failure mode called out in the brief.
12. The image's entrypoint **appends** `$telemetry_retention_days`, `$telemetry_rate_limit_writes_per_hour` and `$telemetry_rate_limit_writes_per_hour_ip` to `telemetry_settings.php`; my file already defines all four names, so the appended duplicates are harmless. Verified in the served webroot (my lines 38–44, appended lines 47–49).
