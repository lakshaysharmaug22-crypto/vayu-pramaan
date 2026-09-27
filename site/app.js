/* Vayu Pramaan · site. Reads data/*.json written by the pipeline's export stage. No build step. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const FILES = ["overview", "live", "seasons", "season_points", "backtest", "findings", "decision", "agent", "ledger", "pipeline", "nomad",
  "whatif", "arena", "drift", "lineage", "catalog", "season_stations"];
const D = {};
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const BANDS = [[50, "Good", "--good"], [100, "Satisfactory", "--sat"], [200, "Moderate", "--mod"], [300, "Poor", "--poor"], [400, "Very poor", "--vpoor"], [1e9, "Severe", "--severe"]];
const band = a => BANDS.find(b => (a ?? 0) <= b[0]);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = x => x == null ? "–" : Math.round(x * 100) + "%";
const n0 = x => x == null ? "–" : Math.round(x).toLocaleString("en-IN");
const d8 = s => s ? new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "–";
const dY = s => s ? new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";
const FEAT = {
  aqi_0: "AQI on issue day", aqi_1: "AQI day before", aqi_ma3: "3-day AQI average", aqi_ma7: "7-day AQI average", pm25_0: "PM2.5 on issue day",
  fires_0: "Upwind fires today", fires_1: "Upwind fires yesterday", fires_2: "Upwind fires 2 days ago", fires_sum3: "Fires, 3-day total",
  fires_trend: "Fire trend", punjab_share_0: "Punjab share of fires", frp_0: "Fire radiative power", nw_frac_0: "Northwest wind share (Delhi)",
  nw_frac_upwind_0: "Northwest wind share (Punjab)", wind_speed_0: "Wind speed", blh_0: "Mixing height", blh_min_0: "Night mixing height",
  temp_0: "Temperature", rh_0: "Humidity", precip_0: "Rain", doy_sin: "Season (day of year)", doy_cos: "Season (day of year)",
  dow: "Day of week", diwali_dist: "Days from Diwali",
};

/* ───────────── svg charts ───────────── */
const sc = (d0, d1, r0, r1) => v => r0 + (v - d0) / ((d1 - d0) || 1) * (r1 - r0);
const svg = (w, h, inner, label = "") => `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${inner}</svg>`;
function lineChart({ n, series = [], band: b, y0, y1, thresholds = [], xl = [], w = 320, h = 150, pad = [10, 10, 22, 34], yt }) {
  const [t, r, bt, l] = pad, x = sc(0, Math.max(1, n - 1), l, w - r), y = sc(y0, y1, h - bt, t);
  const fy = v => (y1 - y0) <= 2 ? v.toFixed(1) : Math.round(v).toLocaleString("en-IN");
  let g = "";
  (yt || [y0, (y0 + y1) / 2, y1]).forEach(v => g += `<line x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${l - 5}" y="${y(v) + 3}" text-anchor="end">${fy(v)}</text>`);
  thresholds.forEach(th => g += `<line x1="${l}" x2="${w - r}" y1="${y(th.y)}" y2="${y(th.y)}" stroke="${th.c}" stroke-dasharray="3 3" opacity=".8"/><text class="lbl" x="${w - r}" y="${y(th.y) - 4}" text-anchor="end" style="fill:${th.c}">${esc(th.label)}</text>`);
  if (b) {
    const up = b.hi.map((v, i) => v == null ? null : `${x(i)},${y(Math.min(y1, v))}`).filter(Boolean);
    const dn = b.lo.map((v, i) => v == null ? null : `${x(i)},${y(Math.max(y0, v))}`).filter(Boolean).reverse();
    g += `<polygon points="${up.concat(dn).join(" ")}" fill="${b.c}" opacity=".22"/>`;
  }
  series.forEach(s => {
    let d = "", pen = false;
    s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(Math.max(y0, Math.min(y1, v))).toFixed(1)}`; pen = true; });
    if (s.area) g += `<path d="${d}L${x(n - 1)} ${y(y0)}L${x(0)} ${y(y0)}Z" fill="${s.c}" opacity=".12"/>`;
    g += `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="${s.w || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
    if (s.dots) s.v.forEach((v, i) => v != null && (g += `<circle cx="${x(i)}" cy="${y(v)}" r="${s.r || 3}" fill="${s.dotC ? s.dotC(v, i) : s.c}"/>`));
    if (s.end) { const i = s.v.length - 1; if (s.v[i] != null) g += `<circle cx="${x(i)}" cy="${y(s.v[i])}" r="4" fill="${s.c}" stroke="var(--surface)" stroke-width="2"/>`; }
  });
  xl.forEach(([i, lab]) => g += `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(lab)}</text>`);
  return svg(w, h, g);
}
function bars(items, { w = 320, h = 150, max, fmt = n0, pad = 24 } = {}) {
  const m = max || Math.max(...items.map(i => i.v || 0)) * 1.15 || 1, bw = (w - 20) / items.length;
  let g = `<line x1="0" x2="${w}" y1="${h - pad}" y2="${h - pad}" stroke="var(--line-2)"/>`;
  items.forEach((it, i) => {
    const bh = (it.v || 0) / m * (h - pad - 16), x = 10 + i * bw + bw * .18, bw2 = bw * .64;
    g += `<rect x="${x}" y="${h - pad - bh}" width="${bw2}" height="${bh}" rx="4" fill="${it.c}"/><text class="lbl" x="${x + bw2 / 2}" y="${h - pad - bh - 5}" text-anchor="middle">${fmt(it.v)}</text><text x="${x + bw2 / 2}" y="${h - 8}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  return svg(w, h, g);
}
function hbars(items, { w = 320, rowH = 22, fmt = v => pct(v), labelW = 150 } = {}) {
  const m = Math.max(...items.map(i => i.v)) || 1, h = items.length * rowH + 4;
  let g = "";
  items.forEach((it, i) => {
    const y = i * rowH + 2, bw = (it.v / m) * (w - labelW - 44);
    g += `<text class="lbl" x="${labelW - 8}" y="${y + 14}" text-anchor="end">${esc(it.label)}</text><rect x="${labelW}" y="${y + 4}" width="${Math.max(2, bw)}" height="${rowH - 9}" rx="3" fill="${it.c}"/><text x="${labelW + bw + 6}" y="${y + 14}">${fmt(it.v)}</text>`;
  });
  return svg(w, h, g);
}
function spark(vals, c, w = 120, h = 28) {
  const v = vals.filter(x => x != null); if (v.length < 2) return "";
  const mn = Math.min(...v), mx = Math.max(...v);
  return lineChart({ n: vals.length, series: [{ v: vals, c, w: 1.6, area: true, end: true }], y0: mn - (mx - mn) * .1, y1: mx + (mx - mn) * .1 || mx + 1, w, h, pad: [3, 4, 3, 4], yt: [] });
}
const kw = sql => esc(sql).replace(/\b(select|from|where|group by|order by|join|left join|on|as|and|or|not|in|between|with|limit|over|partition by|filter|case|when|then|else|end|having|distinct|using|values|qualify|desc|asc|exists|union)\b/gi, m => `<span class="kw">${m}</span>`)
  .replace(/\b(avg|count|sum|round|corr|lag|median|quantile_cont|min|max|abs|month|year|dayofweek|date_trunc|nullif|greatest|range|row_number|cast)\b(?=\()/gi, m => `<span class="fn">${m}</span>`)
  .replace(/'[^']*'/g, m => `<span class="str">${m}</span>`);
const table = (cols, rows, max = 50) => `<div class="tbl"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, max).map(r => `<tr>${cols.map(c => { const v = r[c]; return `<td class="${typeof v === "number" ? "r num" : ""}">${v == null ? "–" : esc(typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toFixed(v < 10 ? 3 : 1)) : v)}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`;

/* ───────────── modal ───────────── */
const M = $("#modal");
$("#m-close").onclick = () => M.close();
M.addEventListener("click", e => { if (e.target === M) M.close(); });
function modal({ eyebrow = "", title, body, after }) {
  $("#m-eyebrow").textContent = eyebrow; $("#m-title").textContent = title;
  const b = $("#m-body"); b.innerHTML = ""; typeof body === "string" ? (b.innerHTML = body) : b.append(body);
  M.showModal(); b.scrollTop = 0; after && after(b);
}

/* ───────────── rows + cards ───────────── */
function row({ id, title, role, c, sub, cards }) {
  const s = document.createElement("section");
  s.className = "row"; s.id = id; s.style.setProperty("--c", `var(${c})`);
  s.innerHTML = `<div class="row-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div><div style="display:flex;gap:10px;align-items:center"><span class="role">${esc(role)}</span><div class="arrows"><button aria-label="Scroll left">‹</button><button aria-label="Scroll right">›</button></div></div></div><div class="scroller"></div>`;
  const sc = $(".scroller", s);
  cards.filter(Boolean).forEach(cd => sc.append(cd));
  const [lb, rb] = s.querySelectorAll(".arrows button");
  lb.onclick = () => sc.scrollBy({ left: -sc.clientWidth * .8, behavior: "smooth" });
  rb.onclick = () => sc.scrollBy({ left: sc.clientWidth * .8, behavior: "smooth" });
  $("#rows").append(s);
  return s;
}
function card({ title, eyebrow, body = "", foot, open, size = "", interactive = false }) {
  const el = document.createElement(interactive || !open ? "div" : "button");
  el.className = `card ${size}`;
  if (!interactive && open) el.type = "button";
  el.innerHTML = `${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}${title ? `<div class="k"><h3>${esc(title)}</h3></div>` : ""}<div class="cb">${body}</div>${foot !== null ? `<div class="foot"><span>${foot || ""}</span>${open ? `<span class="open">Open ›</span>` : ""}</div>` : ""}`;
  if (open) {
    if (interactive) $(".open", el).onclick = open; else el.onclick = open;
    if (interactive) $(".open", el).style.cursor = "pointer";
  }
  if (interactive) el.style.cursor = "default";
  return el;
}

/* ───────────── load ───────────── */
Promise.allSettled(FILES.map(f => fetch(`data/${f}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(f); return r.json(); })))
  .then(res => {
    res.forEach((r, i) => { D[FILES[i]] = r.status === "fulfilled" ? r.value : null; });
    if (!D.overview) { $("#hero").innerHTML = `<p class="skeleton">Couldn't load the forecast data. Run the pipeline to generate site/data.</p>`; return; }
    status(); banner(); hero(); forecastRow(); connectorsRow(); whatifRow(); arenaRow(); findingsRow(); deskRow(); askRow(); liveRow();
    pipelineRow(); lineageRow(); healthRow(); ledgerRow(); apiRow(); nomadRow(); search.init();
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  });

function status() {
  const p = D.pipeline?.latest, v = D.ledger?.verify;
  const st = p?.status === "failed" ? "bad" : (p && Object.values(p.stages || {}).some(s => s.status === "warn")) ? "warn" : "";
  $("#status").innerHTML = `<i class="dot ${st}"></i><span>Last run ${p ? new Date(p.finished).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–"} · ledger ${v?.head ? v.head.slice(0, 8) : "empty"} ${v?.ok ? "✓" : ""}</span>`;
}
function banner() {
  if (D.overview.synthetic) $("#banner").innerHTML = `<div class="banner"><b>Synthetic preview.</b> This build runs on generated test data so the site can be reviewed before the real pipeline runs. None of these numbers are observations.</div>`;
}

/* ───────────── hero + map ───────────── */
function hero() {
  const o = D.overview, f = [...(o.forecast || [])].sort((a, b) => a.horizon_h - b.horizon_h), t = f[0];
  if (!t) { $("#hero").innerHTML = `<p class="skeleton">No forecast yet.</p>`; return; }
  const b = band(t.p50), call = o.grap_call, head = D.ledger?.blocks?.slice(-1)[0];
  $("#hero").style.setProperty("--band", `var(${b[2]})`);
  $("#hero").innerHTML = `
    <div class="eyebrow" style="color:var(--ds)">Forecast · issued ${dY(t.issue_date)}</div>
    <h1>${d8(t.target_date)}: AQI <span class="aqi num">${n0(t.p50)}</span><br><span style="font-size:.62em;color:var(--band)">${b[1]}</span></h1>
    <p class="sub">80% range <b class="num">${n0(t.p10)}–${n0(t.p90)}</b>. ${pct(t.p_severe)} chance of a severe day (AQI above 400). Committed to the public ledger before the day happens.</p>
    <div class="chips">
      ${f.slice(1).map(x => { const bb = band(x.p50); return `<span class="chip" style="color:var(${bb[2]})"><i></i><span style="color:var(--text)">${d8(x.target_date)} · ${n0(x.p50)}</span></span>`; }).join("")}
      <span class="chip" style="color:${call?.act ? "var(--vpoor)" : "var(--qa)"}"><i></i><span style="color:var(--text)">GRAP: ${esc(call?.stage || "Hold")}</span></span>
      ${head ? `<span class="chip" style="color:var(--de)"><i></i><span style="color:var(--text)">Ledger block #${head.height}</span></span>` : ""}
    </div>
    <div class="btns"><button class="btn play" id="play">▶ Play the ${D.season_points?.season || ""} season</button><button class="btn ghost" id="why">Why this forecast</button></div>
    <div class="dock" aria-label="Quick actions"><button type="button" data-go="whatif">What if…</button><button type="button" data-go="verify">Verify ledger</button><button type="button" data-go="ask">Ask Vayu</button><button type="button" data-go="api">Open data</button><button type="button" data-go="search">Search <kbd>/</kbd></button></div>`;
  $("#why").onclick = () => whyModal();
  $("#play").onclick = () => VayuMap.play();
  $("#hero").querySelectorAll("[data-go]").forEach(b => b.onclick = () => {
    const g = b.dataset.go;
    if (g === "search") return search.open();
    if (g === "verify") { const bl = D.ledger?.blocks || []; if (bl.length) return verifyModal(bl[bl.length - 1], bl[bl.length - 2]); }
    document.getElementById(g === "verify" ? "ledger" : g)?.scrollIntoView({ behavior: "smooth" });
  });
  VayuMap.init(D, { station: s => { const b = band(s.aqi); modal({ eyebrow: "Monitoring station", title: s.station,
    body: `<div style="display:flex;align-items:baseline;gap:12px"><span class="big num" style="font-size:52px;color:${s.aqi > 400 ? "var(--red)" : `var(${b[2]})`}">${n0(s.aqi)}</span><b>${b[1]}</b></div>${table(Object.keys(s).filter(k => k !== "pos"), [s])}<p class="dim" style="margin:0;font-size:12px">Map position is approximate.</p>` }); } });
  kpis();
}

function kpis() {
  const o = D.overview, L = D.live || {}, fc = o.forecast || [], peak = fc.reduce((m, f) => f.p50 > (m?.p50 ?? -1) ? f : m, null);
  const w = (L.wind || []).slice(-1)[0] || {}, f24 = (L.fires_daily || []).slice(-1)[0] || {}, m = D.backtest?.metrics?.overall_48h || {};
  const P = D.pipeline?.latest?.stages || {}, cp = Object.values(P).reduce((s, x) => s + (x.checks_passed || 0), 0), ct = Object.values(P).reduce((s, x) => s + (x.checks_total || 0), 0);
  const K = [
    ["Delhi AQI now", o.latest?.aqi, band(o.latest?.aqi)[1], o.latest?.aqi > 400 ? "var(--red)" : `var(${band(o.latest?.aqi)[2]})`],
    ["72h peak forecast", peak?.p50, peak ? d8(peak.target_date) : "", peak?.p50 > 400 ? "var(--red)" : `var(${band(peak?.p50)[2]})`],
    ["Upwind fires, 24h", f24.fires, "Punjab + Haryana", "var(--ds)"],
    ["Northwest wind", w.nw_frac != null ? Math.round(w.nw_frac * 100) : null, "% of hours · smoke corridor", w.nw_frac > .5 ? "var(--red)" : "var(--text)"],
    ["Night mixing height", w.blh_min, "metres · lower traps smoke", w.blh_min < 300 ? "var(--red)" : "var(--text)"],
    ["Skill vs persistence", m.skill_vs_persistence != null ? Math.round(m.skill_vs_persistence * 100) : null, "% lower error, 48h", "var(--text)"],
    ["Ledger blocks", D.ledger?.verify?.blocks ?? 0, D.ledger?.verify?.ok ? "chain intact" : "chain problem", D.ledger?.verify?.ok ? "var(--text)" : "var(--red)"],
    ["Pipeline checks", cp, `of ${ct} passed`, cp < ct ? "var(--ba)" : "var(--text)"],
  ];
  $("#kpis").innerHTML = K.map(([k, v, s, c]) => `<div class="kpi"><span class="k">${k}</span><b class="num" data-v="${v ?? ""}" style="color:${c}">${v == null ? "–" : "0"}</b><span class="s">${esc(s)}</span></div>`).join("");
  $("#kpis").querySelectorAll("b[data-v]").forEach(b => { const v = +b.dataset.v; if (!b.dataset.v) return; if (reduce) { b.textContent = n0(v); return; }
    const t0 = performance.now(); const step = t => { const k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3); b.textContent = n0(v * e); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); });
}
function connectorsRow() {
  const Lg = D.lineage?.nodes || [], fresh = id => Lg.find(n => n.id === id)?.freshness, age = d => d ? Math.round((Date.now() - new Date(String(d).slice(0, 10) + "T00:00:00")) / 864e5) : null;
  const light = d => { const a = age(d); return a == null ? ["–", "var(--dim)"] : a <= 2 ? ["Live", "var(--qa)"] : a <= 7 ? [`${a}d old`, "var(--ba)"] : [`${a}d old`, "var(--red)"]; };
  const N = D.nomad || {}, V = D.ledger?.verify || {};
  const C = [
    ["NASA FIRMS", "VIIRS fire detections · 375 m", fresh("raw_fires"), "https://firms.modaps.eosdis.nasa.gov/", "Ingest"],
    ["CPCB stations", "PM2.5 + PM10, hourly", fresh("raw_aqi") || D.overview.latest?.date, "https://airquality.cpcb.gov.in/", "Ingest"],
    ["Open-Meteo", "Wind, mixing height, weather", fresh("raw_weather"), "https://open-meteo.com/", "Ingest"],
    ["Copernicus CAMS", "Global air-quality model", fresh("raw_cams"), "https://atmosphere.copernicus.eu/", "Ingest · benchmark"],
    ["GitHub Actions", `Daily 06:00 IST run · ${V.blocks ?? 0} ledger blocks`, D.pipeline?.latest?.finished, "https://github.com/features/actions", "Orchestration"],
    ["OpenTimestamps", "Bitcoin-anchored proof of each day's forecasts", D.pipeline?.latest?.finished, "https://opentimestamps.org/", "Proof"],
    ["Nomad Loop Engine", N.status === "complete" ? `${N.verdict} · ${(N.flows || []).length} flows` : "Awaiting first QA run", N.finished || null, "https://github.com/lakshaysharmaug22-crypto/nomad-loop-engine", "Release gate"],
    ["Public API", `${D.catalog?.datasets?.length || 0} JSON endpoints + OpenAPI`, D.catalog?.generated_at, "#api", "Output"],
  ];
  const cards = C.map(([t, s, f, href, role]) => { const [lt, lc] = light(f); const c = card({ eyebrow: role, title: t,
    body: `<p class="take muted" style="margin:0">${esc(s)}</p><div style="display:flex;align-items:center;gap:8px;font-size:12.5px"><i style="width:8px;height:8px;border-radius:50%;background:${lc};display:inline-block"></i><span style="color:${lc}">${lt}</span><span class="dim">${f ? "· " + dY(f) : ""}</span></div>`,
    foot: `<a href="${href}" ${href.startsWith("#") ? "" : 'target="_blank" rel="noopener"'} onclick="event.stopPropagation()" style="color:var(--text)">${href.startsWith("#") ? "Open" : "Visit"} ›</a>`, open: null });
    c.classList.add("black"); return c; });
  row({ id: "connectors", title: "Connected systems", role: "Integrations", c: "--red", sub: "Every source and service this site depends on, with a live freshness light. Green is fresh, amber is stale, red needs attention.", cards });
}
function whyModal() {
  const o = D.overview, e = (o.explain || {})["48"] || (o.explain || {})["24"] || [], br = o.brief || {};
  const items = e.map(x => ({ label: FEAT[x.feature] || x.feature, v: x.aqi_points }));
  const w = 520, rh = 26, mx = Math.max(1, ...items.map(i => Math.abs(i.v))), mid = 250;
  let g = `<line x1="${mid}" x2="${mid}" y1="0" y2="${items.length * rh}" stroke="var(--line-2)"/>`;
  items.forEach((it, i) => {
    const bw = Math.abs(it.v) / mx * 190, y = i * rh;
    g += `<text class="lbl" x="${it.v >= 0 ? mid - 8 : mid + 8}" y="${y + 16}" text-anchor="${it.v >= 0 ? "end" : "start"}">${esc(it.label)}</text><rect x="${it.v >= 0 ? mid : mid - bw}" y="${y + 5}" width="${bw}" height="${rh - 10}" rx="3" fill="${it.v >= 0 ? "var(--vpoor)" : "var(--de)"}"/><text x="${it.v >= 0 ? mid + bw + 6 : mid - bw - 6}" y="${y + 16}" text-anchor="${it.v >= 0 ? "start" : "end"}">${it.v > 0 ? "+" : ""}${it.v}</text>`;
  });
  modal({
    eyebrow: "Data Science · 48-hour forecast", title: "Why this forecast",
    body: `<p class="muted" style="margin:0">Each bar is one input's contribution to the forecast AQI, in AQI points (SHAP values from the model). Red pushes the forecast up, teal pulls it down.</p>
      ${svg(w, items.length * rh + 4, g)}
      <div><div class="eyebrow" style="margin-bottom:6px">Daily brief · ${esc(br.generated_by || "")}</div><p style="margin:0;white-space:pre-wrap">${esc(br.text || "No brief generated in this run.")}</p></div>`,
  });
}

/* ───────────── rows ───────────── */
function forecastRow() {
  const o = D.overview, bt = D.backtest?.metrics || {}, m = bt.overall_48h || {}, byH = bt.by_horizon || [];
  const fc = [...(o.forecast || [])].sort((a, b) => a.horizon_h - b.horizon_h);
  const days = fc.map(f => {
    const b = band(f.p50);
    return card({
      eyebrow: `+${f.horizon_h}h · ${d8(f.target_date)}`, title: "", foot: `P(severe) ${pct(f.p_severe)}`,
      body: `<div class="big num" style="color:var(${b[2]})">${n0(f.p50)}</div><div style="font-weight:600">${b[1]}</div><div class="muted num" style="font-size:13px">80% range ${n0(f.p10)}–${n0(f.p90)}</div>${bandStrip(f)}`,
      open: () => whyModal(),
    });
  });
  const h48 = D.backtest?.h48 || [];
  const lastSeason = Math.max(...h48.map(r => r.season || 0));
  const s = h48.filter(r => r.season === lastSeason);
  const scoreboard = card({
    size: "wide", eyebrow: "Walk-forward backtest · 48h ahead", title: "Model vs baselines",
    body: `${bars([{ label: "Vayu model", v: m.mae, c: "var(--ds)" }, { label: "Persistence", v: m.mae_persistence, c: "var(--surface-3)" }, { label: "Climatology", v: m.mae_climatology, c: "var(--surface-3)" }], { h: 140, fmt: v => v == null ? "–" : v.toFixed(1) })}
      <div class="stat-row"><div class="stat"><b class="num">${pct(m.skill_vs_persistence)}</b><span>lower error than persistence</span></div><div class="stat"><b class="num">${pct(m.coverage_80)}</b><span>inside the 80% band</span></div><div class="stat"><b class="num">${m.hits ?? "–"}/${m.severe_days ?? "–"}</b><span>severe days caught</span></div></div>`,
    foot: `Mean absolute error in AQI points · ${m.n || 0} forecasts`, open: () => backtestModal(),
  });
  const season = card({
    size: "wide", eyebrow: `${lastSeason} season · 48h ahead`, title: "Forecast band vs what happened",
    body: lineChart({ n: s.length, w: 480, h: 170, y0: 0, y1: Math.max(500, ...s.map(r => r.actual || 0)), yt: [0, 200, 400], band: { lo: s.map(r => r.p10), hi: s.map(r => r.p90), c: "var(--ds)" },
      series: [{ v: s.map(r => r.p50), c: "var(--ds)", w: 1.6 }, { v: s.map(r => r.actual), c: "#fff", w: 1.4, dots: true, r: 1.8 }],
      thresholds: [{ y: 400, label: "severe", c: "var(--vpoor)" }], xl: s.length ? [[0, d8(s[0].target_date)], [s.length - 1, d8(s[s.length - 1].target_date)]] : [] }),
    foot: "White dots: observed · orange: forecast median and 80% band", open: () => backtestModal(),
  });
  const cal = D.backtest?.calibration || [];
  const calib = card({
    eyebrow: "Probability check", title: "Is 70% really 70%?",
    body: calChart(cal, 290), foot: "Predicted vs observed severe-day rate", open: () => backtestModal(),
  });
  const imp = (o.importance || {})["48"] || [];
  const drivers = card({
    eyebrow: "What the model listens to", title: "Top inputs",
    body: hbars(imp.slice(0, 6).map(i => ({ label: FEAT[i.feature] || i.feature, v: i.share, c: "var(--ds)" })), { w: 300, labelW: 160 }),
    foot: "Share of model gain, 48h model", open: () => whyModal(),
  });
  row({ id: "forecast", title: "Next 72 hours", role: "Data Science", c: "--ds", sub: "Quantile forecasts with conformal calibration, scored against persistence and climatology on seasons the model never saw.", cards: [...days, scoreboard, season, calib, drivers] });
}
function bandStrip(f) {
  const w = 280, x = sc(0, 500, 0, w);
  let g = BANDS.map((b, i) => { const lo = i ? BANDS[i - 1][0] : 0, hi = Math.min(500, b[0]); return `<rect x="${x(lo)}" y="10" width="${x(hi) - x(lo)}" height="6" fill="var(${b[2]})" opacity=".35"/>`; }).join("");
  g += `<rect x="${x(Math.max(0, f.p10))}" y="6" width="${x(Math.min(500, f.p90)) - x(Math.max(0, f.p10))}" height="14" rx="7" fill="#fff" opacity=".18"/><circle cx="${x(Math.min(500, f.p50))}" cy="13" r="5" fill="#fff"/>`;
  return svg(w, 26, g);
}
function calChart(cal, w = 300) {
  const h = 170, l = 30, b = 22, x = sc(0, 1, l, w - 8), y = sc(0, 1, h - b, 8);
  let g = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--line-2)" stroke-dasharray="3 3"/>`;
  [0, .5, 1].forEach(v => g += `<text x="${x(v)}" y="${h - 6}" text-anchor="middle">${v}</text><text x="${l - 5}" y="${y(v) + 3}" text-anchor="end">${v}</text>`);
  g += `<path d="${cal.map((c, i) => `${i ? "L" : "M"}${x(c.predicted)} ${y(c.observed)}`).join("")}" fill="none" stroke="var(--ds)" stroke-width="1.8"/>`;
  cal.forEach(c => g += `<circle cx="${x(c.predicted)}" cy="${y(c.observed)}" r="${3 + Math.sqrt(c.n) / 4}" fill="var(--ds)" opacity=".8"/>`);
  return svg(w, h, g);
}
function backtestModal() {
  const bt = D.backtest?.metrics || {};
  const cols = ["horizon_h", "mae", "mae_persistence", "mae_climatology", "skill_vs_persistence", "dm_pvalue_vs_persistence", "coverage_80", "hit_rate", "false_alarm_ratio", "csi", "brier_severe"];
  const scols = ["season", "n", "mae", "mae_persistence", "skill_vs_persistence", "coverage_80", "severe_days", "hits", "false_alarms"];
  modal({
    eyebrow: "Data Science · walk-forward backtest", title: "How the forecast is graded",
    body: `<p class="muted" style="margin:0">Each season is forecast by a model trained only on data before it (expanding window). Bands are widened or narrowed with split-conformal calibration so the 80% band means 80%. The DM p-value tests whether the error gap to persistence could be chance.</p>
      <h3>By horizon</h3>${table(cols, bt.by_horizon || [])}<h3>By season (48h)</h3>${table(scols, bt.by_season || [])}
      <h3>Calibration of P(severe)</h3>${calChart(D.backtest?.calibration || [], 420)}`,
  });
}

function findingsRow() {
  const F = D.findings || [];
  const cards = F.map(f => card({
    title: f.title, eyebrow: "SQL finding",
    body: (f.error ? `<p class="bad-t">${esc(f.error)}</p>` : findingChart(f, 300)) + `<p class="take">${esc(f.takeaway || "")}</p>`,
    foot: "Query + result", open: () => openFinding(f),
  }));
  cards.push(card({ title: "KPI dictionary", eyebrow: "Shared definitions", body: `<p class="take">One definition per metric, used by every chart, the decision desk and the agent.</p>`, foot: "8 metrics", open: kpiModal }));
  row({ id: "findings", title: "Smog findings", role: "Data Analyst", c: "--da", sub: "Six questions about where Delhi's smog comes from, each answered by one query you can read.", cards });
}
function openFinding(f) {
  modal({ eyebrow: "Data Analyst · DuckDB", title: f.title,
    body: `<p style="margin:0;font-size:16px">${esc(f.takeaway || "")}</p>${findingChart(f, 640)}${f.rows ? table(Object.keys(f.rows[0] || {}), f.rows) : ""}<div><div class="eyebrow" style="margin-bottom:6px">Query</div><pre>${kw(f.sql)}</pre></div>` });
}
function findingChart(f, w) {
  const r = f.rows || [], big = w > 400, h = big ? 220 : 140;
  if (f.id === "lag") { const i = r.reduce((m, x, k) => x.r > r[m].r ? k : m, 0); return lineChart({ n: r.length, w, h, y0: 0, y1: 1, yt: [0, .5, 1], series: [{ v: r.map(x => x.r), c: "var(--da)", area: true, dots: true, dotC: (v, k) => k === i ? "var(--ds)" : "var(--da)" }], xl: r.map((x, k) => [k, x.lag_h + "h"]) }); }
  if (f.id === "wind" || f.id === "calendar") return bars(r.map((x, k) => ({ label: x.wind || x.bucket, v: x.avg_aqi, c: k ? "var(--surface-3)" : "var(--da)" })), { w, h });
  if (f.id === "floor" && r[0]) { const x = sc(0, 500, 10, w - 10), q = r[0]; let g = BANDS.map((b, i) => { const lo = i ? BANDS[i - 1][0] : 0, hi = Math.min(500, b[0]); return `<rect x="${x(lo)}" y="${h / 2 - 5}" width="${x(hi) - x(lo)}" height="10" fill="var(${b[2]})" opacity=".45"/>`; }).join(""); g += `<rect x="${x(q.p25)}" y="${h / 2 - 16}" width="${x(q.p75) - x(q.p25)}" height="32" rx="6" fill="none" stroke="var(--da)" stroke-width="2"/><line x1="${x(q.local_floor)}" x2="${x(q.local_floor)}" y1="${h / 2 - 22}" y2="${h / 2 + 22}" stroke="#fff" stroke-width="2.5"/><text class="lbl" x="${x(q.local_floor)}" y="${h / 2 - 28}" text-anchor="middle">median ${n0(q.local_floor)}</text>`; [0, 100, 200, 300, 400, 500].forEach(v => g += `<text x="${x(v)}" y="${h - 8}" text-anchor="middle">${v}</text>`); return svg(w, h, g); }
  if (f.id === "states") { const rh = big ? 22 : 13, hh = r.length * rh + 22; let g = ""; r.forEach((x, k) => { const y = k * rh, ww = w - 44, p = (x.punjab_pct || 0) / 100; g += `<text x="36" y="${y + rh - 5}" text-anchor="end">${x.season}</text><rect x="42" y="${y + 2}" width="${ww * p}" height="${rh - 4}" fill="var(--ds)" rx="2"/><rect x="${42 + ww * p}" y="${y + 2}" width="${ww * (1 - p)}" height="${rh - 4}" fill="var(--da)" rx="2"/>`; }); g += `<text class="lbl" x="42" y="${hh - 4}" style="fill:var(--ds)">Punjab</text><text class="lbl" x="${w - 2}" y="${hh - 4}" text-anchor="end" style="fill:var(--da)">Haryana</text>`; return svg(w, hh, g); }
  if (f.id === "cams") { const p = (f.points || []).filter(x => x.observed != null && x.cams != null), mx = Math.max(500, ...p.map(x => x.observed)), X = sc(0, mx, 30, w - 8), Y = sc(0, mx, h - 20, 8); let g = `<rect x="${X(400)}" y="${Y(mx)}" width="${X(mx) - X(400)}" height="${Y(400) - Y(mx)}" fill="var(--vpoor)" opacity=".1"/><line x1="${X(0)}" y1="${Y(0)}" x2="${X(mx)}" y2="${Y(mx)}" stroke="var(--line-2)" stroke-dasharray="3 3"/>`; p.forEach(x => { const miss = x.observed > 400 && x.cams <= 400; g += `<circle cx="${X(x.observed)}" cy="${Y(x.cams)}" r="${miss ? 3 : 2}" fill="${miss ? "var(--ds)" : "var(--da)"}" opacity="${miss ? .95 : .45}"/>`; }); g += `<text x="${w - 8}" y="${h - 6}" text-anchor="end">observed →</text><text x="32" y="16">CAMS ↑</text>`; return svg(w, h, g); }
  return "";
}
function kpiModal() {
  const K = [["Severe day", "Daily city AQI above 400 on the CPCB scale.", "v_aqi_daily"], ["City AQI", "Mean of station AQIs; each station AQI is the max of its 24h PM2.5 and PM10 sub-indices (≥16 valid hours).", "v_aqi_daily"],
    ["Upwind fire load", "VIIRS fire detections in Punjab and Haryana per day.", "v_fires_upwind"], ["Northwest wind share", "Share of hours with wind from 270–340° at Delhi.", "v_wind_daily"],
    ["Hit rate", "Severe days warned ÷ all severe days.", "v_forecasts"], ["False-alarm ratio", "Warnings without a severe day ÷ all warnings.", "v_forecasts"],
    ["Coverage (80%)", "Share of days where observed AQI fell inside p10–p90.", "v_forecasts"], ["Skill vs persistence", "1 − model MAE ÷ persistence MAE, same days and horizon.", "v_forecasts"]];
  modal({ eyebrow: "Data Analyst", title: "KPI dictionary", body: table(["Metric", "Definition", "View"], K.map(k => ({ Metric: k[0], Definition: k[1], View: k[2] }))) });
}

function deskRow() {
  const T = D.decision?.table?.thresholds || [], fc = D.overview.forecast || [], stt = { cfa: 40, cmiss: 220 };
  if (!T.length) { row({ id: "desk", title: "GRAP decision desk", role: "Business Analyst", c: "--ba", cards: [card({ title: "Not enough backtest data yet", body: "" })] }); return; }
  const callCard = card({ eyebrow: "Today's call", title: "", body: `<div id="call"></div>`, foot: "Threshold follows your cost settings" });
  const tradeCard = card({
    size: "xwide", interactive: true, eyebrow: "Your assumptions · ₹ crore per day", title: "Cost trade-off",
    body: `<div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="ctrl"><label for="cfa">False alarm (needless restrictions) <b id="cfav"></b></label><input type="range" id="cfa" min="5" max="200" step="5" value="${stt.cfa}"></div>
        <div class="ctrl"><label for="cmiss">Missed severe day (exposure) <b id="cmissv"></b></label><input type="range" id="cmiss" min="10" max="600" step="10" value="${stt.cmiss}"></div>
        <div id="thr" class="muted" style="font-size:13px"></div>
        <div class="stat-row"><div class="stat"><b class="num" id="sw"></b><span>severe days warned 48h ahead</span></div><div class="stat"><b class="num" id="sfa"></b><span>false alarms</span></div><div class="stat"><b class="num" id="ssv"></b><span>vs reacting on the day</span></div></div>
      </div><div id="costcurve"></div></div>`,
    foot: `Backtest over ${D.decision.table.days} forecast days · ${D.decision.table.severe_days} severe`, open: () => memoModal(stt),
  });
  const cmCard = card({ eyebrow: "Backtest outcomes", title: "Decision matrix", body: `<div id="cm"></div>`, foot: "At your threshold" });
  const memoCard = card({ eyebrow: "One page", title: "Stakeholder memo", body: `<p class="take">Recommendation, evidence and backtest performance, written for the response cell. Updates with your cost settings.</p>`, foot: "Copy-ready", open: () => memoModal(stt) });
  row({ id: "desk", title: "GRAP decision desk", role: "Business Analyst", c: "--ba", sub: "Turns the forecast into a GRAP stage call. Set what a false alarm and a missed severe day cost; the warning threshold and season cost update live.", cards: [callCard, tradeCard, cmCard, memoCard] });
  const upd = () => {
    stt.cfa = +$("#cfa").value; stt.cmiss = +$("#cmiss").value;
    const th = stt.cfa / (stt.cfa + stt.cmiss), r = T.reduce((b, x) => Math.abs(x.threshold - th) < Math.abs(b.threshold - th) ? x : b, T[0]);
    stt.th = r.threshold; stt.r = r;
    const cost = r.fp * stt.cfa + r.fn * stt.cmiss, react = (r.tp + r.fn) * stt.cmiss, save = react - cost;
    $("#cfav").textContent = `₹${stt.cfa} Cr`; $("#cmissv").textContent = `₹${stt.cmiss} Cr`;
    $("#thr").innerHTML = `Warn when P(severe) ≥ <b class="mono" style="color:var(--ba)">${pct(r.threshold)}</b>, the false-alarm cost ÷ (false-alarm cost + miss cost).`;
    $("#sw").textContent = `${r.tp}/${r.tp + r.fn}`; $("#sfa").textContent = r.fp;
    $("#ssv").textContent = `${save >= 0 ? "−" : "+"}₹${n0(Math.abs(save))}`; $("#ssv").style.color = save >= 0 ? "var(--qa)" : "var(--vpoor)";
    $("#cm").innerHTML = `<div class="cm"><div class="h"></div><div class="h">Severe</div><div class="h">Not severe</div><div class="h" style="text-align:left">Warned</div><div class="tp"><b class="num">${r.tp}</b>caught</div><div class="fp"><b class="num">${r.fp}</b>false alarm</div><div class="h" style="text-align:left">Not warned</div><div class="fn"><b class="num">${r.fn}</b>missed</div><div><b class="num">${r.tn}</b>correct quiet</div></div>`;
    const costs = T.map(x => x.fp * stt.cfa + x.fn * stt.cmiss), i = T.indexOf(r);
    $("#costcurve").innerHTML = lineChart({ n: T.length, w: 360, h: 170, y0: 0, y1: Math.max(...costs) * 1.08, yt: [0, Math.max(...costs) / 2, Math.max(...costs)], series: [{ v: costs, c: "var(--ba)", area: true }, { v: costs.map((c, k) => k === i ? c : null), c: "#fff", dots: true, r: 5 }], xl: [[0, "2%"], [T.length - 1, "98%"], [i, pct(r.threshold)]] }) + `<div class="muted" style="font-size:12px">Season cost (₹ Cr) at every threshold · white dot = yours</div>`;
    const top = [...fc].sort((a, b) => b.p_severe - a.p_severe)[0];
    if (top) { const act = top.p_severe >= r.threshold, st = top.p50 > 450 ? "Stage IV" : top.p50 > 400 ? "Stage III" : top.p50 > 300 ? "Stage II" : top.p50 > 200 ? "Stage I" : "Stage I";
      $("#call").innerHTML = `<div class="big" style="color:${act ? "var(--vpoor)" : "var(--qa)"}">${act ? esc(st) : "Hold"}</div><p class="take" style="margin-top:8px">${act ? `Pre-announce for ${d8(top.target_date)}: P(severe) ${pct(top.p_severe)} clears your ${pct(r.threshold)} threshold, ${top.horizon_h} hours ahead.` : `Highest P(severe) in the next 72 hours is ${pct(top.p_severe)}, below your ${pct(r.threshold)} threshold.`}</p>`; }
  };
  ["cfa", "cmiss"].forEach(id => $("#" + id).addEventListener("input", upd)); upd();
}
function memoModal(stt) {
  const r = stt.r, fc = [...(D.overview.forecast || [])].sort((a, b) => b.p_severe - a.p_severe), top = fc[0], F = Object.fromEntries((D.findings || []).map(f => [f.id, f]));
  const act = top && top.p_severe >= r.threshold, cost = r.fp * stt.cfa + r.fn * stt.cmiss, react = (r.tp + r.fn) * stt.cmiss;
  const text = `To: Air quality response cell\nFrom: Vayu Pramaan forecasting desk\nRe: GRAP call for the next 72 hours\n\nRecommendation\n${act ? `Pre-announce restrictions for ${d8(top.target_date)} (forecast AQI ${n0(top.p50)}, 80% range ${n0(top.p10)}–${n0(top.p90)}, P(severe) ${pct(top.p_severe)}).` : "Hold at the current GRAP stage and re-check after the next run."}\n\nEvidence\n• ${F.lag?.takeaway || ""}\n• ${F.wind?.takeaway || ""}\n• ${F.cams?.takeaway || ""}\n\nPolicy performance (walk-forward backtest, 48h ahead)\n• Warning threshold: P(severe) ≥ ${pct(r.threshold)}\n• Severe days warned 48h ahead: ${r.tp} of ${r.tp + r.fn}\n• False alarms: ${r.fp}\n• Cost under stated assumptions: ₹${n0(cost)} Cr vs ₹${n0(react)} Cr reacting on the day\n\nAssumptions\nFalse alarm ₹${stt.cfa} Cr/day; missed severe day ₹${stt.cmiss} Cr/day. Planning inputs set by the reader, not measured costs.`;
  modal({ eyebrow: "Business Analyst", title: "Stakeholder memo", body: `<div class="memo" id="memo">${esc(text)}</div><div><button class="btn small ghost" id="cp">Copy memo</button></div>`,
    after: b => { $("#cp", b).onclick = () => { const btn = $("#cp", b); navigator.clipboard?.writeText(text).then(() => btn.textContent = "Copied", () => { getSelection().selectAllChildren($("#memo", b)); btn.textContent = "Selected. Press Ctrl+C"; }); }; } });
}

function askRow() {
  const A = D.agent || { results: [] }, br = D.overview.brief || {};
  const brief = card({ size: "wide", eyebrow: `Daily AI brief · ${esc(br.generated_by || "not generated")}`, title: "Today in three paragraphs",
    body: `<p class="take" style="white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden">${esc(br.text || "The brief is written by the LLM in the daily run from the facts below the forecast. It hasn't run in this build.")}</p>`,
    foot: "Written only from the run's facts", open: () => whyModal() });
  const cats = Object.entries(A.by_category || {});
  const evalCard = card({ eyebrow: "25 hand-checked questions", title: "Agent eval",
    body: A.passed == null ? `<div class="big muted">Pending</div><p class="take">The eval runs in the daily job once an LLM key is set. The 25 questions and their reference queries are ready; open any question to see its checked answer.</p>`
      : `<div class="big num" style="color:var(--ai)">${A.passed}/${A.total}</div>${cats.map(([k, v]) => `<div><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(k)}</span><span class="mono">${v.passed}/${v.total}</span></div><div class="bar"><i style="width:${v.passed / v.total * 100}%"></i></div></div>`).join("")}`,
    foot: A.model ? `Model: ${esc(A.model)}` : "Pass = result matches the reference query" });
  const qs = (A.results || []).map(r => card({ eyebrow: r.category, title: r.question,
    body: r.passed == null ? "" : `<span class="pill ${r.passed ? "ok" : "bad"}">${r.passed ? "✓ matched reference" : "✗ didn't match"}</span>`,
    foot: "SQL + answer", open: () => askModal(r) }));
  row({ id: "ask", title: "Ask Vayu", role: "AI Analytics", c: "--ai", sub: "A text-to-SQL agent over read-only, whitelisted views. It writes the query, runs it, checks it and explains the result. The SQL is always shown.", cards: [brief, evalCard, ...qs] });
}
function askModal(r) {
  const steps = ["Parse question", "Pick views", "Write SQL", "Guard + run", "Check result", "Explain"];
  modal({ eyebrow: `AI Analytics · ${r.category}`, title: r.question,
    body: `<div class="steps">${steps.map(s => `<span class="step">${s}</span>`).join("")}</div><div id="ans"></div>`,
    after: b => {
      const st = [...b.querySelectorAll(".step")], tick = reduce ? 0 : 260;
      st.forEach((s, k) => setTimeout(() => { if (k) st[k - 1].className = "step done"; s.className = "step on"; if (k === st.length - 1) setTimeout(() => { s.className = "step done"; show(); }, tick); }, k * tick));
      function show() {
        const cols = r.columns || Object.keys((r.rows || [])[0] || {});
        $("#ans", b).innerHTML = `${r.answer ? `<p style="margin:0;font-size:16px">${esc(r.answer)}</p>` : `<p class="muted" style="margin:0">The agent's LLM run hasn't happened in this build, so this shows the hand-checked reference query and its result. In the daily run the agent answers this itself and is graded against it.</p>`}
          ${r.error ? `<p class="bad-t">${esc(r.error)}</p>` : ""}${cols.length ? table(cols, r.rows || []) : ""}
          <div><div class="eyebrow" style="margin-bottom:6px">${r.answer ? "SQL the agent ran" : "Reference SQL"}</div><pre>${kw(r.sql || "")}</pre></div>
          <p class="dim" style="margin:0;font-size:12px">Read-only connection · whitelisted views only · single SELECT · LIMIT 1000${r.latency_s ? ` · ${r.latency_s}s` : ""}</p>`;
      }
    } });
}

function liveRow() {
  const L = D.live || {}, H = L.city_hourly || [], S = L.stations_latest || [], F = L.fires_daily || [], W = L.wind || [];
  const hourly = card({ size: "wide", eyebrow: "Mean of reporting stations", title: "City PM2.5, last 7 days",
    body: lineChart({ n: H.length, w: 480, h: 170, y0: 0, y1: Math.max(100, ...H.map(x => x.pm25 || 0)) * 1.1, series: [{ v: H.map(x => x.pm25), c: "var(--de)", area: true, end: true, w: 1.5 }], thresholds: [{ y: 60, label: "24h standard 60 µg/m³", c: "var(--ba)" }], xl: H.length ? [[0, d8(H[0].ts)], [H.length - 1, d8(H[H.length - 1].ts)]] : [] }),
    foot: `Latest: ${H.length ? n0(H[H.length - 1].pm25) + " µg/m³" : "–"}`, open: null });
  const stations = card({ eyebrow: "Latest full day", title: "Stations, worst first",
    body: S.slice(0, 7).map(s => { const b = band(s.aqi); return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px"><span>${esc(s.station)}</span><span class="num mono" style="color:var(${b[2]})">${n0(s.aqi)}</span></div><div class="bar" style="--c:var(${b[2]})"><i style="width:${Math.min(100, s.aqi / 5)}%"></i></div>`; }).join(""),
    foot: `${S.length} stations reporting`, open: () => modal({ eyebrow: "Data Engineering · station layer", title: "All stations, latest day", body: table(["station", "aqi", "pm25", "pm10", "hours"], S) }) });
  const fires = card({ eyebrow: "Punjab + Haryana · VIIRS", title: "Fires, last 14 days",
    body: bars(F.map(x => ({ label: d8(x.date).split(" ")[0], v: x.fires, c: "var(--ds)" })), { w: 300, h: 150 }), foot: `${n0(F.reduce((s, x) => s + (x.fires || 0), 0))} detections`, open: null });
  const w = W[W.length - 1] || {};
  const wind = card({ eyebrow: "Transport + mixing", title: "Wind and mixing height",
    body: `${windRose(w.wind_dir, w.wind_speed)}<div class="stat-row"><div class="stat"><b class="num">${pct(w.nw_frac)}</b><span>hours from NW</span></div><div class="stat"><b class="num">${n0(w.blh_min)} m</b><span>night mixing height</span></div><div class="stat"><b class="num">${w.wind_speed ?? "–"}</b><span>wind m/s</span></div></div>`,
    foot: `${d8(w.date)} · Delhi`, open: null });
  row({ id: "live", title: "Live now", role: "Data Engineering", c: "--de", sub: "The freshest layer of the warehouse: hourly station data, today's fires and the weather that moves smoke.", cards: [hourly, stations, fires, wind] });
}
function windRose(dir, spd) {
  if (dir == null) return "";
  const w = 300, h = 120, cx = 60, cy = 60, r = 46, a = (dir - 90) * Math.PI / 180;
  const nw = dir >= 270 && dir <= 340;
  let g = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line-2)"/>`;
  ["N", "E", "S", "W"].forEach((t, i) => { const aa = (i * 90 - 90) * Math.PI / 180; g += `<text x="${cx + Math.cos(aa) * (r + 9)}" y="${cy + Math.sin(aa) * (r + 9) + 3}" text-anchor="middle">${t}</text>`; });
  g += `<path d="M${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r} L${cx} ${cy}" stroke="${nw ? "var(--ds)" : "var(--de)"}" stroke-width="3" stroke-linecap="round"/><circle cx="${cx + Math.cos(a) * r}" cy="${cy + Math.sin(a) * r}" r="5" fill="${nw ? "var(--ds)" : "var(--de)"}"/>`;
  g += `<text class="lbl" x="130" y="50" style="font-size:13px">From ${Math.round(dir)}°</text><text x="130" y="70">${nw ? "Northwest: carries Punjab smoke" : "Not the smoke corridor"}</text>`;
  return svg(w, h, g);
}

function pipelineRow() {
  const P = D.pipeline || {}, L = P.latest || { steps: [], stages: {} }, hist = P.history || [];
  const STAGES = [["ingest", "Ingest"], ["validate", "Validate"], ["transform", "Transform"], ["features", "Features"], ["model", "Model"], ["ledger", "Ledger"], ["insights", "Insights"], ["export", "Export"]];
  const col = s => s === "failed" ? "var(--vpoor)" : s === "warn" ? "var(--ba)" : s === "skipped" ? "var(--dim)" : "var(--de)";
  let g = ""; const w = 720, h = 150;
  STAGES.forEach(([k, lab], i) => {
    const s = L.stages?.[k] || {}, x = 14 + (i % 4) * 176, y = i < 4 ? 14 : 86;
    if (i < 7) { const nx = 14 + ((i + 1) % 4) * 176, ny = i + 1 < 4 ? 14 : 86; const d = i === 3 ? `M${x + 72} ${y + 48} C${x + 72} 72, ${nx + 72} 60, ${nx + 72} ${ny}` : `M${x + 146} ${y + 24} L${nx} ${ny + 24}`;
      g += `<path id="pf${i}" d="${d}" fill="none" stroke="var(--line-2)" stroke-width="1.5"/>`;
      if (!reduce) g += `<circle r="3" fill="${col(s.status)}"><animateMotion dur="1.6s" begin="${i * .2}s" repeatCount="indefinite"><mpath href="#pf${i}"/></animateMotion></circle>`; }
    g += `<rect x="${x}" y="${y}" width="146" height="48" rx="9" fill="var(--surface-2)" stroke="${col(s.status)}"/><text class="lbl" x="${x + 12}" y="${y + 20}" style="font-size:12.5px;font-family:var(--body);font-weight:600;fill:var(--text)">${i + 1} · ${lab}</text><text x="${x + 12}" y="${y + 37}">${s.status ? `${s.checks_passed}/${s.checks_total} checks · ${s.duration_s}s` : "not run"}</text>`;
  });
  const flow = card({ size: "xwide", eyebrow: `Run ${L.run_id || "–"} · ${L.mode || ""}`, title: "Pipeline flow", body: `<div style="overflow-x:auto">${svg(w, h + 6, g)}</div>`, foot: `${(L.steps || []).length} sub-steps · status ${L.status || "–"}`, open: () => stageModal(null) });
  const cards = STAGES.map(([k, lab], i) => {
    const s = L.stages?.[k] || {}, steps = (L.steps || []).filter(x => x.stage === k), trend = hist.map(r => r.stages?.[k]?.duration_s ?? null);
    return card({ eyebrow: `Stage ${i + 1}`, title: lab,
      body: `<div><span class="pill ${s.status || "skipped"}">${s.status || "not run"}</span></div><div class="stat-row"><div class="stat"><b class="num">${n0(s.rows_out)}</b><span>rows out</span></div><div class="stat"><b class="num">${s.duration_s ?? "–"}s</b><span>duration</span></div><div class="stat"><b class="num">${s.checks_passed ?? 0}/${s.checks_total ?? 0}</b><span>checks</span></div></div>
        <div style="font-size:12.5px;display:flex;flex-direction:column;gap:3px">${steps.slice(0, 4).map(x => `<div style="display:flex;justify-content:space-between;gap:8px"><span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.step)}</span><span class="mono ${x.status === "ok" ? "ok-t" : x.status === "warn" ? "warn-t" : x.status === "failed" ? "bad-t" : "dim"}">${x.status}</span></div>`).join("")}${steps.length > 4 ? `<span class="dim">+${steps.length - 4} more</span>` : ""}</div>
        ${trend.filter(v => v != null).length > 1 ? `<div>${spark(trend, "var(--de)", 290, 30)}<div class="dim" style="font-size:11px">duration, last ${trend.length} runs</div></div>` : ""}`,
      foot: `${steps.length} sub-steps`, open: () => stageModal(k) });
  });
  const hc = card({ eyebrow: `${hist.length} runs`, title: "Run history",
    body: bars(hist.slice(-20).map(r => ({ label: "", v: Object.values(r.stages || {}).reduce((s, x) => s + (x.duration_s || 0), 0), c: col(r.status === "ok" && Object.values(r.stages || {}).some(x => x.status === "warn") ? "warn" : r.status) })), { w: 300, h: 140, fmt: v => v.toFixed(0) + "s" }),
    foot: "Total duration per run, coloured by outcome" });
  row({ id: "pipeline", title: "Pipeline", role: "Data Engineering · Systems", c: "--de", sub: "Eight stages, each recording rows, checks, freshness and timing in a run manifest. A failed stage halts everything after it.", cards: [flow, ...cards, hc] });
}
function stageModal(k) {
  const L = D.pipeline?.latest || {}, steps = (L.steps || []).filter(x => !k || x.stage === k);
  const rows = steps.map(x => ({ stage: x.stage, step: x.step, status: x.status, rows_in: x.rows_in, rows_out: x.rows_out, "time (s)": x.duration_s, freshness: x.freshness ? String(x.freshness).slice(0, 16) : null }));
  const checks = steps.flatMap(x => (x.checks || []).map(c => ({ step: x.step, check: c.name, result: c.passed ? "pass" : (c.severity === "error" ? "FAIL" : "warn"), detail: c.detail })));
  const notes = steps.filter(x => x.notes || x.error).map(x => `<div><b>${esc(x.step)}</b> <span class="${x.error ? "bad-t" : "muted"}">${esc(x.error || x.notes)}</span></div>`).join("");
  modal({ eyebrow: `Run ${L.run_id || ""}`, title: k ? `Stage · ${k}` : "All pipeline steps",
    body: `${table(["stage", "step", "status", "rows_in", "rows_out", "time (s)", "freshness"], rows, 200)}<h3>Data contracts and checks</h3>${checks.length ? table(["step", "check", "result", "detail"], checks, 200) : `<p class="muted">No checks in this stage.</p>`}${notes ? `<h3>Notes</h3><div style="display:flex;flex-direction:column;gap:6px;font-size:13px">${notes}</div>` : ""}` });
}

