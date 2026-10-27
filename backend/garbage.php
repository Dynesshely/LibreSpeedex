<?php

// Disable Compression
@ini_set('zlib.output_compression', 'Off');
@ini_set('output_buffering', 'Off');
@ini_set('output_handler', '');

require_once __DIR__ . '/backend_settings.php';
require_once __DIR__ . '/getIP_util.php';

/**
 * How many megabytes of random data to send for this request.
 *
 * The client asks (ckSize) and the server decides. The requested value is
 * honoured up to $garbage_max_chunk_mb, which is also the knob that keeps this
 * endpoint from being a free bandwidth amplifier: without a cap, one visitor
 * asking for ckSize=1024 across a handful of streams can pull several hundred
 * megabytes per test at the operator's expense.
 *
 * @param int $maxChunks
 *
 * @return int
 */
function getChunkCount($maxChunks)
{
    if (
        !array_key_exists('ckSize', $_GET)
        || !ctype_digit($_GET['ckSize'])
        || (int) $_GET['ckSize'] <= 0
    ) {
        return min(4, $maxChunks);
    }

    return min((int) $_GET['ckSize'], $maxChunks);
}

/**
 * Take one slot out of a fixed pool of locks.
 *
 * The pool is a directory of empty files that requests contend for with
 * flock(LOCK_EX|LOCK_NB). The kernel releases the lock when the process goes
 * away, so a stream that is aborted, times out, or kills the worker can never
 * leak a slot — which is the failure mode that makes counter-based limiters
 * unusable for a request that can last half a minute.
 *
 * @param string $dir    Slot directory.
 * @param string $prefix Pool name within the directory.
 * @param int    $count  Pool size.
 *
 * @return resource|false|null The held handle, false when the pool is full, or
 *                             null when the pool cannot be used at all (in
 *                             which case the caller serves the request
 *                             unthrottled rather than failing).
 */
function acquireSlot($dir, $prefix, $count)
{
    if ($count <= 0) {
        return null;
    }

    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        return null;
    }
    if (!is_writable($dir)) {
        return null;
    }

    // Per-address pools leave a handful of empty files behind for every address
    // that ever ran a test. A rare sweep keeps that from growing without bound;
    // ten minutes is far longer than any stream this endpoint serves, so a pool
    // old enough to be collected cannot still be held. A pool is removed whole,
    // never slot by slot, so its size never quietly shrinks.
    if (random_int(1, 50) === 1) {
        $pools = [];
        foreach ((array) @glob($dir . '/ip-*-*.lock') as $file) {
            $pool = preg_replace('/-\d+\.lock$/', '', basename($file));
            $pools[$pool] = max($pools[$pool] ?? 0, (int) @filemtime($file));
        }
        foreach ($pools as $pool => $newest) {
            if ($newest < time() - 600) {
                foreach ((array) @glob($dir . '/' . $pool . '-*.lock') as $file) {
                    @unlink($file);
                }
            }
        }
    }

    for ($i = 0; $i < $count; $i++) {
        $handle = @fopen($dir . '/' . $prefix . '-' . $i . '.lock', 'c');
        if ($handle === false) {
            return null;
        }
        if (@flock($handle, LOCK_EX | LOCK_NB)) {
            return $handle;
        }
        @fclose($handle);
    }

    return false;
}

/**
 * @return void
 */
function sendBusyResponse()
{
    header('HTTP/1.1 503 Service Unavailable');
    header('Content-Type: text/plain; charset=utf-8');
    header('Retry-After: 2');
    header('Cache-Control: no-store');
    echo "Too many concurrent transfers on this server. Try again in a moment.\n";
}

// Acquire the transfer slots before any data is generated. A refused request
// costs the server nothing, which is the whole point of refusing early.
$slotsDir = sys_get_temp_dir() . '/librespeedex-garbage-slots';
$clientIp = getClientIp();

$heldSlots = [];
$globalSlot = acquireSlot($slotsDir, 'global', (int) $GLOBALS['garbage_max_concurrent']);
if ($globalSlot === false) {
    sendBusyResponse();
    exit;
}
if (is_resource($globalSlot)) {
    $heldSlots[] = $globalSlot;
}

$ipSlot = acquireSlot($slotsDir, 'ip-' . substr(sha1($clientIp), 0, 24), (int) $GLOBALS['garbage_max_concurrent_per_ip']);
if ($ipSlot === false) {
    sendBusyResponse();
    exit;
}
if (is_resource($ipSlot)) {
    $heldSlots[] = $ipSlot;
}

/**
 * @return void
 */
function sendHeaders()
{
    header('HTTP/1.1 200 OK');

    if (isset($_GET['cors'])) {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST');
    }

    // Indicate a file download
    header('Content-Description: File Transfer');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename=random.dat');
    header('Content-Transfer-Encoding: binary');

    // Cache settings: never cache this request
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
    header('Cache-Control: post-check=0, pre-check=0', false);
    header('Pragma: no-cache');
}

// Determine how much data we should send
$chunks = getChunkCount((int) $GLOBALS['garbage_max_chunk_mb']);

// Generate data. Random bytes are incompressible, so a transparent proxy
// cannot quietly shrink the test by compressing the stream.
$data = openssl_random_pseudo_bytes(1048576);

// Deliver chunks of 1048576 bytes
sendHeaders();
for ($i = 0; $i < $chunks; $i++) {
    echo $data;
    flush();
}

// Hold the slots until the response is fully written; PHP would release them at
// shutdown anyway, this just makes the intent explicit.
foreach ($heldSlots as $slot) {
    @flock($slot, LOCK_UN);
    @fclose($slot);
}
