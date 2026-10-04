/**
 * The "my records" page.
 *
 * Records are found again through the anonymous id the test page leaves in
 * localStorage. There is no account and no server side session, so if the id is
 * gone the page has nothing to ask for and says so instead of calling the
 * endpoint with an empty parameter.
 *
 * The list endpoint already carries everything a row shows, so a row opens
 * instantly from memory and the per-id endpoint is only used to refresh the
 * snapshot afterwards. That second request is allowed to fail quietly: the row
 * we already have is a complete answer.
 */
(function () {
  "use strict";

  const CLIENT_ID_KEY = "librespeedex.clientId";
  const ENDPOINT = "results/mine.php";
  const PAGE_SIZE = 25;
  const SHARE_URL = "results/?id=";

  /* Only these earn a place in the one line summary; the snapshot shows every
     key the run recorded. */
  const SUMMARY_KEYS = [
    "time_dl_max",
    "time_ul_max",
    "xhr_dlMultistream",
    "xhr_ulMultistream",
    "dl_max",
    "ul_max",
    "count_dl",
    "count_ul"
  ];
  const SUMMARY_LIMIT = 4;

  const state = {
    clientId: null,
    storage: true,
    loaded: false,
    loading: false,
    total: 0,
    rows: [],
    selectedId: null,
    confirmingClear: false,
    request: 0
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

  /* Every string on this page comes from the server, so nodes are built with
     textContent and never with markup. */
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

  function setText(id, text) {
    byId(id).textContent = text;
  }

  /* The same precision ladder the stability page uses, so a number reads the
     same way on both pages: two decimals below 10, one below 100, none above. */
  function fmt(value) {
    const number = Number(value);
    if (value === null || value === undefined || value === "" || !isFinite(number)) return "--";
    if (number < 10) return number.toFixed(2);
    if (number < 100) return number.toFixed(1);
    return number.toFixed(0);
  }

  function numeric(rows, key) {
    const values = rows
      .map(function (row) {
        return Number(row[key]);
      })
      .filter(function (value) {
        return isFinite(value);
      });
    return values;
  }

  function best(rows, key) {
    const values = numeric(rows, key);
    return values.length ? Math.max.apply(null, values) : null;
  }

  function mean(rows, key) {
    const values = numeric(rows, key);
    if (!values.length) return null;
    return (
      values.reduce(function (sum, value) {
        return sum + value;
      }, 0) / values.length
    );
  }

  function setHeader(text) {
    byId("header-status").textContent = text;
  }

  /* -------------------------------------------------------------- protocol */

  function fetchJson(url) {
    return fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    }).then(function (response) {
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

  function readClientId() {
    try {
      return window.localStorage.getItem(CLIENT_ID_KEY);
    } catch (error) {
      state.storage = false;
      return null;
    }
  }

  /* ------------------------------------------------------------------ state */

  /* One place for every "nothing to show" outcome: the light carries the state,
     the sentence explains it, and the actions appear only when they apply. */
  function setState(kind, title, text, options) {
    const opts = options || {};
    byId("state").className = "note is-" + kind;
    setText("state-title", title ? title + " " : "");
    setText("state-text", text || "");
    if (opts.link) show(byId("state-link"));
    else hide(byId("state-link"));
    if (opts.retry) show(byId("state-retry"));
    else hide(byId("state-retry"));
    show(byId("state"));
  }

  function showTable(visible) {
    if (visible) {
      show(byId("records-head"));
      show(byId("records-frame"));
      hide(byId("state"));
    } else {
      hide(byId("records-head"));
      hide(byId("records-frame"));
    }
  }

  /* --------------------------------------------------------------- fetching */

  function load(append) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    state.request += 1;
    const ticket = state.request;
    const offset = append ? state.rows.length : 0;

    setHeader("reading records");
    if (!append) {
      showTable(false);
      hide(byId("detail"));
      hide(byId("pager"));
      state.selectedId = null;
      state.rows = [];
      setState("busy", "reading records", "Asking the server for the runs this id produced.");
    } else {
      byId("load-more").disabled = true;
    }

    const url =
      ENDPOINT + "?client_id=" + encodeURIComponent(state.clientId) + "&limit=" + PAGE_SIZE + "&offset=" + offset;

    return fetchJson(url).then(
      function (response) {
        if (ticket !== state.request) return;
        state.loading = false;
        byId("load-more").disabled = false;

        if (response.status === 200 && response.data && Array.isArray(response.data.results)) {
          accept(response.data.results, response.data.total, append);
          return;
        }
        if (response.status === 400) {
          setState(
            "warn",
            "unusable client id",
            "The server rejected this browser's id. Clearing it starts a new set.",
            {
              link: true
            }
          );
          setHeader("id rejected");
          return;
        }
        if (response.status === 429) {
          setState("warn", "rate limited", "Too many requests from this address. Wait a moment, then retry.", {
            retry: true
          });
          setHeader("rate limited");
          return;
        }
        setState("error", "unexpected reply", "The server answered with status " + response.status + ".", {
          retry: true
        });
        setHeader("request failed");
      },
      function () {
        if (ticket !== state.request) return;
        state.loading = false;
        byId("load-more").disabled = false;
        setState(
          "error",
          "server unreachable",
          "The request to " + ENDPOINT + " did not complete. Check the connection, then retry.",
          {
            retry: true
          }
        );
        setHeader("request failed");
      }
    );
  }

  function accept(rows, total, append) {
    state.rows = append ? state.rows.concat(rows) : rows;
    state.total = typeof total === "number" ? total : state.rows.length;
    state.loaded = true;

    if (!state.rows.length) {
      renderKpis();
      showTable(false);
      hide(byId("pager"));
      setState("idle", "no records yet", "This browser has an id, but the server has no run stored for it.", {
        link: true
      });
      setHeader("no records");
      return;
    }

    showTable(true);
    renderKpis();
    renderTable();
    renderPager();
    setHeader(state.total + (state.total === 1 ? " record" : " records"));
  }

  /* -------------------------------------------------------------- rendering */

  function renderKpis() {
    const rows = state.rows;
    const partial = state.total > rows.length;
    const scope = partial ? " · over " + rows.length + " loaded" : "";

    setText("kpi-total", state.loaded ? String(state.total) : "");

    const dl = best(rows, "dl");
    const ul = best(rows, "ul");
    const ping = mean(rows, "ping");
    setText("kpi-dl", dl === null ? "" : fmt(dl));
    setText("kpi-ul", ul === null ? "" : fmt(ul));
    setText("kpi-ping", ping === null ? "" : fmt(ping));
    setText("kpi-dl-unit", "mbit/s" + scope);
    setText("kpi-ul-unit", "mbit/s" + scope);
    setText("kpi-ping-unit", "ms" + scope);
  }

  function summarise(params) {
    if (!params) return "not recorded";
    const keys = SUMMARY_KEYS.filter(function (key) {
      return params[key] !== undefined && params[key] !== null;
    }).slice(0, SUMMARY_LIMIT);
    if (!keys.length) {
      const count = Object.keys(params).length;
      return count ? count + " parameters" : "empty";
    }
    return keys
      .map(function (key) {
        return key + "=" + params[key];
      })
      .join(" · ");
  }

  function buildRow(row) {
    const id = String(row.id);
    const open = state.selectedId === id;
    const line = node("tr", {
      className: "is-clickable" + (open ? " is-open" : ""),
      attrs: { tabindex: "0", "aria-expanded": open ? "true" : "false" }
    });
    line.dataset.id = id;

    const time = node("td");
    time.appendChild(node("span", { className: "caret", attrs: { "aria-hidden": "true" } }));
    time.appendChild(document.createTextNode(row.timestamp || "--"));
    line.appendChild(time);

    line.appendChild(cell(fmt(row.dl), "num v-dl"));
    line.appendChild(cell(fmt(row.ul), "num v-ul"));
    line.appendChild(cell(fmt(row.ping), "num"));
    line.appendChild(cell(fmt(row.jitter), "num"));

    /* The summary is one line by definition; the whole string lives in the
       title and in the snapshot below. */
    const params = node("td", { className: "dim" });
    params.appendChild(
      node("span", {
        className: "trunc trunc-params",
        text: summarise(parseParams(row.params)),
        attrs: { title: summarise(parseParams(row.params)) }
      })
    );
    line.appendChild(params);
    return line;
  }

  function renderTable() {
    const body = byId("records-body");
    while (body.firstChild) body.removeChild(body.firstChild);
    state.rows.forEach(function (row) {
      body.appendChild(buildRow(row));
    });
  }

  function renderPager() {
    const loaded = state.rows.length;
    const range = loaded ? "1–" + loaded + " of " + state.total : "nothing loaded";
    setText("records-range", "showing " + range);

    if (loaded < state.total) {
      setText("pager-range", state.total - loaded + " older runs are still on the server");
      byId("load-more").hidden = false;
      show(byId("pager"));
    } else {
      byId("load-more").hidden = true;
      hide(byId("pager"));
    }
  }

  function parseParams(params) {
    if (!params) return null;
    if (typeof params === "string") {
      try {
        return JSON.parse(params);
      } catch (error) {
        return null;
      }
    }
    return params;
  }

  function findRow(id) {
    for (let index = 0; index < state.rows.length; index += 1) {
      if (String(state.rows[index].id) === String(id)) return state.rows[index];
    }
    return null;
  }

  function paramRow(key, value) {
    const line = node("div", { className: "param" });
    line.appendChild(node("dt", { className: "param-label", text: key }));
    line.appendChild(node("dd", { className: "param-value", text: formatValue(value) }));
    return line;
  }

  function formatValue(value) {
    if (value === null || value === undefined || value === "") return "--";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function renderDetail(row) {
    const id = String(row.id);
    setText("detail-title", "#" + (row.id_formatted || id) + " · " + (row.timestamp || "unknown time"));

    const share = byId("detail-share");
    share.href = SHARE_URL + encodeURIComponent(id) + "&style=modern";
    share.title = "Results page for run " + (row.id_formatted || id);

    const list = byId("detail-params");
    while (list.firstChild) list.removeChild(list.firstChild);

    list.appendChild(paramRow("id", row.id_formatted || id));
    list.appendChild(paramRow("timestamp", row.timestamp));
    list.appendChild(paramRow("download", fmt(row.dl) + " mbit/s"));
    list.appendChild(paramRow("upload", fmt(row.ul) + " mbit/s"));
    list.appendChild(paramRow("ping", fmt(row.ping) + " ms"));
    list.appendChild(paramRow("jitter", fmt(row.jitter) + " ms"));
    list.appendChild(paramRow("ip", row.ip));
    list.appendChild(paramRow("isp", row.isp));

    const params = parseParams(row.params);
    if (params && Object.keys(params).length) {
      Object.keys(params)
        .sort()
        .forEach(function (key) {
          list.appendChild(paramRow(key, params[key]));
        });
    } else {
      list.appendChild(paramRow("params", "not recorded for this run"));
    }

    setText("detail-note", "");
    show(byId("detail"));
  }

  /* The list row is already a full answer, so this only refines it; a 404 or a
     dead connection leaves the row we rendered on screen untouched. */
  function refreshDetail(id) {
    const url = ENDPOINT + "?client_id=" + encodeURIComponent(state.clientId) + "&id=" + encodeURIComponent(id);
    setText("detail-note", "refreshing snapshot");
    fetchJson(url).then(
      function (response) {
        if (state.selectedId !== id) return;
        if (response.status === 200 && response.data && response.data.results && response.data.results[0]) {
          const fresh = response.data.results[0];
          const index = state.rows.indexOf(findRow(id));
          if (index >= 0) state.rows[index] = fresh;
          renderDetail(fresh);
          renderKpis();
          setText("detail-note", "snapshot read again from the server");
          return;
        }
        if (response.status === 404) {
          setText("detail-note", "the server no longer has this run");
          return;
        }
        setText("detail-note", "showing the copy this page loaded with");
      },
      function () {
        if (state.selectedId === id) setText("detail-note", "showing the copy this page loaded with");
      }
    );
  }

  function selectRow(id) {
    state.selectedId = state.selectedId === id ? null : id;
    const rows = byId("records-body").children;
    for (let index = 0; index < rows.length; index += 1) {
      const open = rows[index].dataset.id === state.selectedId;
      rows[index].classList.toggle("is-open", open);
      rows[index].setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (!state.selectedId) {
      hide(byId("detail"));
      return;
    }
    const row = findRow(state.selectedId);
    if (!row) return;
    renderDetail(row);
    refreshDetail(String(row.id));
  }

  function rowFromEvent(event) {
    let element = event.target;
    while (element && element !== event.currentTarget) {
      if (element.tagName === "TR") return element;
      element = element.parentNode;
    }
    return null;
  }

  function onRowKey(event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const row = rowFromEvent(event);
    if (!row) return;
    event.preventDefault();
    selectRow(row.dataset.id);
  }

  /* -------------------------------------------------------------- the id UI */

  function forgetId() {
    try {
      window.localStorage.removeItem(CLIENT_ID_KEY);
    } catch (error) {
      /* Nothing to remove if storage is not writable. */
    }
    state.clientId = null;
    state.rows = [];
    state.total = 0;
    state.loaded = false;
    state.selectedId = null;
    state.request += 1;
    disarmClear();
    renderKpis();
    showTable(false);
    hide(byId("pager"));
    hide(byId("detail"));
    setText("client-id-readout", "—");
    setState("idle", "id forgotten", "This browser has no id again. The old records are still on the server.", {
      link: true
    });
    setHeader("no id in this browser");
  }

  function armClear() {
    state.confirmingClear = true;
    const button = byId("clear-id");
    button.textContent = "confirm: forget this id";
    button.classList.add("is-confirming");
    show(byId("clear-hint"));
    show(byId("clear-cancel"));
  }

  function disarmClear() {
    state.confirmingClear = false;
    const button = byId("clear-id");
    button.textContent = "clear this browser's id";
    button.classList.remove("is-confirming");
    hide(byId("clear-hint"));
    hide(byId("clear-cancel"));
  }

  /* ------------------------------------------------------------------- init */

  /* Reading the id again on every entry point means the refresh button picks up
     an id another tab wrote while this page was open. */
  function start() {
    if (!state.storage) {
      setState(
        "error",
        "storage unavailable",
        "This browser blocks local storage, so records cannot be looked up here.",
        {
          link: true
        }
      );
      setHeader("storage blocked");
      return;
    }

    state.clientId = readClientId();
    if (!state.clientId) {
      byId("client-id-readout").textContent = "not set";
      renderKpis();
      showTable(false);
      hide(byId("pager"));
      hide(byId("detail"));
      setState("idle", "no local id yet", "This browser has not run a test, so there is nothing to look up.", {
        link: true
      });
      setHeader("no id in this browser");
      return;
    }

    byId("client-id-readout").textContent = state.clientId;
    load(false);
  }

  function init() {
    byId("records-body").addEventListener("click", function (event) {
      const row = rowFromEvent(event);
      if (row) selectRow(row.dataset.id);
    });
    byId("records-body").addEventListener("keydown", onRowKey);

    byId("state-retry").addEventListener("click", function () {
      load(false);
    });

    byId("load-more").addEventListener("click", function () {
      load(true);
    });

    byId("refresh").addEventListener("click", start);

    byId("clear-id").addEventListener("click", function () {
      if (state.confirmingClear) forgetId();
      else armClear();
    });

    byId("clear-cancel").addEventListener("click", disarmClear);

    start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