async function sha256(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function canon(o) { return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + JSON.stringify(o[k])).join(",") + "}"; }
function ledgerRow() {
  const Lg = D.ledger || {}, v = Lg.verify || {}, blocks = [...(Lg.blocks || [])].reverse(), G = Lg.graded || [];
  const status = card({ eyebrow: "Hash chain", title: v.ok ? "Chain intact" : "Chain problem",
    body: `<div class="big" style="color:${v.ok ? "var(--qa)" : "var(--vpoor)"}">${v.blocks ?? 0} blocks</div><div class="hash">head ${esc(v.head || "–")}</div>${(v.problems || []).map(p => `<p class="bad-t" style="margin:0">${esc(p)}</p>`).join("")}`,
    foot: "Re-derived from files on every run" });
  const bc = blocks.slice(0, 10).map(b => card({ eyebrow: `Block #${b.height} · ${dY(b.run_date)}`, title: `${b.n} forecasts committed`,
    body: `<div class="hash">root ${b.root.slice(0, 32)}…</div><div class="hash">prev ${b.prev.slice(0, 16)}…</div>`, foot: "Verify in your browser", open: () => verifyModal(b, (Lg.blocks || []).find(x => x.height === b.height - 1)) }));
  const byS = {};
  G.forEach(g => { const k = `${g.source}·${g.horizon_h}`; (byS[k] = byS[k] || []).push(g); });
  const graded = card({ size: "wide", eyebrow: "Live, after the fact", title: "Graded forecasts",
    body: G.length ? table(["source", "horizon", "n", "MAE", "in band"], Object.entries(byS).map(([k, a]) => ({ source: k.split("·")[0], horizon: k.split("·")[1] + "h", n: a.length, MAE: a.reduce((s, x) => s + x.abs_err, 0) / a.length, "in band": a[0].p10 == null ? "–" : pct(a.filter(x => x.in_band).length / a.length) })))
      : `<p class="take">Grading starts two days after the first real forecast, once CPCB data settles. Every committed forecast, ours and CAMS's, is scored the same way.</p>`,
    foot: "Ours vs Copernicus CAMS, same days and horizons" });
  row({ id: "ledger", title: "Public ledger", role: "Systems", c: "--de", sub: "Forecasts are hashed, rolled into a Merkle root and chained to the previous day before the outcome exists. Verify any block here; nothing is taken on trust.", cards: [status, ...bc, graded] });
}
function verifyModal(b, prev) {
  const entries = b.entries || [];
  modal({ eyebrow: `Block #${b.height} · ${b.run_date}`, title: "Verify this block",
    body: `<ol id="vs" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px"></ol>${table(["source", "target_date", "horizon_h", "p10", "p50", "p90", "p_severe"], entries.map(e => JSON.parse(e.line)))}<dl class="kv"><dt>Merkle root</dt><dd class="hash">${b.root}</dd><dt>Previous block</dt><dd class="hash">${b.prev}</dd><dt>Block hash</dt><dd class="hash">${b.block_hash}</dd><dt>Committed</dt><dd>${esc(b.committed_at)}</dd></dl>`,
    after: async body => {
      const out = $("#vs", body), say = (ok, t) => out.insertAdjacentHTML("beforeend", `<li class="${ok ? "ok-t" : "bad-t"}">${ok ? "✓" : "✗"} ${t}</li>`);
      if (!crypto?.subtle) { say(false, "This browser can't compute SHA-256 here (needs HTTPS)."); return; }
      let okH = true; for (const e of entries) if (await sha256(e.line) !== e.hash) okH = false;
      say(okH, `Each of ${entries.length} forecasts hashes to its recorded SHA-256`);
      let okM = true;
      for (const e of entries) { let acc = e.hash; for (const [side, sib] of e.proof) acc = await sha256(side === "L" ? sib + acc : acc + sib); if (acc !== b.root) okM = false; }
      say(okM, "Every forecast's Merkle proof folds up to the block root");
      const hdr = { height: b.height, run_date: b.run_date, n: b.n, root: b.root, prev: b.prev, file_sha256: b.file_sha256 };
      say(await sha256(canon(hdr)) === b.block_hash, "Block header hashes to the block hash");
      say(prev ? prev.block_hash === b.prev : b.prev === "0".repeat(64), prev ? "Links to the previous block" : "First block links to genesis");
    } });
}

