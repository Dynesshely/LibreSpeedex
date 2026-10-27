<?php

/**
 * JSON admin API for LibreSpeedex.
 *
 * Session authenticated with $stats_password from telemetry_settings.php.
 * Every state changing operation also requires the X-CSRF-Token header that
 * login (or op=session) hands out.
 */

error_reporting(0);

require 'telemetry_settings.php';
require_once 'telemetry_db.php';
require_once 'telemetry_guard.php';

// session_start() emits its own cache headers, so ours are set afterwards to
// keep the JSON responses on a strict no-store.
session_set_cookie_params(['httponly' => true, 'samesite' => 'Strict', 'path' => '/']);
session_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// The upstream placeholder must never work as a password.
$statsConfigured = isset($stats_password)
    && '' !== (string) $stats_password
    && 'PASSWORD' !== (string) $stats_password;

/**
 * @param int   $status
 * @param array $payload
 *
 * @return void
 */
function adminRespond($status, array $payload)
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * @param string $method
 *
 * @return void
 */
function adminRequireMethod($method)
{
    $actual = isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string) $_SERVER['REQUEST_METHOD']) : '';
    if ($actual !== $method) {
        adminRespond(405, ['error' => 'method_not_allowed']);
    }
}

/**
 * @return bool
 */
function adminIsLoggedIn()
{
    return !empty($_SESSION['logged']);
}

/**
 * @param bool $statsConfigured
 *
 * @return void
 */
function adminRequireAuth($statsConfigured)
{
    if (!$statsConfigured || !adminIsLoggedIn()) {
        adminRespond(401, ['error' => 'not_logged_in']);
    }
}

/**
 * @return void
 */
function adminRequireCsrf()
{
    $token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
    $expected = isset($_SESSION['csrf']) ? (string) $_SESSION['csrf'] : '';
    if ('' === $expected || !hash_equals($expected, $token)) {
        adminRespond(403, ['error' => 'bad_csrf']);
    }
}

/**
 * @return string
 */
function adminClientIp()
{
    if (!function_exists('getClientIp')) {
        $util = __DIR__.'/../backend/getIP_util.php';
        if (is_file($util)) {
            require_once $util;
        }
    }
    if (function_exists('getClientIp')) {
        return (string) getClientIp();
    }

    return isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
}

/**
 * @return array
 */
function adminParseFilters()
{
    $filters = [];

    foreach (['q', 'ip', 'from', 'to', 'order'] as $key) {
        if (isset($_GET[$key]) && '' !== trim((string) $_GET[$key])) {
            $filters[$key] = (string) $_GET[$key];
        }
    }

    foreach (['min_dl', 'min_ul'] as $key) {
        if (isset($_GET[$key]) && is_numeric($_GET[$key])) {
            $filters[$key] = (float) $_GET[$key];
        }
    }

    return $filters;
}

/**
 * @return int
 */
function adminParseLimit()
{
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
    if ($limit < 1) {
        $limit = 50;
    }
    if ($limit > 500) {
        $limit = 500;
    }

    return $limit;
}

/**
 * @return int
 */
function adminParseOffset()
{
    $offset = isset($_GET['offset']) ? (int) $_GET['offset'] : 0;

    return $offset < 0 ? 0 : $offset;
}

/**
 * @param array $row
 * @param bool  $includeLog
 *
 * @return array
 */
function adminShapeRow(array $row, $includeLog)
{
    $params = null;
    if (isset($row['params']) && is_string($row['params']) && '' !== $row['params']) {
        $decoded = json_decode($row['params']);
        if (is_object($decoded)) {
            $params = $decoded;
        }
    }

    $shaped = [
        'id' => (string) $row['id'],
        'id_formatted' => isset($row['id_formatted']) ? (string) $row['id_formatted'] : (string) $row['id'],
        'timestamp' => isset($row['timestamp']) ? (string) $row['timestamp'] : '',
        'ip' => isset($row['ip']) ? (string) $row['ip'] : '',
        'isp' => telemetryIspLabel(isset($row['ispinfo']) ? $row['ispinfo'] : ''),
        'ispinfo' => isset($row['ispinfo']) ? (string) $row['ispinfo'] : '',
        'ua' => isset($row['ua']) ? (string) $row['ua'] : '',
        'lang' => isset($row['lang']) ? (string) $row['lang'] : '',
        'dl' => isset($row['dl']) ? (string) $row['dl'] : '',
        'ul' => isset($row['ul']) ? (string) $row['ul'] : '',
        'ping' => isset($row['ping']) ? (string) $row['ping'] : '',
        'jitter' => isset($row['jitter']) ? (string) $row['jitter'] : '',
        'extra' => isset($row['extra']) ? (string) $row['extra'] : '',
        'client_id' => (isset($row['client_id']) && null !== $row['client_id']) ? (string) $row['client_id'] : null,
        'params' => $params,
    ];

    if ($includeLog) {
        $shaped['log'] = isset($row['log']) ? (string) $row['log'] : '';
    }

    return $shaped;
}

/**
 * @param array  $row
 * @param string $key
 *
 * @return string
 */
function adminCsvValue(array $row, $key)
{
    if (!isset($row[$key]) || null === $row[$key]) {
        return '';
    }

    return (string) $row[$key];
}

/**
 * @param string $date "YYYY-MM-DD"
 *
 * @return bool
 */
function adminIsValidDate($date)
{
    if (1 !== preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m)) {
        return false;
    }

    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
}

$op = isset($_GET['op']) ? (string) $_GET['op'] : '';

