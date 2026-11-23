const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ───────────── Ajustes persistentes ───────────── */
const DEFAULTS = {
  theme: "dark", accent: "blue", lang: "es", interval: 1500, confirm: true, density: 28, scale: 100,
  mode: "list", panel: true, sortKey: "cpu", sortDir: -1,
};
const settings = { ...DEFAULTS };
try {
  const raw = localStorage.getItem("procly.settings");
  Object.assign(settings, JSON.parse(raw || "{}"));
  if (!raw) { const nav = (navigator.language || "es").slice(0, 2); if (I18N[nav]) settings.lang = nav; }
} catch {}
if (![28, 24].includes(settings.density)) settings.density = 28;
if (!(settings.scale >= 70 && settings.scale <= 200)) settings.scale = 100;
const saveSettings = () => { try { localStorage.setItem("procly.settings", JSON.stringify(settings)); } catch {} };

/* ───────────── i18n ───────────── */
const t = (key, vars = {}) =>
  (I18N[settings.lang]?.[key] ?? I18N.es[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const stateLabel = (s) => t("st." + s);

/* ───────────── Estado ───────────── */
const state = {
  procs: [], byPid: new Map(), view: [], sel: new Set(), anchor: null, maxMem: 1,
  query: "", fUser: "", fState: "", fCpu: 0, fMem: 0,
  tab: "procs", paused: false, pending: null, menuOpen: false,
  cores: 1, snap: null, sysinfo: null, disks: [], tick: 0,
  hist: { cpu: [], mem: [], swap: [], rx: [], tx: [] }, users: [],
};
let ROW_H = settings.density;
const HIST = 90;

/* ───────────── Utilidades ───────────── */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtBytes = (b) => {
  if (b >= 2 ** 40) return (b / 2 ** 40).toFixed(1) + " TB";
  if (b >= 2 ** 30) return (b / 2 ** 30).toFixed(1) + " GB";
  if (b >= 2 ** 20) return (b / 2 ** 20).toFixed(b >= 2 ** 26 ? 0 : 1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
};
const fmtRate = (b) => fmtBytes(b) + "/s";
const fmtDur = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
};
function toast(msg, err = false) {
  const el = $("toast");
  el.className = "toast" + (err ? " err" : "");
  el.innerHTML = icon(err ? "alert" : "check", 16) + `<span>${esc(msg)}</span>`;
  el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3200);
}

/* ───────────── Selector personalizado ───────────── */
let openPop = null;
function closePop() { if (openPop) { openPop.pop.remove(); openPop.root.classList.remove("open"); openPop = null; } }
function Select(root, { label, options, onChange, isActive }) {
  const api = { value: null };
  const btn = document.createElement("button");
  btn.className = "sel-btn"; btn.type = "button"; root.append(btn);
  api.paint = () => {
    const opts = options(); const cur = opts.find((o) => o.value === api.value) || opts[0];
    const lab = label ? label() : "";
    btn.innerHTML = (lab ? `<span class="sel-k">${esc(lab)}</span>` : "") + `<span class="sel-v">${esc(cur?.label ?? "")}</span>` + icon("chevron", 14);
    root.classList.toggle("active", !!isActive && isActive(api.value));
  };
  api.set = (v) => { api.value = v; api.paint(); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openPop?.root === root) return closePop();
    closePop();
    const pop = document.createElement("div"); pop.className = "pop";
    const opts = options();
    pop.innerHTML = opts.map((o, i) => `<button data-i="${i}" class="${o.value === api.value ? "on" : ""}"><span>${esc(o.label)}</span>${o.value === api.value ? icon("check", 13) : ""}</button>`).join("");
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + "px";
    pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
    pop.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-i]"); if (!b) return;
      api.set(opts[Number(b.dataset.i)].value); closePop(); onChange(api.value);
    });
    root.classList.add("open"); openPop = { pop, root };
  });
  return api;
}
document.addEventListener("click", () => closePop());

