<?php

/**
 * Shared helpers for the LibreSpeedex telemetry test harness.
 *
 * This file is included by the per-case child processes (see run.php) and by
 * the orchestrator. It must never include results/*.php itself: each case
 * boots the REAL results/telemetry_db.php from a sandbox working directory so
 * that telemetry_settings.php resolves to the case's test settings.
 *
 * Layout used by the harness:
 *
 *   .scratch/telemetry-test/
 *     run.php                 orchestrator + cases
 *     lib.php                 this file
 *     tmp/<case>/             fresh per case: telemetry_settings.php, app.db, cache/
 *
 * results/telemetry_db.php hardcodes TELEMETRY_SETTINGS_FILE =
 * 'telemetry_settings.php', and PHP resolves a relative include against
 * include_path first, then the CWD, then the including file's directory. So
 * chdir()ing into tmp/<case>/ (and putting that directory first on the
 * include_path) makes the case settings win, while 'idObfuscation.php' still
 * resolves from the real results/ directory next to telemetry_db.php.
 */

$GLOBALS['t_checks'] = 0;
$GLOBALS['t_failures'] = 0;

/**
 * @param bool   $condition
 * @param string $label
 * @param string $detail
 *
 * @return void
 */
function t_check($condition, $label, $detail = '')
{
    ++$GLOBALS['t_checks'];
    if ($condition) {
        echo '[PASS] '.$label."\n";
    } else {
        ++$GLOBALS['t_failures'];
        echo '[FAIL] '.$label.('' !== $detail ? ' -- '.$detail : '')."\n";
    }
}

/**
 * @param mixed  $actual
 * @param mixed  $expected
 * @param string $label
 *
 * @return void
 */
function t_eq($actual, $expected, $label)
{
    $ok = $actual === $expected;
    t_check($ok, $label, $ok ? '' : 'expected '.var_export($expected, true).', got '.var_export($actual, true));
}

/**
 * @param float  $actual
 * @param float  $expected
 * @param string $label
 * @param float  $epsilon
 *
 * @return void
 */
function t_approx($actual, $expected, $label, $epsilon = 0.000001)
{
    $ok = is_numeric($actual) && abs((float) $actual - (float) $expected) <= $epsilon;
    t_check($ok, $label, $ok ? '' : 'expected ~'.var_export($expected, true).', got '.var_export($actual, true));
}

/**
 * @return int
 */
function t_failures()
{
    return $GLOBALS['t_failures'];
}

/**
 * @return string absolute path of the real results/ directory
 */
function t_repoResults()
{
    return realpath(__DIR__.'/../../results');
}

/**
 * Fresh working directory for a case.
 *
 * @param string $case
 *
 * @return string
 */
function t_tmp($case)
{
    $dir = __DIR__.'/tmp/'.$case;
    t_rmdir($dir);
    mkdir($dir, 0777, true);

    return $dir;
}

/**
 * @param string $dir
 *
 * @return void
 */
