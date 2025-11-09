// map.js - module that builds a Three.js globe and supports markers
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';

const container = document.getElementById('map-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const renderer = new THREE.WebGLRenderer({ antialias: true });
// clamp pixel ratio to avoid huge canvases on hi-dpi devices (Surface Pro etc.)
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
// ensure canvas is displayed as block so it sizes predictably across browsers
renderer.domElement.style.display = 'block';
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
async function fetchCountriesStream({ bbox=null, lat=null, lon=null, radius=null, simplify=0.1 } = {}) {
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

  // include observer (controls.target) so server can perform hemisphere/backface culling
  try {
    const center = controls.target.clone();
    const centerLatLon = vector3ToLatLon(center);
    if (centerLatLon && typeof centerLatLon.lat === 'number') {
      params.set('observer_lat', String(centerLatLon.lat));
      params.set('observer_lon', String(centerLatLon.lon));
    }
  } catch (e) {
    // ignore
  }

  const res = await fetch(`/api/countries_stream?${params.toString()}`);
  if (!res.ok) {
    const txt = await res.text();
    console.warn('Countries stream failed', txt);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // placeholder for labels or additional metadata
  const pendingLabels = [];
  // prepare camera frustum and direction once for this streaming session
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
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
      // culling: determine representative lat/lon for geometry (server may have added centroid)
      let repLat = null, repLon = null;
      if (obj.properties && obj.properties.centroid && obj.properties.centroid.length >= 2) {
        repLon = parseFloat(obj.properties.centroid[0]);
        repLat = parseFloat(obj.properties.centroid[1]);
      } else {
        const rep = geometryRepresentativeLatLon(geom);
        if (rep) { repLat = rep.lat; repLon = rep.lon; }
      }
      if (repLat !== null && repLon !== null) {
        const worldPos = latLonToVector3(repLat, repLon, (modelScaledRadius || RADIUS) + 0.006);
        // backface: check facing relative to camera direction
        const toPoint = worldPos.clone().sub(camera.position).normalize();
        if (toPoint.dot(camDir) <= 0) continue; // behind globe
        // frustum test: skip if outside view frustum
        if (!frustum.containsPoint(worldPos)) continue;
      }
      if (geom.type === 'LineString') {
        renderCountryLine(geom.coordinates, 0xffffff, 1);
      } else if (geom.type === 'MultiLineString') {
        for (const part of geom.coordinates) renderCountryLine(part, 0xffffff, 1);
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
        // final item: apply same lightweight culling
        let repLat = null, repLon = null;
        if (obj.properties && obj.properties.centroid && obj.properties.centroid.length >= 2) {
          repLon = parseFloat(obj.properties.centroid[0]);
          repLat = parseFloat(obj.properties.centroid[1]);
        } else {
          const rep = geometryRepresentativeLatLon(geom);
          if (rep) { repLat = rep.lat; repLon = rep.lon; }
        }
        if (repLat !== null && repLon !== null) {
          const worldPos = latLonToVector3(repLat, repLon, (modelScaledRadius || RADIUS) + 0.006);
          const toPoint = worldPos.clone().sub(camera.position).normalize();
          if (toPoint.dot(camDir) > 0 && frustum.containsPoint(worldPos)) {
            if (geom.type === 'LineString') renderCountryLine(geom.coordinates, 0xffffff, 1);
            else if (geom.type === 'MultiLineString') for (const part of geom.coordinates) renderCountryLine(part, 0xffffff, 1);
          }
        } else {
          if (geom.type === 'LineString') renderCountryLine(geom.coordinates, 0xffffff, 1);
          else if (geom.type === 'MultiLineString') for (const part of geom.coordinates) renderCountryLine(part, 0xffffff, 1);
        }
      }
    } catch (e) {
      // ignore
    }
  }
  // labels are created during streaming; they'll be updated each frame
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
      // attach observer center so server can cull far-side features
      try {
        const center = controls.target.clone();
        const centerLatLon = vector3ToLatLon(center);
        if (centerLatLon && typeof centerLatLon.lat === 'number') {
          qs.set('observer_lat', String(centerLatLon.lat));
          qs.set('observer_lon', String(centerLatLon.lon));
        }
      } catch (e) {}
      const res = await fetch(`/api/overpass?${qs.toString()}`);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Overpass API request failed: ' + txt);
      }
      const geojson = await res.json();
      // prepare frustum / camera direction for client-side culling
      const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
      const frustum = new THREE.Frustum();
      const projScreenMatrix = new THREE.Matrix4();
      projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreenMatrix);

      clearFeatures();
      for (const feat of geojson.features || []) {
        const geom = feat.geometry;
        if (!geom) continue;
        // determine representative lat/lon
        let repLat = null, repLon = null;
        if (feat.properties && feat.properties.centroid && feat.properties.centroid.length >= 2) {
          repLon = parseFloat(feat.properties.centroid[0]);
          repLat = parseFloat(feat.properties.centroid[1]);
        } else {
          const rep = geometryRepresentativeLatLon(geom);
          if (rep) { repLat = rep.lat; repLon = rep.lon; }
        }
        if (repLat !== null && repLon !== null) {
          const worldPos = latLonToVector3(repLat, repLon, (modelScaledRadius || RADIUS) + 0.006);
          const toPoint = worldPos.clone().sub(camera.position).normalize();
          if (toPoint.dot(camDir) <= 0) continue; // behind globe
          if (!frustum.containsPoint(worldPos)) continue; // outside view
        }
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
  // attach observer center so server can cull far-side features
  try {
    const center = controls.target.clone();
    const centerLatLon = vector3ToLatLon(center);
    if (centerLatLon && typeof centerLatLon.lat === 'number') {
      qs.set('observer_lat', String(centerLatLon.lat));
      qs.set('observer_lon', String(centerLatLon.lon));
    }
  } catch (e) {}
  const res = await fetch(`/api/overpass_stream?${qs.toString()}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Overpass stream failed: ' + txt);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // prepare frustum/camera direction for local culling
  const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
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
      // lightweight client-side culling: find rep lat/lon and test frustum/backface
      let repLat = null, repLon = null;
      if (obj.properties && obj.properties.centroid && obj.properties.centroid.length >= 2) {
        repLon = parseFloat(obj.properties.centroid[0]);
        repLat = parseFloat(obj.properties.centroid[1]);
      } else {
        const rep = geometryRepresentativeLatLon(geom);
        if (rep) { repLat = rep.lat; repLon = rep.lon; }
      }
      if (repLat !== null && repLon !== null) {
        const worldPos = latLonToVector3(repLat, repLon, (modelScaledRadius || RADIUS) + 0.005);
        const toPoint = worldPos.clone().sub(camera.position).normalize();
        if (toPoint.dot(camDir) <= 0) continue;
        if (!frustum.containsPoint(worldPos)) continue;
      }
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
  // avoid division by zero; ensure sensible aspect
  camera.aspect = (height > 0) ? (width / height) : camera.aspect;
  camera.updateProjectionMatrix();
  // update size and also update the canvas style to match
  renderer.setSize(width, height, true);
  renderer.domElement.style.width = width + 'px';
  renderer.domElement.style.height = height + 'px';
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
fetchCountriesStream({ bbox: '-90,-180,90,180', simplify: 0.2 });