const selUser = Select($("fUser"), {
  isActive: (v) => v !== "",
  options: () => [{ value: "", label: t("f.anyUser") }, ...state.users.map((u) => ({ value: u, label: u }))],
  onChange: (v) => { state.fUser = v; onFilter(); },
});
const selState = Select($("fState"), {
  isActive: (v) => v !== "",
  options: () => [{ value: "", label: t("f.anyState") }, ...["run", "sleep", "idle", "stop", "zombie"].map((s) => ({ value: s, label: t("st." + s) }))],
  onChange: (v) => { state.fState = v; onFilter(); },
});
const selCpu = Select($("fCpu"), {
  isActive: (v) => v !== 0,
  options: () => [{ value: 0, label: t("f.anyCpu") }, { value: 1, label: "> 1%" }, { value: 5, label: "> 5%" }, { value: 25, label: "> 25%" }],
  onChange: (v) => { state.fCpu = v; onFilter(); },
});
const selMem = Select($("fMem"), {
  isActive: (v) => v !== 0,
  options: () => [{ value: 0, label: t("f.anyMem") }, { value: 50, label: "> 50 MB" }, { value: 200, label: "> 200 MB" }, { value: 1000, label: "> 1 GB" }],
  onChange: (v) => { state.fMem = v; onFilter(); },
});
const selLang = Select($("sLang"), {
  options: () => [{ value: "es", label: "Español" }, { value: "en", label: "English" }, { value: "pt", label: "Português" }],
  onChange: (v) => { settings.lang = v; saveSettings(); applyI18n(); },
});
const selInterval = Select($("sInterval"), {
  options: () => [500, 1000, 1500, 3000, 5000].map((v) => ({ value: v, label: `${v / 1000} s` })),
  onChange: (v) => { settings.interval = v; saveSettings(); loop(); },
});
const SCALES = [80, 90, 100, 110, 125, 150];
const selScale = Select($("sScale"), {
  options: () => SCALES.map((v) => ({ value: v, label: v + "%" })),
  onChange: (v) => setScale(v),
});
const allSelects = [selScale, selUser, selState, selCpu, selMem, selLang, selInterval];

/* ───────────── Aplicar idioma / tema ───────────── */
function applyI18n() {
  document.documentElement.lang = settings.lang;
  $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $("keys").innerHTML = `<span><kbd>↑↓</kbd>${esc(t("k.move"))}</span><span><kbd>Del</kbd>${esc(t("close"))}</span><span><kbd>⇧Del</kbd>${esc(t("force"))}</span><span><kbd>/</kbd>${esc(t("k.search"))}</span>`;
  $("btnTerm").textContent = t("close"); $("btnKill").textContent = t("force"); $("btnCancel").textContent = t("cancel");
  $("togglePanel").title = t("d.title");
  paintLive();
  allSelects.forEach((s) => s.paint());
  $("tCpuS").textContent = t("tile.cores", { n: state.cores });
  if (state.procs.length) { buildView(); render(); renderPanel(); renderPerf(); renderNet(); renderSysInfo(); paintTiles(); }
  updateCount();
}
const mq = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  const th = settings.theme === "system" ? (mq.matches ? "light" : "dark") : settings.theme;
  document.documentElement.dataset.theme = th;
  document.documentElement.dataset.accent = settings.accent;
  $$("#sAccent button").forEach((b) => b.classList.toggle("on", b.dataset.accent === settings.accent));
  $$("#sTheme button").forEach((b) => b.classList.toggle("on", b.dataset.themeOpt === settings.theme));
  requestAnimationFrame(() => { redrawCharts(); paintTiles(); });
}
mq.addEventListener("change", () => settings.theme === "system" && applyTheme());
function paintLive() {
  $("pause").classList.toggle("paused", state.paused);
  $("liveText").textContent = state.paused ? t("paused") : t("live");
  $("pause").querySelector("[data-icon]").innerHTML = icon(state.paused ? "play" : "pause", 14);
  $("pause").title = state.paused ? t("resume") : t("pause");
}

/* ───────────── Pipeline de filas ───────────── */
function matches(p, q) {
  if (state.fUser && p.user !== state.fUser) return false;
  if (state.fState && p.status !== state.fState) return false;
  if (state.fCpu && p.cpu / state.cores < state.fCpu) return false;
  if (state.fMem && p.mem < state.fMem * 2 ** 20) return false;
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) ||
    p.user.toLowerCase().includes(q) || String(p.pid).startsWith(q);
}
const toRow = (p) => ({
  key: p.pid, pid: p.pid, ppid: p.ppid, name: p.name, cmd: p.cmd, user: p.user, status: p.status,
  cpu: p.cpu / state.cores, mem: p.mem, io: p.io_r + p.io_w, pids: [p.pid], depth: 0,
});
function cmp() {
  const k = settings.sortKey, d = settings.sortDir;
  return (a, b) => {
    const x = a[k], y = b[k];
    const r = typeof x === "string" ? x.localeCompare(y) : x - y;
    return (r || a.pid - b.pid) * d;
  };
}
function buildView() {
  const q = state.query.trim().toLowerCase();
  const sorter = cmp();
  let rows;
  if (settings.mode === "group") {
    const g = new Map();
    for (const p of state.procs) {
      if (!matches(p, q)) continue;
      const r = toRow(p), cur = g.get(p.name);
      if (!cur) g.set(p.name, { ...r, key: "g:" + p.name, count: 1, pids: [p.pid] });
      else {
        cur.count++; cur.pids.push(p.pid); cur.cpu += r.cpu; cur.mem += r.mem; cur.io += r.io;
        cur.pid = Math.min(cur.pid, p.pid);
        if (cur.user !== p.user) cur.user = "—";
        if (cur.status !== p.status) cur.status = "run";
      }
    }
    rows = [...g.values()].sort(sorter);
  } else if (settings.mode === "tree") {
    const keep = new Set();
    for (const p of state.procs) {
      if (!matches(p, q)) continue;
      for (let c = p; c && !keep.has(c.pid); c = state.byPid.get(c.ppid)) keep.add(c.pid);
    }
    const kids = new Map(), roots = [];
    for (const p of state.procs) {
      if (!keep.has(p.pid)) continue;
      const r = toRow(p);
      if (keep.has(p.ppid) && p.ppid !== p.pid) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(r);
      else roots.push(r);
    }
    rows = [];
    const walk = (list, depth) => {
      list.sort(sorter);
      for (const r of list) { r.depth = depth; rows.push(r); const c = kids.get(r.pid); if (c) walk(c, depth + 1); }
    };
    walk(roots, 0);
  } else {
    rows = state.procs.filter((p) => matches(p, q)).map(toRow).sort(sorter);
  }
  state.view = rows;
  state.maxMem = Math.max(1, ...rows.map((r) => r.mem));
  const keys = new Set(rows.map((r) => r.key));
  for (const k of [...state.sel]) if (!keys.has(k)) state.sel.delete(k);
  updateCount();
  $("clearF").hidden = !(state.query || state.fUser || state.fState || state.fCpu || state.fMem);
}
function updateCount() {
  const n = state.view.length;
  $("count").textContent = t(settings.mode === "group" ? "groups" : "count", { n }) +
    (state.sel.size > 1 ? ` · ${t("selected", { n: state.sel.size })}` : "");
}