function nomadRow() {
  const N = D.nomad || {}, repo = "https://github.com/lakshaysharmaug22-crypto/nomad-loop-engine", dash = "https://nomad-loop-engine.vercel.app/target";
  const sub = "Nomad Loop Engine explores this site like a user after every deploy, files each confirmed bug with a replayable test, and blocks the release on a major or critical one.";
  const links = `<a href="${dash}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Nomad's view ›</a>`;
  if (N.status !== "complete" || !N.stats) {
    const c = card({ eyebrow: "Release gate", title: "Awaiting first scan", body: `<div class="big muted">–</div><p class="take">The scan runs automatically after the next deploy. Results appear here and on Nomad's dashboard from the same report file.</p>`, foot: links });
    c.classList.add("black");
    const how = card({ eyebrow: "How it works", title: "Explore · report · gate", body: `<ol class="muted" style="margin:0;padding-left:18px;font-size:13px;display:flex;flex-direction:column;gap:4px"><li>Vercel finishes a deploy</li><li>Nomad explores the live site for 45 steps</li><li>Each bug is replayed 3× and gets a Playwright test</li><li>A confirmed major bug fails the release check</li></ol>`, foot: `<a href="${repo}" target="_blank" rel="noopener" onclick="event.stopPropagation()">See the engine ›</a>` });
    row({ id: "nomad", title: "Tested by Nomad Loop", role: "Engineering QA", c: "--qa", sub, cards: [c, how] });
    return;
  }
  const s = N.stats, bugs = N.bugs || [], hist = N.history || [], ship = N.verdict === "ship";
  const verdict = card({ eyebrow: `Scan ${esc((N.finished || "").slice(0, 16).replace("T", " "))} · commit ${esc((N.commit || "").slice(0, 7))}`, title: ship ? "Shipped" : "Release blocked",
    body: `<div class="big" style="color:${ship ? "var(--qa)" : "var(--red)"}">${ship ? "PASS" : "BLOCKED"}</div><div class="stat-row"><div class="stat"><b class="num">${s.steps}</b><span>steps</span></div><div class="stat"><b class="num">${s.states}</b><span>UI states</span></div><div class="stat"><b class="num" style="color:${bugs.length ? "var(--red)" : ""}">${bugs.length}</b><span>bugs</span></div></div>`,
    foot: links });
  verdict.classList.add("black");
  const tiers = Object.entries(s.tierCounts || {}).filter(([, v]) => v > 0), tot = tiers.reduce((a, [, v]) => a + v, 0) || 1;
  const how = card({ eyebrow: `${N.duration_s ?? "–"} s scan`, title: "How Nomad decided",
    body: tiers.map(([k, v]) => `<div><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(k)}</span><span class="mono">${v}</span></div><div class="bar" style="--c:var(--qa)"><i style="width:${v / tot * 100}%"></i></div></div>`).join("") || `<p class="take">No decisions recorded.</p>`,
    foot: s.stepP95Ms ? `Step p95 ${s.stepP95Ms} ms` : "" });
  const bg = bugs.map(x => { const c = card({ eyebrow: `${esc(x.severity)} · ${esc(x.status)} · ${esc(x.confirmations || "")}`, title: x.title,
    body: `<p class="take muted" style="margin:0">${esc(x.message || "")}</p><ol style="margin:0;padding-left:18px;font-size:12px" class="mono muted">${(x.steps || []).slice(0, 4).map(st => `<li>${esc(st)}</li>`).join("")}</ol>`,
    foot: `found at step ${x.foundAtStep}` }); if (x.severity !== "minor") c.classList.add("black"); return c; });
  const hc = hist.length > 1 ? card({ eyebrow: `${hist.length} scans`, title: "Release history",
    body: bars(hist.slice(-20).map(h => ({ label: "", v: h.states, c: h.verdict === "ship" ? "var(--qa)" : "var(--red)" })), { w: 300, h: 130 }),
    foot: `${hist.filter(h => h.verdict === "blocked").length} releases blocked` }) : null;
  row({ id: "nomad", title: "Tested by Nomad Loop", role: "Engineering QA", c: "--qa", sub, cards: [verdict, how, ...bg, hc] });
}

