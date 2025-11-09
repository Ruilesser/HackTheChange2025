// map.js - module that builds a Three.js globe and supports markers
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';

const container = document.getElementById('map-container');

// lightweight FPS / timing panel
const fpsCounter = document.createElement('div');
fpsCounter.id = 'fps-counter';
fpsCounter.style.position = 'absolute';
fpsCounter.style.left = '8px';
fpsCounter.style.top = '8px';
fpsCounter.style.padding = '6px 8px';
fpsCounter.style.background = 'rgba(11,16,32,0.8)';
fpsCounter.style.color = '#fff';
fpsCounter.style.font = '12px monospace';
fpsCounter.style.zIndex = 9999;
fpsCounter.style.pointerEvents = 'none';
fpsCounter.innerHTML = '';
container.appendChild(fpsCounter);

// frame timing history (ms)
const FRAME_HISTORY = 60;
const frameTimes = [];
let lastFrameTime = performance.now();
let smoothedFps = 0;

// status element helper (shows short user-facing messages)
const statusEl = document.getElementById('status');
function setStatus(msg, level = 'info', timeout = 6000) {
  try {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    if (level === 'error') {
      statusEl.style.color = '#ff8888';
    } else if (level === 'loading') {
      statusEl.style.color = '#ffd166';
    } else {
      statusEl.style.color = '#ddd';
    }
    if (statusEl._clearTimer) { clearTimeout(statusEl._clearTimer); statusEl._clearTimer = null; }
    if (timeout && msg) {
      statusEl._clearTimer = setTimeout(() => { try { statusEl.textContent = ''; } catch (e) {} }, timeout);
    }
  } catch (e) {
    // ignore
  }
}
function clearStatus() { if (statusEl) { statusEl.textContent = ''; if (statusEl._clearTimer) { clearTimeout(statusEl._clearTimer); statusEl._clearTimer = null; } } }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

// enable depth buffer so scene geometry is depth-tested and occludes correctly
const renderer = new THREE.WebGLRenderer({ antialias: true, depth: true });
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
// how far to push labels out from the globe surface to avoid z-fighting/clipping
const LABEL_OFFSET = 0.03;
{
  const sphereGeo = new THREE.SphereGeometry(RADIUS, 64, 64);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 1 });
  globe = new THREE.Mesh(sphereGeo, mat);
  globe.renderOrder = 0;
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
    setStatus('Failed to load country outlines from server', 'error', 8000);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let featureCount = 0;
  setStatus('Streaming OSM features — receiving tiles...', 'loading', null);
  // placeholder for labels or additional metadata
  const pendingLabels = [];
  let addedCountryGeoms = 0;
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
        addedCountryGeoms++;
        if (addedCountryGeoms % 40 === 0) setStatus(`Loading country outlines… ${addedCountryGeoms} segments rendered`, 'loading', null);
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
  setStatus(`Country outlines: ${addedCountryGeoms} segments loaded`, 'info', 4000);
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
  // enable depthTest so labels can be occluded by nearer geometry (the globe)
  // avoid writing to the depth buffer so labels don't block other objects
  // use alphaTest to discard fully transparent pixels and avoid halo/clipping
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, alphaTest: 0.04 });
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
  const worldPos = latLonToVector3(lat, lon, (modelScaledRadius || RADIUS) + LABEL_OFFSET);
  sprite.position.copy(worldPos);
  sprite.userData.worldPos = worldPos.clone();
  sprite.userData.priority = typeof priority === 'number' ? priority : 0;
  // initial scale -- will be adjusted each frame to keep consistent pixel size
  sprite.scale.set(0.4, 0.14, 1);
  // ensure labels render after globe so depth buffering reflects globe geometry
  sprite.renderOrder = 2;
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
  setStatus('Preparing OSM request — computing radius and method...', 'loading', null);
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
    clearStatus();
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
    setStatus('Overpass stream request failed (server error)', 'error', 8000);
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
        // progress or done marker - the server may emit summaries here
        if (obj._meta && obj._meta.message) {
          setStatus(obj._meta.message, 'loading', null);
        }
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
        featureCount++;
      } else if (geom.type === 'LineString') {
        renderLine(geom.coordinates, 0x00ff88);
        featureCount++;
      } else if (geom.type === 'Polygon') {
        renderPolygon(geom.coordinates, 0x009988);
        featureCount++;
      }
      // update status occasionally to show progress
      if (featureCount > 0 && featureCount % 200 === 0) {
        setStatus(`Streaming OSM features… ${featureCount} features received`, 'loading', null);
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
  setStatus(`Done — streamed ${featureCount} features`, 'info', 6000);
}