/* ───────────── Lista virtualizada ───────────── */
const list = $("list"), spacer = $("spacer"), rowsEl = $("rows");
function render() {
  if (state.tab !== "procs") return;
  const total = state.view.length;
  spacer.style.height = total * ROW_H + "px";
  const top = list.scrollTop;
  const start = Math.max(0, Math.floor(top / ROW_H) - 6);
  const end = Math.min(total, Math.ceil((top + list.clientHeight) / ROW_H) + 6);
  rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
  let html = "";
  if (!total) html = `<div class="panel empty" style="padding:48px 12px;margin:0;display:grid;justify-items:center;gap:10px;color:var(--muted);animation:none;height:auto">${icon("search", 22)}<span>${esc(t("empty"))}</span></div>`;
  for (let i = start; i < end; i++) {
    const r = state.view[i];
    const cls = "row" + (state.sel.has(r.key) ? " sel" : "") + (r.status === "zombie" ? " zombie" : "") + (r.status === "stop" ? " stopped" : "");
    const tw = r.depth ? `<span style="width:${(r.depth - 1) * 16}px;flex:none"></span><span class="tw">└</span>` : "";
    html += `<div class="${cls}" data-key="${esc(r.key)}" title="${esc(r.cmd || r.name)}">
      <div class="c-name">${tw}<span class="dot s-${r.status}"></span><span class="nm">${esc(r.name)}</span>${r.count > 1 ? `<span class="cnt">×${r.count}</span>` : ""}</div>
      <div class="c-pid num">${r.count > 1 ? "·" : r.pid}</div>
      <div class="c-user">${esc(r.user)}</div>
      <div class="c-state">${esc(stateLabel(r.status))}</div>
      <div class="c-cpu"><span>${r.cpu.toFixed(1)}%</span><i class="mb${r.cpu >= 50 ? " hot" : ""}"><b style="width:${Math.min(100, r.cpu * 2)}%"></b></i></div>
      <div class="c-mem"><span>${fmtBytes(r.mem)}</span><i class="mb"><b style="width:${Math.min(100, (r.mem / state.maxMem) * 100)}%"></b></i></div>
      <div class="c-io num">${r.io ? fmtRate(r.io) : "—"}</div>
      <div class="c-act"><button class="ib d" data-kill="${esc(r.key)}" title="${esc(t("close"))}">${icon("power", 15)}</button><button class="ib" data-more="${esc(r.key)}">${icon("more", 15)}</button></div>
    </div>`;
  }
  rowsEl.innerHTML = html;
}
function paintHead() {
  $$("#thead [data-k]").forEach((el) => {
    const on = el.dataset.k === settings.sortKey;
    el.classList.toggle("sorted", on);
    el.dataset.dir = on ? (settings.sortDir > 0 ? "▲" : "▼") : "";
  });
}

