/* ============================================================
   Vessel Tracker — client logic
   Fetches /api/track, draws the route + live position on a MapLibre
   map, and polls for updates. Read-only; no writes ever happen here.

   Basemap: custom style (public/map_style.json) — a Maputnik fork of OSM
   Liberty, repointed at OpenFreeMap's tiles/sprites/glyphs. No API key.
   Overlay: OpenSeaMap seamarks — buoys, lights, anchorages, traffic
   separation schemes. The seamarks are what make this read as a chart;
   the basemap underneath has almost no marine detail.
   ============================================================ */

'use strict';

const POLL_MS = 60 * 1000;                 // refresh cadence

const BASEMAP_STYLE = '/map_style.json';
const SEAMARK_TILES = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

// Source/layer ids. MapLibre addresses everything by string id.
const SRC_ROUTE = 'route';
const SRC_POINTS = 'points';
const SRC_SEAMARK = 'seamark';
const SRC_LOGS = 'logs';
const LYR_ROUTE = 'route-line';
const LYR_POINTS = 'point-circles';
const LYR_SEAMARK = 'seamark-tiles';
const LYR_LOGS = 'log-circles';

// --- map setup ---

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE,
  center: [0, 0],
  zoom: 1,
  attributionControl: true
});

map.addControl(new maplibregl.NavigationControl(), 'top-left');

// The live-position buoy. A DOM element positioned by MapLibre — the only
// marker that isn't drawn on the GL canvas.
let vesselMarker = null;
let hasFitOnce = false;
let styleReady = false;

// The most recent points array from the server. Point features carry only an
// index into this; the popup looks the real object up here. Keeps nested env
// objects out of MapLibre's feature properties entirely.
let currentPoints = [];

// Logs from the boat's noon-log plugin, filtered the same way points are. A log
// is a written entry carrying its own position — a different kind of record
// from a track fix, so it gets its own source, layer, and popup rather than
// being merged into the points.
let allLogs = [];
let currentLogs = [];

const el = {
  vesselName: document.getElementById('vessel-name'),
  coords: document.getElementById('coords'),
  fixTime: document.getElementById('fix-time'),
  fixAge: document.getElementById('fix-age'),
  env: document.getElementById('env'),
  range: document.getElementById('range'),
  rangeFrom: document.getElementById('range-from'),
  rangeTo: document.getElementById('range-to'),
  rangeReset: document.getElementById('range-reset'),
  exportBtn: document.getElementById('export-btn'),
  exportModal: document.getElementById('export-modal'),
  exportBackdrop: document.getElementById('export-backdrop'),
  exportCancel: document.getElementById('export-cancel'),
  exportModalSub: document.getElementById('export-modal-sub'),
  serverError: document.getElementById('server-error')
};

const panel = document.getElementById('panel');
const panelHandle = document.getElementById('panel-handle');

// Full track as fetched. currentPoints holds the FILTERED view — everything
// rendered (route, points, marker, readouts) and, later, everything exported
// comes from currentPoints. allPoints is only the source to filter from.
let allPoints = [];

// Active filter as YYYY-MM-DD strings, or null for "whole track".
let rangeFrom = null;
let rangeTo = null;

// --- helpers ---