try {
    switch ($op) {
        case 'session':
            adminRequireMethod('GET');
            adminRespond(200, [
                'logged' => $statsConfigured && adminIsLoggedIn(),
                'configured' => $statsConfigured,
                'csrf' => ($statsConfigured && adminIsLoggedIn() && isset($_SESSION['csrf']))
                    ? (string) $_SESSION['csrf']
                    : null,
            ]);
            break;

        case 'login':
            adminRequireMethod('POST');
            if (!$statsConfigured) {
                adminRespond(401, ['error' => 'bad_password']);
            }

            // 10 attempts per 15 minutes per IP.
            if (!telemetryRateLimit('admin:login:'.adminClientIp().':'.intdiv(time(), 900), 10, 900)) {
                adminRespond(429, ['error' => 'rate_limited']);
            }

            $password = isset($_POST['password']) ? (string) $_POST['password'] : '';
            if (!hash_equals((string) $stats_password, $password)) {
                adminRespond(401, ['error' => 'bad_password']);
            }

            $_SESSION['logged'] = true;
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            adminRespond(200, ['logged' => true, 'csrf' => $_SESSION['csrf']]);
            break;

        case 'logout':
            adminRequireMethod('POST');
            adminRequireAuth($statsConfigured);
            adminRequireCsrf();
            $_SESSION['logged'] = false;
            unset($_SESSION['csrf']);
            adminRespond(200, ['logged' => false]);
            break;

        case 'list':
            adminRequireMethod('GET');
            adminRequireAuth($statsConfigured);

            $filters = adminParseFilters();
            $limit = adminParseLimit();
            $offset = adminParseOffset();
            $rows = getSpeedtestUsersFiltered($filters, $limit, $offset);
            if (!is_array($rows)) {
                adminRespond(500, ['error' => 'db_error']);
            }

            $shaped = [];
            foreach ($rows as $row) {
                $shaped[] = adminShapeRow($row, false);
            }
            adminRespond(200, [
                'rows' => $shaped,
                'total' => countSpeedtestUsers($filters),
                'limit' => $limit,
                'offset' => $offset,
            ]);
            break;

        case 'detail':
            adminRequireMethod('GET');
            adminRequireAuth($statsConfigured);

            $id = isset($_GET['id']) ? (string) $_GET['id'] : '';
            if ('' === $id) {
                adminRespond(400, ['error' => 'missing_id']);
            }

            // A numeric id is the raw row id; anything else is an obfuscated id.
            $row = getSpeedtestUserById($id, false, ctype_digit($id));
            if (false === $row) {
                adminRespond(500, ['error' => 'db_error']);
            }
            if (null === $row) {
                adminRespond(404, ['error' => 'not_found']);
            }
            adminRespond(200, adminShapeRow($row, true));
            break;

        case 'stats':
            adminRequireMethod('GET');
            adminRequireAuth($statsConfigured);

            $stats = getSpeedtestStats(adminParseFilters());
            if (!is_array($stats)) {
                adminRespond(500, ['error' => 'db_error']);
            }
            adminRespond(200, $stats);
            break;

        case 'delete':
            adminRequireMethod('POST');
            adminRequireAuth($statsConfigured);
            adminRequireCsrf();

            $id = isset($_POST['id']) ? (string) $_POST['id'] : '';
            if (!ctype_digit($id)) {
                adminRespond(400, ['error' => 'bad_id']);
            }

            $deleted = deleteSpeedtestUserById((int) $id);
            if (false === $deleted) {
                adminRespond(500, ['error' => 'db_error']);
            }
            adminRespond(200, ['deleted' => (int) $deleted]);
            break;

        case 'purge':
            adminRequireMethod('POST');
            adminRequireAuth($statsConfigured);
            adminRequireCsrf();

            if (isset($_POST['all']) && '1' === (string) $_POST['all']) {
                $deleted = purgeSpeedtestUsersAll();
            } else {
                $before = isset($_POST['before']) ? trim((string) $_POST['before']) : '';
                if (!adminIsValidDate($before)) {
                    adminRespond(400, ['error' => 'bad_before']);
                }
                $deleted = purgeSpeedtestUsersBefore($before.' 00:00:00');
            }

            if (false === $deleted) {
                adminRespond(500, ['error' => 'db_error']);
            }
            adminRespond(200, ['deleted' => (int) $deleted]);
            break;

        case 'export':
            adminRequireMethod('GET');
            adminRequireAuth($statsConfigured);

            $filters = adminParseFilters();
            $rows = getSpeedtestUsersFiltered($filters, adminParseLimit(), adminParseOffset());
            if (!is_array($rows)) {
                adminRespond(500, ['error' => 'db_error']);
            }

            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="librespeedex-results-'.gmdate('Ymd-Hi').'.csv"');

            $out = fopen('php://output', 'w');
            // The empty $escape argument gives strict RFC4180 quoting.
            fputcsv($out, ['id', 'timestamp', 'ip', 'dl', 'ul', 'ping', 'jitter', 'isp', 'client_id', 'params'], ',', '"', '');
            foreach ($rows as $row) {
                fputcsv($out, [
                    adminCsvValue($row, 'id'),
                    adminCsvValue($row, 'timestamp'),
                    adminCsvValue($row, 'ip'),
                    adminCsvValue($row, 'dl'),
                    adminCsvValue($row, 'ul'),
                    adminCsvValue($row, 'ping'),
                    adminCsvValue($row, 'jitter'),
                    telemetryIspLabel(isset($row['ispinfo']) ? $row['ispinfo'] : ''),
                    adminCsvValue($row, 'client_id'),
                    adminCsvValue($row, 'params'),
                ], ',', '"', '');
            }
            fclose($out);
            exit;

        default:
            adminRespond(400, ['error' => 'unknown_op']);
    }
} catch (Throwable $e) {
    adminRespond(500, ['error' => 'server_error']);
}