/* ───────────── Selección ───────────── */
const rowByKey = (k) => state.view.find((r) => String(r.key) === String(k));
const selRows = () => state.view.filter((r) => state.sel.has(r.key));
const pidsOf = (rows) => [...new Set(rows.flatMap((r) => r.pids))];
function clickRow(key, e) {
  const r = rowByKey(key); if (!r) return;
  if (e.shiftKey && state.anchor != null) {
    const a = state.view.findIndex((x) => x.key === state.anchor), b = state.view.indexOf(r);
    state.sel = new Set(state.view.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key));
  } else if (e.ctrlKey || e.metaKey) {
    state.sel.has(r.key) ? state.sel.delete(r.key) : state.sel.add(r.key);
    state.anchor = r.key;
  } else { state.sel = new Set([r.key]); state.anchor = r.key; }
  selectionChanged();
}
function selectionChanged() { updateCount(); render(); renderPanel(); }
function move(delta, extend) {
  if (!state.view.length) return;
  const cur = state.view.findIndex((r) => r.key === (state.anchor ?? [...state.sel][0]));
  const n = Math.min(state.view.length - 1, Math.max(0, (cur < 0 ? (delta > 0 ? -1 : 0) : cur) + delta));
  const r = state.view[n];
  if (extend && state.anchor != null) {
    const a = state.view.findIndex((x) => x.key === state.anchor);
    state.sel = new Set(state.view.slice(Math.min(a, n), Math.max(a, n) + 1).map((x) => x.key));
  } else { state.sel = new Set([r.key]); state.anchor = r.key; }
  const y = n * ROW_H;
  if (y < list.scrollTop) list.scrollTop = y;
  else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight;
  selectionChanged();
}

/* ───────────── Acciones sobre procesos ───────────── */
const rowsName = (rows) => (rows.length === 1 ? rows[0].name : `${rows.length}×`);
function ask(kind, rows) {
  if (!rows.length) return;
  if (!settings.confirm) return exec(kind, rows);
  state.pending = { kind, rows };
  const r = rows[0], n = pidsOf(rows).length, force = kind === "kill";
  $("mIcon").className = "m-icon" + (force ? " danger" : "");
  $("mIcon").innerHTML = icon(force ? "ban" : "power", 20);
  $("mTitle").textContent = force ? t("m.forceTitle") : rows.length > 1 || r.count > 1 ? t("m.closeTitleN") : t("m.closeTitle");
  $("mText").innerHTML = rows.length > 1 ? t("ask.many", { n }) : r.count > 1 ? t("ask.group", { name: esc(r.name), n: r.count }) : force ? t("ask.force", { name: esc(r.name) }) : t("ask.one", { name: esc(r.name), pid: r.pid });
  const items = rows.flatMap((x) => (x.count > 1 ? [[x.name, `×${x.count}`]] : [[x.name, x.pid]]));
  $("mList").innerHTML = rows.length > 1 || r.count > 1
    ? items.slice(0, 20).map(([a, b]) => `<li><span>${esc(a)}</span><span>${esc(b)}</span></li>`).join("") : "";
  $("mHint").textContent = force ? t("m.forceHint") : t("m.closeHint");
  $("btnTerm").hidden = force;
  $("modal").hidden = false;
  (force ? $("btnKill") : $("btnTerm")).focus();
}
function cancel() { state.pending = null; $("modal").hidden = true; list.focus(); }
async function exec(kind, rows) {
  const pids = pidsOf(rows);
  try {
    const errs = await invoke("signal_processes", { pids, signal: kind });
    if (errs.length) toast(errs.slice(0, 3).join(" · "), true);
    else toast(t("done." + kind, { name: rowsName(rows) }));
    if (kind === "term" || kind === "kill") { state.sel.clear(); selectionChanged(); }
  } catch (e) { toast(String(e), true); }
  setTimeout(refresh, 300);
}
async function setNice(rows, nice) {
  try {
    const errs = await invoke("set_priority", { pids: pidsOf(rows), nice });
    errs.length ? toast(errs.slice(0, 3).join(" · "), true) : toast(t("done.nice", { name: rowsName(rows) }));
  } catch (e) { toast(String(e), true); }
  setTimeout(() => { refresh(); loadDetails(); }, 300);
}
async function confirmPending(kind) {
  const p = state.pending; if (!p) return;
  state.pending = null; $("modal").hidden = true;
  await exec(kind, p.rows);
  list.focus();
}
const PRIOS = [["p.high", -5], ["p.normal", 0], ["p.low", 10], ["p.min", 19]];

