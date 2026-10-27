<?php

/**
 * Normalize and validate an IP address candidate from a request header.
 *
 * Trims whitespace, takes the first comma-separated token (for XFF-like
 * headers that may contain a chain of addresses), and validates the result
 * with filter_var().
 *
 * @param string $raw       Raw header value.
 * @param int    $extraFlags Additional FILTER_FLAG_* flags (e.g. FILTER_FLAG_IPV6).
 *
 * @return string|false The validated IP string, or false on failure.
 */
function normalizeCandidateIp($raw, $extraFlags = 0)
{
    $ip = trim($raw);
    // For XFF-like values, take the first address before a comma.
    if (($pos = strpos($ip, ',')) !== false) {
        $ip = trim(substr($ip, 0, $pos));
    }
    if ($ip === '') {
        return false;
    }
    return filter_var($ip, FILTER_VALIDATE_IP, $extraFlags);
}

/**
 * Drop the IPv4-mapped IPv6 prefix so "::ffff:10.0.0.1" and "10.0.0.1"
 * compare as the same address.
 *
 * @param string $ip
 *
 * @return string
 */
function normalizeIpText($ip)
{
    return preg_replace('/^::ffff:/', '', $ip);
}

/**
 * @return array List of trusted proxy addresses / CIDR blocks.
 */
function getTrustedProxies()
{
    static $proxies = null;

    if ($proxies === null) {
        $proxies = [];
        $settingsFile = __DIR__ . '/backend_settings.php';
        if (is_readable($settingsFile)) {
            require $settingsFile;
            if (isset($trusted_proxies) && is_array($trusted_proxies)) {
                $proxies = $trusted_proxies;
            }
        }
    }

    return $proxies;
}

/**
 * @param string $ip   Address to test.
 * @param string $rule Address or CIDR block, or '*'.
 *
 * @return bool
 */
function ipMatchesRule($ip, $rule)
{
    $rule = trim($rule);
    if ($rule === '') {
        return false;
    }
    if ($rule === '*') {
        return true;
    }

    $ipBinary = @inet_pton($ip);
    if ($ipBinary === false) {
        return false;
    }

    if (strpos($rule, '/') === false) {
        $ruleBinary = @inet_pton($rule);
        return $ruleBinary !== false && $ruleBinary === $ipBinary;
    }

    list($network, $bits) = explode('/', $rule, 2);
    if (!ctype_digit($bits)) {
        return false;
    }
    $networkBinary = @inet_pton($network);
    if ($networkBinary === false || strlen($networkBinary) !== strlen($ipBinary)) {
        return false;
    }

    $bits = (int) $bits;
    $maxBits = strlen($ipBinary) * 8;
    if ($bits < 0 || $bits > $maxBits) {
        return false;
    }

    $wholeBytes = intdiv($bits, 8);
    $remainingBits = $bits % 8;

    if ($wholeBytes > 0 && substr($ipBinary, 0, $wholeBytes) !== substr($networkBinary, 0, $wholeBytes)) {
        return false;
    }
    if ($remainingBits === 0) {
        return true;
    }

    $mask = 0xFF << (8 - $remainingBits) & 0xFF;
    return (ord($ipBinary[$wholeBytes]) & $mask) === (ord($networkBinary[$wholeBytes]) & $mask);
}

/**
 * @param string $ip
 *
 * @return bool
 */
function isTrustedProxy($ip)
{
    if ($ip === '') {
        return false;
    }
    foreach (getTrustedProxies() as $rule) {
        if (!is_string($rule)) {
            continue;
        }
        if (ipMatchesRule($ip, $rule)) {
            return true;
        }
    }

    return false;
}

/**
 * The client address, from the only source that cannot be forged: the peer the
 * web server actually accepted the connection from.
 *
 * Forwarding headers are honoured only when that peer is a configured trusted
 * proxy (see backend_settings.php). Believing them unconditionally, as this
 * function used to, let any visitor pick their own address — which matters now
 * that the address identifies a visitor's records.
 *
 * @return string
 */
function getClientIp()
{
    $remote = normalizeCandidateIp($_SERVER['REMOTE_ADDR'] ?? '');
    if ($remote === false) {
        return $_SERVER['REMOTE_ADDR'] ?? '';
    }
    $remote = normalizeIpText($remote);

    if (!isTrustedProxy($remote)) {
        return $remote;
    }

    // Cloudflare's header first: it carries the real client for IPv6 tunnels.
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IPV6'])) {
        $ip = normalizeCandidateIp($_SERVER['HTTP_CF_CONNECTING_IPV6'], FILTER_FLAG_IPV6);
        if ($ip !== false) {
            return normalizeIpText($ip);
        }
    }
    foreach (['HTTP_CLIENT_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR'] as $header) {
        if (!empty($_SERVER[$header])) {
            $ip = normalizeCandidateIp($_SERVER[$header]);
            if ($ip !== false) {
                return normalizeIpText($ip);
            }
        }
    }

    return $remote;
}
