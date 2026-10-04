<?php

/**
 * LibreSpeedex telemetry data layer test harness.
 *
 * Usage:
 *   docker run --rm -v "$PWD":/src -w /src librespeedex:local php .scratch/telemetry-test/run.php
 *   docker run --rm -v "$PWD":/src -w /src librespeedex:local php .scratch/telemetry-test/run.php migrate
 *
 * Without arguments it spawns one child process per case (each child boots the
 * real results/telemetry_db.php against a fresh sandbox) and summarises the
 * results. With an argument it runs exactly that case in this process.
 */

require __DIR__.'/lib.php';

$cases = [
    'migrate',
    'queries',
    'stats',
    'delete_purge',
    'ratelimit',
    'retention',
    'validators',
];

/**
 * @param string      $clientId
 * @param string      $ip
 * @param string      $ispinfo
 * @param string      $extra
 * @param string      $dl
 * @param string      $ul
 * @param string      $ping
 * @param string      $jitter
 * @param string      $ua
 * @param string      $log
 * @param string|null $params
 *
 * @return int|string|false|Exception
 */
function t_insert($clientId, $ip, $ispinfo, $extra, $dl, $ul, $ping = '0', $jitter = '0', $ua = 'TestUA', $log = 'log', $params = null)
{
    return insertSpeedtestUser($ip, $ispinfo, $extra, $ua, 'en-US', $dl, $ul, $ping, $jitter, $log, $clientId, $params);
}

/**
 * @param array $rows
 *
 * @return int[]
 */
function t_ids($rows)
{
    $ids = [];
    foreach ($rows as $row) {
        $ids[] = (int) $row['id'];
    }

    return $ids;
}