/* ───────────── Panel de detalles ───────────── */
let detailToken = 0, nicePick = null;
function renderPanel() {
  const panel = $("panel");
  panel.classList.toggle("off", !settings.panel || state.tab !== "procs");
  if (panel.classList.contains("off")) return;
  const rows = selRows();
  if (!rows.length) { panel.innerHTML = `<div class="empty">${icon("panel", 26)}<span>${esc(t("d.none"))}</span></div>`; return; }
  const one = rows.length === 1 ? rows[0] : null;
  const title = one ? one.name : `${pidsOf(rows).length} · ${t("tab.procs")}`;
  const sub = one && !(one.count > 1)
    ? `<span class="dot s-${one.status}"></span>${esc(stateLabel(one.status))} · PID ${one.pid} · ${esc(one.user)}` : "";
  const members = !one || one.count > 1
    ? `<div class="members">${rows.flatMap((r) => r.pids.map((pid) => `${pid} ${esc(state.byPid.get(pid)?.name ?? "")}`)).slice(0, 200).join("<br>")}</div>` : "";
  panel.innerHTML = `<h3>${esc(title)}</h3><div class="sub">${sub}</div>
    <div class="actions">
      <button class="btn" data-act="term">${icon("power", 15)}${esc(t("close"))}</button>
      <button class="btn danger" data-act="kill">${icon("ban", 15)}${esc(t("force"))}</button>
      <button class="btn sec" data-act="stop">${icon("pause", 14)}${esc(t("suspend"))}</button>
      <button class="btn sec" data-act="cont">${icon("play", 14)}${esc(t("resumeProc"))}</button>
      <div class="select" id="panelNice"></div>
    </div>${members}<div id="detail"></div>`;
  nicePick = Select($("panelNice"), {
    label: () => t("priority"),
    options: () => [{ value: "", label: "…" }, ...PRIOS.map(([k, v]) => ({ value: v, label: t(k) }))],
    onChange: (v) => { if (v !== "") setNice(selRows(), v); nicePick.set(""); },
  });
  nicePick.set("");
  loadDetails();
}
async function loadDetails() {
  const rows = selRows(), box = $("detail");
  if (!box || rows.length !== 1 || rows[0].count > 1 || !settings.panel) return;
  const token = ++detailToken, r = rows[0];
  try {
    const d = await invoke("process_details", { pid: r.pid });
    if (token !== detailToken || !$("detail")) return;
    const row = (k, v) => (v === "" || v == null ? "" : `<dt>${esc(t(k))}</dt><dd>${esc(v)}</dd>`);
    $("detail").innerHTML = `<dl style="margin-top:16px">
      ${row("d.exe", d.exe)}${row("d.cmd", d.cmd)}${row("d.cwd", d.cwd)}${row("d.parent", d.parent)}
      ${row("d.started", d.start ? new Date(d.start * 1000).toLocaleString(settings.lang) : "")}
      ${row("d.running", fmtDur(d.run_time))}${row("d.threads", d.threads)}${row("d.nice", d.nice)}${row("d.fds", d.fds)}
      ${row("d.virt", fmtBytes(d.virt))}${row("d.read", fmtBytes(d.io_read_total))}${row("d.written", fmtBytes(d.io_write_total))}
    </dl>`;
  } catch { if ($("detail")) $("detail").innerHTML = ""; }
}
$("panel").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const rows = selRows();
  ["term", "kill"].includes(b.dataset.act) ? ask(b.dataset.act, rows) : exec(b.dataset.act, rows);
});

/* ───────────── Menú contextual ───────────── */
const menu = $("menu");
function openMenu(x, y) {
  const rows = selRows(); if (!rows.length) return;
  const items = [
    ["term", t("close"), "power"], ["kill", t("force"), "ban", "d"], null,
    ["stop", t("suspend"), "pause"], ["cont", t("resumeProc"), "play"], null,
    ...PRIOS.map(([k, v]) => ["nice:" + v, `${t("priority")}: ${t(k)}`, "gauge"]), null,
    ["same", t("m.sameName"), "select"], ["pid", t("m.copyPid"), "copy"], ["cmd", t("m.copyCmd"), "copy"],
  ];
  menu.innerHTML = items.map((i) => (i ? `<button data-m="${i[0]}" class="${i[3] || ""}">${icon(i[2], 15)}<span>${esc(i[1])}</span></button>` : "<hr>")).join("");
  menu.hidden = false; state.menuOpen = true;
  menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 8)) + "px";
}
function closeMenu() { menu.hidden = true; state.menuOpen = false; }
menu.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-m]"); if (!b) return;
  const m = b.dataset.m, rows = selRows(); closeMenu();
  if (m === "term" || m === "kill") ask(m, rows);
  else if (m === "stop" || m === "cont") exec(m, rows);
  else if (m.startsWith("nice:")) setNice(rows, Number(m.slice(5)));
  else if (m === "same") {
    const names = new Set(rows.map((r) => r.name));
    state.sel = new Set(state.view.filter((r) => names.has(r.name)).map((r) => r.key)); selectionChanged();
  } else {
    const text = m === "pid" ? rows.map((r) => r.pid).join(" ") : rows.map((r) => r.cmd || r.name).join("\n");
    try { await navigator.clipboard.writeText(text); toast(t("copied")); } catch {}
  }
});
document.addEventListener("click", (e) => { if (state.menuOpen && !e.target.closest("#menu")) closeMenu(); });

/* ───────────── Tarjetas, gráficos, red, discos ───────────── */
const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
const A = () => Charts.css("--accent"), B = () => Charts.css("--accent2");

