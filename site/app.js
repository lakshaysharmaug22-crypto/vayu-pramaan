/* Vayu Pramaan · site. Reads data/*.json written by the pipeline's export stage. No build step. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const FILES = ["overview", "live", "seasons", "season_points", "backtest", "findings", "decision", "agent", "ledger", "pipeline", "nomad"];
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
    status(); banner(); hero(); forecastRow(); findingsRow(); deskRow(); askRow(); liveRow(); pipelineRow(); ledgerRow(); nomadRow();
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
    <div class="btns"><button class="btn play" id="play">▶ Play the ${D.season_points?.season || ""} season</button><button class="btn ghost" id="why">Why this forecast</button></div>`;
  $("#why").onclick = () => whyModal();
  $("#play").onclick = () => map.play();
  map.init();
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

const map = (() => {
  const cv = $("#map"), ctx = cv.getContext("2d");
  const BB = { w: 73.3, e: 78.3, s: 27.5, n: 32.9 }, DELHI = [77.21, 28.61];
  let W, H, DPR, box, parts = [], pts = [], mode = "live", day = 0, days = [], windDir = 300, raf, playing = false, trail, lastT = 0, visible = true;
  function resize() {
    DPR = Math.min(2, devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const mobile = W < 760, mw = mobile ? W * 1.1 : W * .62, mh = mobile ? H * .62 : H * .92;
    const s = Math.min(mw / (BB.e - BB.w), mh / ((BB.n - BB.s) * 1.12));
    const bw = (BB.e - BB.w) * s, bh = (BB.n - BB.s) * 1.12 * s;
    box = { s, x0: mobile ? (W - bw) / 2 : W - bw - W * .04, y0: mobile ? 12 : (H - bh) / 2 };
    trail = document.createElement("canvas"); trail.width = W * DPR; trail.height = H * DPR;
    trail.getContext("2d").setTransform(DPR, 0, 0, DPR, 0, 0);
    seedParticles();
  }
  const P = (lon, lat) => [box.x0 + (lon - BB.w) * box.s, box.y0 + (BB.n - lat) * 1.12 * box.s];
  function seedParticles() { parts = Array.from({ length: Math.round(W * H / 5200) }, () => newPart(true)); }
  function newPart(any) {
    const lon = BB.w + Math.random() * (BB.e - BB.w), lat = BB.s + Math.random() * (BB.n - BB.s);
    return { lon, lat, age: any ? Math.random() * 120 : 0, life: 90 + Math.random() * 90 };
  }
  function base() {
    ctx.fillStyle = "#07090B"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#ffffff0d"; ctx.lineWidth = 1; ctx.font = "10px JetBrains Mono, monospace"; ctx.fillStyle = "#ffffff38";
    for (let lon = 74; lon <= 78; lon++) { const [x, y0] = P(lon, BB.n), [, y1] = P(lon, BB.s); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.fillText(lon + "°E", x + 3, y1 - 4); }
    for (let lat = 28; lat <= 32; lat++) { const [x0, y] = P(BB.w, lat), [x1] = P(BB.e, lat); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(lat + "°N", x0 + 3, y - 4); }
    ctx.font = "600 12px Instrument Sans, sans-serif"; ctx.fillStyle = "#ffffff55"; ctx.letterSpacing = "3px";
    [["PUNJAB", 75.25, 31.35], ["HARYANA", 76.05, 29.35]].forEach(([t, lo, la]) => { const [x, y] = P(lo, la); ctx.fillText(t, x, y); });
    ctx.letterSpacing = "0px";
  }
  function draw(t) {
    const dt = Math.min(50, t - lastT || 16); lastT = t;
    base();
    // wind: particles move toward (dir + 180); trails on offscreen canvas with decay
    const tc = trail.getContext("2d");
    tc.globalCompositeOperation = "destination-out"; tc.fillStyle = "rgba(0,0,0,.08)"; tc.fillRect(0, 0, W, H); tc.globalCompositeOperation = "source-over";
    const rad = (windDir + 180) * Math.PI / 180, vx = Math.sin(rad), vy = Math.cos(rad), sp = .0065 * dt / 16;
    tc.strokeStyle = "rgba(170,195,220,.55)"; tc.lineWidth = 1.1;
    parts.forEach((p, i) => {
      const [x0, y0] = P(p.lon, p.lat);
      const wob = Math.sin((p.lat + p.lon) * 3 + t / 900) * .25;
      p.lon += (vx + wob * vy) * sp; p.lat += (vy - wob * vx) * sp; p.age++;
      const [x1, y1] = P(p.lon, p.lat);
      tc.beginPath(); tc.moveTo(x0, y0); tc.lineTo(x1, y1); tc.stroke();
      if (p.age > p.life || p.lon < BB.w || p.lon > BB.e || p.lat < BB.s || p.lat > BB.n) parts[i] = newPart(false);
    });
    ctx.drawImage(trail, 0, 0, W, H);
    // fires
    const now = mode === "play" ? days[day]?.date : null;
    pts.forEach(p => {
      const [x, y] = P(p.lon, p.lat);
      let a = 1;
      if (mode === "play") { const age = (new Date(now) - new Date(p.date)) / 864e5; if (age < 0) return; a = Math.max(.12, 1 - age / 6); }
      ctx.fillStyle = `rgba(255,122,69,${.18 * a})`; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,${160 + 60 * a | 0},110,${.9 * a})`; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill();
    });
    // Delhi
    const [dx, dy] = P(...DELHI), pulse = (t / 1600) % 1, aqi = mode === "play" ? days[day]?.aqi : D.overview.latest?.aqi;
    const bc = aqi ? cssv(band(aqi)[2]) : "#fff";
    ctx.strokeStyle = bc; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(dx, dy, 8 + pulse * 26, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = bc; ctx.beginPath(); ctx.arc(dx, dy, 7, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(dx, dy, 2.5, 0, 7); ctx.fill();
    ctx.font = "700 13px Bricolage Grotesque, sans-serif"; ctx.fillText("DELHI", dx + 14, dy + 4);
    raf = visible ? requestAnimationFrame(draw) : null;
  }
  function init() {
    resize(); addEventListener("resize", resize);
    const live = D.live?.fire_points || [];
    pts = live; const w = D.live?.wind?.slice(-1)[0]; windDir = w?.wind_dir ?? 300;
    new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible && !raf) raf = requestAnimationFrame(draw); }).observe(cv);
    if (reduce) { base(); draw(0); cancelAnimationFrame(raf); return; }
    raf = requestAnimationFrame(draw);
  }
  function play() {
    if (playing) return;
    const sp = D.season_points, y = sp?.season, rows = (D.seasons || []).filter(r => r.date.startsWith(String(y)) && ["10", "11"].includes(r.date.slice(5, 7)));
    if (!rows.length) return;
    playing = true; mode = "play"; days = rows; day = 0; pts = sp.points;
    const rp = $("#replay"); rp.hidden = false;
    const step = () => {
      const r = days[day]; windDir = r.wind_dir ?? windDir;
      const b = band(r.aqi);
      rp.innerHTML = `<div><div class="lbl">${y} season</div><div class="big num">${d8(r.date)}</div></div><div><div class="lbl">Delhi AQI</div><div class="big num" style="color:var(${b[2]})">${n0(r.aqi)}</div></div><div><div class="lbl">Upwind fires</div><div class="big num" style="color:var(--ds)">${n0(r.fires)}</div></div>`;
      if (++day < days.length) setTimeout(step, reduce ? 60 : 260);
      else setTimeout(() => { playing = false; mode = "live"; pts = D.live?.fire_points || []; rp.hidden = true; windDir = D.live?.wind?.slice(-1)[0]?.wind_dir ?? 300; }, 2600);
    };
    step();
  }
  return { init, play };
})();

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
    foot: "Query + result", open: () => modal({ eyebrow: "Data Analyst · DuckDB", title: f.title,
      body: `<p style="margin:0;font-size:16px">${esc(f.takeaway || "")}</p>${findingChart(f, 640)}${f.rows ? table(Object.keys(f.rows[0] || {}), f.rows) : ""}<div><div class="eyebrow" style="margin-bottom:6px">Query</div><pre>${kw(f.sql)}</pre></div>` }),
  }));
  cards.push(card({ title: "KPI dictionary", eyebrow: "Shared definitions", body: `<p class="take">One definition per metric, used by every chart, the decision desk and the agent.</p>`, foot: "8 metrics", open: kpiModal }));
  row({ id: "findings", title: "Smog findings", role: "Data Analyst", c: "--da", sub: "Six questions about where Delhi's smog comes from, each answered by one query you can read.", cards });
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
  const N = D.nomad || {}, repo = "https://github.com/lakshaysharmaug22-crypto/nomad-loop-engine";
  if (!N.status || N.status === "not_run") {
    const flows = ["Open every row and detail view", "Play the season replay", "Drag both GRAP cost sliders", "Open an Ask Vayu question", "Verify a ledger block in the browser", "Check the page on a phone-width screen"];
    row({ id: "nomad", title: "Tested by Nomad Loop", role: "Engineering QA", c: "--qa", sub: "Nomad Loop Engine explores this site like a user on every deploy, files bugs with repro steps, and blocks the release on a critical one.",
      cards: [card({ eyebrow: "Release gate", title: "Awaiting first run", body: `<div class="big muted">–</div><p class="take">The first Nomad run is wired into the deploy workflow. Results appear here after it runs.</p>`, foot: `<a href="${repo}" onclick="event.stopPropagation()">See the engine ›</a>` }),
        ...flows.map((f, i) => card({ eyebrow: `Flow ${i + 1}`, title: f, body: `<span class="pill skipped">not run yet</span>`, foot: "" }))] });
    return;
  }
  const flows = N.flows || [], bugs = N.bugs || [], hist = N.history || [];
  const verdict = card({ eyebrow: `Run ${esc(N.run_id || "")} · ${N.duration_s ?? "–"}s`, title: N.verdict === "ship" ? "Shipped" : "Blocked",
    body: `<div class="big" style="color:${N.verdict === "ship" ? "var(--qa)" : "var(--vpoor)"}">${flows.filter(f => f.status === "pass").length}/${flows.length} flows</div><p class="take">${bugs.length} bug${bugs.length === 1 ? "" : "s"} found · ${hist.filter(h => h.verdict === "blocked").length} releases blocked so far</p>`,
    foot: `<a href="${repo}" onclick="event.stopPropagation()">See the engine ›</a>` });
  const fl = flows.map(f => card({ eyebrow: "Flow", title: f.name, body: `<span class="pill ${f.status === "pass" ? "ok" : "bad"}">${f.status}</span><div class="muted" style="font-size:12.5px">${f.steps ?? "–"} steps · ${f.duration_s ?? "–"}s</div>`, foot: "" }));
  const bg = bugs.map(x => card({ eyebrow: `${esc(x.severity || "")} · ${esc(x.status || "")}`, title: x.title, body: `<ol style="margin:0;padding-left:18px;font-size:12.5px" class="muted">${(x.repro || []).slice(0, 4).map(s => `<li>${esc(s)}</li>`).join("")}</ol>`, foot: x.issue_url ? `<a href="${esc(x.issue_url)}" onclick="event.stopPropagation()">GitHub issue ›</a>` : "" }));
  row({ id: "nomad", title: "Tested by Nomad Loop", role: "Engineering QA", c: "--qa", sub: "Nomad Loop Engine explores this site like a user on every deploy, files bugs with repro steps, and blocks the release on a critical one.", cards: [verdict, ...fl, ...bg] });
}
})();