function fmtCoord(lat, lon) {
  const latH = lat >= 0 ? 'N' : 'S';
  const lonH = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${latH}, ${Math.abs(lon).toFixed(4)}° ${lonH}`;
}

/**
 * Format an instant for display. Shows the viewer's local time (so "how long
 * ago?" reads naturally) followed by UTC (so it's unambiguous across the
 * viewer's and the boat's timezones). The UTC part omits the date unless it
 * falls on a different day than local — which happens near midnight, and
 * matters for a vessel crossing timezones.
 */
function fmtWhen(tsSec) {
  const d = new Date(tsSec * 1000);

  const local = d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const sameDay =
    d.getDate() === d.getUTCDate() &&
    d.getMonth() === d.getUTCMonth() &&
    d.getFullYear() === d.getUTCFullYear();

  const utc = d.toLocaleString(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
  );

  return `${local} \u00b7 ${utc} UTC`;
}

function fmtValue(value) {
  return typeof value === 'number' ? (Math.round(value * 100) / 100) : value;
}

function vesselEl() {
  const div = document.createElement('div');
  div.className = 'vessel-dot';
  return div;
}

function renderEnv(env) {
  el.env.innerHTML = '';
  if (!Array.isArray(env) || env.length === 0) return;
  for (const item of env) {
    if (!item || item.value === null || item.value === undefined) continue;
    const wrap = document.createElement('div');
    wrap.className = 'env-item';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label || '';

    const value = document.createElement('span');
    value.className = 'value';
    const unit = item.unit ? ` ${item.unit}` : '';
    value.textContent = `${fmtValue(item.value)}${unit}`;

    wrap.appendChild(label);
    wrap.appendChild(value);
    el.env.appendChild(wrap);
  }
}

/**
 * Relative age of a fix, in the largest unit that still reads naturally.
 * No judgment attached: a boat that surfaces once a day is not "stale", it's
 * a boat that surfaces once a day. The viewer knows their boat's habits; the
 * page does not.
 */
function fmtAge(tsSec) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (secs < 60) return 'just now';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Build the popup contents for a single logged point. Returns a DOM node rather
 * than an HTML string — labels come from boat-side config, so we never inject
 * them as markup.
 */
function buildPopup(point) {
  const wrap = document.createElement('div');
  wrap.className = 'point-popup';

  const when = document.createElement('div');
  when.className = 'pp-when';
  when.textContent = fmtWhen(point.ts);
  wrap.appendChild(when);

  const where = document.createElement('div');
  where.className = 'pp-where';
  where.textContent = fmtCoord(point.lat, point.lon);
  wrap.appendChild(where);

  const readings = (point.env || []).filter(
    i => i && i.value !== null && i.value !== undefined
  );

  if (readings.length > 0) {
    const list = document.createElement('dl');
    list.className = 'pp-env';
    for (const item of readings) {
      const dt = document.createElement('dt');
      dt.textContent = item.label || '';
      const dd = document.createElement('dd');
      dd.textContent = `${fmtValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`;
      list.appendChild(dt);
      list.appendChild(dd);
    }
    wrap.appendChild(list);
  }

  return wrap;
}

/**
 * Popup for a log entry. Same DOM-not-markup rule as buildPopup — the text is
 * written by a human on the boat and must never be injected as HTML.
 */
function buildLogPopup(log) {
  const wrap = document.createElement('div');
  wrap.className = 'log-popup';

  // Heading is the voyage name. noon-log has no title field; the voyage is what
  // tells a reader which passage this entry belongs to.
  const head = document.createElement('div');
  head.className = 'lp-head';
  head.textContent = log.voyage || 'Log';
  wrap.appendChild(head);

  const when = document.createElement('div');
  when.className = 'lp-when';
  when.textContent = fmtWhen(log.ts);
  wrap.appendChild(when);

  // Where the log was written. The boat's OWN reported position at log time —
  // independent of the track line, which is only straight interpolation between
  // the tracker plugin's fixes. Worth showing rather than inferring from where
  // the marker landed.
  if (typeof log.lat === 'number' && typeof log.lon === 'number') {
    const where = document.createElement('div');
    where.className = 'lp-where';
    where.textContent = fmtCoord(log.lat, log.lon);
    wrap.appendChild(where);
  }

  if (log.text) {
    const body = document.createElement('p');
    body.className = 'lp-text';
    body.textContent = log.text;
    wrap.appendChild(body);
  }

  // Photos are served off the tracker's own /photos — immutable once written,
  // so they cache hard.
  if (Array.isArray(log.photos) && log.photos.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'lp-photos';
    for (const name of log.photos) {
      const img = document.createElement('img');
      img.src = `/photos/${name}`;
      img.alt = '';
      img.loading = 'lazy';
      gallery.appendChild(img);
    }
    wrap.appendChild(gallery);
  }

  const readings = (log.env || []).filter(
    i => i && i.value !== null && i.value !== undefined
  );

  if (readings.length > 0) {
    const list = document.createElement('dl');
    list.className = 'pp-env';
    for (const item of readings) {
      const dt = document.createElement('dt');
      dt.textContent = item.label || '';
      const dd = document.createElement('dd');
      dd.textContent = `${fmtValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`;
      list.appendChild(dt);
      list.appendChild(dd);
    }
    wrap.appendChild(list);
  }

  const dist = log.distance || {};
  if (dist.sinceLast !== null && dist.sinceLast !== undefined) {
    const foot = document.createElement('div');
    foot.className = 'lp-foot';
    const total = (dist.total !== null && dist.total !== undefined)
      ? ` · ${fmtValue(dist.total)} nm total`
      : '';
    foot.textContent = `${fmtValue(dist.sinceLast)} nm since last${total}`;
    wrap.appendChild(foot);
  }

  return wrap;
}

// --- date range ---
// Dates are handled as YYYY-MM-DD in the VIEWER'S LOCAL timezone, because the
// picker is local and a viewer asking for "the 14th" means their 14th. The
// track's timestamps are epoch seconds, so the local-day boundaries are what
// we compare against — not UTC days.

function toLocalISODate(tsSec) {
  const d = new Date(tsSec * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Inclusive bounds: from = 00:00:00 local, to = 23:59:59 local on that day.
function dayStartSec(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}
function dayEndSec(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000);
}

// Works for points and logs alike — both are { ts, ... }.
function filterByRange(records, fromISO, toISO) {
  if (!fromISO && !toISO) return records;
  const lo = fromISO ? dayStartSec(fromISO) : -Infinity;
  const hi = toISO ? dayEndSec(toISO) : Infinity;
  return records.filter(r => r.ts >= lo && r.ts <= hi);
}

function isNarrowed() {
  if (allPoints.length === 0) return false;
  const first = toLocalISODate(allPoints[0].ts);
  const last = toLocalISODate(allPoints[allPoints.length - 1].ts);
  return (rangeFrom && rangeFrom !== first) || (rangeTo && rangeTo !== last);
}

// Collapse "equal to the track's own bound" down to null, so a range covering
// the whole track is indistinguishable from no range at all. Without this the
// URL, the reset button, and the status line disagree about whether the view
// is filtered.
function normalizeRange() {
  if (allPoints.length === 0) return;
  const first = toLocalISODate(allPoints[0].ts);
  const last = toLocalISODate(allPoints[allPoints.length - 1].ts);
  if (rangeFrom && rangeFrom <= first) rangeFrom = null;
  if (rangeTo && rangeTo >= last) rangeTo = null;
}

function fmtDayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

// The range lives in the URL so a narrowed view is shareable. Only written
// when narrowed; the default whole-track view stays a clean URL.
function readRangeFromURL() {
  const params = new URLSearchParams(location.search);
  const f = params.get('from');
  const t = params.get('to');
  const valid = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  rangeFrom = valid(f) ? f : null;
  rangeTo = valid(t) ? t : null;
  // A backwards range is meaningless — treat it as unset rather than showing
  // an empty map with no explanation.
  if (rangeFrom && rangeTo && rangeFrom > rangeTo) {
    rangeFrom = null;
    rangeTo = null;
  }
  // Not normalized against the track here — allPoints is empty until the first
  // fetch lands. syncRangeUI() clamps and normalizes on the first render.
}

function writeRangeToURL() {
  const url = new URL(location.href);
  if (isNarrowed()) {
    if (rangeFrom) url.searchParams.set('from', rangeFrom); else url.searchParams.delete('from');
    if (rangeTo) url.searchParams.set('to', rangeTo); else url.searchParams.delete('to');
  } else {
    url.searchParams.delete('from');
    url.searchParams.delete('to');
  }
  history.replaceState(null, '', url);
}

// Clamp the pickers to the track's real span. The browser greys out dates
// outside min/max, so an empty selection isn't reachable through the UI.
function syncRangeUI() {
  if (allPoints.length === 0) {
    el.range.hidden = true;
    return;
  }
  el.range.hidden = false;

  const first = toLocalISODate(allPoints[0].ts);
  const last = toLocalISODate(allPoints[allPoints.length - 1].ts);

  // A URL range can point outside the track (shared link, track since trimmed).
  // Clamp rather than honour it, so the view always shows real data.
  if (rangeFrom && rangeFrom < first) rangeFrom = first;
  if (rangeTo && rangeTo > last) rangeTo = last;
  normalizeRange();

  // Unset means "the whole track" — show its real span rather than blank
  // inputs, so the control reads as a fact before it's ever touched.
  el.rangeFrom.value = rangeFrom || first;
  el.rangeTo.value = rangeTo || last;

  // Bounds are derived from the track and the OTHER input's current value —
  // never from a previous call's leftovers. `from` can't exceed `to` and vice
  // versa, which makes an inverted range unreachable without the two functions
  // fighting over the same attributes.
  el.rangeFrom.min = first;
  el.rangeFrom.max = el.rangeTo.value;
  el.rangeTo.min = el.rangeFrom.value;
  el.rangeTo.max = last;

  el.rangeReset.hidden = !isNarrowed();
}

function applyRange() {
  rangeFrom = el.rangeFrom.value || null;
  rangeTo = el.rangeTo.value || null;
  normalizeRange();

  writeRangeToURL();
  // Re-fit on the next draw: a new range is a new extent worth framing.
  hasFitOnce = false;
  render({ vessel: null, points: allPoints, logs: allLogs });
}

el.rangeFrom.addEventListener('change', applyRange);
el.rangeTo.addEventListener('change', applyRange);
el.rangeReset.addEventListener('click', () => {
  rangeFrom = null;
  rangeTo = null;
  writeRangeToURL();
  hasFitOnce = false;
  render({ vessel: null, points: allPoints, logs: allLogs });
});

// --- GeoJSON builders ---
// MapLibre wants [lon, lat] — the reverse of Leaflet's [lat, lon]. Every
// coordinate below is built here so the flip happens in exactly one place.

function routeGeoJSON(points) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => [p.lon, p.lat])
    },
    properties: {}
  };
}

function pointsGeoJSON(points) {
  return {
    type: 'FeatureCollection',
    features: points.map((p, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      // Only the index travels as a feature property. The click handler reads
      // the real point (with its nested env array) out of currentPoints.
      properties: { idx: i }
    }))
  };
}

// Only logs with a position can be drawn. A log written with no GPS fix is
// stored server-side but has nowhere to go on a map. The index carried is into
// currentLogs, so the filter must run before this does.
//
// Log markers are SNAPPED to the nearest point on the route line. The two
// plugins report positions that differ by a small, constant lateral offset, so
// unsnapped logs sit in a line parallel to the track — visibly wrong at close
// zoom. The popup still shows the log's OWN reported coordinates; only the
// marker moves. Projection is perpendicular, so a log keeps its place ALONG the
// route: snapping to the nearest track point instead could shift it by hours on
// a 6- or 12-hour report cycle.
function logsGeoJSON(logs, routePoints) {
  return {
    type: 'FeatureCollection',
    features: logs
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => typeof l.lat === 'number' && typeof l.lon === 'number')
      .map(({ l, i }) => {
        const snapped = snapToRoute(l.lon, l.lat, routePoints);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: snapped },
          properties: { idx: i }
        };
      })
  };
}

/**
 * Nearest point on the route polyline to [lon, lat], as [lon, lat].
 *
 * Works in raw degrees rather than a projected space. That distorts distance by
 * cos(latitude) — a degree of longitude is narrower than a degree of latitude
 * away from the equator — but the offset here is tiny and local, so the nearest
 * segment is the same either way. Scaling longitude by cos(lat) would be more
 * correct and is worth doing if this ever needs to be accurate rather than just
 * visually right.
 *
 * Falls back to the log's own position when the route is empty or degenerate.
 */
function snapToRoute(lon, lat, routePoints) {
  if (!routePoints || routePoints.length === 0) return [lon, lat];
  if (routePoints.length === 1) return [routePoints[0].lon, routePoints[0].lat];

  let best = [lon, lat];
  let bestDistSq = Infinity;

  for (let i = 0; i < routePoints.length - 1; i++) {
    const ax = routePoints[i].lon;
    const ay = routePoints[i].lat;
    const bx = routePoints[i + 1].lon;
    const by = routePoints[i + 1].lat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    // Duplicate consecutive fixes make a zero-length segment; project onto the
    // endpoint rather than dividing by zero.
    let t = lenSq === 0 ? 0 : ((lon - ax) * dx + (lat - ay) * dy) / lenSq;
    // Clamp to the segment: past an endpoint the nearest point IS the endpoint.
    t = Math.max(0, Math.min(1, t));

    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = (lon - px) * (lon - px) + (lat - py) * (lat - py);

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = [px, py];
    }
  }

  return best;
}

// --- style setup ---
// Sources and layers can only be added once the style document has loaded.

map.on('load', () => {
  // Seamark raster overlay: buoys, lights, anchorages, traffic separation.
  // Transparent PNGs over the basemap. The source has no data below z7.
  map.addSource(SRC_SEAMARK, {
    type: 'raster',
    tiles: [SEAMARK_TILES],
    tileSize: 256,
    minzoom: 7,
    maxzoom: 17,
    attribution: '&copy; <a href="https://www.openseamap.org/">OpenSeaMap</a> contributors'
  });
  map.addLayer({
    id: LYR_SEAMARK,
    type: 'raster',
    source: SRC_SEAMARK,
    paint: { 'raster-opacity': 0.8 }
  });

  map.addSource(SRC_ROUTE, {
    type: 'geojson',
    data: routeGeoJSON([])
  });
  map.addLayer({
    id: LYR_ROUTE,
    type: 'line',
    source: SRC_ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#2e6f8e',
      'line-width': 3,
      'line-opacity': 0.9
    }
  });

  map.addSource(SRC_POINTS, {
    type: 'geojson',
    data: pointsGeoJSON([])
  });
  map.addLayer({
    id: LYR_POINTS,
    type: 'circle',
    source: SRC_POINTS,
    paint: {
      'circle-radius': 5,
      'circle-color': '#2e6f8e',
      'circle-opacity': 0.9,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#0b2b3a'
    }
  });

  // Click a logged point -> popup with the conditions recorded there.
  // Hit-testing queries rendered features at the cursor, so nothing can sit
  // "on top of" a point and swallow the click.
  map.on('click', LYR_POINTS, (e) => {
    const feature = e.features && e.features[0];
    if (!feature) return;
    const point = currentPoints[feature.properties.idx];
    if (!point) return;

    new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat([point.lon, point.lat])
      .setDOMContent(buildPopup(point))
      .addTo(map);
  });

  map.on('mouseenter', LYR_POINTS, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', LYR_POINTS, () => {
    map.getCanvas().style.cursor = '';
  });

  // Logs sit ABOVE the track points: where a log and a fix coincide, the log is
  // the more interesting record and should take the click. Brass and bigger so
  // it reads as a different kind of thing, not just another fix.
  map.addSource(SRC_LOGS, {
    type: 'geojson',
    data: logsGeoJSON([], [])
  });
  map.addLayer({
    id: LYR_LOGS,
    type: 'circle',
    source: SRC_LOGS,
    paint: {
      'circle-radius': 8,
      'circle-color': '#c9a227',
      'circle-opacity': 0.95,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#eae3d2'
    }
  });

  map.on('click', LYR_LOGS, (e) => {
    const feature = e.features && e.features[0];
    if (!feature) return;
    const log = currentLogs[feature.properties.idx];
    if (!log) return;

    // Anchor to the feature's own geometry — the SNAPPED position — so the
    // popup's tip points at the marker rather than at the log's raw coordinates
    // some distance off the line. The popup body still reports the real ones.
    new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(buildLogPopup(log))
      .addTo(map);
  });

  map.on('mouseenter', LYR_LOGS, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', LYR_LOGS, () => {
    map.getCanvas().style.cursor = '';
  });

  styleReady = true;
  if (currentPoints.length > 0) drawTrack(currentPoints);
});

// --- draw ---

/**
 * Push the whole track to the map. Unlike the old Leaflet version there is no
 * incremental append and no drawn-count bookkeeping: setData replaces the
 * source's contents outright, so a track that grows, shrinks, or is wiped
 * server-side all handle themselves.
 */
function drawTrack(points) {
  map.getSource(SRC_ROUTE).setData(routeGeoJSON(points));
  map.getSource(SRC_POINTS).setData(pointsGeoJSON(points));
  map.getSource(SRC_LOGS).setData(logsGeoJSON(currentLogs, points));

  const last = points[points.length - 1];
  const here = [last.lon, last.lat];

  if (vesselMarker) {
    vesselMarker.setLngLat(here);
  } else {
    vesselMarker = new maplibregl.Marker({ element: vesselEl() })
      .setLngLat(here)
      .addTo(map);
  }

  // Fit to the whole route once on first load, then leave the user's view alone.
  if (!hasFitOnce && points.length > 0) {
    const bounds = points.reduce(
      (b, p) => b.extend([p.lon, p.lat]),
      new maplibregl.LngLatBounds([points[0].lon, points[0].lat], [points[0].lon, points[0].lat])
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
    hasFitOnce = true;
  }
}

function render(data) {
  allPoints = data.points || [];
  allLogs = data.logs || [];

  // Vessel name comes from the server's VESSEL_NAME env var.
  if (data.vessel) {
    el.vesselName.textContent = data.vessel;
    document.title = data.vessel;
  }

  if (allPoints.length === 0) {
    el.coords.textContent = 'No positions logged yet';
    el.fixTime.textContent = '';
    el.fixAge.textContent = '';
    el.range.hidden = true;
    el.exportBtn.hidden = true;
    return;
  }

  syncRangeUI();

  // currentPoints is the filtered view. Everything downstream draws from it.
  const points = filterByRange(allPoints, rangeFrom, rangeTo);
  currentPoints = points;
  currentLogs = filterByRange(allLogs, rangeFrom, rangeTo);

  if (points.length === 0) {
    el.coords.textContent = 'No positions in selected range';
    el.fixTime.textContent = '';
    el.fixAge.textContent = '';
    el.exportBtn.hidden = true;
    return;
  }

  el.exportBtn.hidden = false;

  // The fetch loop can beat the style load on a cold start; the load handler
  // redraws from currentPoints when that happens.
  if (styleReady) drawTrack(points);

  // Panel readouts.
  const last = points[points.length - 1];
  el.coords.textContent = fmtCoord(last.lat, last.lon);
  el.fixTime.textContent = fmtWhen(last.ts);
  el.fixAge.textContent = fmtAge(last.ts);
  renderEnv(last.env);
}

// --- panel collapse (mobile only) ---
// Desktop has room for the whole panel; only narrow viewports collapse. The
// breakpoint is duplicated from the CSS — if one moves, move both.
const MOBILE_QUERY = window.matchMedia('(max-width: 560px)');

function setCollapsed(collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  panelHandle.setAttribute('aria-expanded', String(!collapsed));
}

// Start collapsed on mobile: the landing view should be the map with a strip of
// position, not a panel eating half the screen.
function applyBreakpoint() {
  if (MOBILE_QUERY.matches) {
    setCollapsed(true);
  } else {
    // Leaving mobile: never strand the desktop panel in a collapsed state it
    // has no handle to escape from.
    setCollapsed(false);
  }
}

panelHandle.addEventListener('click', () => {
  setCollapsed(!panel.classList.contains('collapsed'));
});

MOBILE_QUERY.addEventListener('change', applyBreakpoint);
applyBreakpoint();

// --- export ---
// Everything below serializes currentPoints — the FILTERED view. What you see
// on the map is what lands in the file. No server round trip: the client
// already holds every point, and /api/track is public anyway.

// XML text escaping. The vessel name and env labels come from boat-side config,
// so they are operator-controlled, not hostile — but they land inside markup
// and a stray & or < would produce a corrupt file.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoUTC(tsSec) {
  return new Date(tsSec * 1000).toISOString();
}

// Union of every env label present across the given points, in first-seen
// order. Points can carry different readings over time (sensor added mid-trip),
// so the CSV header has to be the union, not whatever the first point happens
// to have.
function envLabels(points) {
  const seen = [];
  for (const p of points) {
    for (const item of p.env || []) {
      if (item && item.label && !seen.includes(item.label)) seen.push(item.label);
    }
  }
  return seen;
}

function envLookup(point) {
  const map = new Map();
  for (const item of point.env || []) {
    if (item && item.label) map.set(item.label, item);
  }
  return map;
}

/**
 * GPX 1.1. One <trk> with one <trkseg> — no gap-splitting, because there is no
 * defined gap threshold and inventing one would silently reshape the track.
 * Env readings are NOT included: they have no home in the GPX schema, and
 * <extensions> is ignored by most plotters. Use CSV/GeoJSON for readings.
 */
function toGPX(points, name) {
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="signalk-web-tracker" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n    <name>${xmlEscape(name)}</name>\n    <time>${isoUTC(Math.floor(Date.now() / 1000))}</time>\n  </metadata>\n` +
    `  <trk>\n    <name>${xmlEscape(name)}</name>\n    <trkseg>\n`;

  const body = points.map(p =>
    `      <trkpt lat="${p.lat}" lon="${p.lon}">\n` +
    `        <time>${isoUTC(p.ts)}</time>\n` +
    `      </trkpt>\n`
  ).join('');

  return head + body + `    </trkseg>\n  </trk>\n</gpx>\n`;
}

/**
 * CSV. Carries everything: time, position, and one column per env label.
 * Time is written as ISO-8601 UTC — unambiguous, and sorts lexically.
 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote if the value could break the row. Doubling embedded quotes is the
  // RFC 4180 escape.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(points) {
  const labels = envLabels(points);
  const header = ['time_utc', 'latitude', 'longitude', ...labels];
  const rows = [header.map(csvCell).join(',')];

  for (const p of points) {
    const env = envLookup(p);
    const cells = [isoUTC(p.ts), p.lat, p.lon];
    for (const label of labels) {
      const item = env.get(label);
      // Unit is dropped: it belongs in the header, not repeated every row.
      // Labels are stable per sensor, so the unit is implicit in the column.
      cells.push(item && item.value !== null && item.value !== undefined ? item.value : '');
    }
    rows.push(cells.map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

/**
 * GeoJSON FeatureCollection: the route as a LineString, plus one Point per fix
 * carrying its readings. Both, because a line alone loses the per-fix data and
 * points alone lose the path.
 */
function toGeoJSON(points, name) {
  const features = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map(p => [p.lon, p.lat]) },
      properties: { name, kind: 'track' }
    },
    ...points.map(p => {
      const props = { time_utc: isoUTC(p.ts), kind: 'fix' };
      for (const item of p.env || []) {
        if (!item || !item.label) continue;
        props[item.label] = item.value;
        if (item.unit) props[`${item.label} unit`] = item.unit;
      }
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: props
      };
    })
  ];
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