function paintTiles() {
  const s = state.snap; if (!s || state.tab !== "procs") return;
  const mem = s.mem_total ? (s.mem_used / s.mem_total) * 100 : 0;
  $("tCpu").textContent = s.cpu_total.toFixed(0) + "%";
  $("tCpuS").textContent = t("tile.cores", { n: state.cores });
  $("tMem").textContent = mem.toFixed(0) + "%";
  $("tMemS").textContent = `${fmtBytes(s.mem_used)} / ${fmtBytes(s.mem_total)}`;
  $("tProcs").textContent = state.procs.length;
  $("tProcsS").textContent = t("tile.running", { n: state.procs.filter((p) => p.status === "run").length });
  $("tUp").textContent = fmtDur(s.uptime);
  $("tLoad").textContent = `${t("tile.load")} ${s.load.map((x) => x.toFixed(2)).join("  ")}`;
  Charts.spark($("spCpu"), state.hist.cpu, A());
  Charts.spark($("spMem"), state.hist.mem, B());
}
function renderPerf() {
  const s = state.snap; if (!s || state.tab !== "perf") return;
  const h = state.hist;
  $("pCpu").textContent = s.cpu_total.toFixed(0) + "%";
  $("pMem").textContent = `${fmtBytes(s.mem_used)} / ${fmtBytes(s.mem_total)}`;
  Charts.line($("chCpu"), [{ data: h.cpu, color: A() }], { max: 100, fmt: (v) => v.toFixed(0) + "%", points: HIST });
  Charts.line($("chMem"), [{ data: h.mem, color: A() }, { data: h.swap, color: B() }], { max: 100, fmt: (v) => v.toFixed(0) + "%", points: HIST });
  const cores = $("cores");
  if (cores.children.length !== s.cores_usage.length)
    cores.innerHTML = s.cores_usage.map((_, i) => `<div class="core">${i}<b></b><span class="mb"><b></b></span></div>`).join("");
  s.cores_usage.forEach((u, i) => {
    const el = cores.children[i];
    el.firstElementChild.textContent = u.toFixed(0) + "%";
    el.querySelector(".mb b").style.width = Math.min(100, u) + "%";
  });
  const top = (key, fmt) => [...state.procs].sort((a, b) => b[key] - a[key]).slice(0, 6)
    .map((p) => `<li><span>${esc(p.name)} <span class="mut">${p.pid}</span></span><span>${fmt(p)}</span></li>`).join("");
  $("topCpu").innerHTML = top("cpu", (p) => (p.cpu / state.cores).toFixed(1) + "%");
  $("topMem").innerHTML = top("mem", (p) => fmtBytes(p.mem));
  renderSysInfo();
}
function renderSysInfo() {
  const i = state.sysinfo, s = state.snap; if (!i || !s) return;
  const kv = (k, v) => `<dt>${esc(t(k))}</dt><dd>${esc(v)}</dd>`;
  $("sysinfo").innerHTML = kv("sys.host", i.host) + kv("sys.os", i.os) + kv("sys.kernel", i.kernel) + kv("sys.cpu", i.cpu_brand) +
    kv("sys.cores", i.cores) + kv("sys.uptime", fmtDur(s.uptime)) + kv("sys.load", s.load.map((x) => x.toFixed(2)).join("  ")) + kv("sys.procs", state.procs.length);
}
function renderNet() {
  const s = state.snap; if (!s || state.tab !== "net") return;
  const h = state.hist;
  $("pNet").textContent = `↓ ${fmtRate(h.rx.at(-1) || 0)}   ↑ ${fmtRate(h.tx.at(-1) || 0)}`;
  Charts.line($("chNet"), [{ data: h.rx, color: A() }, { data: h.tx, color: B() }], { fmt: fmtRate, points: HIST });
  $("ifaces").innerHTML = `<div class="tr h"><span>${esc(t("net.ifaces"))}</span><span>↓</span><span>↑</span><span>↓ ${esc(t("net.total"))}</span><span>↑ ${esc(t("net.total"))}</span></div>` +
    s.nets.map((n) => `<div class="tr"><span>${esc(n.name)}</span><span>${fmtRate(n.rx)}</span><span>${fmtRate(n.tx)}</span><span>${fmtBytes(n.total_rx)}</span><span>${fmtBytes(n.total_tx)}</span></div>`).join("");
}
async function loadDisks() {
  try { state.disks = await invoke("disks"); } catch { state.disks = []; }
  renderDisks();
}
function renderDisks() {
  if (state.tab !== "disks") return;
  $("diskList").innerHTML = state.disks.length ? state.disks.map((d) => {
    const used = d.total - d.free, pct = d.total ? (used / d.total) * 100 : 0;
    return `<div class="disk"><div class="r"><span>${esc(d.mount)} <span class="mut" style="font-weight:400">${esc(d.name)} · ${esc(d.fs)} · ${esc(d.kind)}</span></span>
      <span>${fmtBytes(used)} / ${fmtBytes(d.total)} · ${fmtBytes(d.free)} ${esc(t("disks.free"))}</span></div>
      <span class="mb${pct > 90 ? " hot" : ""}"><b style="width:${pct}%;${pct > 90 ? "background:var(--danger)" : ""}"></b></span></div>`;
  }).join("") : `<div class="mut">${esc(t("disks.empty"))}</div>`;
}
function redrawCharts() { renderPerf(); renderNet(); }