function t_rmdir($dir)
{
    if (!is_dir($dir)) {
        return;
    }
    $items = scandir($dir);
    foreach ($items as $item) {
        if ('.' === $item || '..' === $item) {
            continue;
        }
        $path = $dir.'/'.$item;
        if (is_dir($path) && !is_link($path)) {
            t_rmdir($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

/**
 * Write the test telemetry_settings.php for a case.
 *
 * @param string $dir       case directory
 * @param string $dbFile    sqlite database file
 * @param array  $overrides variable name => PHP literal
 *
 * @return void
 */
function t_write_settings($dir, $dbFile, array $overrides = [])
{
    $variables = [
        'db_type' => "'sqlite'",
        'stats_password' => "'PASSWORD'",
        'enable_id_obfuscation' => 'false',
        'redact_ip_addresses' => 'false',
        'Sqlite_db_file' => var_export($dbFile, true),
        'telemetry_rate_limit_writes_per_hour' => '60',
        'telemetry_rate_limit_writes_per_hour_ip' => '240',
        'telemetry_retention_days' => '90',
        'telemetry_cache_dir' => var_export($dir.'/cache', true),
    ];

    foreach ($overrides as $name => $literal) {
        $variables[$name] = $literal;
    }

    $php = "<?php\n\n";
    foreach ($variables as $name => $literal) {
        $php .= '$'.$name.' = '.$literal.";\n";
    }
    file_put_contents($dir.'/telemetry_settings.php', $php);
}

/**
 * Boot the real telemetry sources against a case sandbox.
 *
 * @param string $case
 * @param array  $overrides settings overrides (variable name => PHP literal)
 *
 * @return array ['dir' => string, 'db' => string]
 */
function t_boot($case, array $overrides = [])
{
    $dir = t_tmp($case);
    $dbFile = $dir.'/app.db';
    t_write_settings($dir, $dbFile, $overrides);

    chdir($dir);
    set_include_path($dir.PATH_SEPARATOR.get_include_path());

    require_once t_repoResults().'/telemetry_db.php';
    require_once t_repoResults().'/telemetry_guard.php';

    echo 'sandbox: '.$dir."\n";
    echo 'settings: '.$dir.'/telemetry_settings.php'."\n";
    echo 'source: '.t_repoResults()."/telemetry_db.php (sha256 ".hash_file('sha256', t_repoResults().'/telemetry_db.php').")\n";

    return ['dir' => $dir, 'db' => $dbFile];
}

/**
 * Plain PDO handle used only to build fixtures / inspect the sqlite file.
 *
 * @param string $file
 *
 * @return PDO
 */
function t_sqlite($file)
{
    $pdo = new PDO('sqlite:'.$file);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    return $pdo;
}

/**
 * Create a database using the PRE-CHANGE schema and insert one legacy row.
 *
 * @param string $file
 *
 * @return int legacy row id
 */
function t_create_old_schema_db($file)
{
    $pdo = t_sqlite($file);
    $pdo->exec('
        CREATE TABLE `speedtest_users` (
        `id`        INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        `ispinfo`   text,
        `extra`     text,
        `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `ip`        text NOT NULL,
        `ua`        text NOT NULL,
        `lang`      text NOT NULL,
        `dl`        text,
        `ul`        text,
        `ping`      text,
        `jitter`    text,
        `log`       longtext
        );
    ');
    $stmt = $pdo->prepare(
        'INSERT INTO speedtest_users (ip,ispinfo,extra,ua,lang,dl,ul,ping,jitter,log)
         VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    $stmt->execute([
        '10.9.9.9',
        '{"processedString":"Legacy ISP (NL) - 3 km","hostname":"legacy.example"}',
        '{"legacy":true}',
        'LegacyUA/1.0',
        'en-US',
        '12.50',
        '3.25',
        '7.00',
        '0.75',
        'legacy log line',
    ]);

    return (int) $pdo->lastInsertId();
}

/**
 * @return string[]
 */
function t_column_names($dbFile)
{
    $pdo = t_sqlite($dbFile);
    $columns = [];
    foreach ($pdo->query('PRAGMA table_info(speedtest_users)')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $columns[] = $row['name'];
    }

    return $columns;
}

/**
 * @return string[]
 */
function t_index_names($dbFile)
{
    $pdo = t_sqlite($dbFile);
    $indexes = [];
    foreach ($pdo->query('PRAGMA index_list(speedtest_users)')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $indexes[] = $row['name'];
    }

    return $indexes;
}

/**
 * Force a row's timestamp (the insert path always uses CURRENT_TIMESTAMP).
 *
 * @param string $dbFile
 * @param int    $id
 * @param string $timestamp "YYYY-MM-DD HH:MM:SS"
 *
 * @return void
 */
function t_set_timestamp($dbFile, $id, $timestamp)
{
    $pdo = t_sqlite($dbFile);
    $stmt = $pdo->prepare('UPDATE speedtest_users SET timestamp = ? WHERE id = ?');
    $stmt->execute([$timestamp, $id]);
}

/**
 * @param string $case
 * @param int    $exitCode
 *
 * @return void
 */
function t_finish($case, $exitCode)
{
    echo "\n".($exitCode === 0 ? 'CASE '.$case.': ok' : 'CASE '.$case.': FAILED')."\n";
    exit($exitCode);
}
