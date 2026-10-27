<?php

/**
 * Small, dependency-free helpers shared by the telemetry endpoints:
 * rate limiting, opportunistic retention and payload validation.
 *
 * This file never opens a database connection and never sends output. Every
 * failure mode is fail-open: a broken cache directory must never block a
 * telemetry write.
 */

/**
 * Directory holding the rate limit counters and any other scratch data.
 *
 * Uses $telemetry_cache_dir when set, otherwise "<dir of $Sqlite_db_file>/cache".
 * The directory is created when needed; the caller decides what to do when it
 * is not usable.
 *
 * @return string
 */
function telemetryCacheDir()
{
    $settingsFile = defined('TELEMETRY_SETTINGS_FILE') ? TELEMETRY_SETTINGS_FILE : 'telemetry_settings.php';

    $cacheDir = '';
    $sqliteFile = '';
    if (is_readable($settingsFile)) {
        require $settingsFile;
        if (isset($telemetry_cache_dir)) {
            $cacheDir = trim((string) $telemetry_cache_dir);
        }
        if (isset($Sqlite_db_file)) {
            $sqliteFile = (string) $Sqlite_db_file;
        }
    }

    if ('' === $cacheDir) {
        $base = '' !== $sqliteFile ? dirname($sqliteFile) : sys_get_temp_dir();
        $cacheDir = rtrim($base, '/\\').DIRECTORY_SEPARATOR.'cache';
    }

    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0775, true);
    }

    return $cacheDir;
}

/**
 * Fixed window rate limit.
 *
 * Counter files live in telemetryCacheDir() and contain "windowStart:count".
 * Reading and writing is done under flock(LOCK_EX).
 *
 * Fail-open by design: if the cache directory cannot be used, or anything else
 * goes wrong, the call is allowed.
 *
 * @param string $key           identifies the bucket; include a window/day component so counters roll over naturally
 * @param int    $limit         allowed calls per window (<= 0 disables the limit)
 * @param int    $windowSeconds window length in seconds
 *
 * @return bool true when the call is allowed
 */
function telemetryRateLimit($key, $limit, $windowSeconds)
{
    $limit = (int) $limit;
    $windowSeconds = (int) $windowSeconds;

    if ($limit <= 0 || $windowSeconds <= 0) {
        return true;
    }

    try {
        $dir = telemetryCacheDir();
        if (!is_dir($dir) || !is_writable($dir)) {
            return true;
        }

        $file = $dir.DIRECTORY_SEPARATOR.'rl-'.substr(hash('sha256', (string) $key), 0, 32).'.txt';
        $handle = @fopen($file, 'c+');
        if (false === $handle) {
            return true;
        }
        if (!flock($handle, LOCK_EX)) {
            fclose($handle);

            return true;
        }

        $now = time();
        $windowStart = $now - ($now % $windowSeconds);
        $count = 0;

        $stored = (string) stream_get_contents($handle);
        $parts = explode(':', $stored);
        if (2 === count($parts) && ctype_digit($parts[0]) && ctype_digit($parts[1])) {
            if ((int) $parts[0] === $windowStart) {
                $count = (int) $parts[1];
            }
        }

        $allowed = $count < $limit;
        if ($allowed) {
            ++$count;
        }

        rewind($handle);
        ftruncate($handle, 0);
        fwrite($handle, $windowStart.':'.$count);
        fflush($handle);
        flock($handle, LOCK_UN);
        fclose($handle);

        telemetryRateLimitGc($dir, $windowSeconds);

        return $allowed;
    } catch (Throwable $e) {
        return true;
    }
}

/**
 * Drop counter files that have not been touched for two windows.
 *
 * @param string $dir
 * @param int    $windowSeconds
 *
 * @return void
 */
function telemetryRateLimitGc($dir, $windowSeconds)
{
    try {
        $threshold = time() - (2 * (int) $windowSeconds);
        $files = glob($dir.DIRECTORY_SEPARATOR.'rl-*.txt');
        if (!is_array($files)) {
            return;
        }
        foreach ($files as $file) {
            $mtime = @filemtime($file);
            if (false !== $mtime && $mtime < $threshold) {
                @unlink($file);
            }
        }
    } catch (Throwable $e) {
        // Best effort only.
    }
}

/**
 * Delete test results older than $days.
 *
 * Runs on roughly 1 in 50 calls so the cost is paid by nobody in particular.
 * Returns false when retention is disabled ($days <= 0) or when this call was
 * skipped.
 *
 * The database layer is loaded lazily: this file stays free of any database
 * work unless a sweep actually happens.
 *
 * @param int $days
 *
 * @return int|false deleted rows, or false when disabled/skipped/failed
 */
function telemetryRetentionSweep($days)
{
    $days = (int) $days;
    if ($days <= 0) {
        return false;
    }

    try {
        if (random_int(1, 50) !== 1) {
            return false;
        }

        if (!function_exists('purgeSpeedtestUsersBefore')) {
            $dbFile = __DIR__.DIRECTORY_SEPARATOR.'telemetry_db.php';
            if (!is_file($dbFile)) {
                return false;
            }
            require_once $dbFile;
        }

        if (!function_exists('purgeSpeedtestUsersBefore')) {
            return false;
        }

        $cutoff = gmdate('Y-m-d H:i:s', time() - ($days * 86400));

        return purgeSpeedtestUsersBefore($cutoff);
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * Validate an anonymous client id: 8 to 64 characters of [A-Za-z0-9_-].
 *
 * @param mixed $clientId
 *
 * @return bool
 */
function telemetryIsValidClientId($clientId)
{
    return is_string($clientId) && 1 === preg_match('/^[A-Za-z0-9_-]{8,64}$/', $clientId);
}

/**
 * Validate a measurement parameter snapshot.
 *
 * Must be a JSON object of at most 4096 bytes; anything else yields null.
 *
 * @param mixed $params
 *
 * @return string|null the validated raw JSON string, or null
 */
function telemetryNormalizeParams($params)
{
    if (!is_string($params) || '' === $params || strlen($params) > 4096) {
        return null;
    }

    $decoded = json_decode($params);
    if (!is_object($decoded)) {
        return null;
    }

    return $params;
}

/**
 * Byte-safe truncation of a submitted payload.
 *
 * @param mixed $value
 * @param int   $maxBytes
 *
 * @return string
 */
function telemetryClampText($value, $maxBytes)
{
    $text = (string) $value;
    $maxBytes = (int) $maxBytes;

    if ($maxBytes <= 0) {
        return '';
    }
    if (strlen($text) <= $maxBytes) {
        return $text;
    }
    if (function_exists('mb_strcut')) {
        return mb_strcut($text, 0, $maxBytes, 'UTF-8');
    }

    return substr($text, 0, $maxBytes);
}