/* ───────────── what-if simulator ───────────── */
function whatifRow() {
  const W = D.whatif; if (!W?.horizons || !Object.keys(W.horizons).length) return;
  const ax = W.axes, hs = Object.keys(W.horizons).sort((a, b) => a - b);
  const near = (arr, v) => arr.reduce((b, x, i) => Math.abs(x - v) < Math.abs(arr[b] - v) ? i : b, 0);
  const st = { h: hs.includes("48") ? "48" : hs[0] };
  const reset = () => { st.f = ax.fire_mult.indexOf(1); st.n = near(ax.nw, W.horizons[st.h].base.nw_frac_0 ?? .5); st.b = ax.blh_mult.indexOf(1); };
  reset();
  const cell = (h, f, n, b) => W.horizons[h].grid[f * ax.nw.length * ax.blh_mult.length + n * ax.blh_mult.length + b];
  const sim = card({ size: "xwide", interactive: true, eyebrow: "Model response · not a causal estimate", title: "What if…",
    body: `<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><div class="seg" id="wi-h">${hs.map(h => `<button type="button" data-h="${h}" aria-pressed="${h === st.h}">+${h}h</button>`).join("")}</div>
      <div class="presets"><button type="button" data-p="stop">Burning stops</button><button type="button" data-p="peak">Peak burning + NW wind</button><button type="button" data-p="inv">Winter inversion</button><button type="button" data-p="reset">Today</button></div></div>
      <div style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:6px">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="ctrl"><label for="wi-f">Upwind fires <b id="wi-fv"></b></label><input type="range" id="wi-f" min="0" max="${ax.fire_mult.length - 1}" step="1"></div>
          <div class="ctrl"><label for="wi-n">Northwest wind share <b id="wi-nv"></b></label><input type="range" id="wi-n" min="0" max="${ax.nw.length - 1}" step="1"></div>
          <div class="ctrl"><label for="wi-b">Mixing height <b id="wi-bv"></b></label><input type="range" id="wi-b" min="0" max="${ax.blh_mult.length - 1}" step="1"></div>
          <p class="dim" style="margin:0;font-size:12px">The live models re-forecast with these inputs changed. They learned correlations from history, so read this as how the forecast responds, not as proof of cause.</p>
        </div>
        <div id="wi-out" style="display:flex;flex-direction:column;gap:10px"></div>
      </div>`, foot: `${W.horizons[st.h].grid.length} precomputed scenarios per horizon`, open: null });
  sim.classList.add("black");
  const heat = card({ size: "wide", interactive: true, eyebrow: "Every scenario at this mixing height", title: "Fires × wind", body: `<div id="wi-heat"></div>`, foot: "Red and black cells cross the severe line (AQI 400)", open: null });
  heat.classList.add("black");
  row({ id: "whatif", title: "What if…", role: "Data Science · Business", c: "--red", sub: "Move the levers that drive Delhi's smog and watch the live model re-forecast. Presets show the scenarios policy actually argues about.", cards: [sim, heat] });
  const base = h => (D.overview.forecast || []).find(f => String(f.horizon_h) === h);
  const upd = () => {
    const g = cell(st.h, st.f, st.n, st.b), [, , , p10, p50, p90, ps] = g, b = band(p50), bf = base(st.h), bs = W.horizons[st.h].base;
    $("#wi-f").value = st.f; $("#wi-n").value = st.n; $("#wi-b").value = st.b;
    $("#wi-fv").textContent = `${ax.fire_mult[st.f]}× · ${n0((bs.fires_0 || 0) * ax.fire_mult[st.f])} detections`;
    $("#wi-nv").textContent = pct(ax.nw[st.n]);
    $("#wi-bv").textContent = `${ax.blh_mult[st.b]}× · ${n0((bs.blh_0 || 0) * ax.blh_mult[st.b])} m`;
    const d = bf ? p50 - bf.p50 : 0, sev = ps >= .5, all = W.horizons[st.h].grid.map(x => x[4]), spread = Math.max(...all) - Math.min(...all);
    const stage = p50 > 450 ? "Stage IV" : p50 > 400 ? "Stage III" : p50 > 300 ? "Stage II" : p50 > 200 ? "Stage I" : "No GRAP stage";
    $("#wi-out").innerHTML = `<div class="eyebrow">${d8(W.horizons[st.h].target_date)} · +${st.h}h</div>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="big num" style="font-size:52px;color:var(${b[2]})">${n0(p50)}</span><span style="font-weight:600">${b[1]}</span>
      <span class="mono ${d > 0 ? "delta-up" : d < 0 ? "delta-down" : "dim"}">${d > 0 ? "▲ +" : d < 0 ? "▼ " : "± "}${n0(d)} vs today's forecast</span></div>
      ${bandStrip({ p10, p50, p90 })}
      <div><div style="display:flex;justify-content:space-between;font-size:12.5px"><span class="muted">P(severe)</span><b class="mono ${sev ? "red-t" : ""}">${pct(ps)}</b></div><div class="meter"><i style="width:${Math.max(2, ps * 100)}%;background:${sev ? "var(--red)" : ps > .2 ? "var(--ba)" : "var(--qa)"}"></i></div></div>
      <div style="font-size:14px">GRAP: <b class="${p50 > 400 ? "red-t" : ""}">${stage}</b> · 80% range <span class="num">${n0(p10)}–${n0(p90)}</span></div>
      ${spread < 40 ? `<p class="dim" style="margin:0;font-size:12px">Every scenario here lands within ${spread} AQI points. Outside the burning season the model has seen few big fire days at this time of year, so it barely reacts. From October the levers bite.</p>` : ""}`;
    let g2 = "", cw = 58, ch = 30, l = 70, t = 22;
    ax.nw.forEach((n, j) => g2 += `<text x="${l + j * cw + cw / 2}" y="14" text-anchor="middle">${pct(n)}</text>`);
    ax.fire_mult.forEach((f, i) => {
      g2 += `<text x="${l - 8}" y="${t + i * ch + ch / 2 + 3}" text-anchor="end">${f}× fires</text>`;
      ax.nw.forEach((n, j) => { const c = cell(st.h, i, j, st.b), v = c[4], sv = v > 400, bb = band(v), cur = i === st.f && j === st.n;
        g2 += `<g style="cursor:pointer" data-f="${i}" data-n="${j}"><rect x="${l + j * cw + 1}" y="${t + i * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${sv ? "#000" : `var(${bb[2]})`}" opacity="${sv ? 1 : .55}" stroke="${cur ? "#fff" : sv ? "var(--red)" : "none"}" stroke-width="${cur ? 2 : 1}"/><text x="${l + j * cw + cw / 2}" y="${t + i * ch + ch / 2 + 4}" text-anchor="middle" style="fill:${sv ? "var(--red)" : "#0A0C0F"};font-weight:600;font-size:11px">${v}</text></g>`; });
    });
    g2 += `<text class="lbl" x="${l + ax.nw.length * cw / 2}" y="${t + ax.fire_mult.length * ch + 16}" text-anchor="middle">northwest wind share →</text>`;
    $("#wi-heat").innerHTML = `<div style="overflow-x:auto">${svg(l + ax.nw.length * cw + 4, t + ax.fire_mult.length * ch + 22, g2)}</div>`;
    $("#wi-heat").querySelectorAll("g[data-f]").forEach(el => el.onclick = () => { st.f = +el.dataset.f; st.n = +el.dataset.n; upd(); });
    $("#wi-h").querySelectorAll("button").forEach(bt => bt.setAttribute("aria-pressed", bt.dataset.h === st.h));
  };
  $("#wi-f").oninput = e => { st.f = +e.target.value; upd(); };
  $("#wi-n").oninput = e => { st.n = +e.target.value; upd(); };
  $("#wi-b").oninput = e => { st.b = +e.target.value; upd(); };
  $("#wi-h").querySelectorAll("button").forEach(bt => bt.onclick = () => { st.h = bt.dataset.h; upd(); });
  sim.querySelectorAll("[data-p]").forEach(bt => bt.onclick = () => {
    const p = bt.dataset.p; reset();
    if (p === "stop") st.f = 0;
    if (p === "peak") { st.f = ax.fire_mult.length - 1; st.n = ax.nw.length - 1; st.b = ax.blh_mult.indexOf(.75); }
    if (p === "inv") st.b = 0;
    upd();
  });
  upd();
}