/* ───────────── Refresco ───────────── */
async function refresh() {
  if (state.paused || state.pending || state.menuOpen || document.hidden || openPop) return;
  try {
    const s = await invoke("snapshot");
    state.snap = s; state.procs = s.procs; state.cores = s.cores_usage.length || 1;
    state.byPid = new Map(s.procs.map((p) => [p.pid, p]));
    const h = state.hist;
    push(h.cpu, s.cpu_total);
    push(h.mem, s.mem_total ? (s.mem_used / s.mem_total) * 100 : 0);
    push(h.swap, s.swap_total ? (s.swap_used / s.swap_total) * 100 : 0);
    push(h.rx, s.nets.reduce((a, n) => a + n.rx, 0));
    push(h.tx, s.nets.reduce((a, n) => a + n.tx, 0));
    const users = [...new Set(s.procs.map((p) => p.user).filter(Boolean))].sort();
    if (users.join("|") !== state.users.join("|")) { state.users = users; if (!users.includes(state.fUser)) { state.fUser = ""; selUser.set(""); } selUser.paint(); }
    buildView(); render(); paintTiles();
    if (state.sel.size === 1) loadDetails();
    renderPerf(); renderNet();
    if (state.tab === "disks" && ++state.tick % 4 === 0) loadDisks();
  } catch (e) { toast(String(e), true); }
}
let timer;
function loop() { clearTimeout(timer); refresh().finally(() => (timer = setTimeout(loop, settings.interval))); }

/* ───────────── Eventos ───────────── */
list.addEventListener("scroll", () => requestAnimationFrame(render), { passive: true });
window.addEventListener("resize", () => { render(); redrawCharts(); paintTiles(); });
list.addEventListener("click", (e) => {
  const k = e.target.closest("[data-kill]");
  if (k) { const r = rowByKey(k.dataset.kill); if (r) { state.sel = new Set([r.key]); selectionChanged(); ask("term", [r]); } return; }
  const m = e.target.closest("[data-more]");
  if (m) {
    e.stopPropagation();
    const r = rowByKey(m.dataset.more);
    if (r && !state.sel.has(r.key)) { state.sel = new Set([r.key]); state.anchor = r.key; selectionChanged(); }
    const b = m.getBoundingClientRect(); return openMenu(b.right - 220, b.bottom + 4);
  }
  const row = e.target.closest(".row");
  if (row) clickRow(row.dataset.key, e);
});
list.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  e.preventDefault();
  const r = rowByKey(row.dataset.key);
  if (r && !state.sel.has(r.key)) { state.sel = new Set([r.key]); state.anchor = r.key; selectionChanged(); }
  openMenu(e.clientX, e.clientY);
});
$("thead").addEventListener("click", (e) => {
  const c = e.target.closest("[data-k]"); if (!c) return;
  const k = c.dataset.k;
  if (settings.sortKey === k) settings.sortDir *= -1;
  else { settings.sortKey = k; settings.sortDir = ["name", "user", "status"].includes(k) ? 1 : -1; }
  saveSettings(); paintHead(); buildView(); render();
});

const onFilter = () => { buildView(); list.scrollTop = 0; render(); };
$("q").addEventListener("input", (e) => { state.query = e.target.value; onFilter(); });
$("clearF").addEventListener("click", () => {
  Object.assign(state, { query: "", fUser: "", fState: "", fCpu: 0, fMem: 0 });
  $("q").value = ""; [selUser, selState].forEach((s) => s.set("")); [selCpu, selMem].forEach((s) => s.set(0));
  onFilter();
});
$("mode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]"); if (!b) return;
  settings.mode = b.dataset.mode; saveSettings(); paintMode();
  state.sel.clear(); state.anchor = null; buildView(); render(); renderPanel();
});
const paintMode = () => $$("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === settings.mode));
$("togglePanel").addEventListener("click", () => { settings.panel = !settings.panel; saveSettings(); paintSwitches(); renderPanel(); render(); });
$("pause").addEventListener("click", () => { state.paused = !state.paused; paintLive(); if (!state.paused) refresh(); });
$("btnTerm").addEventListener("click", () => confirmPending("term"));
$("btnKill").addEventListener("click", () => confirmPending("kill"));
$("btnCancel").addEventListener("click", cancel);
$("modal").addEventListener("mousedown", (e) => { if (e.target === $("modal")) cancel(); });

function setTab(tab) {
  closePop(); closeMenu();
  state.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === tab));
  if (tab === "disks") loadDisks();
  requestAnimationFrame(() => { render(); renderPanel(); renderPerf(); renderNet(); paintTiles(); });
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