/**
 * KML for Google Earth. A single LineString placemark. Coordinates are
 * lon,lat,alt triples — altitude is always 0; the tracker records none.
 */
function toKML(points, name) {
  const coords = points.map(p => `${p.lon},${p.lat},0`).join('\n          ');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
    `  <Document>\n` +
    `    <name>${xmlEscape(name)}</name>\n` +
    `    <Style id="track">\n      <LineStyle>\n        <color>ff8e6f2e</color>\n        <width>3</width>\n      </LineStyle>\n    </Style>\n` +
    `    <Placemark>\n` +
    `      <name>${xmlEscape(name)}</name>\n` +
    `      <styleUrl>#track</styleUrl>\n` +
    `      <LineString>\n` +
    `        <tessellate>1</tessellate>\n` +
    `        <coordinates>\n          ${coords}\n        </coordinates>\n` +
    `      </LineString>\n` +
    `    </Placemark>\n` +
    `  </Document>\n</kml>\n`
  );
}

const FORMATS = {
  gpx: { ext: 'gpx', mime: 'application/gpx+xml', build: (pts, name) => toGPX(pts, name) },
  csv: { ext: 'csv', mime: 'text/csv', build: (pts) => toCSV(pts) },
  geojson: { ext: 'geojson', mime: 'application/geo+json', build: (pts, name) => toGeoJSON(pts, name) },
  kml: { ext: 'kml', mime: 'application/vnd.google-earth.kml+xml', build: (pts, name) => toKML(pts, name) }
};

