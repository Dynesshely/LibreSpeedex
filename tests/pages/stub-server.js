/**
 * Static file server for the repo, plus stubs for the two PHP endpoints the
 * records and admin pages talk to.
 *
 * It exists so those two pages can be loaded, driven and photographed without a
 * PHP runtime: the real endpoints live behind Docker, and a page that only ever
 * gets looked at in production is a page nobody tests. The stub is not shipped
 * and not authoritative — it answers the shapes documented in doc.md, and if it
 * ever disagrees with results/admin_api.php the PHP is right.
 *
 *   node tests/pages/stub-server.js [port]
 *
 * Env:
 *   ADMIN_CONFIGURED=0  -> op=session reports configured:false
 *   STALE_CSRF=1        -> the first state changing call fails with bad_csrf,
 *                          to exercise the "re-read the session and retry once"
 *                          path of the admin page.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = Number(process.argv[2] || process.env.PORT || 18210);
const CONFIGURED = process.env.ADMIN_CONFIGURED !== "0";
const STALE_CSRF = process.env.STALE_CSRF === "1";
const CSRF = "9f3c1d7ab24e05c6";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

/* --------------------------------------------------------------- fixtures */

let seed = 20260214;
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function between(low, high, digits) {
  return (low + random() * (high - low)).toFixed(digits === undefined ? 2 : digits);
}

const ISPS = [
  { processedString: "Some ISP (NL) - 3 km", rawISPInfo: "AS12345 Some ISP B.V., NL" },
  { processedString: "Fibre House (DE) - 12 km", rawISPInfo: "AS54321 Fibre House GmbH, DE" },
  { processedString: "Cable Co (FR) - 41 km", rawISPInfo: "AS9999 Cable Co SA, FR" },
  { processedString: "Mobile Net (NL) - 1 km", rawISPInfo: "AS4242 Mobile Net B.V., NL" }
];

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/140.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
];

function paramsFor() {
  return {
    time_dl_max: String(Math.round(10 + random() * 5)),
    xhr_dlMultistream: String(4 + Math.round(random() * 4)),
    time_ul_max: String(Math.round(8 + random() * 4)),
    xhr_ulMultistream: String(3 + Math.round(random() * 4)),
    dl_max: between(120, 900, 0),
    ul_max: between(60, 500, 0),
    count_dl: String(Math.round(20 + random() * 20)),
    count_ul: String(Math.round(15 + random() * 15)),
    telemetry_level: "full"
  };
}

function isoDay(daysAgo) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  const month = ("0" + (date.getMonth() + 1)).slice(-2);
  const day = ("0" + date.getDate()).slice(-2);
  return date.getFullYear() + "-" + month + "-" + day;
}

function stamp(daysAgo, hour, minute, second) {
  return (
    isoDay(daysAgo) + " " + ("0" + hour).slice(-2) + ":" + ("0" + minute).slice(-2) + ":" + ("0" + second).slice(-2)
  );
}

/* The records page belongs to one browser. This stub id owns a slice of the
   same table, so both pages show consistent data. */
const CLIENT_ID = "b3f1a2c4d5e6f7a8";

/* One database, shared by both endpoints, so deleting in the admin panel
   really does remove the row from the records page. */
const DB = (function () {
  const rows = [];
  for (let index = 0; index < 240; index += 1) {
    const daysAgo = Math.floor((index / 240) * 29);
    const isp = ISPS[Math.floor(random() * ISPS.length)];
    const ispinfo =
      random() < 0.75
        ? JSON.stringify({
            processedString: isp.processedString,
            rawISPInfo: isp.rawISPInfo,
            rawISPInfoBare: isp.rawISPInfo,
            ip: "10.0." + (20 + Math.floor(random() * 40)) + "." + (2 + Math.floor(random() * 200))
          })
        : "Unknown ISP, raw backend blob that never parsed as JSON, " + isp.rawISPInfo;
    rows.push({
      id: String(4000 - index),
      id_formatted: String(4000 - index),
      timestamp: stamp(
        daysAgo,
        daysAgo === 0 ? Math.floor(random() * 3) : 6 + Math.floor(random() * 16),
        Math.floor(random() * 60),
        Math.floor(random() * 60)
      ),
      ip: "10.0." + (20 + Math.floor(random() * 40)) + "." + (2 + Math.floor(random() * 200)),
      ispinfo: ispinfo,
      ua: UAS[Math.floor(random() * UAS.length)],
      lang: ["en-US", "nl-NL", "de-DE", "fr-FR"][Math.floor(random() * 4)],
      dl: between(18, 940),
      ul: between(4, 480),
      ping: between(2.4, 46),
      jitter: between(0.2, 9.4),
      extra: random() < 0.4 ? JSON.stringify({ client_version: "6.3.0", server: "stub" }) : "",
      client_id: index % 7 === 0 ? CLIENT_ID : random() < 0.1 ? "" : "9c0d1e2f3a4b5c6d",
      params: JSON.stringify(paramsFor()),
      log:
        "GET /garbage.php?ckSize=100 200 41ms\n" +
        "GET /garbage.php?ckSize=100 200 38ms\n" +
        "GET /empty.php 200 12ms\n" +
        "POST /empty.php 200 14ms\n" +
        "GET /garbage.php?ckSize=100 200 44ms\n"
    });
  }
  return rows;
})();