/* Ajustes */
$("sTheme").addEventListener("click", (e) => { const b = e.target.closest("[data-theme-opt]"); if (b) { settings.theme = b.dataset.themeOpt; saveSettings(); applyTheme(); } });
$("sAccent").addEventListener("click", (e) => { const b = e.target.closest("[data-accent]"); if (b) { settings.accent = b.dataset.accent; saveSettings(); applyTheme(); } });
$("sDensity").addEventListener("click", (e) => {
  const b = e.target.closest("[data-d]"); if (!b) return;
  settings.density = ROW_H = Number(b.dataset.d);
  document.documentElement.style.setProperty("--row-h", ROW_H + "px"); saveSettings(); paintSwitches(); render();
});
$("sConfirm").addEventListener("click", () => { settings.confirm = !settings.confirm; saveSettings(); paintSwitches(); });
$("sPanel").addEventListener("click", () => { settings.panel = !settings.panel; saveSettings(); paintSwitches(); renderPanel(); });
function paintSwitches() {
  $("sConfirm").setAttribute("aria-checked", settings.confirm);
  $("sPanel").setAttribute("aria-checked", settings.panel);
  $("togglePanel").classList.toggle("on", settings.panel);
  $$("#sDensity button").forEach((b) => b.classList.toggle("on", Number(b.dataset.d) === settings.density));
}

/* Tamaño de la interfaz: zoom real del webview (Tauri) con respaldo en CSS */
async function applyScale() {
  const f = settings.scale / 100;
  try { await window.__TAURI__.webview.getCurrentWebview().setZoom(f); document.documentElement.style.zoom = ""; }
  catch { document.documentElement.style.zoom = f; }
  requestAnimationFrame(() => { render(); redrawCharts(); paintTiles(); });
}
function setScale(v) {
  settings.scale = Math.min(200, Math.max(70, v)); saveSettings(); selScale.set(settings.scale); applyScale();
}
function stepScale(dir) {
  const i = SCALES.findIndex((s) => s >= settings.scale);
  const cur = SCALES.includes(settings.scale) ? SCALES.indexOf(settings.scale) : i < 0 ? SCALES.length - 1 : i;
  setScale(SCALES[Math.min(SCALES.length - 1, Math.max(0, cur + dir))]);
}

/* Teclado */
const TABS = ["procs", "perf", "net", "disks", "settings"];
window.addEventListener("keydown", (e) => {
  const typing = document.activeElement?.tagName === "INPUT";
  if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) { e.preventDefault(); return e.key === "0" ? setScale(100) : stepScale(e.key === "-" ? -1 : 1); }
  if (e.altKey && /^[1-5]$/.test(e.key)) { e.preventDefault(); return setTab(TABS[Number(e.key) - 1]); }
  if (state.pending) {
    if (e.key === "Escape") cancel();
    else if (e.key === "Enter" && document.activeElement?.tagName !== "BUTTON") confirmPending(e.shiftKey || state.pending.kind === "kill" ? "kill" : "term");
    return;
  }
  if (e.key === "Escape") {
    if (openPop) return closePop();
    if (state.menuOpen) return closeMenu();
    if (typing) { $("q").blur(); return; }
    if (state.query) { $("q").value = ""; state.query = ""; return onFilter(); }
    state.sel.clear(); return selectionChanged();
  }
  if (state.tab !== "procs") return;
  if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); return; }
  if (typing) { if (e.key === "Enter") { $("q").blur(); if (state.view[0]) { state.sel = new Set([state.view[0].key]); selectionChanged(); } } return; }
  if (e.key === "ArrowDown") { e.preventDefault(); move(1, e.shiftKey); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, e.shiftKey); }
  else if (e.key === "Delete" && state.sel.size) ask(e.shiftKey ? "kill" : "term", selRows());
  else if ((e.ctrlKey || e.metaKey) && e.key === "a") { e.preventDefault(); state.sel = new Set(state.view.map((r) => r.key)); selectionChanged(); }
});

/* ───────────── Arranque ───────────── */
hydrateIcons();
document.documentElement.style.setProperty("--row-h", ROW_H + "px");
selScale.set(settings.scale); applyScale();
selLang.set(settings.lang); selInterval.set(settings.interval);
selUser.set(""); selState.set(""); selCpu.set(0); selMem.set(0);
paintMode(); paintHead(); paintSwitches(); applyTheme(); applyI18n();
invoke("system_info").then((i) => { state.sysinfo = i; renderSysInfo(); }).catch(() => {});
loop();
list.focus();