/* ───────────── model arena ───────────── */
function arenaRow() {
  const A = D.arena; if (!A?.horizons?.length) return;
  const cards = A.horizons.map(h => {
    const fair = h.rows.filter(r => !r.reference), mx = Math.max(...h.rows.map(r => r.mae)), worst = fair[fair.length - 1]?.model;
    const c = card({ eyebrow: `+${h.horizon_h}h · ${h.seasons} seasons walk-forward`, title: `Leaderboard, ${h.horizon_h}h ahead`,
      body: `<div class="lb">${h.rows.map((r, i) => { const win = i === 0 && !r.reference, bad = r.model === worst, col = win ? "var(--ds)" : bad ? "var(--red)" : r.reference ? "var(--dim)" : "var(--muted)";
        return `<div class="it" style="--c:${col}"><span class="mono" style="color:${col}">${r.reference ? "–" : i + 1}</span><span style="${win ? "font-weight:600" : ""}">${esc(r.model)}${r.reference ? ` <span class="pill skipped">reference</span>` : ""}</span><span class="mono num" style="color:${col}">${r.mae}</span><div class="bar"><i style="width:${r.mae / mx * 100}%"></i></div></div>`; }).join("")}</div>`,
      foot: "Mean absolute error in AQI points · lower is better", open: () => arenaModal(h) });
    c.classList.add("black");
    return c;
  });
  const h48 = A.horizons.find(h => h.horizon_h === 48) || A.horizons[0], fair = h48.rows.filter(r => !r.reference);
  const wins = card({ eyebrow: `${h48.horizon_h}h ahead`, title: "Season wins",
    body: bars(fair.map((r, i) => ({ label: r.model.split(" ")[0], v: r.season_wins || 0, c: i === 0 ? "var(--ds)" : i === fair.length - 1 ? "var(--red)" : "var(--surface-3)" })), { w: 300, h: 150 }),
    foot: "Seasons where each model had the lowest error", open: () => arenaModal(h48) });
  const sev = card({ eyebrow: `${h48.horizon_h}h ahead`, title: "Who catches severe days",
    body: hbars(h48.rows.map(r => ({ label: r.model.replace(" (LightGBM quantile)", ""), v: r.csi || 0, c: r.reference ? "var(--dim)" : r.model.startsWith("Vayu") ? "var(--ds)" : "var(--surface-3)" })), { w: 300, labelW: 150, fmt: v => v.toFixed(2) }),
    foot: "Critical success index for AQI > 400", open: () => arenaModal(h48) });
  const note = card({ eyebrow: "Read this first", title: "Why CAMS sits apart", body: `<p class="take">${esc(A.note || "")}</p>`, foot: "" });
  row({ id: "arena", title: "Model arena", role: "Data Science", c: "--ds", sub: "The model has to beat simple challengers on seasons it never saw. Winner in orange, weakest fair contender in red.", cards: [...cards, wins, sev, note] });
}
function arenaModal(h) {
  modal({ eyebrow: `Model arena · ${h.horizon_h}h ahead`, title: "Full leaderboard",
    body: `${table(["model", "n", "mae", "rmse", "bias", "csi", "severe_hits", "severe_days", "season_wins"], h.rows)}<p class="muted" style="margin:0">Bias is forecast minus observed: negative means the model runs low. ${esc(D.arena.note || "")}</p>` });
}

