// --- Map setup ---
const map = L.map('map', { zoomControl: true });
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);
map.setView([55.676, 12.568], 12);

// KML pane stays above base tiles
map.createPane('kmlPane');
map.getPane('kmlPane').style.zIndex = 450;

// Layers
const kmlLayerGroup = L.layerGroup().addTo(map);
const pinkGroup = L.layerGroup().addTo(map);
const overlayGroup = L.layerGroup().addTo(map);
const gridGroup = L.layerGroup().addTo(map);

// Live marker & trace
const trace = L.polyline([], { weight: 3, opacity: 0.9 }).addTo(map);
let meMarker = null;

// State
let watchId = null; let wakeLock = null; let deferredPrompt = null;
const visitedTiles = new Set(JSON.parse(localStorage.getItem('squadratinhos_17') || '[]'));
const pinkRectsById = new Map();
let currentTileOutline = null; let autoCenterPausedUntil = 0;

// Restore pink tiles
for (const id of visitedTiles) {
  const [z, x, y] = id.split('/').map(Number);
  const rect = L.rectangle(xyzToBounds(x, y, z), { color: '#ff4da6', weight: 1, fillColor: '#ff4da6', fillOpacity: 0.35 });
  pinkGroup.addLayer(rect); pinkRectsById.set(id, rect);
}

// --- File upload ---
const kmlInput = document.getElementById('kmlInput');
kmlInput.addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  let kmlText; const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.kmz')) {
      const JSZip = (window.JSZip) ? window.JSZip : (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default;
      const buf = await file.arrayBuffer(); const zip = await JSZip.loadAsync(buf);
      let found = null; for (const fname of Object.keys(zip.files)) { if (fname.toLowerCase().endsWith('.kml')) { found = fname; break; } }
      if (!found) throw new Error('No .kml inside .kmz');
      kmlText = await zip.files[found].async('text');
    } else { kmlText = await file.text(); }
  } catch (err) { console.error(err); alert('Could not read the KML/KMZ file. ' + (err.message || '')); return; }

  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  let tgj = (window.toGeoJSON && typeof window.toGeoJSON.kml === 'function') ? window.toGeoJSON : null;
  if (!tgj) { try { tgj = await import('https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.9.0/+esm'); } catch { try { tgj = await import('https://cdn.skypack.dev/@tmcw/togeojson'); } catch (err) { alert('Could not load KML parser.'); return; } } }
  const gj = tgj.kml(dom);

  kmlLayerGroup.clearLayers();
  const layer = L.geoJSON(gj, { pane: 'kmlPane', style: f => ({ color: '#00bcd4', weight: 1, fillColor: '#00bcd4', fillOpacity: 0.25 }) });
  kmlLayerGroup.addLayer(layer); try { map.fitBounds(layer.getBounds(), { padding: [30, 30] }); } catch { }

  autoCenterPausedUntil = Date.now() + 6000; const prev = autoCenter.checked; autoCenter.checked = false; setTimeout(() => { if (Date.now() >= autoCenterPausedUntil) autoCenter.checked = prev; }, 6200);
});

// --- Controls ---
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const centerBtn = document.getElementById('centerBtn');
const installBtn = document.getElementById('installBtn');
const togglePanelBtn = document.getElementById('togglePanel');
const panel = document.getElementById('panel');

const statusEl = document.getElementById('status');
const autoCenter = document.getElementById('autoCenter');
const snapZoom = document.getElementById('snapZoom');
const showTrace = document.getElementById('showTrace');
const showGrid = document.getElementById('showGrid');

startBtn.addEventListener('click', () => startGPS());
stopBtn.addEventListener('click', () => stopGPS());
centerBtn.addEventListener('click', () => { if (meMarker) { map.setView(meMarker.getLatLng(), 17, { animate: true }); } });
togglePanelBtn.addEventListener('click', () => { panel.style.display = (panel.style.display === 'none') ? 'grid' : 'none'; });

document.getElementById('clearPink').addEventListener('click', () => {
  visitedTiles.clear(); localStorage.setItem('squadratinhos_17', JSON.stringify([])); pinkGroup.clearLayers(); pinkRectsById.clear();
});
document.getElementById('exportPink').addEventListener('click', () => {
  const features = Array.from(visitedTiles).map(id => {
    const [z, x, y] = id.split('/').map(Number); const b = xyzToBounds(x, y, z);
    const poly = [[b[0][1], b[0][0]], [b[1][1], b[0][0]], [b[1][1], b[1][0]], [b[0][1], b[1][0]], [b[0][1], b[0][0]]];
    return { type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [poly] } };
  });
  downloadJSON({ type: 'FeatureCollection', features }, 'squadratinhos-session.geojson');
});

