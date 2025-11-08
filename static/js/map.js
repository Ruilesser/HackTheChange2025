// map.js - module that builds a Three.js globe and supports markers
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.158.0/examples/jsm/loaders/GLTFLoader.js';

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

// globe/model
const RADIUS = 1; // we will normalize the GLB to this radius
let globe = null;
let modelScaledRadius = RADIUS; // radius after scaling model to RADIUS

const loader = new GLTFLoader();
const modelPath = '/static/assets/models/Earth_1_12756.glb';

loader.load(
  modelPath,
  (gltf) => {
    const obj = gltf.scene || gltf.scenes[0];
    // compute bounding sphere of the imported model
    const bbox = new THREE.Box3().setFromObject(obj);
    const bs = bbox.getBoundingSphere(new THREE.Sphere());
    const currentRadius = bs.radius || 1;

    // compute scale factor to normalize to our RADIUS
    const s = RADIUS / currentRadius;
    obj.scale.setScalar(s);

    // center the model to origin (optional, helps if model isn't centered)
    const center = bs.center.clone().multiplyScalar(-s);
    obj.position.add(center);

    globe = obj;
    modelScaledRadius = RADIUS; // after scaling, radius is RADIUS
    scene.add(globe);
  },
  undefined,
  (err) => {
    console.error('Failed to load GLB model', err);
    // fallback: simple sphere so page still works
    const sphereGeo = new THREE.SphereGeometry(RADIUS, 64, 64);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 1 });
    globe = new THREE.Mesh(sphereGeo, mat);
    scene.add(globe);
  }
);

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

function clearFeatures() {
  featurePoints.clear();
  featureLines.clear();
  countryBorders.clear();
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
}

animate();

// fetch and render country borders once (simplified)
fetchCountries(0.2);
