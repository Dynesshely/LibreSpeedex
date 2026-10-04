/**
 * The admin panel.
 *
 * `op=session` is the only request that runs before login; it also hands out the
 * CSRF token every state changing call has to repeat back. From there:
 *
 *   - a 401 anywhere drops the page back to the gate,
 *   - a 403 `bad_csrf` re-reads the session and replays the call once,
 *   - nothing else is retried: the server's answer is shown as it came.
 *
 * The panel is built out of textContent and createElement only. Everything it
 * displays (ua, ispinfo, log, params) is data the server received from clients,
 * so none of it is ever treated as markup.
 */
(function () {
  "use strict";

  const ENDPOINT = "admin_api.php";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const PURGE_WORD = "PURGE";
  const NOTE_KINDS = ["is-idle", "is-busy", "is-warn", "is-error", "is-ready"];

  /* The chart: 30 days, four horizontal grid lines, and a 4 css pixel grid the
     bars and the step line are snapped to (same chunky look as the realtime
     plot). */
  const CHART = { days: 30, padTop: 14, padRight: 52, padBottom: 28, padLeft: 46, quant: 4, rows: 4 };

  /* Used until the stylesheet is live, and if a variable ever reads empty: an
     invalid fillStyle is silently ignored and the canvas would paint black. */
  const FALLBACK = { accent: "107,161,245", muted: "141,148,158" };

  const state = {
    logged: false,
    configured: true,
    csrf: null,
    rows: [],
    total: 0,
    offset: 0,
    limit: 50,
    stats: null,
    selectedId: null,
    confirmDeleteId: null,
    resizeHandle: null
  };

  /* ---------------------------------------------------------------- helpers */

  function byId(id) {
    return document.getElementById(id);
  }

  function show(element) {
    element.hidden = false;
  }

  function hide(element) {
    element.hidden = true;
  }

  function setText(id, text) {
    byId(id).textContent = text;
  }

  function node(tag, options) {
    const element = document.createElement(tag);
    const opts = options || {};
    if (opts.className) element.className = opts.className;
    if (opts.text !== undefined && opts.text !== null) element.textContent = String(opts.text);
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (name) {
        element.setAttribute(name, opts.attrs[name]);
      });
    }
    return element;
  }

  function cell(text, className) {
    return node("td", { className: className, text: text });
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  /* The same precision ladder the stability and records pages use, so a number
     reads the same way everywhere: two decimals below 10, one below 100, none
     above. */
  function fmt(value) {
    const number = Number(value);
    if (value === null || value === undefined || value === "" || !isFinite(number)) return "--";
    if (number < 10) return number.toFixed(2);
    if (number < 100) return number.toFixed(1);
    return number.toFixed(0);
  }

  function fmtInt(value) {
    const number = Number(value);
    if (value === null || value === undefined || !isFinite(number)) return "--";
    return String(Math.round(number));
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  function parseJsonish(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (text.charAt(0) !== "{" && text.charAt(0) !== "[") return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  /* `ispinfo` is whatever the backend stored, often a raw JSON blob. The table
     gets one readable line; the detail panel gets the whole thing. */
  function ispShort(raw) {
    if (!raw) return "--";
    const parsed = parseJsonish(raw);
    if (parsed && !Array.isArray(parsed) && typeof parsed.processedString === "string" && parsed.processedString) {
      return parsed.processedString;
    }
    return truncate(String(raw).replace(/\s+/g, " ").trim(), 120);
  }

  function valueText(value) {
    if (value === null || value === undefined || value === "") return "--";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function setHeader(text) {
    setText("header-status", text);
  }

  /* ------------------------------------------------------------------ notes */

  function setNoteKind(element, kind) {
    NOTE_KINDS.forEach(function (name) {
      element.classList.remove(name);
    });
    element.classList.add("is-" + kind);
  }

  function fillNote(element, kind, title, text, retry) {
    setNoteKind(element, kind);
    const titleNode = element.querySelector(".note-title");
    const textNode = element.querySelector(".note-text");
    if (titleNode) titleNode.textContent = title ? title + " " : "";
    if (textNode) textNode.textContent = text || "";
    const button = element.querySelector("button");
    if (button) button.hidden = !retry;
    show(element);
  }

  function setListNote(kind, title, text, retry) {
    fillNote(byId("list-note"), kind, title, text, retry);
  }

  function setActionNote(kind, title, text) {
    fillNote(byId("action-note"), kind, title, text, false);
  }

  function setResultNote(noteId, textId, kind, title, text) {
    const element = byId(noteId);
    setNoteKind(element, kind);
    const titleNode = element.querySelector(".note-title");
    if (titleNode) titleNode.textContent = title ? title + " " : "";
    setText(textId, text || "");
    show(element);
  }

  function showLoginError(text) {
    setText("login-error-text", text);
    show(byId("login-error"));
  }

  /* ---------------------------------------------------------------- protocol */

  function buildUrl(op, params) {
    let url = ENDPOINT + "?op=" + encodeURIComponent(op);
    if (params) {
      Object.keys(params).forEach(function (key) {
        const value = params[key];
        if (value === null || value === undefined || value === "") return;
        url += "&" + encodeURIComponent(key) + "=" + encodeURIComponent(value);
      });
    }
    return url;
  }

  function request(op, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const init = {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    };
    if (method === "POST") {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (opts.csrf) init.headers["X-CSRF-Token"] = state.csrf || "";
      init.body = new URLSearchParams(opts.body || {}).toString();
    }
    return fetch(buildUrl(op, opts.params), init).then(function (response) {
      return response.json().then(
        function (body) {
          return { status: response.status, data: body };
        },
        function () {
          return { status: response.status, data: null };
        }
      );
    });
  }

  /* Every call behind the session goes through here. Returns null when the page
     has already been sent back to the gate or has reported the failure, so
     callers only have to deal with real answers. */
  function api(op, options) {
    const opts = Object.assign({}, options);
    return request(op, opts).then(
      function (response) {
        const error = response.data && response.data.error;
        if (response.status === 401 || (response.status === 403 && error === "unauthorized")) {
          requireLogin("The session ended. Log in again to continue.");
          return null;
        }
        if (response.status === 403 && error === "bad_csrf") {
          if (opts.retried) {
            setActionNote("error", "request refused", "The server rejected the CSRF token twice.");
            return null;
          }
          return readSession().then(function () {
            opts.retried = true;
            return api(op, opts);
          });
        }
        return response;
      },
      function () {
        setActionNote("error", "server unreachable", "The request to " + ENDPOINT + " did not complete.");
        return null;
      }
    );
  }

  function readSession() {
    return request("session").then(
      function (response) {
        if (response.status === 200 && response.data) applySession(response.data);
        return response;
      },
      function () {
        return null;
      }
    );
  }

  function applySession(data) {
    state.configured = data.configured !== false;
    state.logged = data.logged === true;
    state.csrf = data.csrf || null;
  }

  /* ------------------------------------------------------------- the gate */

  function renderGate(mode, reason) {
    const note = byId("gate-note");
    const form = byId("login-form");

    if (mode === "logged") {
      hide(byId("gate"));
      show(byId("panel"));
      return;
    }

    show(byId("gate"));
    hide(byId("panel"));
    hide(byId("login-error"));

    if (mode === "busy") {
      fillNote(note, "busy", "", "Checking whether this browser already has a session.", false);
      hide(form);
      setText("gate-state", "checking");
      setHeader("checking session");
      return;
    }

    if (mode === "noconfig") {
      fillNote(
        note,
        "warn",
        "admin is not configured on this server.",
        "No admin password is set, so there is nothing to log in with. Set one on the server, then reload this page.",
        false
      );
      hide(form);
      setText("gate-state", "not configured");
      setHeader("admin not configured");
      return;
    }

    /* mode === "login" */
    if (reason) fillNote(note, "warn", "", reason, false);
    else hide(note);
    show(form);
    setText("gate-state", "signed out");
    setHeader("not logged in");
    setText("session-readout", "not logged in");
    state.logged = false;
    byId("password").value = "";
  }

  function requireLogin(reason) {
    state.csrf = null;
    renderGate("login", reason);
  }

  function enterPanel() {
    renderGate("logged");
    setText("session-readout", state.csrf ? "logged in · csrf armed" : "logged in · no csrf token");
    setHeader("session active");
    fillNote(byId("list-note"), "busy", "loading records", "Reading the first page.", false);
    updateExport();
    loadStats();
    loadList();
  }

  /* -------------------------------------------------------------- the list */

  function listParams() {
    return {
      q: byId("f-q").value.trim(),
      from: byId("f-from").value,
      to: byId("f-to").value,
      min_dl: byId("f-min-dl").value,
      min_ul: byId("f-min-ul").value,
      order: byId("f-order").value
    };
  }

  function updateExport() {
    const params = listParams();
    byId("export").href = buildUrl("export", params);
  }

  function loadList() {
    setListNote("busy", "loading records", "Reading " + state.limit + " records from offset " + state.offset + ".");
    const params = listParams();
    params.limit = byId("f-limit").value;
    params.offset = state.offset;

    return api("list", { params: params }).then(function (response) {
      if (!response) return;
      if (response.status !== 200 || !response.data || !Array.isArray(response.data.rows)) {
        setListNote(
          "error",
          "could not load the list",
          "The server answered with status " + response.status + ".",
          true
        );
        hide(byId("pager"));
        return;
      }
      const data = response.data;
      state.rows = data.rows;
      state.total = typeof data.total === "number" ? data.total : data.rows.length;
      state.limit = typeof data.limit === "number" && data.limit > 0 ? data.limit : state.limit;
      state.offset = typeof data.offset === "number" && data.offset >= 0 ? data.offset : state.offset;
      state.confirmDeleteId = null;
      renderList();
    });
  }

  function renderList() {
    renderRows();
    renderPager();

    if (!state.rows.length) {
      hide(byId("records-frame"));
      setText("list-range", "0 of " + state.total);
      setText("pager-range", "");
      hide(byId("pager"));
      setListNote("idle", "no records match", "Nothing in the table matches these filters.", false);
      return;
    }

    show(byId("records-frame"));
    hide(byId("list-note"));
  }

  function renderPager() {
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.rows.length, state.total);
    const range = "showing " + from + "–" + to + " of " + state.total;

    setText("list-range", range);
    setText("pager-range", range);
    byId("page-prev").disabled = state.offset <= 0;
    byId("page-next").disabled = state.offset + state.rows.length >= state.total;
    if (state.total > 0) show(byId("pager"));
    else hide(byId("pager"));
  }

  function buildRow(row) {
    const id = String(row.id);
    const line = node("tr", { className: state.selectedId === id ? "is-open" : "" });
    line.dataset.id = id;

    line.appendChild(cell(row.timestamp || "--"));
    line.appendChild(cell(row.ip || "--"));
    line.appendChild(cell(fmt(row.dl), "num v-dl"));
    line.appendChild(cell(fmt(row.ul), "num v-ul"));
    line.appendChild(cell(fmt(row.ping), "num"));
    line.appendChild(cell(fmt(row.jitter), "num"));

    const isp = node("td", { className: "dim" });
    isp.appendChild(
      node("span", {
        className: "trunc",
        text: ispShort(row.ispinfo),
        attrs: { title: row.ispinfo ? String(row.ispinfo) : "no isp information" }
      })
    );
    line.appendChild(isp);

    const client = node("td", { className: "dim" });
    client.appendChild(
      node("span", {
        className: "trunc trunc-client",
        text: row.client_id || "anonymous",
        attrs: { title: row.client_id || "no client id stored" }
      })
    );
    line.appendChild(client);

    const actions = node("td");
    const group = node("div", { className: "row-actions" });
    group.appendChild(
      node("button", { className: "btn btn-small", text: "detail", attrs: { type: "button", "data-action": "detail" } })
    );
    group.appendChild(
      node("button", {
        className: "btn btn-small btn-bad",
        text: "delete",
        attrs: { type: "button", "data-action": "delete" }
      })
    );
    actions.appendChild(group);
    line.appendChild(actions);
    return line;
  }

  /* A confirm step, not a modal: the question names the record, and the answer
     is the next click. */
  function buildConfirmRow(row) {
    const line = node("tr", { className: "confirm-row" });
    /* The id is repeated here on purpose: the buttons in this row have to be
       able to name the record they are about, exactly like the row above. */
    line.dataset.id = String(row.id);
    line.dataset.confirm = "1";
    const box = node("td", { attrs: { colspan: "9" } });
    box.appendChild(
      document.createTextNode(
        "Delete test #" +
          (row.id_formatted || row.id) +
          " recorded " +
          (row.timestamp || "at an unknown time") +
          " from " +
          (row.ip || "an unknown address") +
          "? The server will not keep a copy."
      )
    );
    const actions = node("div", { className: "btn-row" });
    actions.appendChild(
      node("button", {
        className: "btn btn-small btn-bad",
        text: "delete this record",
        attrs: { type: "button", "data-action": "delete-confirm" }
      })
    );
    actions.appendChild(
      node("button", {
        className: "btn btn-small",
        text: "cancel",
        attrs: { type: "button", "data-action": "delete-cancel" }
      })
    );
    box.appendChild(actions);
    line.appendChild(box);
    return line;
  }

  function renderRows() {
    const body = byId("records-body");
    clear(body);
    state.rows.forEach(function (row) {
      body.appendChild(buildRow(row));
      if (state.confirmDeleteId === String(row.id)) body.appendChild(buildConfirmRow(row));
    });
  }

  function rowFromElement(element, root) {
    let current = element;
    while (current && current !== root) {
      if (current.tagName === "TR" && current.dataset.id) return current.dataset.id;
      current = current.parentNode;
    }
    return null;
  }

  function actionFromEvent(event) {
    let element = event.target;
    while (element && element !== event.currentTarget) {
      if (element.tagName === "BUTTON" && element.dataset.action) return element;
      element = element.parentNode;
    }
    return null;
  }

  function onRecordsClick(event) {
    const button = actionFromEvent(event);
    if (!button) return;
    const id = rowFromElement(button, event.currentTarget);
    if (!id) return;

    switch (button.dataset.action) {
      case "detail":
        openDetail(id);
        break;
      case "delete":
        state.confirmDeleteId = id;
        renderRows();
        break;
      case "delete-cancel":
        state.confirmDeleteId = null;
        renderRows();
        break;
      case "delete-confirm":
        deleteRow(id);
        break;
      default:
        break;
    }
  }

  function deleteRow(id) {
    setActionNote("busy", "deleting", "Asking the server to remove record #" + id + ".");
    api("delete", { method: "POST", csrf: true, body: { id: id } }).then(function (response) {
      if (!response) return;
      if (response.status === 200 && response.data && typeof response.data.deleted === "number") {
        const deleted = response.data.deleted;
        state.confirmDeleteId = null;
        if (state.selectedId === id) closeDetail();
        setActionNote("ready", "record deleted", deleted + (deleted === 1 ? " row removed." : " rows removed."));
        loadList();
        loadStats();
        return;
      }
      setActionNote("error", "delete failed", "The server answered with status " + response.status + ".");
    });
  }

  /* --------------------------------------------------------------- details */

  function closeDetail() {
    state.selectedId = null;
    hide(byId("detail"));
    renderRows();
  }

  function paramRow(key, value, wide) {
    const line = node("div", { className: "param" + (wide ? " is-wide" : "") });
    line.appendChild(node("dt", { className: "param-label", text: key }));
    line.appendChild(node("dd", { className: "param-value", text: valueText(value) }));
    return line;
  }

  function openDetail(id) {
    state.selectedId = id;
    setText("detail-title", "record #" + id);
    setText("detail-note", "reading record");
    clear(byId("detail-fields"));
    clear(byId("detail-params"));
    byId("detail-log").textContent = "";
    show(byId("detail"));
    renderRows();

    api("detail", { params: { id: id } }).then(function (response) {
      if (state.selectedId !== id) return;
      if (!response || response.status !== 200 || !response.data) {
        setText("detail-note", "The server did not return this record.");
        return;
      }
      const row = response.data.row || response.data;
      if (!row || row.id === undefined) {
        setText("detail-note", "The server did not return this record.");
        return;
      }
      renderDetail(row);
    });
  }

  function renderDetail(row) {
    setText("detail-title", "record #" + (row.id_formatted || row.id) + " · " + (row.timestamp || "unknown time"));

    const fields = byId("detail-fields");
    clear(fields);
    ["id", "id_formatted", "timestamp", "ip", "client_id", "dl", "ul", "ping", "jitter"].forEach(function (key) {
      if (row[key] === undefined || row[key] === null || row[key] === "") return;
      if (key === "dl" || key === "ul") fields.appendChild(paramRow(key, fmt(row[key]) + " mbit/s"));
      else if (key === "ping" || key === "jitter") fields.appendChild(paramRow(key, fmt(row[key]) + " ms"));
      else fields.appendChild(paramRow(key, row[key]));
    });
    /* The two blobs and the user agent are the long fields: they get the full
       width of the snapshot. */
    ["ispinfo", "ua", "lang", "extra"].forEach(function (key) {
      if (row[key] === undefined || row[key] === null || row[key] === "") return;
      fields.appendChild(paramRow(key, row[key], key !== "lang"));
    });

    /* Anything the server sends that this page has not heard of is still shown:
       a field the admin cannot see is a field the admin cannot trust. */
    Object.keys(row).forEach(function (key) {
      if (key === "log" || key === "params" || key === "ispinfo" || key === "ua" || key === "lang" || key === "extra")
        return;
      if (["id", "id_formatted", "timestamp", "ip", "client_id", "dl", "ul", "ping", "jitter"].indexOf(key) !== -1)
        return;
      fields.appendChild(paramRow(key, row[key]));
    });

    const params = byId("detail-params");
    clear(params);
    const decoded = typeof row.params === "object" && row.params !== null ? row.params : parseJsonish(row.params);
    if (decoded && typeof decoded === "object") {
      Object.keys(decoded)
        .sort()
        .forEach(function (key) {
          params.appendChild(paramRow(key, decoded[key]));
        });
    } else if (row.params) {
      params.appendChild(paramRow("params", row.params));
    } else {
      params.appendChild(paramRow("params", "not recorded for this run"));
    }

    byId("detail-log").textContent = row.log ? String(row.log) : "no log stored for this run";
    setText("detail-note", "");
  }

  /* ----------------------------------------------------------- statistics */

  function loadStats() {
    return api("stats").then(function (response) {
      if (!response || response.status !== 200 || !response.data) return;
      state.stats = response.data;
      renderStats();
    });
  }

  function renderStats() {
    const stats = state.stats;
    setText("kpi-total", fmtInt(stats.total));
    setText("kpi-clients", fmtInt(stats.unique_clients));
    setText("kpi-dl-avg", fmt(stats.dl_avg));
    setText("kpi-dl-max", fmt(stats.dl_max));
    setText("kpi-ul-avg", fmt(stats.ul_avg));
    setText("kpi-ul-max", fmt(stats.ul_max));
    setText("kpi-ping-avg", fmt(stats.ping_avg));
    setText("kpi-jitter-avg", fmt(stats.jitter_avg));

    const total = Number(stats.total) || 0;
    setText(
      "purge-all-count",
      total === 0 ? "There is nothing in the table right now." : "This deletes all " + fmtInt(total) + " records."
    );

    const perDay = Array.isArray(stats.per_day) ? stats.per_day : [];
    const busiest = perDay.reduce(
      function (best, day) {
        return Number(day.count) > Number(best.count) ? day : best;
      },
      { date: "", count: 0, dl_avg: 0 }
    );
    setText(
      "chart-readout",
      Number(busiest.count) > 0
        ? "busiest day " + busiest.date + " · " + fmtInt(busiest.count) + " tests"
        : "no tests in the last 30 days"
    );

    drawChart();
  }

  /* ----------------------------------------------------------------- chart */

  function palette() {
    const root = getComputedStyle(document.documentElement);
    function triplet(name) {
      const value = root.getPropertyValue(name).trim();
      return /^\d+\s+\d+\s+\d+$/.test(value) ? value.replace(/\s+/g, ",") : null;
    }
    const accent = triplet("--crt-accent") || FALLBACK.accent;
    const muted = triplet("--crt-muted") || FALLBACK.muted;
    return {
      bar: "rgba(" + muted + ",0.28)",
      barEdge: "rgba(" + muted + ",0.5)",
      grid: "rgba(" + muted + ",0.18)",
      label: "rgba(" + muted + ",0.95)",
      line: "rgba(" + accent + ",0.95)"
    };
  }

  function isoDate(date) {
    const month = ("0" + (date.getMonth() + 1)).slice(-2);
    const day = ("0" + date.getDate()).slice(-2);
    return date.getFullYear() + "-" + month + "-" + day;
  }

  /* The server only returns days that have rows; the plot always shows a full
     window, so the quiet days are part of the picture instead of being closed
     up. */
  function dayWindow(perDay, size) {
    const byDate = {};
    (perDay || []).forEach(function (day) {
      if (day && day.date) byDate[String(day.date).slice(0, 10)] = day;
    });
    const days = [];
    const today = new Date();
    for (let offset = size - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      const key = isoDate(date);
      const entry = byDate[key];
      days.push({
        date: key,
        count: entry ? Number(entry.count) || 0 : 0,
        dl: entry ? Number(entry.dl_avg) || 0 : 0
      });
    }
    return days;
  }

  function axisTop(value) {
    const magnitude = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    const scaled = value / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function drawChart() {
    const canvas = byId("stats-chart");
    if (!state.stats) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;
    /* Zero while the panel is hidden: wait for the layout that reveals it. */
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    const colors = palette();
    ctx.clearRect(0, 0, width, height);

    const days = dayWindow(state.stats.per_day, CHART.days);
    const padL = CHART.padLeft * dpr;
    const padR = width - CHART.padRight * dpr;
    const padT = CHART.padTop * dpr;
    const padB = height - CHART.padBottom * dpr;
    const plotW = padR - padL;
    const plotH = padB - padT;
    const quant = CHART.quant * dpr;
    const snap = function (value) {
      return Math.round(value / quant) * quant;
    };
    /* Tests are counted, so the left scale is always a whole number of tests:
       rounding the top up to a multiple of the four grid rows keeps the labels
       integers instead of 7.5 and 2.5. */
    const busiest = days.reduce(function (max, day) {
      return Math.max(max, day.count);
    }, 0);
    const countTop = Math.max(4, Math.ceil(busiest / CHART.rows) * CHART.rows);
    const dlTop = axisTop(
      Math.max(
        1,
        days.reduce(function (max, day) {
          return Math.max(max, day.dl);
        }, 0)
      )
    );

    ctx.font = 10 * dpr + "px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.lineWidth = dpr;

    /* grid + both scales */
    for (let row = 0; row <= CHART.rows; row += 1) {
      const y = snap(padB - (plotH * row) / CHART.rows);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padR, y);
      ctx.stroke();

      ctx.fillStyle = colors.label;
      ctx.textAlign = "right";
      ctx.fillText(fmtInt(Math.round((countTop * row) / CHART.rows)), padL - 6 * dpr, y);
      ctx.textAlign = "left";
      const throughput = Math.round((dlTop * row) / CHART.rows);
      ctx.fillText(throughput === 0 ? "0" : fmt(throughput), padR + 6 * dpr, y);
    }

    ctx.strokeStyle = colors.grid;
    ctx.strokeRect(padL, padT, plotW, plotH);

    /* bars: how many tests were run that day (volume, so the neutral ramp) */
    const slot = plotW / days.length;
    const barW = Math.max(quant, snap(slot * 0.52));
    days.forEach(function (day, index) {
      if (day.count <= 0) return;
      const x = snap(padL + slot * index + (slot - barW) / 2);
      const barH = Math.max(quant, snap((Math.min(day.count, countTop) / countTop) * plotH));
      ctx.fillStyle = colors.bar;
      ctx.fillRect(x, padB - barH, barW, barH);
      ctx.strokeStyle = colors.barEdge;
      ctx.strokeRect(x + 0.5 * dpr, padB - barH + 0.5 * dpr, barW - dpr, barH - dpr);
    });

    /* the step line: the measurement, so it takes the accent */
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    let drawing = false;
    let lastY = 0;
    days.forEach(function (day, index) {
      if (day.count <= 0 || day.dl <= 0) {
        drawing = false;
        return;
      }
      const x = snap(padL + slot * index + slot / 2);
      const y = snap(padB - (Math.min(day.dl, dlTop) / dlTop) * plotH);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, lastY);
        ctx.lineTo(x, y);
      }
      lastY = y;
    });
    ctx.stroke();

    /* x labels: every fifth day, plus the last one when it is far enough away */
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = colors.label;
    const every = 5;
    let lastLabel = -every;
    days.forEach(function (day, index) {
      const isLast = index === days.length - 1;
      if (index % every !== 0 && !isLast) return;
      if (isLast && index - lastLabel < 2) return;
      lastLabel = index;
      ctx.fillText(day.date.slice(5), padL + slot * index + slot / 2, padB + 6 * dpr);
    });

    if (
      !days.some(function (day) {
        return day.count > 0;
      })
    ) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = colors.label;
      ctx.fillText("no tests in the last 30 days", padL + plotW / 2, padT + plotH / 2);
    }
  }

  /* ------------------------------------------------------------------ wire */

  function applyFilters() {
    state.offset = 0;
    updateExport();
    loadList();
  }

  function resetFilters() {
    byId("f-q").value = "";
    byId("f-from").value = "";
    byId("f-to").value = "";
    byId("f-min-dl").value = "";
    byId("f-min-ul").value = "";
    byId("f-order").value = "newest";
    byId("f-limit").value = "50";
    applyFilters();
  }

  function runPurge(body, noteId, textId) {
    setResultNote(noteId, textId, "busy", "purging", "Waiting for the server to report how many rows it removed.");
    api("purge", { method: "POST", csrf: true, body: body }).then(function (response) {
      if (!response) return;
      if (response.status === 200 && response.data && typeof response.data.deleted === "number") {
        const deleted = response.data.deleted;
        setResultNote(
          noteId,
          textId,
          "ready",
          "purge complete.",
          deleted + (deleted === 1 ? " record" : " records") + " deleted."
        );
        byId("purge-before-confirm").value = "";
        byId("purge-all-confirm").value = "";
        state.confirmDeleteId = null;
        if (state.selectedId) closeDetail();
        loadList();
        loadStats();
        return;
      }
      setResultNote(
        noteId,
        textId,
        "error",
        "purge failed.",
        "The server answered with status " + response.status + "."
      );
    });
  }

  function onPurgeOlder() {
    const cutoff = byId("purge-before").value;
    const typed = byId("purge-before-confirm").value.trim();
    if (!DATE_RE.test(cutoff)) {
      setResultNote(
        "purge-before-note",
        "purge-before-result",
        "warn",
        "no cutoff.",
        "Pick the date to purge up to first."
      );
      return;
    }
    if (typed !== cutoff) {
      setResultNote(
        "purge-before-note",
        "purge-before-result",
        "warn",
        "not confirmed.",
        "Type " + cutoff + " in the confirmation field to confirm."
      );
      return;
    }
    runPurge({ before: cutoff }, "purge-before-note", "purge-before-result");
  }

  function onPurgeAll() {
    const typed = byId("purge-all-confirm").value.trim();
    if (typed !== PURGE_WORD) {
      setResultNote(
        "purge-all-note",
        "purge-all-result",
        "warn",
        "not confirmed.",
        "Type " + PURGE_WORD + " in the confirmation field to confirm."
      );
      return;
    }
    runPurge({ all: 1 }, "purge-all-note", "purge-all-result");
  }

  function init() {
    byId("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
      const password = byId("password").value;
      if (!password) {
        showLoginError("Enter the admin password.");
        return;
      }
      byId("login-submit").disabled = true;
      request("login", { method: "POST", body: { password: password } }).then(
        function (response) {
          byId("login-submit").disabled = false;
          if (response.status === 200 && response.data && response.data.logged) {
            applySession(response.data);
            if (!state.configured) {
              renderGate("noconfig");
              return;
            }
            enterPanel();
            return;
          }
          if (response.status === 401) {
            showLoginError("That password is not the one this server expects.");
            return;
          }
          if (response.status === 429) {
            showLoginError("Too many attempts from this address. Wait a moment, then try again.");
            return;
          }
          showLoginError("The server answered with status " + response.status + ".");
        },
        function () {
          byId("login-submit").disabled = false;
          showLoginError("The request to " + ENDPOINT + " did not complete.");
        }
      );
    });

    byId("filters").addEventListener("submit", function (event) {
      event.preventDefault();
      applyFilters();
    });

    byId("reset").addEventListener("click", resetFilters);

    byId("page-prev").addEventListener("click", function () {
      state.offset = Math.max(0, state.offset - state.limit);
      loadList();
    });

    byId("page-next").addEventListener("click", function () {
      state.offset = state.offset + state.limit;
      loadList();
    });

    byId("records-body").addEventListener("click", onRecordsClick);
    byId("list-retry").addEventListener("click", function () {
      loadStats();
      loadList();
    });

    byId("detail-close").addEventListener("click", closeDetail);
    byId("purge-before-run").addEventListener("click", onPurgeOlder);
    byId("purge-all-run").addEventListener("click", onPurgeAll);

    byId("logout").addEventListener("click", function () {
      api("logout", { method: "POST", csrf: true }).then(function () {
        requireLogin("Signed out.");
      });
    });

    window.addEventListener("resize", function () {
      if (state.resizeHandle) cancelAnimationFrame(state.resizeHandle);
      state.resizeHandle = requestAnimationFrame(function () {
        state.resizeHandle = null;
        drawChart();
      });
    });

    renderGate("busy");
    readSession().then(function (response) {
      if (!response || response.status !== 200 || !response.data) {
        renderGate("login", "The session check did not complete. The server may be unreachable.");
        return;
      }
      applySession(response.data);
      if (!state.configured) {
        renderGate("noconfig");
        return;
      }
      if (state.logged) {
        enterPanel();
        return;
      }
      renderGate("login");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
