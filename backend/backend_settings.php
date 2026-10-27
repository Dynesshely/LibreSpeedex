<?php

/*
 * Backend policy: who is allowed to speak for the client, how much traffic a
 * single test may pull, and what the server is willing to say about itself.
 *
 * Every value here has a safe default, so the file works as committed. The
 * Docker entrypoint rewrites the assignments below from environment variables
 * (TRUSTED_PROXIES, GARBAGE_MAX_CHUNK_MB, GARBAGE_MAX_CONCURRENT,
 * GARBAGE_MAX_CONCURRENT_PER_IP, SERVER_INFO_*), which is why each one is a
 * single plain assignment on its own line.
 */

/*
 * Forwarding headers (X-Forwarded-For, X-Real-IP, Client-IP, CF-Connecting-IP)
 * are only believed when the request actually arrives from one of these
 * addresses. Anything else is a client claiming to be someone else, so its
 * REMOTE_ADDR is used instead.
 *
 * Entries are plain addresses or CIDR blocks, IPv4 or IPv6. The special entry
 * '*' trusts every peer, which is only reasonable behind a reverse proxy that
 * rewrites REMOTE_ADDR to the proxy itself.
 */
$trusted_proxies = ['127.0.0.1', '::1'];

/*
 * Upper bound on a single garbage.php response, in megabytes. The client asks
 * for a chunk count (ckSize); this is the ceiling the server will honour. The
 * engine's own default is 100MB per stream.
 */
$garbage_max_chunk_mb = 256;

/*
 * Concurrent download streams the server will serve. Each request holds a slot
 * for its whole lifetime, so the limits also bound how much bandwidth one
 * visitor (or one script) can pin down at once. Set either to 0 to disable that
 * limiter.
 */
$garbage_max_concurrent = 64;
$garbage_max_concurrent_per_ip = 16;

/*
 * Whether backend/serverInfo.php may report the interface address it was
 * reached on ($_SERVER['SERVER_ADDR']). Behind Docker that is the container's
 * private address, which is worth showing on a LAN install and worth hiding on
 * a public one.
 */
$server_info_expose_interface = true;

/*
 * Whether the server may look up its own public egress address, and for how
 * long the answer is cached in seconds. The lookup leaves the machine, so it
 * can be turned off entirely.
 */
$server_info_public_ip = true;
$server_info_public_ip_ttl = 3600;
$server_info_public_ip_url = 'https://ipinfo.io/json';
