// map.js - module that builds a Three.js globe and supports markers
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';

const container = document.getElementById('map-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
camera.position.set(0, 0, 3.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 10;

// lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(5, 3, 5);
scene.add(dir);

// globe (procedural sphere)
const RADIUS = 1;
let globe = null;
let modelScaledRadius = RADIUS;
{
  const sphereGeo = new THREE.SphereGeometry(RADIUS, 64, 64);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 1 });
  globe = new THREE.Mesh(sphereGeo, mat);
  scene.add(globe);
}

// helper: convert lat/lon to 3D on sphere
function latLonToVector3(lat, lon, radius = RADIUS) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}

// containers for OSM features
const featurePoints = new THREE.Group();
const featureLines = new THREE.Group();
const countryBorders = new THREE.Group();
scene.add(featurePoints);
scene.add(featureLines);
scene.add(countryBorders);

// Sprite-based labels (Three.js) for performance and consistent scaling
const spriteLabels = []; // array of sprites
// index to deduplicate labels by name or centroid key -> sprite
const spriteLabelIndex = new Map();

// Clear only OSM feature layers (keep country borders and labels intact)
function clearFeatures() {
  featurePoints.clear();
  featureLines.clear();
}

// Clear everything including country borders and label sprites
function clearAllFeatures() {
  featurePoints.clear();
  featureLines.clear();
  countryBorders.clear();
  // remove sprite labels from scene
  for (const s of spriteLabels) {
    try { scene.remove(s); } catch (e) { /* ignore */ }
    if (s.material && s.material.map) s.material.map.dispose();
    if (s.material) s.material.dispose();
  }
  spriteLabels.length = 0;
  spriteLabelIndex.clear();
}

function renderPoint(lat, lon, color = 0xff3333, size = 0.02) {
  const radius = (modelScaledRadius || RADIUS) + 0.01;
  const pos = latLonToVector3(lat, lon, radius);
  const geo = new THREE.SphereGeometry(size, 8, 8);
  const mat = new THREE.MeshStandardMaterial({ color });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(pos);
  m.lookAt(pos.clone().multiplyScalar(2));
  featurePoints.add(m);
}

function renderLine(coords, color = 0x00ff00, width = 1) {
  // coords is array of [lon, lat]
  const radius = (modelScaledRadius || RADIUS) + 0.005;
  const sampled = simplifyCoords(coords, 400); // reduce vertex count for large ways
  const points = sampled.map(([lon, lat]) => latLonToVector3(lat, lon, radius));
  const positions = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    positions[i * 3 + 0] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, linewidth: width });
  const line = new THREE.Line(geom, mat);
  featureLines.add(line);
}

function renderCountryLine(coords, color = 0xffffff, width = 1) {
  const radius = (modelScaledRadius || RADIUS) + 0.006;
  const sampled = simplifyCoords(coords, 800);
  const points = sampled.map(([lon, lat]) => latLonToVector3(lat, lon, radius));
  const positions = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    positions[i * 3 + 0] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, linewidth: width });
  const line = new THREE.Line(geom, mat);
  countryBorders.add(line);
}

async function fetchCountries(simplify = 0.2) {
  try {
    const qs = new URLSearchParams({ simplify: String(simplify) });
    const res = await fetch(`/api/countries?${qs.toString()}`);
    if (!res.ok) {
      console.warn('Failed to load countries', await res.text());
      return;
    }
    const geo = await res.json();
    if (!geo || !geo.features) return;
    for (const f of geo.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'LineString') {
        renderCountryLine(g.coordinates, 0xffffff, 1);
      } else if (g.type === 'MultiLineString') {
        for (const part of g.coordinates) renderCountryLine(part, 0xffffff, 1);
      }
    }
  } catch (e) {
    console.error('Error fetching countries', e);
  }
}

