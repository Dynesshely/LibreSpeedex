# Page harness

The records page and the admin panel talk to PHP endpoints that only exist
inside the container. This directory is what lets them be loaded, driven and
photographed without a PHP runtime — a page that is only ever looked at in
production is a page nobody tests.

```sh
node tests/pages/stub-server.js 18210          # repo files + both endpoints
ADMIN_CONFIGURED=0 node tests/pages/stub-server.js 18211
node tests/pages/shot.js                       # photographs both pages
node tests/pages/probe.js                      # table widths, scroll frames, section heads
STALE_CSRF=1 node tests/pages/stub-server.js 18210   # then: node tests/pages/csrf-probe.js
```

| File | What it does |
|---|---|
| `stub-server.js` | Serves the repository and answers `results/mine.php` and `results/admin_api.php` with the shapes documented in [doc.md](../../doc.md). `ADMIN_CONFIGURED=0` exercises the "no admin password set" gate; `STALE_CSRF=1` makes the first state-changing call fail with `bad_csrf`. |
| `shot.js` | Loads both pages at a desktop and a phone width, photographs them, and fails loudly on page errors. |
| `probe.js` | Measures what a screenshot only suggests: how wide each table wants to be, whether the frames scroll at each width, and what the section heads say. |
| `csrf-probe.js` | Drives the `bad_csrf` path, where the page has to re-read the session and replay the request once. |

The stub is **not authoritative**. It mirrors `results/admin_api.php` and
`results/mine.php`; when the two disagree, the PHP is right and the stub is the
bug. Its fixtures are synthetic, so it is also useless as a check that the real
database layer works — that is what [`tests/telemetry/`](../telemetry/) is for.