// --- Geolocation + Wake Lock ---
async function enableWakeLock() { try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { }); } } catch (e) { } }
async function regrabWakeLock() { if (document.visibilityState === 'visible' && watchId !== null) { await enableWakeLock(); } }
document.addEventListener('visibilitychange', regrabWakeLock);

function startGPS() {
  if (!('geolocation' in navigator)) { alert('Geolocation not supported.'); return; }
  if (watchId !== null) return;
  statusEl.textContent = 'Requesting permission…'; enableWakeLock();
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
}
function stopGPS() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; statusEl.textContent = 'GPS stopped'; }
  try { wakeLock && wakeLock.release && wakeLock.release(); } catch { }
}

let lastUpdate = 0;
function onPos(pos) {
  const now = Date.now(); if (now - lastUpdate < 800) return; lastUpdate = now;
  const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = Math.round(pos.coords.accuracy);
  if (!meMarker) { meMarker = L.marker([lat, lon], { title: 'You' }).addTo(map); } else { meMarker.setLatLng([lat, lon]); }
  if (showTrace.checked) trace.addLatLng([lat, lon]);
  statusEl.textContent = `Fix: ±${acc} m`;

  if (autoCenter.checked && Date.now() >= autoCenterPausedUntil) { if (snapZoom.checked) map.setView([lat, lon], 17, { animate: false }); else map.panTo([lat, lon], { animate: false }); }

  const z = 17; const { x, y } = lonLatToTileXY(lon, lat, z); const id = `${z}/${x}/${y}`; const bounds = xyzToBounds(x, y, z);
  if (currentTileOutline) overlayGroup.removeLayer(currentTileOutline);
  currentTileOutline = L.rectangle(bounds, { color: '#7aa2ff', weight: 1.5, dashArray: '6,4', fill: false }).addTo(overlayGroup);

  if (!visitedTiles.has(id)) {
    visitedTiles.add(id); localStorage.setItem('squadratinhos_17', JSON.stringify(Array.from(visitedTiles)));
    const rect = L.rectangle(bounds, { color: '#ff4da6', weight: 1, fillColor: '#ff4da6', fillOpacity: 0.35 }); pinkGroup.addLayer(rect); pinkRectsById.set(id, rect);
  }

  drawGridIfNeeded();
}
function onErr(err) { statusEl.textContent = err.message || 'GPS error'; console.warn(err); }

// --- Slippy helpers ---
function lonLatToTileXY(lon, lat, z) { const n = Math.pow(2, z); const x = Math.floor((lon + 180) / 360 * n); const latRad = lat * Math.PI / 180; const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n); return { x, y }; }
function xyzToBounds(x, y, z) { const n = Math.pow(2, z); const lonW = x / n * 360 - 180; const lonE = (x + 1) / n * 360 - 180; const latN = rad2deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))); const latS = rad2deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)))); return [[latS, lonW], [latN, lonE]]; }
function rad2deg(r) { return r * 180 / Math.PI; }
function downloadJSON(obj, filename) { const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

// --- Grid overlay (z=17) ---
function drawGridIfNeeded() { if (!showGrid || !showGrid.checked) { gridGroup.clearLayers(); return; } const z = 17; const b = map.getBounds(); const tNW = lonLatToTileXY(b.getWest(), b.getNorth(), z); const tSE = lonLatToTileXY(b.getEast(), b.getSouth(), z); gridGroup.clearLayers(); let count = 0, maxTiles = 500; for (let x = tNW.x; x <= tSE.x; x++) { for (let y = tNW.y; y <= tSE.y; y++) { gridGroup.addLayer(L.rectangle(xyzToBounds(x, y, z), { color: '#7aa2ff', weight: 0.7, dashArray: '2,2', fill: false, opacity: 0.5 })); if (++count > maxTiles) return; } } }
map.on('moveend', drawGridIfNeeded); if (showGrid) showGrid.addEventListener('change', drawGridIfNeeded);

// --- PWA: install prompt ---
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.classList.add('show'); });
installBtn.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; installBtn.classList.remove('show'); });
window.addEventListener('appinstalled', () => { installBtn.classList.remove('show'); });

// --- PWA: Service Worker registration ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(err => console.warn('SW register failed', err));
}

// Tap map to toggle auto-center
map.on('click', () => autoCenter.checked = !autoCenter.checked);