// New: stream country outlines (NDJSON) and render incrementally.
async function fetchCountriesStream({ bbox=null, lat=null, lon=null, radius=null, simplify=0 } = {}) {
  // when fetching countries we want to clear existing country outlines and labels
  clearAllFeatures();
  // build query string
  const params = new URLSearchParams();
  params.set('simplify', String(simplify));
  if (bbox) params.set('bbox', bbox);
  else if (lat !== null && lon !== null && radius !== null) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
    params.set('radius', String(radius));
  }

  const res = await fetch(`/api/countries_stream?${params.toString()}`);
  if (!res.ok) {
    const txt = await res.text();
    console.warn('Countries stream failed', txt);
    return { ok: false, error: txt, processedFeatures: 0, processedLabels: 0 };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // progress counters
  let processedFeatures = 0;
  let processedLabels = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        console.warn('Failed to parse NDJSON line', e, line);
        continue;
      }
      if (obj._meta) continue;
      // expect feature with geometry LineString/MultiLineString
      const geom = obj.geometry;
      if (!geom) continue;
      if (geom.type === 'LineString') {
        renderCountryLine(geom.coordinates, 0xffffff, 1);
        processedFeatures++;
      } else if (geom.type === 'MultiLineString') {
        for (const part of geom.coordinates) renderCountryLine(part, 0xffffff, 1);
        processedFeatures++;
      }
      // collect label info and add label (country name)
      if (obj.properties && obj.properties.name) {
        try {
          // server provides centroid (lon,lat) and label_priority when available
          const props = obj.properties || {};
          let latc = null, lonc = null, priority = props.label_priority || 0;
          if (props.centroid && props.centroid.length >= 2) {
            lonc = parseFloat(props.centroid[0]);
            latc = parseFloat(props.centroid[1]);
          } else {
            const rep = geometryRepresentativeLatLon(geom);
            if (rep) {
              latc = rep.lat; lonc = rep.lon;
            }
          }
          if (latc !== null && lonc !== null) {
            addCountryLabelSprite(obj.properties.name, latc, lonc, priority);
            // New: create country button (for country list UI)
            createCountryButton(obj.properties.name, lonc, latc);
            processedLabels++;
          }
        } catch (e) {
          // ignore label errors
        }
      }
    }
  }
  // final buffer
  if (buf.trim()) {
    try {
      const obj = JSON.parse(buf.trim());
      if (obj && obj.geometry) {
        const geom = obj.geometry;
        if (geom.type === 'LineString') { renderCountryLine(geom.coordinates, 0xffffff, 1); processedFeatures++; }
        else if (geom.type === 'MultiLineString') { for (const part of geom.coordinates) renderCountryLine(part, 0xffffff, 1); processedFeatures++; }
        if (obj.properties && obj.properties.name) {
          const rep = geometryRepresentativeLatLon(geom);
          if (rep) {
            addCountryLabelSprite(obj.properties.name, rep.lat, rep.lon, obj.properties.label_priority||0);
            createCountryButton(obj.properties.name, rep.lon, rep.lat);
            processedLabels++;
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // return progress summary
  return { ok: true, processedFeatures, processedLabels };
}

// compute a representative lat/lon for a LineString or MultiLineString geometry
function geometryRepresentativeLatLon(geom) {
  if (!geom) return null;
  if (geom.type === 'LineString') {
    const coords = geom.coordinates;
    if (!coords || coords.length === 0) return null;
    const mid = Math.floor(coords.length / 2);
    const [lon, lat] = coords[mid];
    return { lat, lon };
  } else if (geom.type === 'MultiLineString') {
    // pick the longest part
    let best = null;
    let bestLen = -1;
    for (const part of geom.coordinates) {
      if (!part) continue;
      if (part.length > bestLen) {
        bestLen = part.length;
        best = part;
      }
    }
    if (!best || best.length === 0) return null;
    const mid = Math.floor(best.length / 2);
    const [lon, lat] = best[mid];
    return { lat, lon };
  }
  return null;
}
// create a sprite containing text for a label
function createLabelSprite(text) {
  const padding = 8;
  const font = 'bold 28px sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = 34; // approximate line height
  canvas.width = textWidth + padding * 2;
  canvas.height = textHeight + padding * 2;
  // redraw with proper size
  ctx.font = font;
  ctx.fillStyle = 'rgba(11,16,32,0.9)';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 6);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  // store pixel size for collision heuristics
  sprite.userData.screenSize = { w: canvas.width, h: canvas.height };
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function addCountryLabelSprite(name, lat, lon, priority = 0) {
  // use name as primary key for deduplication; fallback to centroid key
  const keyName = (name || '').trim();
  const centroidKey = (lat !== null && lon !== null) ? `${lat.toFixed(6)},${lon.toFixed(6)}` : null;
  const key = keyName || centroidKey;
  if (!key) return; // can't create label without identifier

  // If we already have a label with this key, keep the higher-priority one
  if (spriteLabelIndex.has(key)) {
    const existing = spriteLabelIndex.get(key);
    const existingPriority = existing.userData.priority || 0;
    if ((priority || 0) <= existingPriority) {
      // existing is equal or better, skip
      return;
    }
    // new label has higher priority: remove existing and replace
    try { scene.remove(existing); } catch (e) {}
    if (existing.material && existing.material.map) existing.material.map.dispose();
    if (existing.material) existing.material.dispose();
    const idx = spriteLabels.indexOf(existing);
    if (idx >= 0) spriteLabels.splice(idx, 1);
    spriteLabelIndex.delete(key);
  }

  const sprite = createLabelSprite(name);
  const worldPos = latLonToVector3(lat, lon, (modelScaledRadius || RADIUS) + 0.01);
  sprite.position.copy(worldPos);
  sprite.userData.worldPos = worldPos.clone();
  sprite.userData.priority = typeof priority === 'number' ? priority : 0;
  sprite.userData.countryName = name;            // <- add this so click handler can read name
  // initial scale -- will be adjusted each frame to keep consistent pixel size
  sprite.scale.set(0.4, 0.14, 1);
  scene.add(sprite);
  spriteLabels.push(sprite);
  spriteLabelIndex.set(key, sprite);
}

// update sprite label visibility and approximate collision avoidance
function updateLabelSprites() {
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  // build list of candidates with screen positions
  const candidates = [];
  for (const s of spriteLabels) {
    const wp = s.userData.worldPos.clone();
    // bounding: check camera-facing
    const toPoint = wp.clone().sub(camera.position).normalize();
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const facing = toPoint.dot(camDir) > 0.12;
    if (!facing) {
      s.visible = false;
      continue;
    }
    const proj = wp.project(camera);
    const x = (proj.x + 1) / 2 * width;
    const y = (-proj.y + 1) / 2 * height;
    candidates.push({ sprite: s, x, y, priority: s.userData.priority, wp });
  }
  // sort by priority desc (bigger first)
  candidates.sort((a,b) => b.priority - a.priority);
  const placed = [];
  const threshold = 80; // pixel distance threshold for label collision
  for (const c of candidates) {
    let ok = true;
    for (const p of placed) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (Math.hypot(dx, dy) < threshold) { ok = false; break; }
    }
    if (ok) {
      // show
      c.sprite.visible = true;
      // adjust scale so sprite appears roughly constant in pixel size
      const dist = camera.position.distanceTo(c.wp) || 1;
      const scaleFactor = (dist * 0.08);
      c.sprite.scale.set(scaleFactor, scaleFactor * 0.4, 1);
      placed.push(c);
    } else {
      c.sprite.visible = false;
    }
  }
}

function renderPolygon(rings, color = 0x00aa00) {
  // rings is array of linear rings; render outer ring as a line loop
  if (!rings || rings.length === 0) return;
  renderLine(rings[0], color);
}

// simple coordinate reducer (uniform sampling). Keeps first and last points.
function simplifyCoords(coords, maxPoints) {
  if (!coords || coords.length <= maxPoints) return coords;
  const n = coords.length;
  const step = Math.ceil(n / maxPoints);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(coords[i]);
  if (out[out.length - 1] !== coords[n - 1]) out.push(coords[n - 1]);
  return out;
}

async function fetchOverpass(lat, lon, radiusMeters) {
  const status = document.getElementById('status');
  status.textContent = 'Loading...';
  // use streaming endpoint for larger radii to avoid large single responses
  const useStream = radiusMeters > 3000;
  try {
    if (useStream) {
      await fetchOverpassStream(lat, lon, radiusMeters);
    } else {
      const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radiusMeters) });
      const res = await fetch(`/api/overpass?${qs.toString()}`);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Overpass API request failed: ' + txt);
      }
      const geojson = await res.json();
      clearFeatures();
      for (const feat of geojson.features || []) {
        const geom = feat.geometry;
        if (!geom) continue;
        if (geom.type === 'Point') {
          const [lon, lat] = geom.coordinates;
          renderPoint(lat, lon, 0xff5533, 0.02);
        } else if (geom.type === 'LineString') {
          renderLine(geom.coordinates, 0x00ff88);
        } else if (geom.type === 'Polygon') {
          renderPolygon(geom.coordinates, 0x009988);
        }
      }
    }
  } catch (err) {
    console.error('Failed to fetch/parse Overpass data', err);
    alert('Failed to load Overpass data: ' + err.message);
  } finally {
    status.textContent = '';
  }
}

