// Reine Tour-Logik ohne DOM — läuft im Browser und in Node (Tests).
// Track-Format: [lat, lon, ele, km, cumHm] pro Punkt, km aufsteigend.

export const ANKER_TYPEN = new Set([
  "Supermarkt", "Nachbarschaftsladen", "Bäckerei", "Tankstelle",
  "Kiosk", "Getränkemarkt",
]);
export const ESSEN_TYPEN = new Set([
  ...ANKER_TYPEN, "Café", "Fast Food", "Eisdiele", "Verkaufsautomat",
]);
export const LAEDEN_TYPEN = new Set([
  "Supermarkt", "Nachbarschaftsladen", "Getränkemarkt", "Kiosk", "Tankstelle",
]);
export const WASSER_TYPEN = new Set([
  "Trinkwasser", "Quelle", "Friedhof (Trinkwasser)", "Toilette",
]);

export const PUFFER_MIN = 30;        // "offen" braucht >= 30 min bis Ladenschluss
export const OFFROUTE_M = 150;
export const LUECKE_KM = 40;         // Standard-Schwellwert Lückenwarnung

export function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad;
  const a = Math.sin((p2 - p1) / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// --- 6.1 Map-Matching -------------------------------------------------------

// lastIdx < 0 = Kaltstart (Vollsuche). Fenster -200/+2000 erzwingt
// Vorwärtsfortschritt; > 150 m Abstand => Vollsuche + off route.
export function matchPosition(track, lastIdx, lat, lon) {
  const n = track.length;
  let bestIdx = 0, bestD = Infinity;
  const scan = (from, to) => {
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const d = haversineM(lat, lon, track[i][0], track[i][1]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
  };
  if (lastIdx >= 0) {
    scan(lastIdx - 200, lastIdx + 2000);
    if (bestD > OFFROUTE_M) { bestD = Infinity; scan(0, n); }
  } else {
    scan(0, n);
  }
  return { idx: bestIdx, km: track[bestIdx][3], distM: bestD, offRoute: bestD > OFFROUTE_M };
}

// --- Höhenprofil -------------------------------------------------------------

function idxAtKm(track, km) { // binäre Suche: letzter Index mit track[i].km <= km
  let lo = 0, hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid][3] <= km) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function cumHmAt(track, km) {
  if (km <= 0) return 0;
  const last = track[track.length - 1];
  if (km >= last[3]) return last[4];
  return track[idxAtKm(track, km)][4];
}

export function hmZwischen(track, vonKm, bisKm) {
  return Math.max(0, cumHmAt(track, bisKm) - cumHmAt(track, vonKm));
}

export function naechsterClimb(climbs, km) {
  for (const c of climbs) {
    if (c.km_ende > km + 0.2) return c;
  }
  return null;
}

// --- 6.2/6.4 Geschwindigkeit & ETA -------------------------------------------

// Bewegungsschnitt aus GPS-Samples [{t(ms), km}]: gleitend über 20 min,
// Segmente unter 4 km/h gelten als Pause und fallen raus.
export function autoSchnitt(samples, nowMs) {
  const seit = nowMs - 20 * 60000;
  let dist = 0, zeit = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.t < seit || b.t <= a.t) continue;
    const dtH = (b.t - a.t) / 3600000;
    const dKm = Math.abs(b.km - a.km);
    if (dKm / dtH >= 4) { dist += dKm; zeit += dtH; }
  }
  if (zeit < 3 / 60) return null; // unter 3 min Bewegung: keine Aussage
  return dist / zeit;
}

// Steigungsfaktor: ab 20 hm/km wird's langsamer, bei 60+ hm/km (= 600 hm/10 km,
// Schwelle aus der Spec) nur noch knapp halbes Tempo.
function steigungsFaktor(hmProKm) {
  if (hmProKm <= 20) return 1;
  return Math.max(0.45, 1 - (hmProKm - 20) * 0.014);
}

// Fahrzeit in Minuten von vonKm nach bisKm, integriert über 5-km-Blöcke.
export function fahrzeitMin(track, vonKm, bisKm, vKmh) {
  if (bisKm <= vonKm) return 0;
  let min = 0, a = vonKm;
  while (a < bisKm) {
    const b = Math.min(a + 5, bisKm);
    const f = steigungsFaktor(hmZwischen(track, a, b) / (b - a));
    min += (b - a) / (vKmh * f) * 60;
    a = b;
  }
  return min;
}