function mineRows() {
  return DB.filter(function (row) {
    return row.client_id === CLIENT_ID;
  });
}

function publicRow(row) {
  return {
    id: row.id,
    id_formatted: row.id_formatted,
    timestamp: row.timestamp,
    dl: row.dl,
    ul: row.ul,
    ping: row.ping,
    jitter: row.jitter,
    ip: row.ip,
    isp: ispString(row.ispinfo),
    params: JSON.parse(row.params)
  };
}

function ispString(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.processedString) return parsed.processedString;
  } catch (error) {
    /* not JSON: fall through to the first chunk of the blob */
  }
  return String(raw).slice(0, 60);
}

function perDay() {
  const days = {};
  DB.forEach(function (row) {
    const date = row.timestamp.slice(0, 10);
    if (!days[date]) days[date] = { date: date, count: 0, dl: 0, ul: 0 };
    days[date].count += 1;
    days[date].dl += Number(row.dl);
    days[date].ul += Number(row.ul);
  });
  return Object.keys(days)
    .sort()
    .map(function (date) {
      return {
        date: date,
        count: days[date].count,
        dl_avg: Number((days[date].dl / days[date].count).toFixed(2)),
        ul_avg: Number((days[date].ul / days[date].count).toFixed(2))
      };
    });
}

/* ----------------------------------------------------------------- helpers */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (chunk) {
      data += chunk;
    });
    req.on("end", function () {
      resolve(data);
    });
  });
}

function isLogged(req) {
  return String(req.headers.cookie || "").indexOf("adminsession=1") !== -1;
}

let staleCsrfUsed = false;

function csrfOk(req) {
  if (STALE_CSRF && !staleCsrfUsed) {
    staleCsrfUsed = true;
    return false;
  }
  return req.headers["x-csrf-token"] === CSRF;
}

/* ------------------------------------------------------------- mine.php */

function serveMine(req, res, query) {
  const clientId = query.client_id || "";
  if (!clientId) {
    json(res, 400, { error: "invalid_client_id" });
    return;
  }
  if (clientId === "rate-limited") {
    json(res, 429, { error: "rate_limited" });
    return;
  }

  const rows = mineRows();
  if (query.id) {
    const found = rows.filter(function (row) {
      return String(row.id) === String(query.id);
    });
    if (!found.length) {
      json(res, 404, { error: "not_found" });
      return;
    }
    json(res, 200, { total: 1, results: found.map(publicRow) });
    return;
  }

  const limit = Math.min(Number(query.limit) || 25, 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const page = rows.slice(offset, offset + limit).map(publicRow);
  json(res, 200, { total: rows.length, results: page });
}

/* --------------------------------------------------------- admin_api.php */

function matchesFilters(row, query) {
  if (query.from && row.timestamp.slice(0, 10) < query.from) return false;
  if (query.to && row.timestamp.slice(0, 10) > query.to) return false;
  if (query.min_dl && Number(row.dl) < Number(query.min_dl)) return false;
  if (query.min_ul && Number(row.ul) < Number(query.min_ul)) return false;
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    const haystack = [row.ip, row.ispinfo, row.ua, row.client_id, row.id, row.id_formatted].join(" ").toLowerCase();
    if (haystack.indexOf(needle) === -1) return false;
  }
  return true;
}

function sortRows(rows, order) {
  const sorted = rows.slice();
  if (order === "oldest") sorted.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  else if (order === "dl") sorted.sort((a, b) => Number(b.dl) - Number(a.dl));
  else if (order === "ul") sorted.sort((a, b) => Number(b.ul) - Number(a.ul));
  else sorted.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  return sorted;
}

function adminRow(row) {
  return {
    id: row.id,
    id_formatted: row.id_formatted,
    timestamp: row.timestamp,
    ip: row.ip,
    ispinfo: row.ispinfo,
    ua: row.ua,
    lang: row.lang,
    dl: row.dl,
    ul: row.ul,
    ping: row.ping,
    jitter: row.jitter,
    extra: row.extra,
    client_id: row.client_id,
    params: row.params
  };
}