// Geolocation: center on user's current position
document.getElementById('locate-me').addEventListener('click', () => {
  // show a friendly status while geolocation runs
  setStatus('Requesting device location…', 'loading', 10000);
  if (!navigator.geolocation) {
    setStatus('Geolocation not supported by your browser', 'error', 5000);
    alert('Geolocation not supported by your browser');
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    centerOnLatLon(lat, lon, 3.0);

    clearIconMarkers(); // clear icons

    // initial fetch uses radius based on current camera distance
    const dist = camera.position.distanceTo(controls.target || new THREE.Vector3());
    const radius = cameraDistanceToRadius(dist);
    fetchOverpass(lat, lon, radius);
    clearStatus();

    // THIS CODE HERE is for adding icons onto the map
    getOsmJson(lat, lon, radius)
      .then(osmData => processOsmJson(JSON.stringify(osmData)))
      .then(processedElements => {
        for (const el of processedElements) {
          addIconMarker(
            el.centroid.lat,
            el.centroid.lon,
            el.base_elev + (el.effective_height || 0.08),
            el.icon || '/icons/default.svg'
          );
        }
      })
      .catch(err => {
        console.error(err);
        setStatus('Error processing OSM data', 'error', 5000);
      });

  }, (err) => {
    clearStatus();
    setStatus('Failed to get device location', 'error', 6000);
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
  const now = performance.now();
  const dt = Math.max(0.001, now - lastFrameTime); // ms
  lastFrameTime = now;
  const instFps = 1000.0 / dt;
  // exponential smoothing for FPS display
  smoothedFps = smoothedFps * 0.93 + instFps * 0.07;
  // update frameTimes buffer
  frameTimes.push(dt);
  if (frameTimes.length > FRAME_HISTORY) frameTimes.shift();

  controls.update();
  renderer.render(scene, camera);
  // update labels after render to ensure camera/projection are current
  updateLabelSprites();

  // compute ms stats
  let avg = 0, min = Infinity, max = 0;
  for (const t of frameTimes) { avg += t; if (t < min) min = t; if (t > max) max = t; }
  const n = frameTimes.length || 1;
  avg = avg / n;
  if (min === Infinity) min = 0;
  // update UI
  fpsCounter.innerHTML = `FPS: ${smoothedFps.toFixed(1)} &nbsp;|&nbsp; frame: ${dt.toFixed(1)} ms<br>avg: ${avg.toFixed(1)} ms (min ${min.toFixed(1)} / max ${max.toFixed(1)})`;
}

animate();

// fetch and render country borders via streaming (covers full globe initially)
// bbox format: minlat,minlon,maxlat,maxlon
fetchCountriesStream({ bbox: '-90,-180,90,180', simplify: 0.2 });


// -----------------------------------------------------------
// Utilities
// -----------------------------------------------------------
function lonLatToMeters(lon, lat) {
    const RADIUS = 6378137.0;  // Earth's radius in meters (WGS84)
    const x = lon * RADIUS * Math.PI / 180.0;
    const y = Math.log(Math.tan((90 + lat) * Math.PI / 360.0)) * RADIUS;
    return { x, y };
}

async function getElevation(lat, lon) {
    // Get elevation (m) for given coordinates using OpenTopoData SRTM90m
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${lat},${lon}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
        return data.results[0].elevation ?? 0.0;
    }
    return 0.0;
}

// -----------------------------------------------------------
// Height parsing
// -----------------------------------------------------------
// Building heights
function parseHeight(tags) {
    /** Parse building height and min_height if available. */
    function safeFloat(value) {
        try {
            return parseFloat(value.toLowerCase().replace("m", "").trim());
        } catch {
            return null;
        }
    }

    let height = safeFloat(tags.height ?? "");
    let minHeight = safeFloat(tags.min_height ?? tags["building:min_height"] ?? "");
    let levels = safeFloat(tags["building:levels"] ?? "");
    let minLevels = safeFloat(tags["building:min_level"] ?? "");

    // height if missing
    if (height === null && levels !== null) height = levels * 3.0;
    if (minHeight === null && minLevels !== null) minHeight = minLevels * 3.0;

    // Fallbacks - check for heights
    if (height === null) height = "building" in tags ? 10.0 : 0.0;
    if (minHeight === null) minHeight = 0.0;

    return {
        height,
        min_height: minHeight,
        effective_height: Math.max(0.0, height - minHeight) // USE THIS FOR HEIGHT ON MAP
    };
}

// -----------------------------------------------------------
// OSM extraction
// -----------------------------------------------------------
function extractElements(osmJson) {
    /**
     * Extract all 'way' elements from full JSON
     * node coordinates into lat/lon points.
     * Returns a list of objects like:
     * { points: [...], tags: {...}, type: 'way' }
     * You can filter by tag (e.g. 'building', 'highway')
     */
    const elements = osmJson.elements || [];
    const nodes = Object.fromEntries(elements.filter(n => n.type === "node").map(n => [n.id, n]));

    const extracted = [];
    for (const el of elements) {
        if (el.type === "way") {
            const points = el.nodes?.map(nid => nodes[nid] && ({ lat: nodes[nid].lat, lon: nodes[nid].lon })).filter(Boolean);
            if (points?.length) {
                extracted.push({
                    points,
                    tags: el.tags ?? {},
                    id: el.id,
                    type: el.type
                });
            }
        }
    }
    return extracted;
}

function isBuilding(element) {
    // True if element is a building (has 'building' tag)
    return "building" in element.tags;
}

// -----------------------------------------------------------
// Processing functions
// -----------------------------------------------------------
function getIconForElement(element, iconMap) {
    /**
     * Assign an icon based on tags:
     * - Recreational amenities get generic recreational icon
     * - Other amenities use value-specific icons if available, otherwise default
     * - Natural uses one generic icon
     * - Emergency uses value-specific icons
     * - Other keys use default per key or global fallback
     */
    const tags = element.tags || {};

    for (const [key, value] of Object.entries(tags)) {
        // --- Amenity ---
        if (key === "amenity") {
            const recreationList = [
                "bar", "bbq", "brothel", "cafe", "cinema", "food_court",
                "marketplace", "nightclub", "restaurant", "swinger_club",
                "theatre", "vending_machine"
            ];
            if (recreationList.includes(value)) return iconMap.amenity[value] ?? iconMap.amenity._default;
            return iconMap.amenity[value] ?? iconMap.amenity._default;
        }

        // --- Emergency ---
        if (key === "emergency") return iconMap.emergency[value] ?? iconMap.emergency._default;

        // --- Natural ---
        if (key === "natural") return iconMap.natural._default;

        // --- Other keys ---
        if (key in iconMap) return iconMap[key]._default ?? iconMap._global_default._default;
    }

    // --- Global fallback ---
    return iconMap._global_default._default;
}

async function processElement(element, iconMap) {
    /** Compute center, elevation, and height (if any). */
    const lat = element.points.reduce((acc, p) => acc + p.lat, 0) / element.points.length;
    const lon = element.points.reduce((acc, p) => acc + p.lon, 0) / element.points.length;
    const baseElev = await getElevation(lat, lon);

    const heightInfo = isBuilding(element) ? parseHeight(element.tags) : {
        height: 0.0,
        min_height: 0.0,
        effective_height: 0.0 // USE THIS
    };

    const icon = getIconForElement(element, iconMap);
    const xy = lonLatToMeters(lon, lat);

    return {
        id: element.id,
        points: element.points,
        centroid: { lat, lon },
        xy, // this is the coordinates to use on the map
        base_elev: baseElev,
        ...heightInfo,
        tags: element.tags,
        icon
    };
}

// -----------------------------------------------------------
// Main entry point
// -----------------------------------------------------------
async function getOsmJson(lat, lon, radius = 500) {
    // radius = 500 is the default, can be overwritten by passing a different value
    const overpassUrl = "https://overpass-api.de/api/interpreter";
    const query = `
        [out:json];
        (
          node(around:${radius},${lat},${lon});
          way(around:${radius},${lat},${lon});
          relation(around:${radius},${lat},${lon});
        );
        out body;
        >;
        out skel qt;
    `;

    const response = await fetch(overpassUrl, {
        method: "POST", // Overpass API expects POST for queries
        body: query
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
}


async function processOsmJson(jsonString) {
    /**
     * Process a full OSM JSON string.
     * Returns a unified list of all elements, each with:
     * - id, points, center, xy, base_elev
     * - height/min_height/effective_height (if any)
     * - tags
     */
    const osmData = JSON.parse(jsonString);
    const allElements = extractElements(osmData);
    const processed = [];
    for (const el of allElements) {
        processed.push(await processElement(el, ICON_MAP));
    }
    return processed;
}

// -----------------------------------------------------------
// ICON_MAP
// -----------------------------------------------------------
async function loadOsmFeaturesAt(lat, lon, radius = 500) {
  try {
    // Fetch OSM data near the clicked location
    const osmJson = await getOsmJson(lat, lon, radius);
    const jsonString = JSON.stringify(osmJson);

    // Process it into usable structures
    const elements = await processOsmJson(jsonString);

    // Add markers for each
    for (const el of elements) {
      if (el.icon && el.centroid) {
        addIconMarker(el.centroid.lat, el.centroid.lon, el.icon, 0.08);
      }
    }

    console.log(`Placed ${elements.length} OSM icons near (${lat}, ${lon})`);
  } catch (err) {
    console.error("Failed to load OSM features:", err);
  }
}

let iconMarkers = [];

function addIconMarker(lat, lon, elevation, imageUrl) {
  const EARTH_RADIUS = 6371000; // meters

  // Convert lat/lon/elev → XYZ
  const radius = EARTH_RADIUS + elevation;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  const x = radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);

  // Create a sprite for the icon
  const texture = new THREE.TextureLoader().load(imageUrl);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);

  // Scale & position
  sprite.scale.set(10000, 10000, 1);
  sprite.position.set(x, y, z);

  scene.add(sprite);
  iconMarkers.push(sprite);
  return sprite;
}

function clearIconMarkers() {
  for (const marker of iconMarkers) {
    scene.remove(marker);
    marker.geometry?.dispose(); // clean up geometry if needed
    marker.material?.dispose(); // clean up material if needed
  }
  iconMarkers = []; // reset the array
}


const ICON_MAP = {
    "amenity": { 
        "bar": "icons/amenity_recreational.svg",
        "bbq": "icons/amenity_recreational.svg",
        "brothel": "icons/amenity_recreational.svg",
        "cafe": "icons/amenity_recreational.svg",
        "cinema": "icons/amenity_recreational.svg",
        "food_court": "icons/amenity_recreational.svg",
        "marketplace": "icons/amenity_recreational.svg",
        "nightclub": "icons/amenity_recreational.svg",
        "restaurant": "icons/amenity_recreational.svg",
        "swinger_club": "icons/amenity_recreational.svg",
        "theatre": "icons/amenity_recreational.svg",
        "vending_machine": "icons/amenity_recreational.svg",
        "bicycle_parking": "icons/amenity_vehicle.svg",
        "bicycle_rental": "icons/amenity_vehicle.svg",
        "car_rental": "icons/amenity_vehicle.svg",
        "car_sharing": "icons/amenity_vehicle.svg",
        "fuel": "icons/amenity_vehicle.svg",
        "parking": "icons/amenity_vehicle.svg",
        "charging_station": "icons/amenity_charging_station.svg",
        "clinic": "icons/health.svg",
        "dentist": "icons/health.svg",
        "doctors": "icons/health.svg",
        "hospital": "icons/health.svg",
        "pharmacy": "icons/health.svg",
        "college": "icons/amenity_education.svg",
        "kindergarten": "icons/amenity_education.svg",
        "school": "icons/amenity_education.svg",
        "courthouse": "icons/amenity_public_building.svg",
        "fire_station": "icons/emergency_fire_station.svg",
        "police": "icons/emergency_police.svg",
        "ferry_terminal": "icons/amenity_ferry_terminal.svg",
        "grave_yard": "icons/amenity_grave_yard.svg",
        "library": "icons/amenity_library.svg",
        "place_of_worship": "icons/amenity_place_of_worship.svg",
        "post_box": "icons/amenity_post.svg",
        "post_office": "icons/amenity_post.svg",
        "prison": "icons/amenity_prison.svg",
        "public_building": "icons/amenity_public_building.svg",
        "recycling": "icons/amenity_recycling.svg",
        "shelter": "icons/amenity_shelter.svg",
        "taxi": "icons/amenity_taxi.svg",
        "telephone": "icons/amenity_telephone.svg",
        "toilets": "icons/amenity_toilets.svg",
        "townhall": "icons/amenity_public_building.svg",
        "drinking_water": "icons/water.svg",
        "water_point": "icons/water.svg",
        "_default": "icons/amenity.svg"
    },
    "natural": { "_default": "icons/natural.svg" },
    "emergency": {
        "ambulance_station": "icons/emergency_ambulance_station.svg",
        "fire_station": "icons/emergency_fire_station.svg",
        "lifeguard_station": "icons/emergency_lifeguard_station.svg",
        "police": "icons/emergency_police.svg",
        "first_aid": "icons/emergency_first_aid.svg",
        "defibrillator": "icons/emergency_first_aid.svg",
        "assembly_point": "icons/emergency_assembly_point.svg",
        "_default": "icons/emergency.svg"
    },
    "aerialway":   { "_default": "icons/aerialway.svg" },
    "aeroway":     { "_default": "icons/aerialway.svg" },
    "barrier":     { "_default": "icons/barrier.svg" },
    "boundary":    { "_default": "icons/barrier.svg" },
    "building":    { "_default": "icons/building.svg" },
    "craft":       { "_default": "icons/craft.svg" },
    "geological":  { "_default": "icons/geological.svg" },
    "healthcare":  { "_default": "icons/health.svg" },
    "highway":     { "_default": "icons/highway.svg" },
    "historic":    { "_default": "icons/historic.svg" },
    "landuse":     { "_default": "icons/landuse.svg" },
    "leisure":     { "_default": "icons/leisure.svg" },
    "man_made":    { "_default": "icons/man_made.svg" },
    "military":    { "_default": "icons/military.svg" },
    "office":      { "_default": "icons/office.svg" },
    "place":       { "_default": "icons/place.svg" },
    "power":       { "_default": "icons/power.svg" },
    "public_transport": { "_default": "icons/public_transport.svg" },
    "railway":     { "_default": "icons/route.svg" },
    "route":       { "_default": "icons/route.svg" },
    "shop":        { "_default": "icons/shop.svg" },
    "telecom":     { "_default": "icons/telecom.svg" },
    "tourism":     { "_default": "icons/tourism.svg" },
    "water":       { "_default": "icons/water.svg" },
    "waterway":    { "_default": "icons/water.svg" },
    "_global_default": { "_default": "icons/default.svg" }
};