export function etaMs(track, vonKm, bisKm, vKmh, nowMs) {
  return nowMs + fahrzeitMin(track, vonKm, bisKm, vKmh) * 60000;
}

// --- 6.3 Öffnungsstatus -------------------------------------------------------

// oz = poi.oeffnungszeiten ({confidence, intervalle: [[vonMs,bisMs,unknown],…]})
// Rückgabe: {code: offen|knapp|zu|unbekannt, bis?, naechste?, puffer?}
export function statusZu(oz, tMs, fenster) {
  if (!oz || oz.confidence === "keine" || !oz.intervalle) return { code: "unbekannt" };
  if (fenster && (tMs < fenster[0] || tMs >= fenster[1])) return { code: "unbekannt" };
  for (const [von, bis, unbekannt] of oz.intervalle) {
    if (tMs >= von && tMs < bis) {
      if (unbekannt) return { code: "unbekannt" };
      const puffer = bis - tMs;
      return { code: puffer >= PUFFER_MIN * 60000 ? "offen" : "knapp", bis, puffer };
    }
  }
  for (const [von, , unbekannt] of oz.intervalle) {
    if (von > tMs && !unbekannt) return { code: "zu", naechste: von };
  }
  return { code: "zu", naechste: null };
}

// Verlässlicher Anker: echte Verpflegung + Zeiten vorhanden (confidence
// mittel/hoch). "Unbekannt ist nicht offen": ohne Zeiten nie Teil der Kette.
export function istAnker(poi) {
  return ANKER_TYPEN.has(poi.typ)
    && poi.oeffnungszeiten
    && (poi.oeffnungszeiten.confidence === "mittel" || poi.oeffnungszeiten.confidence === "hoch");
}

// --- 6.5 Lückenwarnung --------------------------------------------------------

// Nächste Lücke > schwelleKm in der Ankerkette ab aktueller Position.
// Liefert null oder { vonKm, bisKm, laengeKm, ankerDavor: [POIs aufsteigend],
// naechsterDanach, bisZiel }.
export function findeLuecke(pois, streckeKm, aktKm, schwelleKm = LUECKE_KM) {
  const anker = pois.filter(p => istAnker(p) && p.km > aktKm - 0.2);
  let prevKm = aktKm;
  const davor = [];
  for (const a of anker) {
    if (a.km - prevKm > schwelleKm) {
      return {
        vonKm: prevKm, bisKm: a.km, laengeKm: a.km - prevKm,
        ankerDavor: davor, naechsterDanach: a, bisZiel: false,
      };
    }
    davor.push(a);
    prevKm = a.km;
  }
  if (streckeKm - prevKm > schwelleKm) {
    return {
      vonKm: prevKm, bisKm: streckeKm, laengeKm: streckeKm - prevKm,
      ankerDavor: davor, naechsterDanach: null, bisZiel: true,
    };
  }
  return null;
}

// Letzter Anker vor der Lücke, der bei Ankunft noch offen ist.
export function letzteVersorgungVorLuecke(luecke, track, aktKm, nowMs, vKmh, fenster) {
  for (let i = luecke.ankerDavor.length - 1; i >= 0; i--) {
    const p = luecke.ankerDavor[i];
    const eta = etaMs(track, aktKm, p.km, vKmh, nowMs);
    const st = statusZu(p.oeffnungszeiten, eta, fenster);
    if (st.code === "offen" || st.code === "knapp") return { poi: p, eta, status: st };
  }
  return null;
}

// "Es wird spät": letzter Anker, der HEUTE vor Ladenschluss noch erreichbar ist.
export function letzterPunktDesTages(pois, track, aktKm, nowMs, vKmh, fenster) {
  const tagesEnde = new Date(nowMs);
  tagesEnde.setHours(23, 59, 59, 0);
  let best = null;
  for (const p of pois) {
    if (!istAnker(p) || p.km <= aktKm) continue;
    const eta = etaMs(track, aktKm, p.km, vKmh, nowMs);
    if (eta > tagesEnde.getTime()) break; // ETA wächst mit km: ab hier zwecklos
    const st = statusZu(p.oeffnungszeiten, eta, fenster);
    if (st.code === "offen" || st.code === "knapp") best = { poi: p, eta, status: st };
  }
  return best;
}
