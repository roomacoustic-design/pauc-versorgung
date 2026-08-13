import {
  ANKER_TYPEN, ESSEN_TYPEN, LAEDEN_TYPEN, WASSER_TYPEN, LUECKE_KM,
  matchPosition, hmZwischen, naechsterClimb, fixAkzeptieren,
  fahrzeitMin, etaMs, effektivKmh, prognoseKm,
  statusZu, istAnker, findeLuecke, letzteVersorgungVorLuecke, letzterPunktDesTages,
} from "./logic.js";

// Fehler niemals stumm schlucken — auf Tour ist ein toter Bildschirm ohne
// Meldung der schlimmste Zustand.
function zeigeFehler(text) {
  const el = document.getElementById("fatal");
  if (!el) return;
  el.hidden = false;
  el.textContent = `⚠ ${text}`;
}
window.addEventListener("error", (e) => zeigeFehler(`Fehler: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  zeigeFehler(`Fehler: ${e.reason?.message || e.reason}`));

const ICONS = {
  "Supermarkt": "🛒", "Nachbarschaftsladen": "🏪", "Bäckerei": "🥖",
  "Tankstelle": "⛽", "Kiosk": "🗞️", "Getränkemarkt": "🧃", "Café": "☕",
  "Fast Food": "🍔", "Eisdiele": "🍦", "Trinkwasser": "💧", "Quelle": "⛲",
  "Friedhof (Trinkwasser)": "🪦", "Toilette": "🚻", "Verkaufsautomat": "🥤",
  "Checkpoint": "📍",
};
const FILTER_SETS = { essen: ESSEN_TYPEN, laeden: LAEDEN_TYPEN, wasser: WASSER_TYPEN };

const state = {
  tour: null,
  posMode: "gps",          // gps | manuell
  manualKm: 0,
  matchIdx: -1,
  km: 0,
  offRoute: false,
  gpsStatus: "aus",        // aus | warte | ok | fehler
  lastFixT: 0,
  speedMode: "manuell",    // manuell | konservativ (kein Auto-Tracking, Wunsch Max)
  manualKmh: 20,
  stehMin: 10,             // Minuten Stehzeit (Klo, Einkauf …) pro Stunde Fahrt
  ermuedung: 5,            // % Tempo-Abschlag pro weiterem Tourtag
  planStunden: 10,         // geplante Stunden unterwegs (inkl. Stehzeit)
  tage: [],                // abgeschlossene Tourtage {d, endKm, stunden, tempo, steh}
  filter: "alles",
  horizontKm: 50,
  wakeLock: null,
};

const $ = (id) => document.getElementById(id);

// --- Persistenz ---------------------------------------------------------------

function speichern() {
  try {
    localStorage.setItem("versorgung", JSON.stringify({
      posMode: state.posMode, manualKm: state.manualKm, matchIdx: state.matchIdx,
      km: state.km,
      speedMode: state.speedMode, manualKmh: state.manualKmh, filter: state.filter,
      stehMin: state.stehMin, ermuedung: state.ermuedung, planStunden: state.planStunden,
    }));
    localStorage.setItem("versorgung-tage", JSON.stringify(state.tage));
  } catch { /* Speicher voll o. ä. — nicht kritisch */ }
}
// Gespeicherten Zustand validieren statt blind übernehmen — kaputte oder
// veraltete Werte dürfen die App nicht in einen Unsinns-Zustand ziehen.
function laden() {
  try {
    const s = JSON.parse(localStorage.getItem("versorgung") || "{}");
    if (s.posMode === "gps" || s.posMode === "manuell") state.posMode = s.posMode;
    if (Number.isFinite(s.manualKm)) state.manualKm = Math.max(0, s.manualKm);
    if (Number.isFinite(s.matchIdx) && s.matchIdx >= 0) state.matchIdx = Math.floor(s.matchIdx);
    if (Number.isFinite(s.km)) state.km = Math.max(0, s.km); // letzter Stand bis zum ersten Fix
    if (["manuell", "konservativ"].includes(s.speedMode)) state.speedMode = s.speedMode;
    else if (s.speedMode === "auto") state.speedMode = "manuell"; // Migration alter Stände
    if (Number.isFinite(s.manualKmh)) state.manualKmh = Math.min(45, Math.max(5, s.manualKmh));
    if (["alles", "essen", "laeden", "wasser"].includes(s.filter)) state.filter = s.filter;
    if (Number.isFinite(s.stehMin)) state.stehMin = Math.min(30, Math.max(0, s.stehMin));
    if (Number.isFinite(s.ermuedung)) state.ermuedung = Math.min(20, Math.max(0, s.ermuedung));
    if (Number.isFinite(s.planStunden)) state.planStunden = Math.min(18, Math.max(2, s.planStunden));
    const tage = JSON.parse(localStorage.getItem("versorgung-tage") || "[]");
    if (Array.isArray(tage)) state.tage = tage.filter((t) => t && Number.isFinite(t.endKm));
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

// Alle ETAs rechnen mit dem EFFEKTIVEN Tempo: Bewegungstempo anteilig um
// die Stehzeit reduziert — wir fahren ja nicht durch (Klo, Einkaufen, Fotos).
function effektiverSchnitt() {
  const basis = state.speedMode === "konservativ" ? state.manualKmh * 0.8 : state.manualKmh;
  return {
    v: effektivKmh(basis, state.stehMin),
    quelle: state.speedMode === "konservativ" ? "eff. konservativ" : "effektiv",
  };
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
  // Fix-Alter ehrlich anzeigen: ein 10 Minuten alter Stand darf nicht wie
  // "GPS ok" aussehen — veraltete Distanzen sind gefährlicher als keine.
  const fixAlterMin = state.lastFixT ? Math.floor((now - state.lastFixT) / 60000) : null;
  let gpsText = { aus: "GPS aus", warte: "suche GPS…", ok: "GPS ok", ungenau: "GPS ungenau", fehler: "GPS-Fehler" }[state.gpsStatus];
  if (state.posMode === "manuell") gpsText = "km gesetzt";
  else if ((state.gpsStatus === "ok" || state.gpsStatus === "ungenau") && fixAlterMin >= 2) {
    gpsText = `Fix vor ${fixAlterMin} min`;
  }
  $("gps-status").textContent = gpsText;
  $("gps-status").classList.toggle("warnend",
    state.posMode === "gps" && (state.gpsStatus === "ungenau" || fixAlterMin >= 2));

  // GPS-Problem? Großer Knopf — iOS zeigt den Standort-Dialog zuverlässig
  // erst nach einer echten Nutzer-Geste.
  let warnHtml = "";
  const gpsHaengt = state.gpsStatus === "warte" && now - (state.gpsSeit || 0) > 8000;
  if (state.posMode === "gps"
      && (state.gpsStatus === "fehler" || state.gpsStatus === "aus" || gpsHaengt)) {
    const hinweis = state.gpsError === 1
      ? "Standort ist blockiert. iPhone: Einstellungen → Datenschutz → Ortungsdienste → Safari-Websites (bzw. „Versorgung“) → „Beim Verwenden“. Danach hier tippen."
      : gpsHaengt
        ? "Kein brauchbares GPS-Signal (freie Sicht zum Himmel?). Hier tippen für Neustart der Suche."
        : "Hier tippen, um die Standortfreigabe anzustoßen.";
    warnHtml += `<button class="card warnung" id="gps-retry" style="width:100%;text-align:left;font:inherit;color:inherit">
      <div class="titel">📡 GPS aktivieren</div>
      <div class="neben">${hinweis}</div>
    </button>`;
  }

  // Lückenwarnung
  const luecke = findeLuecke(t.pois, t.meta.laenge_km, state.km, LUECKE_KM,
    { track: t.track, nowMs: now, vKmh: v, fenster });
  if (luecke) {
    const letzte = letzteVersorgungVorLuecke(luecke, t.track, state.km, now, v, fenster);
    const ziel = luecke.bisZiel ? "bis zum Ziel" : `${nf0.format(luecke.laengeKm)} km ohne alles`;
    if (letzte) {
      const p = letzte.poi;
      warnHtml += `<button class="card warnung poi-open" data-id="${p.id}" style="width:100%;text-align:left;font:inherit;color:inherit">
        <div class="titel">⚠ Letzte Versorgung vor Lücke</div>
        <div class="haupt">${ICONS[p.typ] || ""} ${esc(p.name)} · km ${km1(p.km)}</div>
        <div class="neben">in ${km1(Math.max(0, p.km - state.km))} km · Ankunft ~${uhr(letzte.eta)} ·
          ${letzte.status.code === "knapp"
            ? `<span class="s-knapp">knapp! schließt ${uhrMitTag(letzte.status.bis, now)}</span>`
            : `<span class="s-offen">offen ${bisText(letzte.status.bis, now)}</span>`}</div>
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
      <div class="titel">🌙 Heute noch erreichbar</div>
      <div class="neben"><b>${ICONS[p.typ] || ""} ${esc(p.name)}</b> · km ${km1(p.km)} · in ${km1(Math.max(0, p.km - state.km))} km</div>
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
  const rows = voraus.slice(0, 400).map((p) => {
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
        <div class="dist">${km1(Math.max(0, p.km - state.km))} km</div>
        <div class="eta">~${uhrMitTag(eta, now)}</div>
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

function tagesZeilen(intervalle, refMs) {
  if (!intervalle?.length) return "";
  const proTag = new Map();
  for (const [von, bis, unbekannt] of intervalle) {
    const d = new Date(von);
    const key = `${WOCHENTAGE[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
    if (!proTag.has(key)) proTag.set(key, []);
    // unbestätigte Intervalle (opening_hours "unknown") mit ? markieren
    proTag.get(key).push(`${uhr(von)}–${uhr(bis)}${unbekannt ? "\u202f?" : ""}`);
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
    ${oz?.widerspruch ? `<div class="block"><div class="label">⚠ Google und OSM widersprechen sich — Stand ${t.meta.zeiten_snapshot}</div>
      <div class="wert"><div class="quelle-titel">Google (für Ampel verwendet)</div>${tagesZeilen(oz.intervalle_google, now)}
      <div class="quelle-titel" style="margin-top:10px">OpenStreetMap</div>${tagesZeilen(oz.intervalle_osm, now)}</div></div>`
    : oz?.intervalle ? `<div class="block"><div class="label">Zeiten während der Tour · Quelle: ${oz.quelle_bevorzugt === "google" ? "Google" : "OSM"} · Confidence: ${oz.confidence} · Stand ${t.meta.zeiten_snapshot}</div>
      <div class="wert">${tagesZeilen(oz.intervalle, now)}</div></div>` : ""}
    ${oz?.osm ? `<div class="block"><div class="label">OSM-Rohdaten · Confidence: ${oz.confidence}${oz.woche_instabil ? " · ⚠ nicht wochenstabil" : ""}</div>
      <div class="wert" style="font-family:ui-monospace,monospace;font-size:14px">${esc(oz.osm)}</div></div>` : ""}
    ${oz?.parse_fehler ? `<div class="block"><div class="label">Hinweis</div><div class="wert s-unbekannt">Zeiten-String nicht auswertbar: ${esc(oz.parse_fehler)}</div></div>` : ""}
    <div class="modal-btns">
      <a href="https://www.google.com/maps/search/?api=1&query=${p.lat}%2C${p.lon}" target="_blank" rel="noopener">Google Maps</a>
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
      const wert = parseFloat(input.value);
      state.manualKm = Number.isFinite(wert)
        ? Math.min(max, Math.max(0, wert)) : state.km; // Unsinn-Eingabe: bleiben
      setzeKm(state.manualKm);
      stopGps();
    } else {
      startGps();
    }
    speichern(); schliesseModal(); render();
  });
}

function zeigeGeschwindigkeit() {
  oeffneModal(`
    <h2>Geschwindigkeit</h2>
    <div class="untertitel">Fahr-Schnitt in Bewegung plus Stehzeit (Klo, Einkauf, Fotos) — alle Ankunftszeiten rechnen mit dem effektiven Tempo. Konservativ: −20 % aufs Fahrtempo.</div>
    <div class="segmente" id="v-seg">
      <button data-m="manuell" class="${state.speedMode === "manuell" ? "active" : ""}">Manuell</button>
      <button data-m="konservativ" class="${state.speedMode === "konservativ" ? "active" : ""}">Konservativ<br><small>−20 %</small></button>
    </div>
    <div class="feld" style="margin-top:14px">
      <label>Fahrtempo in Bewegung (km/h)</label>
      <input type="number" id="v-input" inputmode="decimal" min="5" max="45" step="0.5" value="${state.manualKmh}">
    </div>
    <div class="feld">
      <label>Stehzeit: Minuten pro Stunde Fahrt</label>
      <input type="number" id="steh-input" inputmode="numeric" min="0" max="30" step="1" value="${state.stehMin}">
    </div>
    <div class="block"><div class="label">Effektives Reisetempo</div>
      <div class="wert" id="v-eff">–</div></div>
    <div class="modal-btns"><button class="primaer" id="v-ok">Übernehmen</button></div>`);
  const seg = $("v-seg");
  let mode = state.speedMode;
  const effAnzeigen = () => {
    const v = parseFloat($("v-input").value) || state.manualKmh;
    const steh = parseFloat($("steh-input").value) || 0;
    const basis = mode === "konservativ" ? v * 0.8 : v;
    $("v-eff").textContent = `${nf1.format(effektivKmh(basis, steh))} km/h`
      + (mode === "konservativ" ? ` (konservativ: ${nf1.format(basis)} in Bewegung)` : "");
  };
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    effAnzeigen();
  });
  $("v-input").addEventListener("input", effAnzeigen);
  $("steh-input").addEventListener("input", effAnzeigen);
  effAnzeigen();
  $("v-ok").addEventListener("click", () => {
    state.speedMode = mode;
    const v = parseFloat($("v-input").value);
    if (Number.isFinite(v)) state.manualKmh = Math.min(45, Math.max(5, v));
    const steh = parseFloat($("steh-input").value);
    if (Number.isFinite(steh)) state.stehMin = Math.min(30, Math.max(0, steh));
    speichern(); schliesseModal(); render();
  });
}

// --- Tagesplan: Prognose + Tagesabschluss ---------------------------------------

function tageListe() {
  if (!state.tage.length) return `<div class="wert dim-text">Noch kein Tag abgeschlossen.</div>`;
  let vorher = 0;
  return state.tage.map((t) => {
    const tagKm = t.endKm - vorher;
    vorher = t.endKm;
    const ges = t.stunden > 0 ? tagKm / t.stunden : 0;
    return `<div class="tages-zeile"><span>${esc(t.d)}</span>
      <span class="zeiten">+${nf0.format(tagKm)} km (bis km ${nf0.format(t.endKm)}) · ${nf1.format(t.stunden)} h · Ø ${nf1.format(ges)}</span></div>`;
  }).join("");
}

function zeigePlan() {
  const t = state.tour;
  const heute = new Date();
  const morgenFruehMoeglich = heute.getHours() >= 12; // nachmittags plant man den Folgetag
  oeffneModal(`
    <h2>🗓 Tagesplan</h2>
    <div class="untertitel">Wie weit kommen wir ab km ${km1(state.km)}? Rechnet mit effektivem Tempo (Fahrtempo + Stehzeit) und Höhenmetern; für morgen mit Ermüdungsabschlag.</div>
    <div class="block"><div class="label">Bisherige Tage</div>${tageListe()}</div>
    <div class="segmente" id="plan-tag-seg">
      <button data-t="heute" class="${morgenFruehMoeglich ? "" : "active"}">ab jetzt</button>
      <button data-t="morgen" class="${morgenFruehMoeglich ? "active" : ""}">morgen früh</button>
    </div>
    <div class="feld" style="margin-top:14px">
      <label>Stunden unterwegs (inkl. Stehzeit)</label>
      <input type="number" id="plan-stunden" inputmode="decimal" min="2" max="18" step="0.5" value="${state.planStunden}">
    </div>
    <div class="feld">
      <label>Startzeit morgen</label>
      <input type="number" id="plan-start" inputmode="numeric" min="4" max="12" step="1" value="7">
    </div>
    <div class="feld">
      <label>Ermüdung: % langsamer pro weiterem Tag</label>
      <input type="number" id="plan-erm" inputmode="numeric" min="0" max="20" step="1" value="${state.ermuedung}">
    </div>
    <div class="block"><div class="label">Prognose</div><div class="wert" id="plan-ergebnis">–</div></div>
    <div class="modal-btns">
      <button id="tag-abschliessen">Tag abschließen<br><small>bei km ${km1(state.km)}</small></button>
      <button class="primaer" data-close>Fertig</button>
    </div>`);

  let planTag = morgenFruehMoeglich ? "morgen" : "heute";
  const seg = $("plan-tag-seg");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    planTag = b.dataset.t;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    berechnen();
  });

  const berechnen = () => {
    const stunden = Math.min(18, Math.max(2, parseFloat($("plan-stunden").value) || state.planStunden));
    const erm = Math.min(20, Math.max(0, parseFloat($("plan-erm").value) || 0));
    const startH = Math.min(12, Math.max(4, parseFloat($("plan-start").value) || 7));
    // Basis: aktuelles Fahrtempo; morgen mit Ermüdungsabschlag
    const basis = state.speedMode === "konservativ" ? state.manualKmh * 0.8 : state.manualKmh;
    const tempoPlan = planTag === "morgen" ? basis * (1 - erm / 100) : basis;
    const vEff = effektivKmh(tempoPlan, state.stehMin);
    let startMs;
    if (planTag === "morgen") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(startH, 0, 0, 0);
      startMs = d.getTime();
    } else {
      startMs = Date.now();
    }
    const zielKm = prognoseKm(t.track, state.km, vEff, stunden);
    const strecke = zielKm - state.km;
    const hm = hmZwischen(t.track, state.km, zielKm);
    const ankunft = startMs + stunden * 3600000;
    // Letzte offene Versorgung vor dem Tagesziel
    let letzte = null;
    for (const p of t.pois) {
      if (p.km > zielKm) break;
      if (p.km <= state.km || !istAnker(p)) continue;
      const eta = etaMs(t.track, state.km, p.km, vEff, startMs);
      const st = statusZu(p.oeffnungszeiten, eta, t.meta.zeiten_fenster);
      if (st.code === "offen" || st.code === "knapp") letzte = { p, st };
    }
    $("plan-ergebnis").innerHTML = `
      <b>bis ~km ${nf0.format(zielKm)}</b> (${nf0.format(strecke)} km · +${nf0.format(hm)} hm)<br>
      Tempo: ${nf1.format(vEff)} km/h effektiv${planTag === "morgen" && erm > 0 ? ` (inkl. −${erm} % Ermüdung)` : ""}<br>
      ${planTag === "morgen" ? `${String(startH).padStart(2, "0")}:00` : "jetzt"} → Ankunft ~${uhrMitTag(ankunft, Date.now())}
      ${zielKm >= t.meta.laenge_km ? "<br>🏁 <b>Das ist das Ziel!</b>" : ""}
      ${letzte ? `<br>Letzte offene Versorgung davor: <b>${esc(letzte.p.name)}</b> km ${km1(letzte.p.km)} <span class="s-offen">(${letzte.st.code})</span>` : "<br><span class='s-zu'>Keine offene Versorgung bis dahin!</span>"}`;
    state.planStunden = stunden;
    state.ermuedung = erm;
  };
  ["plan-stunden", "plan-start", "plan-erm"].forEach((id) =>
    $(id).addEventListener("input", berechnen));
  berechnen();

  $("tag-abschliessen").addEventListener("click", () => {
    const d = new Date();
    const key = `${WOCHENTAGE[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
    const stunden = Math.min(18, Math.max(2, parseFloat($("plan-stunden").value) || state.planStunden));
    const eintrag = { d: key, endKm: Math.round(state.km * 10) / 10, stunden, tempo: state.manualKmh, steh: state.stehMin };
    const letzter = state.tage[state.tage.length - 1];
    if (letzter && letzter.d === key) state.tage[state.tage.length - 1] = eintrag; // selber Tag: ersetzen
    else state.tage.push(eintrag);
    speichern();
    zeigePlan(); // Modal mit aktualisierter Liste neu aufbauen
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
function stopGps() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  state.gpsStatus = "aus";
}
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
  const annahme = fixAkzeptieren(state.lastFixT, now, fix.coords.accuracy);
  if (!annahme.ok) return;
  state.lastFixT = now;
  state.gpsStatus = annahme.ungenau ? "ungenau" : "ok";
  const m = matchPosition(state.tour.track, state.matchIdx, fix.coords.latitude, fix.coords.longitude);
  state.matchIdx = m.idx;
  state.offRoute = m.offRoute;
  if (state.posMode === "gps") state.km = m.km;
  speichern();
  render();
}

// --- Wake Lock ---------------------------------------------------------------

async function fordereWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch { state.wakeLock = null; }
}
async function toggleWakeLock() {
  // Wahrheitsquelle ist das Gewollt-Flag — iOS released den Lock bei jedem
  // App-Wechsel, die Anzeige darf davon nicht kippen.
  state.wakeLockGewollt = !state.wakeLockGewollt && "wakeLock" in navigator;
  if (state.wakeLockGewollt) await fordereWakeLock();
  else { await state.wakeLock?.release().catch(() => {}); state.wakeLock = null; }
  $("wake-btn").classList.toggle("an", state.wakeLockGewollt);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // iOS gibt den Lock beim Wechsel frei — beim Zurückkommen erneuern,
  // und die im Hintergrund eingefrorenen ETAs/Uhr sofort auffrischen.
  if (state.wakeLockGewollt && !state.wakeLock) fordereWakeLock();
  render();
});

// --- Boot ---------------------------------------------------------------

async function boot() {
  laden();
  // Tour-Bundle mit Retry laden — beim allerersten Start (noch kein Cache)
  // darf ein Netz-Wackler nicht in einem toten Bildschirm enden.
  let tour = null;
  for (let versuch = 1; versuch <= 3; versuch++) {
    try {
      const res = await fetch("tour.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tour = await res.json();
      break;
    } catch (e) {
      if (versuch === 3) {
        zeigeFehler(`Tour-Daten konnten nicht geladen werden (${e.message}). `
          + `Einmal mit Internet öffnen, danach läuft alles offline.`);
        return;
      }
      await new Promise((r) => setTimeout(r, 800 * versuch));
    }
  }
  state.tour = tour;
  // Gespeicherten Zustand gegen das geladene Bundle klemmen
  const maxKm = tour.meta.laenge_km;
  state.manualKm = Math.min(state.manualKm, maxKm);
  state.km = Math.min(state.km, maxKm);
  if (state.matchIdx >= tour.track.length) state.matchIdx = -1;
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
  $("plan-btn").addEventListener("click", zeigePlan);
  $("speed-btn").addEventListener("click", zeigeGeschwindigkeit);
  $("wake-btn").addEventListener("click", toggleWakeLock);
  $("more-btn").addEventListener("click", () => { state.horizontKm += 50; render(); });
  document.body.addEventListener("click", (e) => {
    if (e.target.closest("#gps-retry")) { startGps(); return; }
    if (e.target.closest("#update-hint")) { location.reload(); return; }
    const open = e.target.closest(".poi-open");
    if (open) zeigePoi(Number(open.dataset.id));
    if (e.target.closest("[data-close]") || e.target === $("modal-backdrop")) schliesseModal();
  });

  render();
  setInterval(render, 30000); // ETAs/Uhr alle 30 s auffrischen
  navigator.storage?.persist?.().catch(() => {});

  if ("serviceWorker" in navigator) {
    // Update-Fluss sichtbar machen: neuer SW aktiviert => ein Tipp lädt die
    // neue Version, statt auf das "zweimal öffnen"-Ritual zu vertrauen.
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const neu = reg.installing;
        neu?.addEventListener("statechange", () => {
          if (neu.state === "activated" && navigator.serviceWorker.controller) {
            $("update-hint").hidden = false;
          }
        });
      });
    }).catch(() => {});
  }
}

boot();
