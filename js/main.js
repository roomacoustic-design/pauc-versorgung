import {
  ANKER_TYPEN, ESSEN_TYPEN, LAEDEN_TYPEN, WASSER_TYPEN, LUECKE_KM,
  matchPosition, hmZwischen, naechsterClimb, autoSchnitt, fahrzeitMin, etaMs,
  statusZu, istAnker, findeLuecke, letzteVersorgungVorLuecke, letzterPunktDesTages,
} from "./logic.js";

const ICONS = {
  "Supermarkt": "🛒", "Nachbarschaftsladen": "🏪", "Bäckerei": "🥖",
  "Tankstelle": "⛽", "Kiosk": "🗞️", "Getränkemarkt": "🧃", "Café": "☕",
  "Fast Food": "🍔", "Eisdiele": "🍦", "Trinkwasser": "💧", "Quelle": "⛲",
  "Friedhof (Trinkwasser)": "🪦", "Toilette": "🚻", "Verkaufsautomat": "🥤",
  "Checkpoint": "📍",
};
const FILTER_SETS = { essen: ESSEN_TYPEN, laeden: LAEDEN_TYPEN, wasser: WASSER_TYPEN };
const DEFAULT_KMH = 18;

const state = {
  tour: null,
  posMode: "gps",          // gps | manuell
  manualKm: 0,
  matchIdx: -1,
  km: 0,
  offRoute: false,
  gpsStatus: "aus",        // aus | warte | ok | fehler
  lastFixT: 0,
  samples: [],             // {t, km} für Bewegungsschnitt
  speedMode: "auto",       // auto | manuell | konservativ
  manualKmh: 20,
  filter: "alles",
  horizontKm: 50,
  wakeLock: null,
};

const $ = (id) => document.getElementById(id);

// --- Persistenz ---------------------------------------------------------------

function speichern() {
  localStorage.setItem("versorgung", JSON.stringify({
    posMode: state.posMode, manualKm: state.manualKm, matchIdx: state.matchIdx,
    speedMode: state.speedMode, manualKmh: state.manualKmh, filter: state.filter,
  }));
}
function laden() {
  try {
    const s = JSON.parse(localStorage.getItem("versorgung") || "{}");
    Object.assign(state, s);
  } catch { /* egal */ }
}

// --- Formatierung ---------------------------------------------------------------