/* ───────────── lineage graph ───────────── */
function lineageRow() {
  const Lg = D.lineage; if (!Lg?.nodes) return;
  const layers = ["source", "raw", "curated", "model", "product"], LC = { source: "var(--muted)", raw: "var(--de)", curated: "var(--da)", model: "var(--ds)", product: "var(--ai)" };
  const colW = 176, nw = 146, nh = 30, gap = 14, pos = {};
  const byL = layers.map(l => Lg.nodes.filter(n => n.layer === l));
  const H = Math.max(...byL.map(a => a.length)) * (nh + gap) + 36, W = layers.length * colW;
  byL.forEach((arr, li) => { const off = (H - 30 - arr.length * (nh + gap)) / 2 + 26; arr.forEach((n, i) => pos[n.id] = { x: 8 + li * colW, y: off + i * (nh + gap), n }); });
  let g = layers.map((l, i) => `<text x="${8 + i * colW}" y="14" style="fill:${LC[l]};letter-spacing:.1em">${l.toUpperCase()}</text>`).join("");
  Lg.edges.forEach((e, i) => { const a = pos[e.from], b = pos[e.to]; if (!a || !b) return; const x1 = a.x + nw, y1 = a.y + nh / 2, x2 = b.x, y2 = b.y + nh / 2, mx = (x1 + x2) / 2;
    g += `<path data-from="${e.from}" data-to="${e.to}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="#3a3f47" stroke-width="1.2"/>`; });
  Object.values(pos).forEach(({ x, y, n }) => { const bad = n.status === "failed", warn = n.status === "warn";
    g += `<g class="node" data-id="${n.id}" tabindex="0"><rect x="${x}" y="${y}" width="${nw}" height="${nh}" rx="7" fill="${bad ? "#1a0305" : "#0c0e11"}" stroke="${bad ? "var(--red)" : warn ? "var(--ba)" : LC[n.layer]}" stroke-width="${bad ? 2 : 1}"/><text x="${x + 10}" y="${y + 19}" style="fill:var(--text)">${esc(n.label.length > 17 ? n.label.slice(0, 16) + "…" : n.label)}</text>${n.rows != null ? `<text x="${x + nw - 8}" y="${y + 19}" text-anchor="end">${n.rows >= 1e6 ? (n.rows / 1e6).toFixed(1) + "M" : n.rows >= 1e3 ? Math.round(n.rows / 1e3) + "k" : n.rows}</text>` : ""}</g>`; });
  const c = card({ size: "xwide", interactive: true, eyebrow: `${Lg.nodes.length} nodes · ${Lg.edges.length} edges · live row counts`, title: "From satellite to screen",
    body: `<div style="overflow-x:auto"><svg class="chart lin" id="lin" viewBox="0 0 ${W} ${H}" style="min-width:${W}px">${g}</svg></div><p class="dim" style="margin:0;font-size:12px">Hover a node to trace everything upstream and downstream in red. Click for its columns, checks and freshness.</p>`,
    foot: "", open: null });
  c.classList.add("black");
  const failed = Lg.nodes.filter(n => n.status === "failed"), fresh = Lg.nodes.filter(n => n.freshness);
  const st = card({ eyebrow: "Health", title: failed.length ? `${failed.length} node${failed.length > 1 ? "s" : ""} failing` : "All nodes healthy",
    body: `<div class="big" style="color:${failed.length ? "var(--red)" : "var(--qa)"}">${Lg.nodes.filter(n => n.status && n.status !== "failed").length}/${Lg.nodes.filter(n => n.status).length}</div><p class="take">checked nodes passing. ${fresh.length} nodes carry a freshness stamp.</p>`, foot: "" });
  st.classList.add("black");
  row({ id: "lineage", title: "Lineage", role: "Data Engineering", c: "--de", sub: "Every table, model and screen, and exactly what feeds it. Failures show in red.", cards: [c, st] });
  const svgEl = $("#lin"), up = {}, dn = {};
  Lg.edges.forEach(e => { (dn[e.from] = dn[e.from] || []).push(e.to); (up[e.to] = up[e.to] || []).push(e.from); });
  const walk = (id, m, acc = new Set()) => { (m[id] || []).forEach(x => { if (!acc.has(x)) { acc.add(x); walk(x, m, acc); } }); return acc; };
  svgEl.querySelectorAll(".node").forEach(el => {
    const id = el.dataset.id;
    el.onmouseenter = el.onfocus = () => { const set = new Set([id, ...walk(id, up), ...walk(id, dn)]); svgEl.classList.add("focus");
      svgEl.querySelectorAll(".node").forEach(n => n.classList.toggle("hl", set.has(n.dataset.id)));
      svgEl.querySelectorAll("path").forEach(p => p.classList.toggle("hl", set.has(p.dataset.from) && set.has(p.dataset.to))); };
    el.onmouseleave = el.onblur = () => { svgEl.classList.remove("focus"); svgEl.querySelectorAll(".hl").forEach(x => x.classList.remove("hl")); };
    el.onclick = () => lineageModal(Lg.nodes.find(n => n.id === id), up[id] || [], dn[id] || []);
  });
}
function lineageModal(n, ups, dns) {
  const name = id => D.lineage.nodes.find(x => x.id === id)?.label || id;
  modal({ eyebrow: `Lineage · ${n.layer}`, title: n.label,
    body: `<dl class="kv"><dt>Rows</dt><dd>${n.rows != null ? n.rows.toLocaleString("en-IN") : "–"}</dd><dt>Status</dt><dd class="${n.status === "failed" ? "red-t" : ""}">${n.status || "–"}</dd><dt>Freshness</dt><dd>${esc(n.freshness || "–")}</dd><dt>Fed by</dt><dd>${ups.map(name).join(", ") || "–"}</dd><dt>Feeds</dt><dd>${dns.map(name).join(", ") || "–"}</dd></dl>
      ${n.columns ? `<h3>Columns</h3>${table(["column_name", "data_type"], n.columns, 100)}` : ""}${n.checks?.length ? `<h3>Checks</h3>${table(["name", "passed", "detail"], n.checks.map(c => ({ ...c, passed: c.passed ? "pass" : "FAIL" })))}` : ""}` });
}

