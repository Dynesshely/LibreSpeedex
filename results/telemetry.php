<?php

require 'telemetry_settings.php';
require_once 'telemetry_db.php';
require_once 'telemetry_guard.php';
require_once '../backend/getIP_util.php';

$ip = getClientIp();
// The stored IP may be redacted below, but the rate limit must always use the
// real client address: with $redact_ip_addresses every request would otherwise
// share the "0.0.0.0" bucket.
$clientIp = $ip;

$ispinfo = isset($_POST['ispinfo']) ? (string) $_POST['ispinfo'] : '';
$extra = isset($_POST['extra']) ? (string) $_POST['extra'] : '';
$ua = isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : '';
$lang = '';
if (isset($_SERVER['HTTP_ACCEPT_LANGUAGE'])) {
    $lang = (string) $_SERVER['HTTP_ACCEPT_LANGUAGE'];
}
$dl = isset($_POST['dl']) ? (string) $_POST['dl'] : '';
$ul = isset($_POST['ul']) ? (string) $_POST['ul'] : '';
$ping = isset($_POST['ping']) ? (string) $_POST['ping'] : '';
$jitter = isset($_POST['jitter']) ? (string) $_POST['jitter'] : '';
$log = isset($_POST['log']) ? (string) $_POST['log'] : '';

// Anonymous browser client id: optional, and ignored when malformed.
$clientId = isset($_POST['client_id']) ? $_POST['client_id'] : null;
if (!telemetryIsValidClientId($clientId)) {
    $clientId = null;
} else {
    $clientId = (string) $clientId;
}

// JSON snapshot of the measurement parameters: optional, must be a JSON object.
$params = telemetryNormalizeParams(isset($_POST['params']) ? $_POST['params'] : null);

// Clamp the payloads before they reach the database.
$ispinfo = telemetryClampText($ispinfo, 8192);
$extra = telemetryClampText($extra, 1024);
$ua = telemetryClampText($ua, 512);
$lang = telemetryClampText($lang, 128);
$log = telemetryClampText($log, 32768);

if (isset($redact_ip_addresses) && true === $redact_ip_addresses) {
    $ip = '0.0.0.0';
    $ipv4_regex = '/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/';
    $ipv6_regex = '/(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/';
    $hostname_regex = '/"hostname":"([^\\\\"]|\\\\")*"/';
    $ispinfo = preg_replace($ipv4_regex, '0.0.0.0', $ispinfo);
    $ispinfo = preg_replace($ipv6_regex, '0.0.0.0', $ispinfo);
    $ispinfo = preg_replace($hostname_regex, '"hostname":"REDACTED"', $ispinfo);
    $log = preg_replace($ipv4_regex, '0.0.0.0', $log);
    $log = preg_replace($ipv6_regex, '0.0.0.0', $log);
    $log = preg_replace($hostname_regex, '"hostname":"REDACTED"', $log);
}

// Rate limits. The key carries the current UTC hour so that a key is only ever
// used within one window; 0 (or a missing setting) disables the limit.
$rateLimitPerClient = isset($telemetry_rate_limit_writes_per_hour) ? (int) $telemetry_rate_limit_writes_per_hour : 60;
$rateLimitPerIp = isset($telemetry_rate_limit_writes_per_hour_ip) ? (int) $telemetry_rate_limit_writes_per_hour_ip : 240;
$rateWindow = gmdate('Y-m-d-H');

if (
    null !== $clientId
    && !telemetryRateLimit('telemetry:client:'.$clientId.':'.$rateWindow, $rateLimitPerClient, 3600)
) {
    http_response_code(429);
    echo 'rate_limited';
    exit;
}

if (!telemetryRateLimit('telemetry:ip:'.$clientIp.':'.$rateWindow, $rateLimitPerIp, 3600)) {
    http_response_code(429);
    echo 'rate_limited';
    exit;
}

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');

$id = insertSpeedtestUser($ip, $ispinfo, $extra, $ua, $lang, $dl, $ul, $ping, $jitter, $log, $clientId, $params);
if (false === $id) {
    exit(1);
}

// Opportunistic retention: usually a no-op, actually sweeps ~1 in 50 calls.
$retentionDays = isset($telemetry_retention_days) ? (int) $telemetry_retention_days : 0;
telemetryRetentionSweep($retentionDays);

echo 'id '.$id;
