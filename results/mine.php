<?php

/**
 * Per-client result list for LibreSpeedex.
 *
 * GET only, no session: the anonymous client_id stored in the browser is the
 * only credential. Only rows belonging to that client id are ever returned,
 * and the log/user-agent are never exposed here.
 */

error_reporting(0);

require_once 'telemetry_db.php';
require_once 'telemetry_guard.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/**
 * @param int   $status
 * @param array $payload
 *
 * @return void
 */
function mineRespond($status, array $payload)
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * @return string
 */
function mineClientIp()
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
 * Shape one row for the list response. log and ua are deliberately dropped.
 *
 * @param array $row
 *
 * @return array
 */
function mineShapeRow(array $row)
{
    $params = null;
    if (isset($row['params']) && is_string($row['params']) && '' !== $row['params']) {
        $decoded = json_decode($row['params']);
        if (is_object($decoded)) {
            $params = $decoded;
        }
    }

    return [
        'id' => (string) $row['id'],
        'id_formatted' => isset($row['id_formatted']) ? (string) $row['id_formatted'] : (string) $row['id'],
        'timestamp' => isset($row['timestamp']) ? (string) $row['timestamp'] : '',
        'dl' => isset($row['dl']) ? (string) $row['dl'] : '',
        'ul' => isset($row['ul']) ? (string) $row['ul'] : '',
        'ping' => isset($row['ping']) ? (string) $row['ping'] : '',
        'jitter' => isset($row['jitter']) ? (string) $row['jitter'] : '',
        'ip' => isset($row['ip']) ? (string) $row['ip'] : '',
        'isp' => telemetryIspLabel(isset($row['ispinfo']) ? $row['ispinfo'] : ''),
        'params' => $params,
    ];
}

$clientId = isset($_GET['client_id']) ? $_GET['client_id'] : null;
if (!telemetryIsValidClientId($clientId)) {
    mineRespond(400, ['error' => 'invalid_client_id']);
}
$clientId = (string) $clientId;

// 120 requests per hour per IP.
if (!telemetryRateLimit('mine:ip:'.mineClientIp().':'.intdiv(time(), 3600), 120, 3600)) {
    mineRespond(429, ['error' => 'rate_limited']);
}

$limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 25;
if ($limit < 1) {
    $limit = 25;
}
if ($limit > 100) {
    $limit = 100;
}
$offset = isset($_GET['offset']) ? (int) $_GET['offset'] : 0;
if ($offset < 0) {
    $offset = 0;
}

$total = countSpeedtestUsers(['client_id' => $clientId]);

// Single result: only when it belongs to the requesting client id.
if (isset($_GET['id']) && '' !== (string) $_GET['id']) {
    $rows = getSpeedtestUsersFiltered(['client_id' => $clientId, 'id' => (int) $_GET['id']], 1, 0);
    if (!is_array($rows) || empty($rows)) {
        mineRespond(404, ['error' => 'not_found']);
    }

    mineRespond(200, ['total' => $total, 'results' => [mineShapeRow($rows[0])]]);
}

$rows = getSpeedtestUsersByClientId($clientId, $limit, $offset);
if (!is_array($rows)) {
    mineRespond(500, ['error' => 'db_error']);
}

$results = [];
foreach ($rows as $row) {
    $results[] = mineShapeRow($row);
}

mineRespond(200, ['total' => $total, 'results' => $results]);