/* ───────────── model health (drift) ───────────── */
function healthRow() {
  const Dr = D.drift; if (!Dr?.features) return;
  const S = { drift: ["DRIFT", "var(--red)"], watch: ["WATCH", "var(--ba)"], stable: ["STABLE", "var(--qa)"] }[Dr.status] || ["–", "var(--dim)"];
  const stc = card({ eyebrow: `Last ${Dr.window_days} days vs same days in ${Dr.reference.split(", ")[1] || "earlier years"}`, title: "Input drift",
    body: `<div class="big" style="color:${S[1]};letter-spacing:.04em">${S[0]}</div><p class="take">${Dr.features.filter(f => f.status === "drift").length} drifting · ${Dr.features.filter(f => f.status === "watch").length} to watch · ${Dr.features.length} inputs checked</p>`,
    foot: "Seasonal PSI with an empirical null", open: () => driftModal() });
  stc.classList.add("black");
  const top = Dr.features.slice(0, 9), w = 460, rh = 24, lw = 190, mx = Math.max(...top.map(f => Math.max(f.psi, f.threshold))) * 1.1;
  let g = "";
  top.forEach((f, i) => { const y = i * rh, bw = f.psi / mx * (w - lw - 50), tx = lw + f.threshold / mx * (w - lw - 50), col = f.status === "drift" ? "var(--red)" : f.status === "watch" ? "var(--ba)" : "#3a3f47";
    g += `<text class="lbl" x="${lw - 8}" y="${y + 15}" text-anchor="end">${esc(FEAT[f.feature] || f.feature)}</text><rect x="${lw}" y="${y + 5}" width="${Math.max(2, bw)}" height="${rh - 10}" rx="3" fill="${col}"/><line x1="${tx}" x2="${tx}" y1="${y + 2}" y2="${y + rh - 2}" stroke="#fff" stroke-width="1.5"/><text x="${w - 4}" y="${y + 15}" text-anchor="end" style="fill:${f.status === "drift" ? "var(--red)" : "var(--dim)"}">${f.psi.toFixed(2)}</text>`; });
  const psi = card({ size: "wide", eyebrow: "White tick = this input's drift threshold", title: "Population stability by input", body: svg(w, top.length * rh + 4, g), foot: "Red crosses its threshold · amber above its normal range", open: () => driftModal() });
  psi.classList.add("black");
  const E = Dr.error_by_season || [];
  const err = card({ size: "wide", eyebrow: "48h ahead, walk-forward", title: "Error season by season",
    body: lineChart({ n: E.length, w: 460, h: 160, y0: 0, y1: Math.max(10, ...E.map(e => Math.max(e.mae, e.mae_persistence))) * 1.15, series: [{ v: E.map(e => e.mae_persistence), c: "#5a6069", dash: "4 3" }, { v: E.map(e => e.mae), c: "var(--ds)", dots: true, end: true }], xl: E.map((e, i) => [i, String(e.season)]) }),
    foot: "Orange: Vayu · dashed: persistence. A rising orange line would mean the model is ageing.", open: null });
  const L = Dr.live_error;
  const live = card({ eyebrow: "Live, from the ledger", title: "Live error vs expected",
    body: L ? `<div class="big num" style="color:${L.status === "drift" ? "var(--red)" : "var(--qa)"}">${L.mae}</div><p class="take">MAE over the last ${L.n} graded forecasts, vs ${L.expected} expected from the backtest (${L.ratio}×). Alert above 1.3×.</p>` : `<div class="big muted">–</div><p class="take">Starts once real forecasts are graded (two days after the first run). Alerts when live error runs 30% above the backtest.</p>`,
    foot: "" });
  live.classList.add("black");
  const r = row({ id: "health", title: "Model health", role: "MLOps", c: "--red", sub: "Is the world still the one the model learned? Inputs are compared with the same days in earlier years, and live error with the backtest.", cards: [stc, psi, err, live] });
  r.classList.add("alert");
}
function driftModal() {
  const Dr = D.drift;
  modal({ eyebrow: "MLOps · drift method", title: "How drift is judged",
    body: `<p style="margin:0">The last ${Dr.window_days} issue days (${esc(Dr.current.join(" to "))}, n=${Dr.current_n}) are compared with ${esc(Dr.reference)} (n=${Dr.reference_n}). Matching the calendar keeps Delhi's normal winter swing from reading as drift.</p>
      <p class="muted" style="margin:0">A 30-day window is always narrower than nine pooled years, so fixed PSI cut-offs would raise false alarms. Each earlier year's same window is scored against the other years to build a null distribution. An input drifts only when today's PSI beats that null's 90th percentile and the textbook 0.25.</p>
      ${table(["feature", "psi", "null_p50", "threshold", "status", "ref_mean", "cur_mean"], Dr.features.map(f => ({ ...f, feature: FEAT[f.feature] || f.feature })), 40)}` });
}

/* ───────────── open data API ───────────── */
function apiRow() {
  const Cg = D.catalog; if (!Cg?.datasets) return;
  const head = card({ eyebrow: "No key · no rate limit · rebuilt 06:00 IST", title: "Open data API",
    body: `<div class="endpoint">${esc(location.origin)}/api/v1</div><p class="take">${Cg.datasets.length} JSON endpoints plus an OpenAPI 3.1 spec and a catalog with schemas, row counts and freshness.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><span class="get">GET</span><span class="endpoint">/api/v1/openapi.json</span></div>`,
    foot: "", open: () => modal({ eyebrow: "Open data", title: "OpenAPI spec", body: `<p class="muted" style="margin:0">Machine-readable spec for every endpoint. Import it into Postman or generate a client.</p><pre id="oas">Loading…</pre>`, after: b => fetch("api/v1/openapi.json").then(r => r.json()).then(j => $("#oas", b).textContent = JSON.stringify(j, null, 2).slice(0, 6000)).catch(() => $("#oas", b).textContent = "Couldn't load openapi.json") }) });
  head.classList.add("black");
  const cards = Cg.datasets.map(d => { const c = card({ eyebrow: `${esc(d.source)} · ${d.cadence}`, title: d.title,
    body: `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="get">GET</span><span class="endpoint">${esc(d.endpoint)}</span></div><div class="stat-row"><div class="stat"><b class="num">${d.rows != null ? n0(d.rows) : "–"}</b><span>rows</span></div><div class="stat"><b class="num">${(d.bytes / 1024).toFixed(0)} KB</b><span>size</span></div><div class="stat"><b class="num" style="font-size:15px">${d.freshness ? d8(d.freshness) : "–"}</b><span>fresh to</span></div></div>`,
    foot: `${(d.schema || []).length} columns`, open: () => apiModal(d) }); c.classList.add("black"); return c; });
  row({ id: "api", title: "Open data", role: "Data Engineering", c: "--red", sub: "Everything behind this site, as versioned JSON anyone can use. Each dataset has a schema, row count and freshness stamp.", cards: [head, ...cards] });
}
function apiModal(d) {
  const url = `${location.origin}${d.endpoint}`, curl = `curl -s ${url}`, js = `const res = await fetch("${url}");\nconst { rows } = await res.json();`;
  modal({ eyebrow: `Open data · ${d.source}`, title: d.title,
    body: `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="get">GET</span><span class="endpoint">${esc(d.endpoint)}</span></div><p style="margin:0">${esc(d.description)}</p>
      ${(d.schema || []).length ? `<h3>Schema</h3>${table(["column_name", "column_type"], d.schema, 60)}` : ""}
      <h3>Use it</h3><pre>${esc(curl)}</pre><pre>${esc(js)}</pre><div style="display:flex;gap:8px"><button class="btn small ghost" id="cpc">Copy curl</button><button class="btn small ghost" id="try">Try it</button></div><div id="tryout"></div>`,
    after: b => {
      $("#cpc", b).onclick = () => navigator.clipboard?.writeText(curl).then(() => $("#cpc", b).textContent = "Copied", () => {});
      $("#try", b).onclick = () => fetch(d.endpoint.slice(1)).then(r => r.json()).then(j => { const rows = j.rows || j.forecast || j.entries || []; $("#tryout", b).innerHTML = rows.length ? table(Object.keys(rows[0]), rows.slice(-5)) + `<p class="dim" style="font-size:12px;margin:6px 0 0">Last 5 of ${rows.length} rows</p>` : `<pre>${esc(JSON.stringify(j, null, 2).slice(0, 2000))}</pre>`; }).catch(e => $("#tryout", b).innerHTML = `<p class="red-t">Request failed: ${esc(e.message)}</p>`);
    } });
}