const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const km1 = (v) => nf1.format(v);
const WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function uhr(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function uhrMitTag(ms, refMs) {
  const d = new Date(ms), r = new Date(refMs);
  return d.getDate() === r.getDate() && d.getMonth() === r.getMonth()
    ? uhr(ms) : `${WOCHENTAGE[d.getDay()]} ${uhr(ms)}`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// --- Geschwindigkeit ---------------------------------------------------------------

function effektiverSchnitt() {
  const auto = autoSchnitt(state.samples, Date.now());
  if (state.speedMode === "manuell") return { v: state.manualKmh, quelle: "manuell" };
  if (state.speedMode === "konservativ") {
    return { v: (auto ?? DEFAULT_KMH) * 0.8, quelle: auto ? "konservativ" : "konservativ*" };
  }
  return auto ? { v: auto, quelle: "auto" } : { v: DEFAULT_KMH, quelle: "Annahme" };
}

// --- Statuszeile pro POI ---------------------------------------------------------------

// "bis"-Zeitpunkt lesbar machen; Intervalle bis ans Fensterende = durchgehend offen
function bisText(bis, refMs) {
  const fenster = state.tour.meta.zeiten_fenster;
  if (fenster && bis >= fenster[1] - 60000) return "durchgehend";
  return `bis ${uhrMitTag(bis, refMs)}`;
}

function statusHtml(poi, eta) {
  const oz = poi.oeffnungszeiten;
  const fenster = state.tour.meta.zeiten_fenster;
  if (!ESSEN_TYPEN.has(poi.typ)) return "";                       // Wasser & Co: keine Zeiten nötig
  const st = statusZu(oz, eta, fenster);
  switch (st.code) {
    case "offen": return `<div class="status s-offen">offen ${bisText(st.bis, eta)}</div>`;
    case "knapp": return `<div class="status s-knapp">knapp! schließt ${uhrMitTag(st.bis, eta)}</div>`;
    case "zu": return `<div class="status s-zu">zu${st.naechste ? ` — öffnet ${uhrMitTag(st.naechste, eta)}` : ""}</div>`;
    default: return `<div class="status s-unbekannt">Zeiten unbekannt</div>`;
  }
}

// --- Rendering ---------------------------------------------------------------

function render() {
  const t = state.tour;
  if (!t) return;
  const now = Date.now();
  const { v, quelle } = effektiverSchnitt();
  const fenster = t.meta.zeiten_fenster;

  // Kopfzeile
  $("pos-km").textContent = km1(state.km);
  $("pos-mode").textContent = state.posMode === "manuell" ? "manuell"
    : state.offRoute ? "⚠ abseits" : "GPS";
  $("pos-mode").classList.toggle("warnend", state.offRoute && state.posMode === "gps");
  $("speed-val").textContent = nf1.format(v);
  $("speed-mode").textContent = quelle;
  $("clock").textContent = uhr(now);
  $("gps-status").textContent = state.posMode === "manuell" ? "km gesetzt"
    : { aus: "GPS aus", warte: "suche GPS…", ok: "GPS ok", fehler: "GPS-Fehler" }[state.gpsStatus];

  // GPS-Problem? Großer Knopf — iOS zeigt den Standort-Dialog zuverlässig
  // erst nach einer echten Nutzer-Geste.
  let warnHtml = "";
  const gpsHaengt = state.gpsStatus === "warte" && now - (state.gpsSeit || 0) > 8000;
  if (state.posMode === "gps"
      && (state.gpsStatus === "fehler" || state.gpsStatus === "aus" || gpsHaengt)) {
    const hinweis = state.gpsError === 1
      ? "Standort ist blockiert. iPhone: Einstellungen → Datenschutz → Ortungsdienste → Safari-Websites (bzw. „Versorgung“) → „Beim Verwenden“. Danach hier tippen."
      : "Hier tippen, um die Standortfreigabe anzustoßen.";
    warnHtml += `<button class="card warnung" id="gps-retry" style="width:100%;text-align:left;font:inherit;color:inherit">
      <div class="titel">📡 GPS aktivieren</div>
      <div class="neben">${hinweis}</div>
    </button>`;
  }

  // Lückenwarnung
  const luecke = findeLuecke(t.pois, t.meta.laenge_km, state.km);
  if (luecke) {
    const letzte = letzteVersorgungVorLuecke(luecke, t.track, state.km, now, v, fenster);
    const ziel = luecke.bisZiel ? "bis zum Ziel" : `${nf0.format(luecke.laengeKm)} km ohne alles`;
    if (letzte) {
      const p = letzte.poi;
      warnHtml += `<button class="card warnung poi-open" data-id="${p.id}" style="width:100%;text-align:left;font:inherit;color:inherit">
        <div class="titel">⚠ Letzte Versorgung vor Lücke</div>
        <div class="haupt">${ICONS[p.typ] || ""} ${esc(p.name)} · km ${km1(p.km)}</div>
        <div class="neben">in ${km1(p.km - state.km)} km · Ankunft ~${uhr(letzte.eta)} ·
          <span class="${letzte.status.code === "knapp" ? "s-knapp" : "s-offen"}">offen ${bisText(letzte.status.bis, now)}</span></div>
        <div class="neben">danach ${ziel}</div>
      </button>`;
    } else if (luecke.ankerDavor.length === 0) {
      warnHtml += `<div class="card warnung">
        <div class="titel">⚠ Versorgungslücke</div>
        <div class="haupt">Nächste verlässliche Versorgung erst in ${nf0.format(luecke.bisKm - state.km)} km</div>
        ${luecke.naechsterDanach ? `<div class="neben">${esc(luecke.naechsterDanach.name)} · km ${km1(luecke.naechsterDanach.km)}</div>` : ""}
      </div>`;
    } else {
      warnHtml += `<div class="card warnung">
        <div class="titel">⚠ Lücke voraus — nichts mehr offen davor</div>
        <div class="haupt">Ab km ${km1(luecke.vonKm)}: ${ziel}</div>
        <div class="neben">Kein Laden vor der Lücke hat bei Ankunft noch offen.</div>
      </div>`;
    }
  }
  $("warn").innerHTML = warnHtml;

  // Letzter Punkt des Tages (abendliche Kernfrage)
  const letzterHeute = letzterPunktDesTages(t.pois, t.track, state.km, now, v, fenster);
  if (letzterHeute) {
    const p = letzterHeute.poi;
    $("dayend").innerHTML = `<button class="card poi-open" data-id="${p.id}" style="width:100%;text-align:left;font:inherit;color:inherit">
      <div class="titel">🌙 Heute noch erreichbar (letzter Laden)</div>
      <div class="neben"><b>${ICONS[p.typ] || ""} ${esc(p.name)}</b> · km ${km1(p.km)} · in ${km1(p.km - state.km)} km</div>
      <div class="neben">Ankunft ~${uhr(letzterHeute.eta)} · <span class="s-offen">offen ${bisText(letzterHeute.status.bis, now)}</span></div>
    </button>`;
  } else {
    $("dayend").innerHTML = `<div class="card">
      <div class="titel">🌙 Heute</div>
      <div class="neben s-zu">Kein Laden mehr offen erreichbar.</div>
    </div>`;
  }

  // POI-Liste
  const set = FILTER_SETS[state.filter];
  const voraus = t.pois.filter((p) =>
    p.km > state.km - 0.3 && p.km <= state.km + state.horizontKm
    && (!set || set.has(p.typ)));
  const rows = voraus.slice(0, 60).map((p) => {
    const eta = etaMs(t.track, state.km, p.km, v, now);
    const bonus = ESSEN_TYPEN.has(p.typ)
      && (!p.oeffnungszeiten || p.oeffnungszeiten.confidence === "keine");
    return `<button class="poi poi-open ${bonus ? "bonus" : ""}" data-id="${p.id}">
      <span class="icon">${ICONS[p.typ] || "❓"}</span>
      <span class="mitte">
        <div class="name">${esc(p.name)}</div>
        ${statusHtml(p, eta)}
      </span>
      <span class="rechts">
        <div class="dist">${km1(p.km - state.km)} km</div>
        <div class="eta">~${uhr(eta)}</div>
      </span>
    </button>`;
  });
  $("poi-list").innerHTML = rows.join("")
    || `<div class="leer">Nichts in den nächsten ${nf0.format(state.horizontKm)} km.</div>`;
  $("more-btn").textContent = `weiter voraus zeigen (${nf0.format(state.horizontKm)} → ${nf0.format(state.horizontKm + 50)} km)`;

  // Höhenmeter voraus
  const c = naechsterClimb(t.climbs, state.km);
  let climbHtml = `<div class="card"><div class="titel">Voraus</div>`;
  for (const d of [5, 10, 25]) {
    climbHtml += `<div class="zeile"><span>nächste ${d} km</span><b>+${nf0.format(hmZwischen(t.track, state.km, state.km + d))} hm</b></div>`;
  }
  if (c) {
    const imAnstieg = state.km >= c.km_start - 0.2;
    climbHtml += `<div class="zeile"><span>${imAnstieg ? "im Anstieg, noch" : `Anstieg ab km ${km1(c.km_start)}`}</span>
      <b>${km1(imAnstieg ? c.km_ende - state.km : c.km_ende - c.km_start)} km · ${nf0.format(imAnstieg ? hmZwischen(t.track, state.km, c.km_ende) : c.hm)} hm · ⌀ ${nf1.format(c.schnitt_prozent)} %</b></div>`;
  }
  climbHtml += `</div>`;
  $("climb-info").innerHTML = climbHtml;

  $("attrib").textContent = `${t.meta.attribution} · Zeiten-Stand: ${t.meta.zeiten_snapshot || "—"} · ${t.meta.name}`;
}

// --- POI-Detail ---------------------------------------------------------------

function tagesZeilen(oz, refMs) {
  if (!oz?.intervalle?.length) return "";
  const proTag = new Map();
  for (const [von, bis] of oz.intervalle) {
    const d = new Date(von);
    const key = `${WOCHENTAGE[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
    if (!proTag.has(key)) proTag.set(key, []);
    proTag.get(key).push(`${uhr(von)}–${uhr(bis)}`);
  }
  const heute = new Date(refMs);
  const heuteKey = `${WOCHENTAGE[heute.getDay()]} ${heute.getDate()}.${heute.getMonth() + 1}.`;
  return [...proTag].map(([tag, zeiten]) =>
    `<div class="tages-zeile ${tag === heuteKey ? "heute" : ""}"><span>${tag}</span><span class="zeiten">${zeiten.join(", ")}</span></div>`
  ).join("");
}

function zeigePoi(id) {
  const t = state.tour;
  const p = t.pois.find((x) => x.id === id);
  if (!p) return;
  const now = Date.now();
  const { v } = effektiverSchnitt();
  const eta = etaMs(t.track, state.km, p.km, v, now);
  const st = statusZu(p.oeffnungszeiten, eta, t.meta.zeiten_fenster);
  const stText = {
    offen: `<span class="s-offen">offen bei Ankunft (${bisText(st.bis || 0, now)})</span>`,
    knapp: `<span class="s-knapp">knapp — schließt ${uhrMitTag(st.bis || 0, now)}</span>`,
    zu: `<span class="s-zu">zu bei Ankunft${st.naechste ? ` — öffnet ${uhrMitTag(st.naechste, now)}` : ""}</span>`,
    unbekannt: `<span class="s-unbekannt">Öffnungszeiten unbekannt — nicht drauf verlassen!</span>`,
  }[st.code];
  const oz = p.oeffnungszeiten;
  const hm = hmZwischen(t.track, state.km, p.km);

  oeffneModal(`
    <h2>${ICONS[p.typ] || ""} ${esc(p.name)}</h2>
    <div class="untertitel">${esc(p.typ)} · km ${km1(p.km)} · ${p.abstand_route_m ?? "?"} m neben der Route</div>
    <div class="block">
      <div class="label">Ankunft</div>
      <div class="wert">in ${km1(Math.max(0, p.km - state.km))} km (+${nf0.format(hm)} hm) · ~${uhrMitTag(eta, now)}<br>${stText}</div>
    </div>
    ${oz?.intervalle ? `<div class="block"><div class="label">Zeiten während der Tour (Stand ${t.meta.zeiten_snapshot})</div>
      <div class="wert">${tagesZeilen(oz, now)}</div></div>` : ""}
    ${oz?.osm ? `<div class="block"><div class="label">OSM-Rohdaten · Confidence: ${oz.confidence}${oz.woche_instabil ? " · ⚠ nicht wochenstabil" : ""}</div>
      <div class="wert" style="font-family:ui-monospace,monospace;font-size:14px">${esc(oz.osm)}</div></div>` : ""}
    ${oz?.parse_fehler ? `<div class="block"><div class="label">Hinweis</div><div class="wert s-unbekannt">Zeiten-String nicht auswertbar: ${esc(oz.parse_fehler)}</div></div>` : ""}
    <div class="modal-btns">
      <a href="https://maps.apple.com/?ll=${p.lat},${p.lon}&q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">Karte (online)</a>
      <button class="primaer" data-close>Schließen</button>
    </div>`);
}

// --- Dialoge: Position & Geschwindigkeit ---------------------------------------

function zeigePosition() {
  const max = state.tour.meta.laenge_km;
  oeffneModal(`
    <h2>Position</h2>
    <div class="untertitel">GPS nutzen oder Strecken-km von Hand setzen (auch für die Abendplanung).</div>
    <div class="segmente" id="pos-seg">
      <button data-m="gps" class="${state.posMode === "gps" ? "active" : ""}">GPS</button>
      <button data-m="manuell" class="${state.posMode === "manuell" ? "active" : ""}">manuell</button>
    </div>
    <div class="feld" style="margin-top:14px">
      <label>Strecken-km (0–${km1(max)})</label>
      <input type="number" id="km-input" inputmode="decimal" min="0" max="${max}" step="0.1" value="${state.km.toFixed(1)}">
      <input type="range" id="km-range" min="0" max="${max.toFixed(1)}" step="0.1" value="${state.km.toFixed(1)}">
      <div class="schnell">
        <button data-d="-10">−10</button><button data-d="-1">−1</button>
        <button data-d="1">+1</button><button data-d="10">+10</button>
      </div>
    </div>
    <div class="modal-btns"><button class="primaer" id="pos-ok">Übernehmen</button></div>`);

  const input = $("km-input"), range = $("km-range");
  const seg = $("pos-seg");
  let mode = state.posMode;
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  });
  range.addEventListener("input", () => { input.value = range.value; });
  input.addEventListener("input", () => { range.value = input.value; });
  document.querySelector(".schnell").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const v = Math.min(max, Math.max(0, parseFloat(input.value || 0) + parseFloat(b.dataset.d)));
    input.value = v.toFixed(1); range.value = v;
  });
  $("pos-ok").addEventListener("click", () => {
    state.posMode = mode;
    if (mode === "manuell") {
      state.manualKm = Math.min(max, Math.max(0, parseFloat(input.value) || 0));
      setzeKm(state.manualKm);
    } else {
      startGps();
    }
    speichern(); schliesseModal(); render();
  });
}

function zeigeGeschwindigkeit() {
  const auto = autoSchnitt(state.samples, Date.now());
  oeffneModal(`
    <h2>Geschwindigkeit</h2>
    <div class="untertitel">Gemessener Bewegungsschnitt (20 min): ${auto ? nf1.format(auto) + " km/h" : "noch keine Messung"}</div>
    <div class="segmente" id="v-seg">
      <button data-m="auto" class="${state.speedMode === "auto" ? "active" : ""}">Auto</button>
      <button data-m="manuell" class="${state.speedMode === "manuell" ? "active" : ""}">Manuell</button>
      <button data-m="konservativ" class="${state.speedMode === "konservativ" ? "active" : ""}">Konservativ<br><small>−20 %</small></button>
    </div>
    <div class="feld" style="margin-top:14px">
      <label>Manueller Wert (km/h)</label>
      <input type="number" id="v-input" inputmode="decimal" min="5" max="45" step="0.5" value="${state.manualKmh}">
    </div>
    <div class="modal-btns"><button class="primaer" id="v-ok">Übernehmen</button></div>`);
  const seg = $("v-seg");
  let mode = state.speedMode;
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  });
  $("v-ok").addEventListener("click", () => {
    state.speedMode = mode;
    const v = parseFloat($("v-input").value);
    if (!Number.isNaN(v)) state.manualKmh = Math.min(45, Math.max(5, v));
    speichern(); schliesseModal(); render();
  });
}

// --- Modal-Gerüst ---------------------------------------------------------------

function oeffneModal(html) {
  $("modal").innerHTML = html;
  $("modal-backdrop").hidden = false;
}
function schliesseModal() { $("modal-backdrop").hidden = true; }

// --- GPS ---------------------------------------------------------------

let watchId = null;
function setzeKm(km) {
  const t = state.tour.track;
  let lo = 0, hi = t.length - 1; // Index zur km-Angabe (für Fenster-Matching)
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m][3] <= km) lo = m; else hi = m - 1; }
  state.matchIdx = lo;
  state.km = km;
  state.offRoute = false;
}

function startGps() {
  if (!navigator.geolocation) { state.gpsStatus = "fehler"; state.gpsError = 0; return; }
  state.posMode = "gps";
  state.gpsStatus = "warte";
  state.gpsError = null;
  state.gpsSeit = Date.now();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    state.gpsStatus = "fehler"; state.gpsError = err.code; render();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  render();
  setTimeout(render, 8500); // falls iOS die Anfrage stumm ignoriert: Banner zeigen
}

function onFix(fix) {
  const now = Date.now();
  if (now - state.lastFixT < 15000) return;             // Akku: max. alle 15 s
  if (fix.coords.accuracy > 200) return;                 // Müll-Fixe ignorieren
  state.lastFixT = now;
  state.gpsStatus = "ok";
  const m = matchPosition(state.tour.track, state.matchIdx, fix.coords.latitude, fix.coords.longitude);
  state.matchIdx = m.idx;
  state.offRoute = m.offRoute;
  if (state.posMode === "gps") state.km = m.km;
  state.samples.push({ t: now, km: m.km });
  if (state.samples.length > 200) state.samples.splice(0, 50);
  speichern();
  render();
}

// --- Wake Lock ---------------------------------------------------------------

async function toggleWakeLock() {
  if (state.wakeLock) {
    await state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  } else if ("wakeLock" in navigator) {
    try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* verweigert */ }
    state.wakeLock?.addEventListener("release", () => {
      state.wakeLock = null; $("wake-btn").classList.remove("an");
    });
  }
  $("wake-btn").classList.toggle("an", !!state.wakeLock);
}
document.addEventListener("visibilitychange", async () => {
  // iOS gibt den Lock beim Wechsel frei — beim Zurückkommen erneuern
  if (document.visibilityState === "visible" && $("wake-btn").classList.contains("an") && !state.wakeLock) {
    try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* ok */ }
  }
});

// --- Boot ---------------------------------------------------------------

async function boot() {
  laden();
  const res = await fetch("tour.json");
  state.tour = await res.json();
  if (state.posMode === "manuell") setzeKm(state.manualKm);
  else startGps();

  document.querySelectorAll("#filters .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.f === state.filter);
    b.addEventListener("click", () => {
      state.filter = b.dataset.f;
      document.querySelectorAll("#filters .chip").forEach((x) => x.classList.toggle("active", x === b));
      speichern(); render();
    });
  });
  $("pos-btn").addEventListener("click", zeigePosition);
  $("speed-btn").addEventListener("click", zeigeGeschwindigkeit);
  $("wake-btn").addEventListener("click", toggleWakeLock);
  $("more-btn").addEventListener("click", () => { state.horizontKm += 50; render(); });
  document.body.addEventListener("click", (e) => {
    if (e.target.closest("#gps-retry")) { startGps(); return; }
    const open = e.target.closest(".poi-open");
    if (open) zeigePoi(Number(open.dataset.id));
    if (e.target.closest("[data-close]") || e.target === $("modal-backdrop")) schliesseModal();
  });

  render();
  setInterval(render, 30000); // ETAs/Uhr alle 30 s auffrischen

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
