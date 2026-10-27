<?php

/*
 * What the server is willing to say about itself.
 *
 * The frontend already knows the address the visitor dialled — that is
 * location.host, and it needs no help from us. What it cannot know is what the
 * server looks like from the inside, which is the interesting half: whether the
 * address in the URL bar is the machine's own interface (a LAN install), a
 * forwarded port (the routers address), or a container behind both.
 *
 * Nothing here is secret from someone who can already reach the port, but the
 * interface address does describe the network topology, so it can be withheld
 * with $server_info_expose_interface = false in backend_settings.php.
 */

require_once __DIR__ . '/backend_settings.php';
require_once __DIR__ . '/getIP_util.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');

// A frontend-only deployment asks the node it selected, which may live on
// another origin. It has to ask for that explicitly, like the other backend
// files, so a page cannot quietly read a node's topology behind its back.
if (isset($_GET['cors'])) {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET');
}

/**
 * The node name as the frontend knows it, so the panel can label the same node
 * the server thinks it is.
 *
 * @return string
 */
function readNodeName()
{
    static $name = null;

    if ($name !== null) {
        return $name;
    }

    $name = '';
    $listFile = __DIR__ . '/../server-list.json';
    if (is_readable($listFile)) {
        $list = json_decode(file_get_contents($listFile), true);
        if (is_array($list) && isset($list[0]['name']) && is_string($list[0]['name'])) {
            $name = $list[0]['name'];
        }
    }

    return $name;
}

/**
 * The address the rest of the internet sees this machine as. Cached, because it
 * costs an outbound request and the answer changes about never.
 *
 * @return string|null
 */
function lookupPublicIp()
{
    if (empty($GLOBALS['server_info_public_ip'])) {
        return null;
    }

    $ttl = isset($GLOBALS['server_info_public_ip_ttl']) ? (int) $GLOBALS['server_info_public_ip_ttl'] : 3600;
    $cacheFile = sys_get_temp_dir() . '/librespeedex_server_public_ip.json';
    $cached = null;

    if (is_readable($cacheFile)) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if (
            is_array($cached)
            && isset($cached['ip'], $cached['at'])
            && is_string($cached['ip'])
            && (time() - (int) $cached['at']) < $ttl
        ) {
            return $cached['ip'];
        }
    }

    $url = isset($GLOBALS['server_info_public_ip_url'])
        ? (string) $GLOBALS['server_info_public_ip_url']
        : 'https://ipinfo.io/json';

    // A two second ceiling: this endpoint is called from the browser after the
    // page is usable, and a slow lookup must not hold anything up.
    $context = stream_context_create(['http' => ['timeout' => 2, 'method' => 'GET']]);
    $answer = @file_get_contents($url, false, $context);
    if (!is_string($answer)) {
        return is_array($cached) && isset($cached['ip']) && is_string($cached['ip']) ? $cached['ip'] : null;
    }

    $ip = trim($answer);
    if (!filter_var($ip, FILTER_VALIDATE_IP)) {
        // Some services answer JSON; try that before giving up.
        $json = json_decode($answer, true);
        $ip = is_array($json) && isset($json['ip']) && is_string($json['ip']) ? $json['ip'] : '';
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            return null;
        }
    }

    @file_put_contents($cacheFile, json_encode(['ip' => $ip, 'at' => time()]), LOCK_EX);

    return $ip;
}

$host = isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : '';
$hostName = $host;
$hostPort = '';

// Split "10.0.30.61:18100" and "[fe80::1]:8080" into their two halves.
if (preg_match('/^\[(.+)\]:(\d+)$/', $host, $m) === 1) {
    $hostName = $m[1];
    $hostPort = $m[2];
} elseif (substr_count($host, ':') === 1) {
    list($hostName, $hostPort) = explode(':', $host, 2);
}

$proto = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') ? 'https' : 'http';

$interface = null;
if (!empty($GLOBALS['server_info_expose_interface']) && !empty($_SERVER['SERVER_ADDR'])) {
    $interface = normalizeIpText((string) $_SERVER['SERVER_ADDR']);
}

$answer = [
    'node' => readNodeName(),
    // Exactly what the browser typed, including a hostname if that is how the
    // visitor arrived: the only address that is true by definition.
    'dialed' => $host,
    'host' => $hostName,
    'port' => $hostPort,
    'proto' => $proto,
    'interface' => $interface,
    'public' => lookupPublicIp(),
    'client' => getClientIp(),
];

echo json_encode($answer);