/* ───────────── search palette ───────────── */
const search = (() => {
  const P = $("#palette"), Q = $("#pal-q"), L = $("#pal-list");
  let items = null, daily = null, sel = 0, shown = [];
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const mon = w => MON[w.slice(0, 4)] ?? MON[w.slice(0, 3)];
  function parseDate(q) {
    q = q.trim().toLowerCase(); let m;
    if ((m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2] - 1, +m[3]);
    if ((m = q.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) return iso(+m[3], +m[2] - 1, +m[1]);
    if ((m = q.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*,?\s*(\d{4})?$/)) && mon(m[2]) != null) return iso(+(m[3] || 0), mon(m[2]), +m[1]);
    if ((m = q.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?$/)) && mon(m[1]) != null) return iso(+(m[3] || 0), mon(m[1]), +m[2]);
    return null;
  }
  function iso(y, mo, d) { if (mo == null || d < 1 || d > 31) return null; return { y, mo, d }; }
  const pad = n => String(n).padStart(2, "0");
  async function loadDaily() { if (daily) return daily; try { daily = (await (await fetch("api/v1/aqi/daily.json")).json()).rows; } catch { daily = []; } return daily; }
  function build() {
    const it = [], add = (group, label, sub, tag, run, sev = false) => it.push({ group, label, sub, tag, run, sev, hay: `${label} ${sub} ${tag} ${group}`.toLowerCase() });
    (D.live?.stations_latest || []).forEach(s => add("Stations", s.station, `AQI ${n0(s.aqi)} · ${band(s.aqi)[1]}`, "station", () => modal({ eyebrow: "Station · latest full day", title: s.station, body: `<div class="big" style="color:var(${band(s.aqi)[2]})">${n0(s.aqi)}</div>${table(["station", "aqi", "pm25", "pm10", "hours"], [s])}` }), s.aqi > 400));
    (D.findings || []).forEach(f => add("Findings", f.title, f.takeaway || "", "finding", () => openFinding(f)));
    (D.agent?.results || []).forEach(r => add("Ask Vayu", r.question, r.category, "question", () => askModal(r)));
    [["Severe day", "AQI above 400"], ["City AQI", "CPCB method"], ["Hit rate", "severe days warned"], ["False-alarm ratio", "warnings without severe day"], ["Coverage", "p10–p90 band"], ["Skill vs persistence", "error reduction"], ["Northwest wind share", "smoke corridor"], ["Upwind fire load", "VIIRS detections"]]
      .forEach(([k, v]) => add("KPIs", k, v, "kpi", kpiModal, k === "Severe day"));
    (D.ledger?.blocks || []).forEach((b, i, arr) => add("Ledger", `Block #${b.height}`, `${b.run_date} · ${b.n} forecasts · ${b.root.slice(0, 10)}…`, "block", () => verifyModal(b, arr[i - 1])));
    (D.catalog?.datasets || []).forEach(d => add("Open data", d.endpoint, d.title, "GET", () => apiModal(d)));
    Object.entries(D.pipeline?.latest?.stages || {}).forEach(([k, v]) => add("Pipeline", `Stage · ${k}`, `${v.status} · ${v.checks_passed}/${v.checks_total} checks · ${v.duration_s}s`, "stage", () => stageModal(k), v.status === "failed"));
    (D.pipeline?.latest?.steps || []).forEach(s => add("Pipeline", s.step, `${s.stage} · ${s.status}`, "step", () => stageModal(s.stage), s.status === "failed"));
    (D.drift?.features || []).forEach(f => add("Model health", FEAT[f.feature] || f.feature, `PSI ${f.psi} · ${f.status}`, "drift", driftModal, f.status === "drift"));
    (D.arena?.horizons || []).forEach(h => add("Model arena", `Leaderboard +${h.horizon_h}h`, h.rows.map(r => r.model).join(", "), "arena", () => arenaModal(h)));
    (D.lineage?.nodes || []).forEach(n => add("Lineage", n.label, `${n.layer}${n.rows != null ? " · " + n.rows.toLocaleString("en-IN") + " rows" : ""}`, "node", () => lineageModal(n, D.lineage.edges.filter(e => e.to === n.id).map(e => e.from), D.lineage.edges.filter(e => e.from === n.id).map(e => e.to)), n.status === "failed"));
    [["What-if simulator", "#whatif"], ["GRAP decision desk", "#desk"], ["Live now", "#live"], ["Season replay", "#top"]].forEach(([l, h]) => add("Go to", l, "section", "jump", () => document.querySelector(h)?.scrollIntoView({ behavior: "smooth" })));
    return it;
  }
  async function render() {
    const q = Q.value.trim().toLowerCase(); items = items || build(); shown = [];
    const dt = parseDate(q);
    if (dt) { const rows = await loadDaily(); const cands = rows.filter(r => { const [y, mo, d] = r.date.split("-").map(Number); return mo - 1 === dt.mo && d === dt.d && (!dt.y || y === dt.y); }).slice(-8).reverse();
      cands.forEach(r => shown.push({ group: "Days", label: dY(r.date), sub: `AQI ${r.aqi} · ${r.band}`, tag: "day", sev: r.aqi > 400, run: () => dayModal(r) }));
      if (!cands.length) shown.push({ group: "Days", label: "No observations for that date", sub: `Data covers ${rows[0]?.date || "–"} to ${rows[rows.length - 1]?.date || "–"}`, tag: "", run: () => {} }); }
    if (q) { const toks = q.split(/\s+/).filter(Boolean), per = {};
      items.map(x => ({ x, s: toks.every(t => x.hay.includes(t)) ? (x.label.toLowerCase().startsWith(toks[0]) ? 2 : 1) + (x.sev ? .5 : 0) : 0 })).filter(o => o.s).sort((a, b) => b.s - a.s)
        .forEach(({ x }) => { per[x.group] = (per[x.group] || 0) + 1; if (per[x.group] <= 6) shown.push(x); });
      const best = (D.agent?.results || []).map(r => ({ r, s: toks.filter(t => r.question.toLowerCase().includes(t)).length })).sort((a, b) => b.s - a.s)[0];
      shown.push({ group: "Ask Vayu", label: `Ask: “${Q.value.trim()}”`, sub: best?.s ? `Closest checked question: ${best.r.question}` : "Free-text questions go to the agent in the daily run", tag: "agent", run: () => best?.s ? askModal(best.r) : modal({ eyebrow: "Ask Vayu", title: Q.value.trim(), body: `<p class="muted" style="margin:0">Free-text questions are answered by the agent when it runs with an LLM (python -m vp ask "…"). This static site answers the 25 checked questions directly.</p>` }) });
    } else {
      items.filter(x => x.group === "Go to" || x.group === "Findings").forEach(x => shown.push(x));
    }
    sel = 0; let g = "", html = "";
    shown.forEach((x, i) => { if (x.group !== g) { g = x.group; html += `<div class="pal-group">${esc(g)}</div>`; }
      html += `<button type="button" class="pal-item" role="option" data-i="${i}" aria-selected="${i === sel}"><span><div>${esc(x.label)}</div><small>${esc(x.sub)}</small></span><span class="tag ${x.sev ? "sev" : ""}">${x.sev ? "● " : ""}${esc(x.tag)}</span></button>`; });
    L.innerHTML = html || `<div class="pal-group">Nothing matched</div>`;
    L.querySelectorAll(".pal-item").forEach(b => { b.onclick = () => go(+b.dataset.i); b.onmouseenter = () => mark(+b.dataset.i); });
  }
  function mark(i) { sel = i; L.querySelectorAll(".pal-item").forEach(b => b.setAttribute("aria-selected", +b.dataset.i === sel)); L.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }
  function go(i) { const x = shown[i]; if (!x) return; P.close(); setTimeout(() => x.run(), 30); }
  function open() { Q.value = ""; P.showModal(); Q.focus(); render(); }
  function init() {
    $("#search-btn").onclick = open;
    addEventListener("keydown", e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement !== Q;
      if ((e.key === "/" && !typing && !P.open) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); open(); }
    });
    let t; Q.oninput = () => { clearTimeout(t); t = setTimeout(render, 80); };
    Q.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); mark(Math.min(shown.length - 1, sel + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); mark(Math.max(0, sel - 1)); } if (e.key === "Enter") { e.preventDefault(); go(sel); } };
    P.addEventListener("click", e => { if (e.target === P) P.close(); });
  }
  return { init, open };
})();

async function dayModal(r) {
  const get = async p => { try { return (await (await fetch(p)).json()).rows || []; } catch { return []; } };
  const [fires, wx, cams] = await Promise.all([get("api/v1/fires/daily.json"), get("api/v1/weather/daily.json"), get("api/v1/cams/daily.json")]);
  const prev = d => { const t = new Date(d + "T00:00:00"); t.setDate(t.getDate() - 1); return t.toISOString().slice(0, 10); };
  const f = fires.find(x => x.date === prev(r.date)), w = wx.find(x => x.date === r.date), c = cams.find(x => x.date === r.date);
  const fc = (D.backtest?.h48 || []).find(x => String(x.target_date).slice(0, 10) === r.date);
  const led = (D.ledger?.blocks || []).flatMap(b => (b.entries || []).map(e => JSON.parse(e.line))).filter(e => e.target_date === r.date);
  const b = band(r.aqi), sev = r.aqi > 400;
  modal({ eyebrow: `Delhi · ${new Date(r.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long" })}`, title: dY(r.date),
    body: `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="big num" style="font-size:56px;color:${sev ? "var(--red)" : `var(${b[2]})`}">${n0(r.aqi)}</span><span style="font-weight:600;font-size:18px">${b[1]}</span>${sev ? `<span class="get">SEVERE</span>` : ""}<span class="muted">GRAP ${esc(r.grap || "–")} · ${r.n_stations} stations</span></div>
      <div class="stat-row" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <div class="stat"><b class="num">${r.pm25 ?? "–"}</b><span>PM2.5 µg/m³</span></div>
        <div class="stat"><b class="num" style="color:var(--ds)">${f ? n0(f.fires) : "–"}</b><span>upwind fires the day before</span></div>
        <div class="stat"><b class="num">${w ? pct(w.nw_frac) : "–"}</b><span>hours of northwest wind</span></div>
        <div class="stat"><b class="num">${w?.blh_min != null ? n0(w.blh_min) + " m" : "–"}</b><span>night mixing height</span></div>
        <div class="stat"><b class="num">${c ? n0(c.aqi_equiv) : "–"}</b><span>CAMS said</span></div>
      </div>
      <div class="card black" style="width:auto;cursor:default"><div class="eyebrow">What the model said 48 hours before</div>
        ${fc ? `<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap"><span class="big num" style="color:var(${band(fc.p50)[2]})">${n0(fc.p50)}</span><span class="num muted">range ${n0(fc.p10)}–${n0(fc.p90)} · P(severe) ${pct(fc.p_severe)}</span><span class="mono ${Math.abs(fc.p50 - r.aqi) > 60 ? "red-t" : "ok-t"}">off by ${n0(Math.abs(fc.p50 - r.aqi))}</span></div><p class="dim" style="margin:0;font-size:12px">Walk-forward backtest: the model for this season never saw it.</p>`
          : led.length ? table(["source", "horizon_h", "p10", "p50", "p90", "p_severe"], led) : `<p class="muted" style="margin:0">No forecast on record for this date. Backtests cover October–November; the ledger covers days since launch.</p>`}
      </div>` });
}

})();