// Filename-safe slug of the vessel name. Falls back to 'track' if the name
// slugs to nothing (e.g. a name that's entirely punctuation).
function slug(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return out || 'track';
}

function exportFilename(ext) {
  const base = slug(el.vesselName.textContent || 'track');
  const from = el.rangeFrom.value;
  const to = el.rangeTo.value;
  const span = from && to ? `_${from}_${to}` : '';
  return `${base}${span}.${ext}`;
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function doExport(fmtKey) {
  const fmt = FORMATS[fmtKey];
  if (!fmt || currentPoints.length === 0) return;
  const name = el.vesselName.textContent || 'Track';
  download(fmt.build(currentPoints, name), exportFilename(fmt.ext), fmt.mime);
  closeExportModal();
}

function openExportModal() {
  if (currentPoints.length === 0) return;
  const n = currentPoints.length;
  const span = isNarrowed()
    ? `${fmtDayLabel(el.rangeFrom.value)} – ${fmtDayLabel(el.rangeTo.value)}`
    : 'whole track';
  el.exportModalSub.textContent = `${n} position${n === 1 ? '' : 's'} · ${span}`;
  el.exportModal.hidden = false;
  // Focus the first format so the modal is keyboard-usable immediately.
  el.exportModal.querySelector('.fmt').focus();
}

function closeExportModal() {
  el.exportModal.hidden = true;
  el.exportBtn.focus();
}

el.exportBtn.addEventListener('click', openExportModal);
el.exportCancel.addEventListener('click', closeExportModal);
el.exportBackdrop.addEventListener('click', closeExportModal);
for (const btn of document.querySelectorAll('.fmt')) {
  btn.addEventListener('click', () => doExport(btn.dataset.fmt));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.exportModal.hidden) closeExportModal();
});

// --- fetch loop ---

// One failed poll is normal — a phone changing towers, a wifi blip. Two in a
// row (~2 min of no contact) is worth surfacing. Reset on any success.
const FAIL_THRESHOLD = 2;
let consecutiveFails = 0;

async function refresh() {
  try {
    const res = await fetch('/api/track', { cache: 'no-store' });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    consecutiveFails = 0;
    el.serverError.hidden = true;
    render(data);
  } catch (err) {
    consecutiveFails++;
    if (consecutiveFails >= FAIL_THRESHOLD) el.serverError.hidden = false;
  }
}

readRangeFromURL();
refresh();
setInterval(refresh, POLL_MS);