async function serveAdmin(req, res, query) {
  const op = query.op || "session";

  if (op === "session") {
    json(
      res,
      200,
      isLogged(req)
        ? { logged: true, configured: CONFIGURED, csrf: CSRF }
        : { logged: false, configured: CONFIGURED, csrf: null }
    );
    return;
  }

  if (op === "login") {
    const body = new url.URLSearchParams(await readBody(req));
    if (!CONFIGURED) {
      json(res, 401, { error: "bad_password" });
      return;
    }
    if (body.get("password") !== "librespeed") {
      json(res, 401, { error: "bad_password" });
      return;
    }
    res.setHeader("Set-Cookie", "adminsession=1; Path=/; HttpOnly; SameSite=Lax");
    json(res, 200, { logged: true, csrf: CSRF });
    return;
  }

  if (!isLogged(req)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (op === "logout") {
    if (!csrfOk(req)) {
      json(res, 403, { error: "bad_csrf" });
      return;
    }
    res.setHeader("Set-Cookie", "adminsession=; Path=/; Max-Age=0");
    json(res, 200, { logged: false });
    return;
  }

  if (op === "list") {
    const rows = sortRows(
      DB.filter(function (row) {
        return matchesFilters(row, query);
      }),
      query.order
    );
    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;
    json(res, 200, {
      rows: rows.slice(offset, offset + limit).map(adminRow),
      total: rows.length,
      limit: limit,
      offset: offset
    });
    return;
  }

  if (op === "detail") {
    const found = DB.filter(function (row) {
      return String(row.id) === String(query.id);
    })[0];
    if (!found) {
      json(res, 404, { error: "not_found" });
      return;
    }
    const detailed = adminRow(found);
    detailed.log = found.log;
    json(res, 200, detailed);
    return;
  }

  if (op === "stats") {
    const days = perDay();
    const numbers = function (key) {
      return DB.map(function (row) {
        return Number(row[key]);
      }).filter(function (value) {
        return isFinite(value);
      });
    };
    const avg = function (values) {
      return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;
    };
    const dl = numbers("dl");
    const ul = numbers("ul");
    const clients = {};
    DB.forEach(function (row) {
      if (row.client_id) clients[row.client_id] = true;
    });
    const isps = {};
    DB.forEach(function (row) {
      const name = ispString(row.ispinfo);
      isps[name] = (isps[name] || 0) + 1;
    });
    json(res, 200, {
      total: DB.length,
      unique_clients: Object.keys(clients).length,
      dl_avg: avg(dl),
      dl_max: Math.max.apply(null, dl),
      ul_avg: avg(ul),
      ul_max: Math.max.apply(null, ul),
      ping_avg: avg(numbers("ping")),
      jitter_avg: avg(numbers("jitter")),
      per_day: days,
      top_isp: Object.keys(isps)
        .map(function (name) {
          return { isp: name, count: isps[name] };
        })
        .sort(function (a, b) {
          return b.count - a.count;
        })
        .slice(0, 5)
    });
    return;
  }

  if (op === "export") {
    const rows = sortRows(
      DB.filter(function (row) {
        return matchesFilters(row, query);
      }),
      query.order
    );
    const header = "id,timestamp,ip,dl,ul,ping,jitter,client_id\n";
    const csv = rows
      .map(function (row) {
        return [row.id, row.timestamp, row.ip, row.dl, row.ul, row.ping, row.jitter, row.client_id].join(",");
      })
      .join("\n");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="librespeedex-results.csv"',
      "Cache-Control": "no-store"
    });
    res.end(header + csv);
    return;
  }

  if (op === "delete" || op === "purge") {
    if (!csrfOk(req)) {
      json(res, 403, { error: "bad_csrf" });
      return;
    }
    const body = new url.URLSearchParams(await readBody(req));
    let removed = 0;
    if (op === "delete") {
      const id = body.get("id");
      for (let index = DB.length - 1; index >= 0; index -= 1) {
        if (String(DB[index].id) === String(id)) {
          DB.splice(index, 1);
          removed += 1;
        }
      }
    } else if (body.get("all") === "1") {
      removed = DB.length;
      DB.length = 0;
    } else {
      const before = body.get("before") || "";
      for (let index = DB.length - 1; index >= 0; index -= 1) {
        if (DB[index].timestamp.slice(0, 10) < before) {
          DB.splice(index, 1);
          removed += 1;
        }
      }
    }
    json(res, 200, { deleted: removed });
    return;
  }

  json(res, 400, { error: "unknown_op" });
}

/* ------------------------------------------------------------ static files */

function serveStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative || "index.html");

  if (target.indexOf(ROOT) !== 0) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(target, function (error, data) {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found: " + relative);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": data.length
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------- serve */

const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);
  const query = parsed.query;

  if (parsed.pathname === "/results/mine.php") {
    serveMine(req, res, query);
    return;
  }
  if (parsed.pathname === "/results/admin_api.php") {
    serveAdmin(req, res, query).catch(function (error) {
      json(res, 500, { error: "stub_failure", message: String(error) });
    });
    return;
  }
  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, "127.0.0.1", function () {
  console.log(
    "stub on http://127.0.0.1:" + PORT + " configured=" + CONFIGURED + " staleCsrf=" + STALE_CSRF + " rows=" + DB.length
  );
});