async function fetchOverpassStream(lat, lon, radiusMeters) {
  clearFeatures();
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radiusMeters) });
  const res = await fetch(`/api/overpass_stream?${qs.toString()}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Overpass stream failed: ' + txt);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        console.warn('Failed to parse NDJSON line', e, line);
        continue;
      }
      if (obj._error) {
        console.warn('Overpass tile error', obj);
        continue;
      }
      if (obj._meta) {
        // progress or done marker
        continue;
      }
      // treat as GeoJSON Feature
      const geom = obj.geometry;
      if (!geom) continue;
      if (geom.type === 'Point') {
        const [lon, lat] = geom.coordinates;
        renderPoint(lat, lon, 0xff5533, 0.02);
      } else if (geom.type === 'LineString') {
        renderLine(geom.coordinates, 0x00ff88);
      } else if (geom.type === 'Polygon') {
        renderPolygon(geom.coordinates, 0x009988);
      }
    }
  }
  // parse final buffer
  if (buf.trim()) {
    try {
      const obj = JSON.parse(buf.trim());
      if (obj && obj.geometry) {
        const geom = obj.geometry;
        if (geom.type === 'Point') {
          const [lon, lat] = geom.coordinates;
          renderPoint(lat, lon, 0xff5533, 0.02);
        } else if (geom.type === 'LineString') {
          renderLine(geom.coordinates, 0x00ff88);
        } else if (geom.type === 'Polygon') {
          renderPolygon(geom.coordinates, 0x009988);
        }
      }
    } catch (e) {
      console.warn('final NDJSON parse failed', e, buf);
    }
  }
}

// UI: load example OSM reconstruction data (London 5 km)
document.getElementById('load-osm').addEventListener('click', () => {
  // center near London by default and fetch
  const lat = 51.5074, lon = -0.1278;
  centerOnLatLon(lat, lon, 3.5);
  fetchOverpass(lat, lon, 5000);
});

// Geolocation: center on user's current position
document.getElementById('locate-me').addEventListener('click', () => {
  const status = document.getElementById('status');
  if (!navigator.geolocation) {
    alert('Geolocation not supported by your browser');
    return;
  }
  status.textContent = 'Requesting location...';
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    centerOnLatLon(lat, lon, 3.0);
    // initial fetch uses radius based on current camera distance
    const dist = camera.position.distanceTo(controls.target || new THREE.Vector3());
    const radius = cameraDistanceToRadius(dist);
    fetchOverpass(lat, lon, radius);
    status.textContent = '';
  }, (err) => {
    status.textContent = '';
    alert('Failed to get location: ' + (err && err.message));
  }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 });
});

// helpers: convert 3D vector to lat/lon
function vector3ToLatLon(v) {
  const r = v.length() || 1;
  const lat = 90 - Math.acos(v.y / r) * (180 / Math.PI);
  const lon = Math.atan2(v.z, -v.x) * (180 / Math.PI) - 180;
  return { lat, lon };
}

// map camera distance to Overpass search radius (meters)
function cameraDistanceToRadius(distance) {
  // distance roughly scales with model radius (modelScaledRadius==1)
  // map distance in [1.5, 10] -> radius in meters [200, 20000]
  const minD = 1.5, maxD = 10;
  const minR = 200, maxR = 20000;
  const t = Math.min(1, Math.max(0, (distance - minD) / (maxD - minD)));
  // invert so smaller distance => smaller radius
  const v = 1 - t;
  return Math.round(minR + v * (maxR - minR));
}

// center camera and controls target on lat/lon; factor controls camera distance multiplier
function centerOnLatLon(lat, lon, distanceFactor = 3.5) {
  const target = latLonToVector3(lat, lon, modelScaledRadius || RADIUS);
  controls.target.copy(target);
  // set camera position along same direction but farther out
  const camPos = target.clone().multiplyScalar(distanceFactor);
  camera.position.copy(camPos);
  controls.update();
}

// debounce/fetch-on-end logic
let lastFetch = { lat: null, lon: null, radius: null };
let fetchScheduled = null;

function shouldFetch(newLat, newLon, newRadius) {
  if (lastFetch.lat === null) return true;
  const dLat = Math.abs(lastFetch.lat - newLat);
  const dLon = Math.abs(lastFetch.lon - newLon);
  // rough degrees -> meters approx (lat ~111km per deg)
  const metersMoved = Math.sqrt((dLat * 111320) ** 2 + (dLon * 111320) ** 2);
  const radiusChanged = Math.abs(newRadius - (lastFetch.radius || 0)) / (lastFetch.radius || 1);
  return metersMoved > 500 || radiusChanged > 0.3;
}

function scheduleFetchForControls() {
  if (fetchScheduled) clearTimeout(fetchScheduled);
  fetchScheduled = setTimeout(() => {
    const target = controls.target.clone();
    const { lat, lon } = vector3ToLatLon(target);
    const dist = camera.position.distanceTo(target);
    const radius = cameraDistanceToRadius(dist);
    if (shouldFetch(lat, lon, radius)) {
      lastFetch = { lat, lon, radius };
      fetchOverpass(lat, lon, radius);
    }
  }, 600);
}

controls.addEventListener('end', scheduleFetchForControls);

// resize handling
function onWindowResize() {
  const width = container.clientWidth;
  const height = container.clientHeight;
  camera.aspect = width / height || 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

window.addEventListener('resize', onWindowResize, false);
onWindowResize();

// animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  // update labels after render to ensure camera/projection are current
  updateLabelSprites();
}

animate();

// fetch and render country borders via streaming (covers full globe initially)
// bbox format: minlat,minlon,maxlat,maxlon
fetchCountriesStream({ bbox: '-90,-180,90,180' });

// --- Add click handling, info panel UI and icon rendering ----

// create an info panel DOM element (right side, semi-opaque)
const infoPanel = document.createElement('div');
infoPanel.id = 'info-panel';
infoPanel.style.position = 'fixed';
infoPanel.style.top = '8%';
infoPanel.style.right = '-420px'; // start hidden off-screen
infoPanel.style.width = '360px';
infoPanel.style.maxWidth = '40%';
infoPanel.style.height = '84%';
infoPanel.style.background = 'rgba(11,16,32,0.5)'; // 50% opacity
infoPanel.style.color = '#fff';
infoPanel.style.padding = '12px';
infoPanel.style.borderRadius = '8px';
infoPanel.style.overflow = 'auto';
infoPanel.style.boxShadow = '0 6px 24px rgba(0,0,0,0.6)';
infoPanel.style.zIndex = '9999';
infoPanel.style.display = 'block'; // remain in DOM but off-screen
infoPanel.style.transition = 'right 280ms ease, opacity 280ms ease';
infoPanel.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
    <strong id="info-title">Country</strong>
    <button id="info-close" style="background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;">✕</button>
  </div>
  <div id="info-content"><em>Loading...</em></div>
`;
document.body.appendChild(infoPanel);
document.getElementById('info-close').addEventListener('click', () => {
  // close panel (slide out)
  infoPanel.style.right = '-420px';
});

// create a floating list of country buttons (left side)
const countryList = document.createElement('div');
countryList.id = 'country-list';
countryList.style.position = 'fixed';
countryList.style.top = '12%';
countryList.style.left = '12px';
countryList.style.maxHeight = '76%';
countryList.style.overflow = 'auto';
countryList.style.zIndex = '9999';
countryList.style.background = 'rgba(11,16,32,0.6)';
countryList.style.padding = '6px';
countryList.style.borderRadius = '6px';
countryList.style.color = '#fff';
countryList.style.fontSize = '13px';
countryList.style.backdropFilter = 'blur(4px)';
document.body.appendChild(countryList);

// keep track to avoid duplicate buttons
const countryButtonIndex = new Set();

function createCountryButton(name, lon = null, lat = null) {
  if (!name) return;
  const key = name.trim();
  if (countryButtonIndex.has(key)) return;
  countryButtonIndex.add(key);
  const btn = document.createElement('button');
  btn.className = 'country-btn';
  btn.textContent = name;
  btn.style.display = 'block';
  btn.style.width = '100%';
  btn.style.margin = '4px 0';
  btn.style.textAlign = 'left';
  btn.style.background = 'transparent';
  btn.style.border = '1px solid rgba(255,255,255,0.08)';
  btn.style.color = '#fff';
  btn.style.padding = '6px 8px';
  btn.style.borderRadius = '4px';
  btn.style.cursor = 'pointer';
  btn.dataset.name = name;
  if (lat !== null && lon !== null) {
    btn.dataset.lat = lat;
    btn.dataset.lon = lon;
  }
  btn.addEventListener('click', async (e) => {
    const cname = e.currentTarget.dataset.name;
    const clat = parseFloat(e.currentTarget.dataset.lat || '0');
    const clon = parseFloat(e.currentTarget.dataset.lon || '0');
    if (!isNaN(clat) && !isNaN(clon)) {
      centerOnLatLon(clat, clon, 3.5);
    }
    await showCountryInfoPanel(cname);
    // slide panel into view
    infoPanel.style.right = '12px';
  });
  countryList.appendChild(btn);
}

// ...existing code...

// inside the streaming loop in fetchCountriesStream where you parse each streamed country feature:
// find the section that processes each line/feature and add createCountryButton(...)
 // Example insertion context (replace the "for (const line of lines) {…}" block's processing)
 // ...existing code...
 // when you parse a streamed feature 'obj' that has properties.name and properties.centroid:
 // after existing label/sprite creation add:
 // createCountryButton(name, centroidLon, centroidLat)
// ...existing code...

// fetch country info from server and populate panel; also render returned icons
async function showCountryInfoPanel(countryName, worldPos=null) {
  const title = document.getElementById('info-title');
  const content = document.getElementById('info-content');
  title.textContent = countryName;
  content.innerHTML = '<p>Loading data…</p>';
  infoPanel.style.display = 'block';

  try {
    const res = await fetch(`/api/country_info?country=${encodeURIComponent(countryName)}`);
    if (!res.ok) {
      content.innerHTML = `<p>Error loading info: ${await res.text()}</p>`;
      return;
    }
    const data = await res.json();
    // basic display
    const rest = data.rest || {};
    const props = data.properties || {};
    const centroid = data.centroid ? `${data.centroid[1]?.toFixed(4) || ''}, ${data.centroid[0]?.toFixed(4) || ''}` : '';
    const bbox = data.bbox ? data.bbox.map(n => Number(n).toFixed(4)).join(', ') : '';
    const pop = rest.population ? rest.population.toLocaleString() : 'n/a';
    const area = rest.area ? rest.area.toLocaleString() + ' km²' : 'n/a';
    let flagHtml = '';
    if (rest.flag) flagHtml = `<div style="margin:8px 0"><img src="${rest.flag}" alt="flag" style="width:100%;max-width:200px;border-radius:4px"/></div>`;

    content.innerHTML = `
      ${flagHtml}
      <p><strong>Centroid</strong>: ${centroid}</p>
      <p><strong>BBox</strong>: ${bbox}</p>
      <p><strong>Population</strong>: ${pop}</p>
      <p><strong>Area</strong>: ${area}</p>
      <p><strong>Source properties</strong>: ${Object.keys(props).length ? JSON.stringify(props) : 'none'}</p>
      <div id="info-icons" style="margin-top:12px"><strong>Icons / features</strong><div id="info-icons-list"></div></div>
    `;

    // Clear previously-rendered icon sprites for this country
    if (!window._countryIconSprites) window._countryIconSprites = [];
    for (const s of window._countryIconSprites) { try { featurePoints.remove(s); } catch(e){} }
    window._countryIconSprites.length = 0;

    // render any icons returned by server (expect array of {lat,lon,type,url,label})
    const icons = data.icons || [];
    const iconsList = document.getElementById('info-icons-list');
    iconsList.innerHTML = '';
    for (const ic of icons) {
      const label = ic.label || ic.type || '';
      const lat = parseFloat(ic.lat), lon = parseFloat(ic.lon);
      let sprite = null;
      if (ic.url) {
        // use image URL texture
        const tex = new THREE.TextureLoader().load(ic.url);
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.08, 0.08, 1);
      } else {
        // fallback: colored dot
        const dot = document.createElement('canvas');
        dot.width = 48; dot.height = 48;
        const ctx = dot.getContext('2d');
        ctx.fillStyle = '#ffdd44';
        ctx.beginPath(); ctx.arc(24,24,12,0,Math.PI*2); ctx.fill();
        const tex = new THREE.CanvasTexture(dot);
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.06, 0.06, 1);
      }
      if (sprite) {
        const pos = latLonToVector3(lat, lon, (modelScaledRadius || RADIUS) + 0.02);
        sprite.position.copy(pos);
        sprite.userData = { country: countryName, label: label };
        featurePoints.add(sprite);
        window._countryIconSprites.push(sprite);
      }
      // add to list in panel
      const item = document.createElement('div');
      item.textContent = `${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      item.style.padding = '4px 0';
      iconsList.appendChild(item);
    }

  } catch (e) {
    content.innerHTML = `<p>Error fetching country info: ${e.message}</p>`;
  }
}

// expose quick debug helper
window.getMapPopulateStats = function() {
  return {
    countryBorders: countryBorders.children.length,
    labels: spriteLabels.length,
    countryButtons: (document.getElementById('country-list')||{children:[]}).children.length
  };
};
// callback pattern (Manifest V2 / compat)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'doThing') return; 
  (async () => {
    try {
      const r = await fetch(msg.url);
      const json = await r.json();
      sendResponse({ ok: true, data: json });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep channel open until sendResponse is called
});

// manifest v3: return a Promise (or async function) from listener
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'doThing') return;
  return (async () => {
    try {
      const r = await fetch(msg.url);
      const json = await r.json();
      return { ok: true, data: json };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  })();
});

// Extension message listener (guarded so page won't throw when 'chrome' is undefined)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'doThing') return;

    const proc = (async () => {
      try {
        const r = await fetch(msg.url);
        const json = await r.json();
        return { ok: true, data: json };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })();

    // If sendResponse is available (MV2 compatibility), use it and keep channel open.
    if (typeof sendResponse === 'function') {
      proc.then(res => sendResponse(res)).catch(err => sendResponse({ ok: false, error: String(err) }));
      return true; // keep channel open for async sendResponse
    }

    // MV3: return a Promise from the listener
    return proc;
  });
} else {
  // not running inside an extension; no-op
  console.debug('chrome.runtime not available — extension listeners skipped');
}
