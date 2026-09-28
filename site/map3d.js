/* Vayu Pramaan · 3D hero map. MapLibre GL basemap + deck.gl layers.
   Layers: 3D fire hexagons · wind particle flow · estimated smoke paths · station pillars · AQI surface.
   Interactions: timeline scrubber (today / latest season), click-to-inspect, camera fly-through. */
window.VayuMap = (() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  const DELHI = [77.209, 28.614], LUDHIANA = [75.857, 30.901];
  const DELHI_BOX = [76.83, 28.40, 77.36, 28.89];
  const PLACES = [["Ludhiana", 75.857, 30.901], ["Amritsar", 74.872, 31.634], ["Patiala", 76.387, 30.340], ["Bathinda", 74.951, 30.211],
    ["Chandigarh", 76.779, 30.733], ["Karnal", 76.990, 29.686], ["Hisar", 75.722, 29.149], ["Panipat", 76.968, 29.391]];
  const BAND_RGB = [[50, [63, 178, 106]], [100, [156, 203, 74]], [200, [230, 195, 58]], [300, [240, 138, 44]], [400, [229, 72, 77]], [1e9, [255, 40, 40]]];
  const bandRGB = a => (BAND_RGB.find(b => (a ?? 0) <= b[0]) || BAND_RGB[5])[1];
  const EMBER = [[255, 196, 120], [255, 150, 70], [255, 106, 50], [240, 60, 40], [200, 20, 25], [120, 0, 10]];
  let D, H, map, overlay, stations = {}, region = null, raf = null, visible = true;
  const S = { mode: "today", day: 0, playing: false, speed: 1, t: 0, flying: false,
    layers: { fires: true, wind: true, smoke: true, stations: true, surface: true, labels: true } };
  let view = {}; // current frame data
  let seasonDays = [], ptsByDate = {}, stByDate = {};

  const norm = s => String(s || "").toLowerCase().replace(/\b(dpcc|cpcb|imd|iitm|delhi|new|dpc)\b/g, "").replace(/[^a-z0-9]/g, "");
  function coordFor(name) {
    const k = norm(name);
    if (stations[k]) return stations[k];
    const hit = Object.keys(stations).find(s => k.includes(s) || s.includes(k));
    return hit ? stations[hit] : null;
  }

  /* ---- frame data ---- */
  function frame() {
    let fires, st, wind, aqi, date, fireCount;
    if (S.mode === "season" && seasonDays.length) {
      const r = seasonDays[S.day]; date = r.date; aqi = r.aqi; fireCount = r.fires;
      const prev = seasonDays[S.day - 1]?.date;
      fires = [...(ptsByDate[date] || []), ...(prev ? ptsByDate[prev] || [] : [])];
      st = (stByDate[date] || []).map(x => ({ ...x }));
      wind = { dir: r.wind_dir ?? 300, speed: r.wind_speed ?? 2, nw: r.nw_frac };
    } else {
      fires = D.live?.fire_points || []; date = D.overview?.latest?.date; aqi = D.overview?.latest?.aqi;
      fireCount = (D.live?.fires_daily || []).slice(-1)[0]?.fires;
      st = (D.live?.stations_latest || []).map(x => ({ ...x }));
      const w = (D.live?.wind || []).slice(-1)[0] || {};
      wind = { dir: w.wind_dir ?? 300, speed: w.wind_speed ?? 2, nw: w.nw_frac };
    }
    st.forEach(s => s.pos = coordFor(s.station)); st = st.filter(s => s.pos && s.aqi != null);
    view = { fires, stations: st, wind, aqi, date, fireCount, trips: windTrips(wind), smoke: smokePaths(fires, wind), surface: surface(st) };
    render(); hud();
  }

  // Uniform wind from the day's Delhi mean, gently meandering so the flow reads as air, not arrows.
  function windTrips(w) {
    const n = innerWidth < 760 ? 260 : 620, steps = 34, rad = ((w.dir ?? 300) + 180) * Math.PI / 180;
    const vx = Math.sin(rad), vy = Math.cos(rad), sp = 0.018 + Math.min(6, w.speed || 2) * 0.006;
    const out = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      let x = 72.6 + rnd() * 6.6, y = 27.2 + rnd() * 6.2; const path = [], ts = [], t0 = rnd() * 100;
      for (let k = 0; k < steps; k++) {
        path.push([x, y]); ts.push(t0 + k * 3);
        const m = Math.sin(y * 2.3 + x * 1.7) * 0.35;
        x += (vx + m * vy) * sp; y += (vy - m * vx) * sp;
      }
      out.push({ path, ts });
    }
    return out;
  }

  // Estimated smoke paths: advect the biggest fire clusters with the day's wind for 36 hours.
  function smokePaths(fires, w) {
    if (!fires.length) return [];
    const cells = {};
    fires.forEach(p => { const k = `${Math.round(p.lon * 4) / 4},${Math.round(p.lat * 4) / 4}`; (cells[k] = cells[k] || { n: 0, lon: 0, lat: 0 }); cells[k].n++; cells[k].lon += p.lon; cells[k].lat += p.lat; });
    const top = Object.values(cells).map(c => ({ n: c.n, lon: c.lon / c.n, lat: c.lat / c.n })).sort((a, b) => b.n - a.n).slice(0, 10);
    const rad = ((w.dir ?? 300) + 180) * Math.PI / 180, kmh = Math.max(0.8, w.speed || 2) * 3.6, degPerH = kmh / 111;
    return top.map(c => {
      let x = c.lon, y = c.lat; const path = [[x, y]], ts = [0]; let near = Infinity, hit = null;
      for (let h = 1; h <= 36; h++) {
        x += Math.sin(rad) * degPerH / Math.cos(y * Math.PI / 180); y += Math.cos(rad) * degPerH;
        path.push([x, y]); ts.push(h);
        const d = Math.hypot((x - DELHI[0]) * Math.cos(28.6 * Math.PI / 180), y - DELHI[1]) * 111;
        if (d < near) { near = d; if (d < 45 && hit == null) hit = h; }
      }
      return { path, ts, n: c.n, reaches: hit, near: Math.round(near) };
    });
  }

  // Inverse-distance-weighted AQI surface over Delhi, clipped to the state outline.
  function surface(st) {
    if (st.length < 3) return null;
    const W = 180, Hh = 180, cv = document.createElement("canvas"); cv.width = W; cv.height = Hh;
    const cx = cv.getContext("2d"), img = cx.createImageData(W, Hh), [x0, y0, x1, y1] = DELHI_BOX;
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
      const lon = x0 + (i + .5) / W * (x1 - x0), lat = y1 - (j + .5) / Hh * (y1 - y0);
      let num = 0, den = 0;
      for (const s of st) { const d2 = (s.pos[0] - lon) ** 2 + (s.pos[1] - lat) ** 2 + 1e-6, w = 1 / d2; num += w * s.aqi; den += w; }
      const a = num / den, c = a > 400 ? [Math.max(40, 255 - (a - 400) * 2), 20, 20] : bandRGB(a), o = (j * W + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = a > 400 ? 175 : 125;
    }
    cx.putImageData(img, 0, 0);
    const delhi = region?.features.find(f => f.properties.name === "Delhi");
    if (delhi) {
      const m = document.createElement("canvas"); m.width = W; m.height = Hh; const mx = m.getContext("2d");
      const P = ([lon, lat]) => [(lon - x0) / (x1 - x0) * W, (y1 - lat) / (y1 - y0) * Hh];
      const polys = delhi.geometry.type === "Polygon" ? [delhi.geometry.coordinates] : delhi.geometry.coordinates;
      mx.beginPath(); polys.forEach(poly => poly.forEach(ring => ring.forEach((pt, k) => { const [a, b] = P(pt); k ? mx.lineTo(a, b) : mx.moveTo(a, b); })));
      mx.clip(); mx.filter = "blur(2px)"; mx.drawImage(cv, 0, 0); return m;
    }
    return cv;
  }

  /* ---- deck layers ---- */
  function render() {
    if (!overlay) return;
    const L = S.layers, t = S.t, dk = deck, layers = [];
    if (L.surface && view.surface) layers.push(new dk.BitmapLayer({ id: "surface", image: view.surface, bounds: DELHI_BOX, opacity: .9, updateTriggers: { image: view.date } }));
    if (reduce) {
      if (L.wind) layers.push(new dk.PathLayer({ id: "wind", data: view.trips, getPath: d => d.path.slice(0, 12), getColor: [190, 205, 225, 70], widthMinPixels: 1, updateTriggers: { getPath: view.date } }));
      if (L.smoke) layers.push(new dk.PathLayer({ id: "smoke", data: view.smoke, getPath: d => d.path, getColor: d => d.reaches ? [255, 59, 59, 220] : [255, 140, 70, 180], getWidth: d => 2 + Math.sqrt(d.n) * .6, widthUnits: "pixels", pickable: true, capRounded: true, updateTriggers: { getPath: view.date } }));
    }
    if (L.wind && !reduce) layers.push(new dk.TripsLayer({ id: "wind", data: view.trips, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: [190, 205, 225], opacity: .32, widthMinPixels: 1.1, trailLength: 26, currentTime: (t * 14) % 130, capRounded: true, updateTriggers: { getPath: view.date } }));
    if (L.smoke && !reduce) layers.push(new dk.TripsLayer({ id: "smoke", data: view.smoke, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: d => d.reaches ? [255, 59, 59] : [255, 140, 70], getWidth: d => 2 + Math.sqrt(d.n) * .9, widthUnits: "pixels", opacity: .85,
      trailLength: 14, currentTime: (t * 3.2) % 42, capRounded: true, jointRounded: true, pickable: true, updateTriggers: { getPath: view.date } }));
    if (L.fires) layers.push(new dk.HexagonLayer({ id: "fires", data: view.fires, getPosition: d => [d.lon, d.lat], radius: 7000, coverage: .86,
      extruded: true, elevationScale: 40, elevationRange: [0, 1100], colorRange: EMBER, upperPercentile: 99, pickable: true,
      material: { ambient: .5, diffuse: .6, shininess: 40 }, transitions: reduce ? {} : { elevationScale: 600 }, updateTriggers: { getPosition: view.date } }));
    if (L.stations) layers.push(new dk.ColumnLayer({ id: "stations", data: view.stations, getPosition: d => d.pos, diskResolution: 14, radius: 1150,
      extruded: true, getElevation: d => d.aqi * 22, getFillColor: d => d.aqi > 400 ? [255, 40, 40, 245] : [...bandRGB(d.aqi), 235],
      getLineColor: [0, 0, 0], pickable: true, material: { ambient: .6, diffuse: .6 }, updateTriggers: { getElevation: view.date, getFillColor: view.date },
      transitions: reduce ? {} : { getElevation: 500 } }));
    const pulse = (t % 1.6) / 1.6, sev = (view.aqi ?? 0) > 400;
    layers.push(new dk.ScatterplotLayer({ id: "delhi-pulse", data: [DELHI], getPosition: d => d, getRadius: 3000 + pulse * 16000, radiusUnits: "meters",
      stroked: true, filled: false, getLineColor: sev ? [255, 40, 40, 255 * (1 - pulse)] : [255, 255, 255, 200 * (1 - pulse)], lineWidthMinPixels: 2, updateTriggers: { getRadius: t, getLineColor: t } }));
    if (L.labels) layers.push(new dk.TextLayer({ id: "labels", data: [["PUNJAB", 75.25, 31.2, 16], ["HARYANA", 76.2, 29.45, 16], ["DELHI", 77.35, 28.62, 15], ...PLACES.map(p => [...p, 11])],
      getPosition: d => [d[1], d[2]], getText: d => d[0], getSize: d => d[3], getColor: d => d[3] > 12 ? [255, 255, 255, 150] : [200, 205, 212, 130],
      fontFamily: "Instrument Sans, system-ui, sans-serif", fontWeight: 600, characterSet: "auto", getTextAnchor: "start", getPixelOffset: d => d[3] > 12 ? [0, 0] : [6, 0],
      billboard: true, outlineWidth: 2, outlineColor: [0, 0, 0, 200], fontSettings: { sdf: true } }));
    overlay.setProps({ layers });
  }

  function tooltip({ object, layer }) {
    if (!object) return null;
    const box = html => ({ html, style: { background: "#000", border: "1px solid #3a0a0e", borderRadius: "10px", color: "#EAEDF0", font: "13px Instrument Sans, sans-serif", padding: "10px 12px", maxWidth: "240px" } });
    if (layer.id === "fires") return box(`<b style="color:#FF7A45">${object.count ?? object.points?.length} fire detections</b><br><span style="color:#9AA4AF">in this 7 km hexagon, ${S.mode === "season" ? "this day and the day before" : "last 3 days"}</span>`);
    if (layer.id === "stations") return box(`<b>${object.station}</b><br><span style="font-size:20px;font-weight:700;color:rgb(${bandRGB(object.aqi)})">${Math.round(object.aqi)}</span> AQI<br><span style="color:#9AA4AF">Click for details</span>`);
    if (layer.id === "smoke") return box(`<b style="color:${object.reaches ? "#FF3B3B" : "#FF8C46"}">Smoke from ${object.n} detections</b><br>${object.reaches ? `Reaches Delhi in about ${object.reaches} h` : `Passes ${object.near} km from Delhi`}<br><span style="color:#9AA4AF">Estimated from the day's wind, not a dispersion model</span>`);
    return null;
  }
  function onClick({ object, layer }) {
    if (!object) return;
    if (layer.id === "stations") H.station(object);
    if (layer.id === "fires") map.flyTo({ center: object.position, zoom: 9, pitch: 60, duration: 1400 });
  }

  /* ---- HUD: timeline + layer panel ---- */
  function hud() {
    const b = $("#tl-date"), a = $("#tl-aqi"), f = $("#tl-fires"), w = $("#tl-wind");
    if (!b) return;
    b.textContent = view.date ? new Date(String(view.date).slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";
    a.textContent = view.aqi != null ? Math.round(view.aqi) : "–"; a.style.color = view.aqi > 400 ? "#FF3B3B" : `rgb(${bandRGB(view.aqi)})`;
    f.textContent = view.fireCount != null ? Math.round(view.fireCount).toLocaleString("en-IN") : "–";
    const dir = view.wind?.dir; w.textContent = dir != null ? `${Math.round(dir)}°${dir >= 270 && dir <= 340 ? " NW" : ""}` : "–";
    w.style.color = dir >= 270 && dir <= 340 ? "#FF7A45" : "";
    const reach = view.smoke?.filter(s => s.reaches).length || 0;
    $("#tl-smoke").textContent = `${reach} of ${view.smoke?.length || 0} plumes reach Delhi`;
    $("#tl-smoke").style.color = reach ? "#FF3B3B" : "";
    const sl = $("#tl-range"); if (sl && S.mode === "season") sl.value = S.day;
  }
  function buildHud() {
    const hero = $("#top");
    const panel = document.createElement("div"); panel.className = "map-panel";
    const names = { fires: "Fire columns", wind: "Wind flow", smoke: "Smoke paths", stations: "Station pillars", surface: "AQI surface", labels: "Labels" };
    panel.innerHTML = `<div class="mp-h">Layers</div>${Object.keys(S.layers).map(k => `<label class="mp-row"><input type="checkbox" data-l="${k}" ${S.layers[k] ? "checked" : ""}><span class="sw sw-${k}"></span>${names[k]}</label>`).join("")}
      <div class="mp-btns"><button type="button" id="mp-3d" aria-pressed="true">3D</button><button type="button" id="mp-fly">Fly</button><button type="button" id="mp-reset">Reset</button></div>`;
    hero.append(panel);
    panel.querySelectorAll("input[data-l]").forEach(i => i.onchange = () => { S.layers[i.dataset.l] = i.checked; render(); });
    $("#mp-3d").onclick = e => { const on = map.getPitch() < 20; map.easeTo({ pitch: on ? 52 : 0, bearing: on ? -14 : 0, duration: 900 }); e.target.setAttribute("aria-pressed", on); };
    $("#mp-fly").onclick = () => fly(true);
    $("#mp-reset").onclick = () => map.easeTo({ ...home(), duration: 1200 });

    const days = seasonDays, yr = D.season_points?.season;
    const tl = document.createElement("div"); tl.className = "timeline";
    const spark = days.length ? (() => { const w = 1000, h = 34, mx = Math.max(500, ...days.map(d => d.aqi || 0));
      return `<svg class="tl-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${days.map((d, i) => { const x = i / (days.length - 1) * w, bh = (d.aqi || 0) / mx * h; return `<rect x="${x - w / days.length / 2}" y="${h - bh}" width="${w / days.length * .8}" height="${bh}" fill="${d.aqi > 400 ? "#FF3B3B" : "#3a3f47"}"/>`; }).join("")}</svg>`; })() : "";
    tl.innerHTML = `<div class="tl-modes"><button type="button" data-m="today" aria-pressed="true">Today</button>${days.length ? `<button type="button" data-m="season" aria-pressed="false">${yr} season</button>` : ""}</div>
      <button type="button" class="tl-play" id="tl-play" aria-label="Play season">▶</button>
      <div class="tl-track">${spark}<input type="range" id="tl-range" min="0" max="${Math.max(0, days.length - 1)}" value="0" aria-label="Day of season"></div>
      <button type="button" class="tl-speed" id="tl-speed">1×</button>
      <div class="tl-read"><div><span>Date</span><b id="tl-date">–</b></div><div><span>Delhi AQI</span><b id="tl-aqi">–</b></div><div><span>Upwind fires</span><b id="tl-fires">–</b></div><div><span>Wind from</span><b id="tl-wind">–</b></div><div class="tl-smoke-w"><span>Smoke</span><b id="tl-smoke">–</b></div></div>`;
    hero.append(tl);
    tl.querySelectorAll("[data-m]").forEach(b => b.onclick = () => setMode(b.dataset.m));
    $("#tl-range").oninput = e => { if (S.mode !== "season") setMode("season", false); S.day = +e.target.value; frame(); };
    $("#tl-play").onclick = () => S.playing ? stop() : play();
    $("#tl-speed").onclick = e => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; e.target.textContent = S.speed + "×"; };
    $("#tl-range").disabled = !days.length;
  }
  function setMode(m, reframe = true) {
    S.mode = m; document.querySelectorAll(".tl-modes button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
    $("#top").classList.toggle("season-mode", m === "season");
    if (m === "today") stop();
    if (reframe) frame();
  }
  let timer = null;
  function play() {
    if (!seasonDays.length) return;
    if (S.mode !== "season") { setMode("season", false); S.day = 0; }
    if (S.day >= seasonDays.length - 1) S.day = 0;
    S.playing = true; $("#tl-play").textContent = "❚❚"; frame();
    const tick = () => { if (!S.playing) return; if (S.day >= seasonDays.length - 1) { stop(); return; } S.day++; frame(); timer = setTimeout(tick, (reduce ? 120 : 700) / S.speed); };
    timer = setTimeout(tick, 700 / S.speed);
  }
  function stop() { S.playing = false; clearTimeout(timer); const p = $("#tl-play"); if (p) p.textContent = "▶"; }

  /* ---- camera ---- */
  const home = () => innerWidth < 760 ? { center: [76.3, 29.6], zoom: 5.6, pitch: 40, bearing: -10 } : { center: [75.2, 29.9], zoom: 6.55, pitch: 50, bearing: -14 };
  async function fly(force) {
    if ((reduce && !force) || S.flying) return;
    S.flying = true;
    const stop = () => { S.flying = false; };
    map.once("mousedown", stop); map.once("touchstart", stop); map.once("wheel", stop);
    const hop = (o, ms) => new Promise(res => { if (!S.flying) return res(); map.flyTo({ ...o, duration: ms, essential: true }); map.once("moveend", res); });
    await hop({ center: [75.05, 31.05], zoom: 8.3, pitch: 64, bearing: -42 }, force ? 1800 : 10);
    await hop({ center: LUDHIANA, zoom: 8.6, pitch: 66, bearing: 115 }, 3600);
    await hop({ center: [76.55, 29.7], zoom: 8.1, pitch: 62, bearing: 140 }, 3600);
    await hop({ center: DELHI, zoom: 9.6, pitch: 58, bearing: 150 }, 3400);
    await hop(home(), 3200);
    S.flying = false;
  }

  /* ---- boot ---- */
  async function styleOrFallback() {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch(STYLE_URL, { signal: ctl.signal }); clearTimeout(to);
      if (r.ok) { const j = await r.json(); return { style: j, basemap: true }; }
    } catch { /* offline or blocked: draw our own */ }
    return { style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#050607" } }] }, basemap: false };
  }
  function addRegion(basemap) {
    if (!region) return;
    map.addSource("region", { type: "geojson", data: region });
    map.addLayer({ id: "region-fill", type: "fill", source: "region", paint: { "fill-color": ["case", ["get", "focus"], "#FF3B3B", "#ffffff"], "fill-opacity": ["case", ["get", "focus"], basemap ? .035 : .05, basemap ? 0 : .015] } });
    map.addLayer({ id: "region-line", type: "line", source: "region", paint: { "line-color": ["case", ["get", "focus"], "#ffffff", "#8a9099"], "line-opacity": ["case", ["get", "focus"], .45, .18], "line-width": ["case", ["get", "focus"], 1.3, .8] } });
    if (basemap) try {
      map.addSource("dem", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 10 });
      map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": .35, "hillshade-shadow-color": "#000", "hillshade-highlight-color": "#2a2f36" } }, "region-fill");
    } catch { /* terrain optional */ }
  }
  async function init(data, hooks) {
    D = data; H = hooks;
    const el = $("#map3d");
    if (!window.maplibregl || !window.deck) { el.innerHTML = `<p class="map-fail">Map libraries didn't load.</p>`; return; }
    try {
      const [sj, rg] = await Promise.all([fetch("geo/stations.json").then(r => r.json()).catch(() => ({ stations: {} })), fetch("geo/region.geojson").then(r => r.json()).catch(() => null)]);
      stations = sj.stations || {}; region = rg;
      seasonDays = (D.seasons || []).filter(r => r.date.startsWith(String(D.season_points?.season)) && ["10", "11"].includes(r.date.slice(5, 7)));
      (D.season_points?.points || []).forEach(p => (ptsByDate[p.date] = ptsByDate[p.date] || []).push(p));
      (D.season_stations?.rows || []).forEach(p => (stByDate[String(p.date).slice(0, 10)] = stByDate[String(p.date).slice(0, 10)] || []).push(p));
      const { style, basemap } = await styleOrFallback();
      map = new maplibregl.Map({ container: el, style, ...home(), pitch: reduce ? 45 : 64, center: reduce ? home().center : [75.05, 31.05], zoom: reduce ? home().zoom : 8.3, bearing: reduce ? -14 : -42,
        attributionControl: false, maxPitch: 75, dragRotate: true, cooperativeGestures: innerWidth < 760 });
      map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: basemap ? "© OpenStreetMap contributors © CARTO · Natural Earth" : "Natural Earth · offline basemap" }), "bottom-right");
      map.on("load", () => {
        addRegion(basemap);
        overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip, onClick });
        map.addControl(overlay);
        buildHud(); frame();
        new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible && !raf) loop(); }).observe(el);
        loop();
        if (!reduce) setTimeout(() => fly(false), 400);
        el.classList.add("ready");
      });
    } catch (e) { el.innerHTML = `<p class="map-fail">3D map unavailable here (${String(e.message || e).slice(0, 80)}). Everything else works.</p>`; }
  }
  let last = 0;
  function loop(ts = 0) {
    if (!visible || document.hidden) { raf = null; return; }
    const dt = Math.min(.05, (ts - last) / 1000 || .016); last = ts;
    if (!reduce) { S.t += dt; render(); }
    raf = requestAnimationFrame(loop);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && visible && !raf) loop(); });
  return { init, play: () => { play(); document.getElementById("top").scrollIntoView({ behavior: "smooth" }); }, setMode };
})();