// ---------------------------------------------------------------------------
// case: migrate
// ---------------------------------------------------------------------------
function case_migrate()
{
    $env = t_boot('migrate');

    $legacyId = t_create_old_schema_db($env['db']);
    t_eq(
        t_column_names($env['db']),
        ['id', 'ispinfo', 'extra', 'timestamp', 'ip', 'ua', 'lang', 'dl', 'ul', 'ping', 'jitter', 'log'],
        'fixture starts from the OLD schema (no client_id/params)'
    );
    t_check(!in_array('idx_speedtest_users_client_id', t_index_names($env['db']), true), 'fixture has no client_id index yet');

    $pdo = getPdo();
    t_check($pdo instanceof PDO, 'getPdo() returns a PDO against the old database');

    $columns = t_column_names($env['db']);
    t_check(in_array('client_id', $columns, true), 'migration added client_id');
    t_check(in_array('params', $columns, true), 'migration added params');
    t_check(in_array('idx_speedtest_users_client_id', t_index_names($env['db']), true), 'migration created the client_id index');
    t_check(true === ensureSchema($pdo), 'ensureSchema() reports success');
    t_check(true === ensureSchema($pdo), 'ensureSchema() is idempotent');

    $legacy = getSpeedtestUserById($legacyId);
    t_check(is_array($legacy), 'the pre-existing row is still readable');
    t_eq($legacy['ip'], '10.9.9.9', 'legacy row ip survived');
    t_eq($legacy['ua'], 'LegacyUA/1.0', 'legacy row ua survived');
    t_eq($legacy['log'], 'legacy log line', 'legacy row log survived');
    t_eq($legacy['dl'], '12.50', 'legacy row dl survived');
    t_eq($legacy['extra'], '{"legacy":true}', 'legacy row extra survived');
    t_check(null === $legacy['client_id'], 'legacy row client_id is NULL');
    t_check(null === $legacy['params'], 'legacy row params is NULL');

    $id = t_insert('ClientA1234', '10.0.0.1', '{"processedString":"New ISP (NL) - 1 km"}', '{"x":1}', '91.20', '42.10', '12.40', '1.20', 'ModernUA/2.0', 'modern log', '{"time_dl_max":"12"}');
    t_check(!($id instanceof Exception) && false !== $id, 'insert with client_id + params succeeds');

    $row = getSpeedtestUserById($id);
    t_eq($row['client_id'], 'ClientA1234', 'client_id round-trips through insert/select');
    t_eq($row['params'], '{"time_dl_max":"12"}', 'params round-trips through insert/select');
    t_eq($row['dl'], '91.20', 'dl round-trips after migration');
    t_eq(countSpeedtestUsers(['client_id' => 'ClientA1234']), 1, 'count sees the migrated row');
    t_eq(countSpeedtestUsers([]), 2, 'both rows are present after migration');

    t_finish('migrate', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: queries
// ---------------------------------------------------------------------------
function case_queries()
{
    $env = t_boot('queries');
    t_check(getPdo() instanceof PDO, 'schema ready');

    $clientA = 'aaaaaaaaaaaa1111';
    $clientB = 'bbbbbbbbbbbb2222';

    $f1 = t_insert($clientA, '10.0.0.1', '{"processedString":"ISP One (NL) - 3 km"}', '{"alpha":1}', '100', '10', '5', '0.5', 'Firefox');
    $f2 = t_insert($clientA, '10.0.0.2', '{"processedString":"ISP One (NL) - 4 km"}', '{"beta":2}', '50', '20', '15', '1.5', 'Chrome');
    $f3 = t_insert($clientB, '10.0.0.3', '{"processedString":"ISP Two (DE) - 9 km"}', '{"gamma":3}', '30', '30', '25', '2.5', 'Safari');
    $f4 = t_insert($clientB, '192.168.1.9', '{"processedString":"ISP Three"}', '100%_literal', '5', '1', '2', '0.2', 'Chrome');
    $f5 = t_insert($clientA, '10.0.0.5', 'plain text isp', '100Xliteral', '1', '2', '3', '0.3', 'Edge');

    t_set_timestamp($env['db'], $f1, '2026-02-10 10:00:00');
    t_set_timestamp($env['db'], $f2, '2026-02-14 10:00:00');
    t_set_timestamp($env['db'], $f3, '2026-02-14 23:00:00');
    t_set_timestamp($env['db'], $f4, '2026-02-20 00:30:00');
    t_set_timestamp($env['db'], $f5, '2026-02-21 00:00:00');

    t_eq(countSpeedtestUsers([]), 5, 'count without filters');
    t_eq(countSpeedtestUsers(['client_id' => $clientA]), 3, 'count scoped to client A');
    t_eq(countSpeedtestUsers(['client_id' => $clientB]), 2, 'count scoped to client B');
    t_eq(countSpeedtestUsers(['client_id' => 'doesnotexist0000']), 0, 'count of unknown client');
    t_eq(countSpeedtestUsers(['ip' => '10.0.0.2']), 1, 'ip filter is exact');
    t_eq(countSpeedtestUsers(['q' => 'Chrome']), 2, 'q matches user agent');
    t_eq(countSpeedtestUsers(['q' => 'gamma']), 1, 'q matches extra');
    t_eq(countSpeedtestUsers(['q' => '10.0.0.3']), 1, 'q matches ip');
    t_eq(countSpeedtestUsers(['q' => $clientB]), 2, 'q matches client_id');
    t_eq(countSpeedtestUsers(['q' => '100%_literal']), 1, 'q escapes LIKE wildcards');
    t_eq(countSpeedtestUsers(['q' => 'nothing-matches-this']), 0, 'q without match');
    t_eq(countSpeedtestUsers(['from' => '2026-02-14']), 4, 'from date is inclusive of that day');
    t_eq(countSpeedtestUsers(['to' => '2026-02-14']), 3, 'to date covers the whole day');
    t_eq(countSpeedtestUsers(['from' => '2026-02-14 12:00:00', 'to' => '2026-02-20 01:00:00']), 2, 'from/to datetime range');
    t_eq(countSpeedtestUsers(['to' => 'not-a-date']), 5, 'invalid to date is ignored');
    t_eq(countSpeedtestUsers(['min_dl' => '50']), 2, 'min_dl filter');
    t_eq(countSpeedtestUsers(['min_ul' => '20']), 2, 'min_ul filter');
    t_eq(countSpeedtestUsers(['min_dl' => '0']), 5, 'min_dl 0 keeps every row with a value');
    t_eq(countSpeedtestUsers(['client_id' => $clientA, 'min_dl' => '50']), 2, 'filters combine');

    $rowsA = getSpeedtestUsersByClientId($clientA);
    t_eq(count($rowsA), 3, 'getSpeedtestUsersByClientId returns only client A rows');
    t_eq(t_ids($rowsA), [(int) $f5, (int) $f2, (int) $f1], 'client A rows are newest first');
    $foreign = 0;
    foreach ($rowsA as $row) {
        if ($row['client_id'] !== $clientA) {
            ++$foreign;
        }
    }
    t_eq($foreign, 0, 'no client B row leaks into client A list');

    $rowsB = getSpeedtestUsersByClientId($clientB, 1, 1);
    t_eq(t_ids($rowsB), [(int) $f3], 'limit/offset paging on getSpeedtestUsersByClientId');

    t_check(!array_key_exists('log', $rowsA[0]), 'list rows do not carry the log column');
    t_eq($rowsA[0]['id_formatted'], $rowsA[0]['id'], 'id_formatted is present (obfuscation off)');
    t_check(array_key_exists('client_id', $rowsA[0]), 'list rows carry client_id');
    t_check(array_key_exists('params', $rowsA[0]), 'list rows carry params');
    t_check(null === $rowsA[0]['params'], 'params is NULL when it was not submitted');

    t_eq(getSpeedtestUsersFiltered(['client_id' => $clientB, 'id' => (int) $f1]), [], 'other client id cannot fetch client A row');
    $mine = getSpeedtestUsersFiltered(['client_id' => $clientA, 'id' => (int) $f1], 1, 0);
    t_eq(t_ids($mine), [(int) $f1], 'own id lookup returns exactly that row');

    t_eq(t_ids(getSpeedtestUsersFiltered(['order' => 'oldest'], 2, 0)), [(int) $f1, (int) $f2], 'order oldest');
    t_eq(t_ids(getSpeedtestUsersFiltered(['order' => 'dl'], 3, 0)), [(int) $f1, (int) $f2, (int) $f3], 'order dl');
    t_eq(t_ids(getSpeedtestUsersFiltered(['order' => 'ul'], 2, 0)), [(int) $f3, (int) $f2], 'order ul');
    t_eq(t_ids(getSpeedtestUsersFiltered([], 2, 1)), [(int) $f4, (int) $f3], 'default order is newest first with offset');

    $limited = getSpeedtestUsersFiltered(['q' => 'Chrome', 'order' => 'dl'], 10, 0);
    t_eq(t_ids($limited), [(int) $f2, (int) $f4], 'filter + order combined');

    t_finish('queries', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: stats
// ---------------------------------------------------------------------------
function case_stats()
{
    $env = t_boot('stats');
    t_check(getPdo() instanceof PDO, 'schema ready');

    $clientA = 'cccccccccccc1111';
    $clientB = 'dddddddddddd2222';
    $clientC = 'eeeeeeeeeeee3333';
    $today = gmdate('Y-m-d').' 08:00:00';
    $yesterday = gmdate('Y-m-d', time() - 86400).' 08:00:00';
    $longAgo = gmdate('Y-m-d H:i:s', time() - 40 * 86400);

    $r1 = t_insert($clientA, '10.0.0.1', '{"processedString":"ISP One"}', '', '100', '10', '5', '0.5');
    $r2 = t_insert($clientA, '10.0.0.1', '{"processedString":"ISP One"}', '', '50', '20', '15', '1.5');
    $r3 = t_insert($clientB, '10.0.0.2', '{"processedString":"ISP Two"}', '', '30', '30', '25', '2.5');
    $r4 = t_insert($clientC, '10.0.0.3', '', '', '', '', '', '');
    $r5 = t_insert(null, '10.0.0.4', '', '', '10', '5', '1', '0.1');

    t_set_timestamp($env['db'], $r1, $today);
    t_set_timestamp($env['db'], $r2, $today);
    t_set_timestamp($env['db'], $r3, $yesterday);
    t_set_timestamp($env['db'], $r4, $yesterday);
    t_set_timestamp($env['db'], $r5, $longAgo);

    $stats = getSpeedtestStats();
    t_check(is_array($stats), 'getSpeedtestStats returns an array');
    foreach (['total', 'unique_clients', 'dl_avg', 'dl_max', 'ul_avg', 'ul_max', 'ping_avg', 'jitter_avg', 'per_day', 'top_isp'] as $key) {
        t_check(array_key_exists($key, $stats), 'stats carries '.$key);
    }

    t_eq($stats['total'], 5, 'stats total');
    t_eq($stats['unique_clients'], 3, 'stats unique_clients ignores NULL client_id');
    t_approx($stats['dl_avg'], 47.5, 'stats dl_avg ignores empty values');
    t_approx($stats['dl_max'], 100.0, 'stats dl_max');
    t_approx($stats['ul_avg'], 16.25, 'stats ul_avg');
    t_approx($stats['ul_max'], 30.0, 'stats ul_max');
    t_approx($stats['ping_avg'], 11.5, 'stats ping_avg');
    t_approx($stats['jitter_avg'], 1.15, 'stats jitter_avg');

    t_eq(count($stats['per_day']), 2, 'per_day only contains days with data (40 day old row excluded)');
    t_eq($stats['per_day'][0]['date'], gmdate('Y-m-d', time() - 86400), 'per_day is ordered oldest first');
    t_eq($stats['per_day'][0]['count'], 2, 'per_day yesterday count');
    t_approx($stats['per_day'][0]['dl_avg'], 30.0, 'per_day yesterday dl_avg');
    t_approx($stats['per_day'][0]['ul_avg'], 30.0, 'per_day yesterday ul_avg');
    t_eq($stats['per_day'][1]['date'], gmdate('Y-m-d'), 'per_day today');
    t_eq($stats['per_day'][1]['count'], 2, 'per_day today count');
    t_approx($stats['per_day'][1]['dl_avg'], 75.0, 'per_day today dl_avg');
    t_approx($stats['per_day'][1]['ul_avg'], 15.0, 'per_day today ul_avg');

    t_eq($stats['top_isp'], [['isp' => 'ISP One', 'count' => 2], ['isp' => 'ISP Two', 'count' => 1]], 'top_isp by label');
    t_check(is_int($stats['top_isp'][0]['count']), 'top_isp count is an int');

    $scoped = getSpeedtestStats(['client_id' => $clientA]);
    t_eq($scoped['total'], 2, 'scoped stats total');
    t_eq($scoped['unique_clients'], 1, 'scoped stats unique_clients');
    t_approx($scoped['dl_avg'], 75.0, 'scoped stats dl_avg');
    t_eq($scoped['top_isp'], [['isp' => 'ISP One', 'count' => 2]], 'scoped top_isp');

    $empty = getSpeedtestStats(['client_id' => 'nosuchclient0000']);
    t_eq($empty['total'], 0, 'stats of empty filter set');
    t_eq($empty['per_day'], [], 'stats of empty filter set has no per_day');
    t_eq($empty['top_isp'], [], 'stats of empty filter set has no top_isp');

    t_finish('stats', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: delete_purge
// ---------------------------------------------------------------------------
function case_delete_purge()
{
    $env = t_boot('delete_purge');
    t_check(getPdo() instanceof PDO, 'schema ready');

    $old = t_insert('ffffffffffff1111', '10.1.1.1', '', '', '1', '1', '1', '1');
    $new1 = t_insert('ffffffffffff2222', '10.1.1.2', '', '', '2', '2', '2', '2');
    $new2 = t_insert('ffffffffffff3333', '10.1.1.3', '', '', '3', '3', '3', '3');
    t_set_timestamp($env['db'], $old, gmdate('Y-m-d H:i:s', time() - 100 * 86400));
    t_set_timestamp($env['db'], $new2, gmdate('Y-m-d H:i:s', time() - 86400));
    t_eq(countSpeedtestUsers([]), 3, 'three fixture rows');

    t_eq(deleteSpeedtestUserById((int) $new1), 1, 'delete removes the right row');
    t_eq(countSpeedtestUsers([]), 2, 'two rows left');
    t_eq(deleteSpeedtestUserById((int) $new1), 0, 'deleting the same id again deletes 0');
    t_eq(countSpeedtestUsers(['client_id' => 'ffffffffffff2222']), 0, 'deleted row is gone');

    $cutoff = gmdate('Y-m-d H:i:s', time() - 50 * 86400);
    t_eq(purgeSpeedtestUsersBefore($cutoff), 1, 'purge before 50 days removes the 100 day old row');
    t_eq(countSpeedtestUsers([]), 1, 'only the recent row remains');
    t_eq(countSpeedtestUsers(['client_id' => 'ffffffffffff3333']), 1, 'the recent row is the surviving one');
    t_eq(purgeSpeedtestUsersBefore($cutoff), 0, 'purge is idempotent');
    t_eq(purgeSpeedtestUsersBefore(''), false, 'purge with an empty timestamp refuses');
    t_eq(purgeSpeedtestUsersAll(), 1, 'purge all removes everything left');
    t_eq(countSpeedtestUsers([]), 0, 'table is empty');
    t_eq(purgeSpeedtestUsersBefore('2020-01-01 00:00:00'), 0, 'purge on an empty table deletes 0');

    t_finish('delete_purge', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: ratelimit
// ---------------------------------------------------------------------------
function case_ratelimit()
{
    $env = t_boot('ratelimit');
    $cacheDir = $env['dir'].'/cache';

    $allowed = [];
    for ($i = 0; $i < 4; ++$i) {
        $allowed[] = telemetryRateLimit('unit:test', 3, 3600);
    }
    t_eq($allowed, [true, true, true, false], 'rate limit blocks the 4th call in the window');
    t_eq(telemetryRateLimit('unit:other', 3, 3600), true, 'a different key is unaffected');
    t_eq(telemetryRateLimit('unit:disabled', 0, 3600), true, 'limit 0 disables the limit');
    t_eq(telemetryRateLimit('unit:disabled2', 5, 0), true, 'window 0 disables the limit');

    $counterFile = $cacheDir.'/rl-'.substr(hash('sha256', 'unit:test'), 0, 32).'.txt';
    t_check(is_file($counterFile), 'counter file is created in the cache dir');
    $expectedWindow = time() - (time() % 3600);
    t_eq(file_get_contents($counterFile), $expectedWindow.':3', 'counter file contains windowStart:count');

    // A counter written by a previous window must not leak into this one.
    file_put_contents($counterFile, '1:999');
    t_eq(telemetryRateLimit('unit:test', 3, 3600), true, 'stale window resets the counter');
    t_eq(file_get_contents($counterFile), $expectedWindow.':1', 'counter was rewritten for the current window');

    // Fail open: the cache directory cannot be created (its parent is a file).
    $blocker = $env['dir'].'/blocker';
    file_put_contents($blocker, 'not a directory');
    t_write_settings($env['dir'], $env['db'], ['telemetry_cache_dir' => var_export($blocker.'/cache', true)]);
    $open = [];
    for ($i = 0; $i < 5; ++$i) {
        $open[] = telemetryRateLimit('unit:failopen', 1, 3600);
    }
    t_eq($open, [true, true, true, true, true], 'unusable cache dir fails open');

    // Restore a usable cache dir and let telemetryCacheDir() create it again.
    t_write_settings($env['dir'], $env['db']);
    $cacheDir = telemetryCacheDir();
    t_check($cacheDir === $env['dir'].'/cache', 'cache dir setting is honoured');
    t_check(is_dir($cacheDir), 'telemetryCacheDir creates the configured directory');

    // Opportunistic GC: files older than two windows go away, fresh ones stay.
    $stale = $cacheDir.'/rl-'.substr(hash('sha256', 'unit:stale'), 0, 32).'.txt';
    $fresh = $cacheDir.'/rl-'.substr(hash('sha256', 'unit:fresh'), 0, 32).'.txt';
    file_put_contents($stale, '1:1');
    file_put_contents($fresh, '1:1');
    touch($stale, time() - (3 * 3600));
    telemetryRateLimit('unit:gctrigger', 5, 3600);
    t_check(!file_exists($stale), 'GC removes counters older than two windows');
    t_check(file_exists($fresh), 'GC keeps fresh counters');

    // The default cache dir ('' => <dir of db>/cache) is created on demand.
    $env2 = $env['dir'].'/mkdir-case';
    mkdir($env2, 0777, true);
    t_write_settings($env2, $env2.'/app.db', ['telemetry_cache_dir' => "''"]);
    chdir($env2);
    set_include_path($env2.PATH_SEPARATOR.get_include_path());
    t_check(telemetryCacheDir() === $env2.'/cache', 'telemetryCacheDir derives <dbdir>/cache from the settings');
    t_check(is_dir($env2.'/cache'), 'telemetryCacheDir creates the directory');

    t_finish('ratelimit', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: retention
// ---------------------------------------------------------------------------
function case_retention()
{
    $env = t_boot('retention');
    t_check(getPdo() instanceof PDO, 'schema ready');

    $expired = t_insert('9999999999991111', '10.2.2.1', '', '', '1', '1', '1', '1');
    $recent = t_insert('9999999999992222', '10.2.2.2', '', '', '2', '2', '2', '2');
    t_set_timestamp($env['db'], $expired, gmdate('Y-m-d H:i:s', time() - 100 * 86400));
    t_set_timestamp($env['db'], $recent, gmdate('Y-m-d H:i:s', time() - 86400));

    $disabled = [];
    for ($i = 0; $i < 50; ++$i) {
        $disabled[] = telemetryRetentionSweep(0);
    }
    t_eq(array_unique($disabled, SORT_REGULAR), [false], 'retention 0 is always a no-op');

    $skipped = 0;
    $swept = false;
    for ($i = 0; $i < 500; ++$i) {
        $result = telemetryRetentionSweep(90);
        if (false === $result) {
            ++$skipped;
            continue;
        }
        $swept = $result;
        break;
    }
    t_check(false !== $swept, 'retention(90) actually sweeps within 500 calls (1 in 50 gate)');
    t_eq($swept, 1, 'the sweep deleted exactly the expired row');
    t_eq(countSpeedtestUsers([]), 1, 'the recent row survived');
    t_eq(countSpeedtestUsers(['client_id' => '9999999999992222']), 1, 'the surviving row is the recent one');
    t_check($skipped < 500, 'at least one call was allowed to run');

    t_finish('retention', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// case: validators
// ---------------------------------------------------------------------------
function case_validators()
{
    $env = t_boot('validators');
    t_check(getPdo() instanceof PDO, 'schema ready');

    t_eq(telemetryIsValidClientId('abcd1234'), true, 'valid minimum length client id');
    t_eq(telemetryIsValidClientId(str_repeat('a', 64)), true, 'valid maximum length client id');
    t_eq(telemetryIsValidClientId('a-b_c-D_9'), true, 'valid alphabet for client id');
    t_eq(telemetryIsValidClientId('abc123'), false, 'too short client id rejected');
    t_eq(telemetryIsValidClientId(str_repeat('a', 65)), false, 'too long client id rejected');
    t_eq(telemetryIsValidClientId('abc 1234'), false, 'space rejected');
    t_eq(telemetryIsValidClientId('abc/1234'), false, 'slash rejected');
    t_eq(telemetryIsValidClientId(''), false, 'empty client id rejected');
    t_eq(telemetryIsValidClientId(null), false, 'null client id rejected');
    t_eq(telemetryIsValidClientId(['abc12345']), false, 'array client id rejected');

    t_eq(telemetryNormalizeParams('{"time_dl_max":"12"}'), '{"time_dl_max":"12"}', 'valid params object accepted');
    t_eq(telemetryNormalizeParams('{}'), '{}', 'empty params object accepted');
    t_eq(telemetryNormalizeParams('[1,2]'), null, 'JSON array rejected');
    t_eq(telemetryNormalizeParams('"text"'), null, 'JSON scalar rejected');
    t_eq(telemetryNormalizeParams('{not json'), null, 'malformed JSON rejected');
    t_eq(telemetryNormalizeParams(''), null, 'empty params rejected');
    t_eq(telemetryNormalizeParams(null), null, 'null params rejected');
    t_eq(telemetryNormalizeParams(str_repeat('a', 4097)), null, 'oversized params rejected');
    t_check(null !== telemetryNormalizeParams('{"a":"'.str_repeat('b', 4080).'"}'), 'params of exactly 4096 bytes accepted');

    t_eq(telemetryClampText('short', 100), 'short', 'clamp leaves short text alone');
    $clamped = telemetryClampText('aaaa'.'€€', 6);
    t_check(strlen($clamped) <= 6, 'clamp respects the byte budget');
    t_check(mb_check_encoding($clamped, 'UTF-8'), 'clamp does not split a multibyte character');
    t_eq(strlen(telemetryClampText(str_repeat('x', 100), 32)), 32, 'clamp truncates to the byte budget');

    // Backwards compatibility with the pre-change signature: the 11th
    // argument is $returnExceptionOnError, as sanitycheck.php still calls it.
    $legacyId = insertSpeedtestUser('10.3.3.1', '', '', 'UA', 'en', '1', '1', '1', '1', 'log', true);
    t_check(!($legacyId instanceof Exception) && false !== $legacyId, 'legacy 11-argument call still inserts');
    $legacyRow = getSpeedtestUserById($legacyId);
    t_check(null === $legacyRow['client_id'], 'legacy boolean 11th argument is not stored as client_id');

    $explicit = insertSpeedtestUser('10.3.3.2', '', '', 'UA', 'en', '1', '1', '1', '1', 'log', 'legacyflag1111', null, true);
    t_check(!($explicit instanceof Exception) && false !== $explicit, 'new 13-argument call still inserts');
    t_eq(getSpeedtestUserById($explicit)['client_id'], 'legacyflag1111', 'client_id is stored for the 13-argument call');

    // A second sandbox with an unusable database: the error reporting paths.
    $dir2 = t_tmp('validators-broken');
    t_write_settings($dir2, $dir2.'/missing/app.db');
    chdir($dir2);
    set_include_path($dir2.PATH_SEPARATOR.get_include_path());
    t_eq(getPdo(), false, 'getPdo fails when the sqlite directory is missing');
    t_check(insertSpeedtestUser('1.1.1.1', '', '', 'UA', 'en', '1', '1', '1', '1', 'log', true) instanceof Exception, 'insert returns an Exception when asked (legacy signature)');
    t_check(insertSpeedtestUser('1.1.1.1', '', '', 'UA', 'en', '1', '1', '1', '1', 'log', null, null, true) instanceof Exception, 'insert returns an Exception when asked (new signature)');
    t_eq(insertSpeedtestUser('1.1.1.1', '', '', 'UA', 'en', '1', '1', '1', '1', 'log'), false, 'insert returns false by default on failure');

    t_finish('validators', t_failures() > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------
$case = isset($argv[1]) ? (string) $argv[1] : '';

if ('' !== $case) {
    $function = 'case_'.$case;
    if (!function_exists($function)) {
        fwrite(STDERR, 'unknown case: '.$case."\n");
        exit(2);
    }
    $function();
    exit(0);
}

echo "LibreSpeedex telemetry harness\n";
echo 'php: '.PHP_VERSION."\n";
foreach (['telemetry_db.php', 'telemetry_guard.php', 'telemetry.php', 'mine.php', 'admin_api.php'] as $file) {
    echo 'sha256 '.hash_file('sha256', t_repoResults().'/'.$file).'  results/'.$file."\n";
}
echo "\n";

$failed = [];
foreach ($cases as $current) {
    echo "================================================================\n";
    echo 'case: '.$current."\n";
    echo "================================================================\n";
    $command = escapeshellarg(PHP_BINARY).' '.escapeshellarg(__FILE__).' '.escapeshellarg($current);
    passthru($command, $exitCode);
    if (0 !== $exitCode) {
        $failed[] = $current;
    }
    echo "\n";
}

if (empty($failed)) {
    echo "ALL CASES PASSED (".count($cases)." cases)\n";
    exit(0);
}

echo 'FAILED CASES: '.implode(', ', $failed)."\n";
exit(1);
