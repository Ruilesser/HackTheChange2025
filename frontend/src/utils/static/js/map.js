// map.js - module that builds a Three.js globe and supports markers
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';
//import { GoogleGenerativeAI } from "@google/generative-ai";

async function callGeminiAPI(prompt) {
    const API_KEY = "AIzaSyBQ7eKuefURDF7CA7mhT4Oe_ntu2ruLiMk";
    
    // Updated endpoint for newer Gemini models
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`;
    
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 2048,
                }
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Response error:', errorText);
            throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        // Check if the response structure is as expected
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            console.error('Unexpected API response structure:', data);
            throw new Error('Unexpected API response structure');
        }
        
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Gemini API call failed:', error);
        throw error;
    }
}


// Remove the duplicate AIService class definition (the second one around line 400)
// Keep only this one:
class AIService {
  constructor() {
    this.apiKey = "AIzaSyBQ7eKuefURDF7CA7mhT4Oe_ntu2ruLiMk";
  }

  async submit(data, timeout = 30000) { // Increased timeout for longer responses
    try {
      const prompt = `You are an advanced urban planning, sustainability, and community-development analysis model. You produce formal, narrative, human-readable reports, written for community leaders, municipal planners, and urban development authorities. You must never output JSON, code, bullet-free raw data dumps, or any machine-formatted structure. Your output must always be a coherent, multi-section written report in professional planning language. You will analyze this JSON consisting of restaurants, hospitals, and other amenities and services, and in turn you will give recommendations for improving urban planning, sustainability, and community development based on the data provided. Your report must be at least 500 words long and cover multiple aspects of urban planning and community development. Here is the data: ${JSON.stringify(data)}`;

      return await callGeminiAPI(prompt);
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      throw error;
    }
  }
}

// Then use it like this in the locate-me handler:
setTimeout(() => {
  const allData = passAllDataTo(async (data) => {
    const aiService = new AIService();
    try {
      const result = await aiService.submit(data);
      console.log('AI Analysis completed:', result);
      // Display or process the result
    } catch (error) {
      console.error('AI Analysis failed:', error);
    }
  });
}, 2000);

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

// debug overlay (shows sub-satellite, simplify, cooldown)
const debugOverlay = document.createElement('div');
debugOverlay.id = 'debug-overlay';
debugOverlay.style.position = 'absolute';
debugOverlay.style.left = '8px';
debugOverlay.style.bottom = '8px';
debugOverlay.style.padding = '6px 8px';
debugOverlay.style.background = 'rgba(0,0,0,0.6)';
debugOverlay.style.color = '#9fc';
debugOverlay.style.font = '12px monospace';
debugOverlay.style.zIndex = 9999;
debugOverlay.style.pointerEvents = 'none';
debugOverlay.innerHTML = '';
container.appendChild(debugOverlay);

function passAllDataTo(targetFunction) {
  const allData = {
    timestamp: Date.now(),
    osmData: window.lastOsmData, // You'd need to store this
    countryData: window.lastCountryData, // Store this too
    iconData: window.lastIconData,
    viewState: {
      lat: getSubSatelliteLatLon().lat,
      lon: getSubSatelliteLatLon().lon,
      zoom: camera.position.length()
    }
  };
  
  if (typeof targetFunction === 'function') {
    targetFunction(allData);
  }
  
  return allData;
}


// Function to pass all acquired data to any other function
function useAcquiredData(callback) {
  if (typeof callback === 'function') {
    const allData = {
      osm: lastOsmData,
      countries: lastCountryData,
      icons: lastIconData,
      metadata: {
        timestamp: Date.now(),
        osmFeatureCount: lastOsmData?.features?.length || 0,
        countryFeatureCount: lastCountryData.length,
        viewState: getSubSatelliteLatLon()
      }
    };
    callback(allData);
  }
  return {
    osm: lastOsmData,
    countries: lastCountryData,
    icons: lastIconData
  };
}

// Observer culling toggle (controls both client-side culling and whether
// we send an observer_lat/observer_lon to server endpoints). Default: disabled.
// Set false so features are rendered by default (no client/server culling)
// unless the user explicitly enables it.
let observerCullingEnabled = false;
const observerCullingToggleEl = document.getElementById('toggle-observer-culling');
if (observerCullingToggleEl) {
  try {
    observerCullingEnabled = !!observerCullingToggleEl.checked;
    observerCullingToggleEl.addEventListener('change', (ev) => {
      observerCullingEnabled = !!ev.target.checked;
      setStatus(`Observer culling ${observerCullingEnabled ? 'enabled' : 'disabled'}`, 'info', 2000);
    });
  } catch (e) { /* ignore UI hookup errors */ }
}

// Enable verbose logging for country outline streaming when debugging
const DEBUG_COUNTRY_STREAM = true;

// Toggle polygon simplification. Set false to disable simplifying polygons
// client-side and request full-precision outlines from the server.
const POLYGON_SIMPLIFICATION_ENABLED = false;

// OSM / elevation controls
let lastOsmElementsCount = 0; // number of elements in last OSM payload
let lastIconRequestTime = 0;
let currentOverpassController = null;
let currentIconRequestController = null;
// Add these with your other global variables at the top
let lastOsmData = null;
let lastCountryData = [];
let lastIconData = null;

const MIN_ICON_REQUEST_INTERVAL = 2000; // 2 seconds between icon requests
//const ELEVATION_ENABLED = true; // set false to disable elevation lookups entirely
//const ELEVATION_BATCH_THRESHOLD = 5000; // skip per-element elevation if payload larger than this
// maximum radius (meters) for fetching detailed OSM icons — prevents huge requests
const ICON_OSM_RADIUS_MAX = 300;
const OVERPASS_MAX_RADIUS = 2000;
const OVERPASS_SPLIT_THRESHOLD = 800; // Lower threshold to split earlier

// debug overlay updater (throttled)
let lastDebugUpdate = 0;
const DEBUG_UPDATE_MS = 500;
function updateDebugOverlay() {
  try {
    const sub = getSubSatelliteLatLon() || { lat: null, lon: null };
    let latStr = '-';
    let lonStr = '-';
    if (sub && typeof sub.lat === 'number') latStr = sub.lat.toFixed(4);
    if (sub && typeof sub.lon === 'number') lonStr = sub.lon.toFixed(4);
    // compute radius/simplify for display
    let targetVec = null;
    if (sub && sub.lat !== null && sub.lon !== null) targetVec = latLonToVector3(sub.lat, sub.lon, modelScaledRadius || RADIUS);
    else targetVec = controls.target.clone();
    const dist = camera.position.distanceTo(targetVec);
    const radius = cameraDistanceToRadius(dist);
    const simplify = computeSimplifyForRadius(radius);
    const cooldownRem = Math.max(0, (overpassCooldownUntil || 0) - Date.now());
    const pendingCount = countryBordersPending ? countryBordersPending.children.length : 0;
    const bordersCount = countryBorders ? countryBorders.children.length : 0;
    debugOverlay.innerHTML =
      `<div style="line-height:1.2">
         <strong>sub</strong>: ${latStr}, ${lonStr}<br>
         <strong>radius</strong>: ${radius} m<br>
         <strong>simplify</strong>: ${simplify.toFixed(3)}<br>
         <strong>cooldown</strong>: ${Math.ceil(cooldownRem/1000)}s<br>
         <strong>inFlight</strong>: ${inFlightOverpassRequests}<br>
         <strong>pendingBorders</strong>: ${pendingCount}<br>
         <strong>currentBorders</strong>: ${bordersCount}
       </div>`;
  } catch (e) {
    // don't let overlay errors break render loop
  }
}

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
// current rendered country borders group (swapped on each successful stream)
let countryBorders = new THREE.Group();
// pending group used while streaming; created per-stream
let countryBordersPending = null;
scene.add(featurePoints);
scene.add(featureLines);
scene.add(countryBorders);

// Overpass rate-limit / cooldown handling
let overpassCooldownUntil = 0; // ms timestamp until which we should not issue new Overpass requests
const OVERPASS_COOLDOWN_DEFAULT_MS = 60 * 1000; // 60s cooldown on 429
function inOverpassCooldown() { return Date.now() < (overpassCooldownUntil || 0); }

// stream idle read timeout (ms): if no chunk arrives within this window, cancel the stream
const OVERPASS_STREAM_IDLE_MS = 12000;

// Throttle / concurrency controls to avoid spamming Overpass
let lastOverpassRequestAt = 0;
const MIN_OVERPASS_INTERVAL_MS = 1200; // minimum time between starting requests
let inFlightOverpassRequests = 0;
const MAX_CONCURRENT_OVERPASS = 1;
let pendingOverpassTimer = null;

// simple in-memory cache to avoid re-requesting recently fetched tiles/areas
const overpassCache = new Map(); // key -> { ts, ttlMs }
const OVERPASS_CACHE_TTL_MS = 60 * 1000; // 60s

function makeOverpassCacheKey(lat, lon, radius) {
  // coarse grid to group nearby requests
  const latKey = (Math.round(lat * 20) / 20).toFixed(3); // 0.05 deg bins
  const lonKey = (Math.round(lon * 20) / 20).toFixed(3);
  const rKey = Math.round(radius / 200) * 200; // 200m buckets
  return `${latKey}:${lonKey}:${rKey}`;
}

// Clear the Overpass cache to force fresh requests
function clearOverpassCache() {
  overpassCache.clear();
  console.log('Overpass cache cleared');
}

function scheduleOverpassFetch(lat, lon, radius) {
  // if in cooldown, skip
  if (inOverpassCooldown()) {
    setStatus('Overpass cooldown active — delaying request', 'error', 3000);
    return;
  }
  const key = makeOverpassCacheKey(lat, lon, radius);
  const cached = overpassCache.get(key);
  if (cached && (Date.now() - cached.ts) < (cached.ttlMs || OVERPASS_CACHE_TTL_MS)) {
    // recently fetched — skip
    console.debug('Using cached Overpass key', key);
    return;
  }

  const tryStart = () => {
    const now = Date.now();
    if (inFlightOverpassRequests >= MAX_CONCURRENT_OVERPASS) {
      // retry after a short delay
      pendingOverpassTimer = setTimeout(tryStart, 400);
      return;
    }
    const since = now - (lastOverpassRequestAt || 0);
    if (since < MIN_OVERPASS_INTERVAL_MS) {
      pendingOverpassTimer = setTimeout(tryStart, MIN_OVERPASS_INTERVAL_MS - since + 50);
      return;
    }
    // mark and start
    inFlightOverpassRequests++;
    lastOverpassRequestAt = now;
    // mark cache immediately to avoid duplicate parallel attempts
    overpassCache.set(key, { ts: now, ttlMs: OVERPASS_CACHE_TTL_MS });
    // call the fetch
    fetchOverpass(lat, lon, radius)
      .catch(err => console.warn('fetchOverpass error', err))
      .finally(() => { inFlightOverpassRequests = Math.max(0, inFlightOverpassRequests - 1); });
  };

  // schedule immediate attempt
  if (pendingOverpassTimer) { clearTimeout(pendingOverpassTimer); pendingOverpassTimer = null; }
  pendingOverpassTimer = setTimeout(tryStart, 0);
}

// Sprite-based labels (Three.js) for performance and consistent scaling
const spriteLabels = []; // array of sprites
// index to deduplicate labels by name or centroid key -> sprite
const spriteLabelIndex = new Map();
// icon markers (sprites/meshes) placed for OSM features — declared early to avoid TDZ
let iconMarkers = [];

// Clear only OSM feature layers (keep country borders and labels intact)
function clearFeatures() {
  featurePoints.clear();
  featureLines.clear();
}

// Clear everything including country borders and label sprites
function clearAllFeatures() {
  featurePoints.clear();
  featureLines.clear();
  // dispose and reset country borders as this is an explicit full-clear
  try { disposeCountryGroup(countryBorders); } catch (e) { countryBorders.clear(); }
  countryBorders = new THREE.Group();
  scene.add(countryBorders);
  // remove sprite labels from scene
  for (const s of spriteLabels) {
    try { scene.remove(s); } catch (e) { /* ignore */ }
    if (s.material && s.material.map) s.material.map.dispose();
    if (s.material) s.material.dispose();
  }
  spriteLabels.length = 0;
  spriteLabelIndex.clear();
}

// Dispose geometries/materials/textures in a country borders group
function disposeCountryGroup(group) {
  if (!group) return;
  try {
    for (const child of group.children) {
      try {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            for (const m of child.material) {
              if (m.map) m.map.dispose();
              m.dispose && m.dispose();
            }
          } else {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose && child.material.dispose();
          }
        }
      } catch (e) { /* ignore per-child errors */ }
    }
    // remove children
    group.clear();
    try { scene.remove(group); } catch (e) {}
  } catch (e) { /* ignore */ }
}

// Swap the active country borders with a new group (dispose old group)
function swapCountryBorders(newGroup) {
  if (!newGroup) return;
  try {
    // remove old
    try { disposeCountryGroup(countryBorders); } catch (e) { /* ignore */ }
    countryBorders = newGroup;
    scene.add(countryBorders);
    countryBordersPending = null;
  } catch (e) {
    console.warn('swapCountryBorders failed', e);
  }
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

function renderCountryLine(coords, color = 0xffffff, width = 1, targetGroup = countryBorders) {
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
  // add to provided group (pending or current)
  try {
    (targetGroup || countryBorders).add(line);
  } catch (e) {
    // fallback to main group
    countryBorders.add(line);
  }
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
    if (!geo || !geo.features) {
      console.warn('fetchCountries: server returned no features');
      return;
    }
    // Store received data for diagnostics and other consumers
    try { lastCountryData = geo.features.slice(); } catch (e) { lastCountryData = []; }

    // Build a new group and render all features into it, then swap it in place
    const newGroup = new THREE.Group();

    console.info(`fetchCountries: received ${geo.features.length} features`);
    // log sample of feature types for diagnostics
    try {
      const types = {};
      for (let i = 0; i < Math.min(30, geo.features.length); i++) {
        const t = (geo.features[i].geometry && geo.features[i].geometry.type) || 'none';
        types[t] = (types[t] || 0) + 1;
      }
      console.debug('fetchCountries: sample feature types', types);
    } catch (e) {}

    // Counters for diagnostics
    let counts = { LineString: 0, MultiLineString: 0, Polygon: 0, MultiPolygon: 0, GeometryCollection: 0, other: 0 };
    function renderGeometry(g, targetGroup) {
      if (!g || !g.type) return;
      try {
        if (g.type === 'LineString') {
          renderCountryLine(g.coordinates, 0xffffff, 1, targetGroup);
          counts.LineString++;
        } else if (g.type === 'MultiLineString') {
          for (const part of g.coordinates) renderCountryLine(part, 0xffffff, 1, targetGroup);
          counts.MultiLineString++;
        } else if (g.type === 'Polygon') {
          // render exterior and optionally interior rings
          if (Array.isArray(g.coordinates) && g.coordinates.length > 0) {
            renderCountryLine(g.coordinates[0], 0xffffff, 1, targetGroup);
            // render holes as subtler lines to aid debugging
            for (let i = 1; i < g.coordinates.length; i++) renderCountryLine(g.coordinates[i], 0x666666, 1, targetGroup);
          }
          counts.Polygon++;
        } else if (g.type === 'MultiPolygon') {
          for (const poly of g.coordinates) {
            if (poly && poly[0]) renderCountryLine(poly[0], 0xffffff, 1, targetGroup);
            for (let i = 1; poly && i < poly.length; i++) renderCountryLine(poly[i], 0x666666, 1, targetGroup);
          }
          counts.MultiPolygon++;
        } else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
          counts.GeometryCollection++;
          for (const sg of g.geometries) renderGeometry(sg, targetGroup);
        } else {
          counts.other++;
        }
      } catch (e) {
        console.warn('fetchCountries.renderGeometry failed', e);
      }
    }

    for (const f of geo.features) {
      if (!f || !f.geometry) continue;
      renderGeometry(f.geometry, newGroup);
    }

    console.debug('fetchCountries: geometry counts', counts);

    // Swap the new group into place (this disposes the previous one)
    try {
      swapCountryBorders(newGroup);
    } catch (e) {
      // Fallback: add it manually if swap fails
      try {
        disposeCountryGroup(countryBorders);
      } catch (er) {}
      countryBorders = newGroup;
      scene.add(countryBorders);
    }
  } catch (e) {
    console.error('Error fetching countries', e);
  }
}

// New: stream country outlines (NDJSON) and render incrementally.
async function fetchCountriesStream({ bbox=null, lat=null, lon=null, radius=null, simplify=0.1 } = {}) {
  lastCountryData = [];
  // when fetching countries we want to clear only OSM feature layers (points/lines)
  // but keep current country outlines until the new stream completes to avoid
  // an abrupt visual clear. We'll stream into `countryBordersPending` and
  // swap when the stream finishes successfully.
  // avoid concurrent streams
  if (countryStreamInProgress) {
    console.debug('fetchCountriesStream: stream already in progress; skipping new request');
    return;
  }
  countryStreamInProgress = true;
  clearFeatures();
  if (countryBordersPending) {
    // dispose any leftover pending group
    disposeCountryGroup(countryBordersPending);
    countryBordersPending = null;
  }
  countryBordersPending = new THREE.Group();
  // build query string
  const params = new URLSearchParams();
  params.set('simplify', String(simplify));
  if (bbox) params.set('bbox', bbox);
  else if (lat !== null && lon !== null && radius !== null) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
    params.set('radius', String(radius));
  }

  // include observer (sub-satellite point computed from camera) so server can perform hemisphere/backface culling
  try {
    if (observerCullingEnabled) {
      const centerLatLon = getSubSatelliteLatLon();
      if (centerLatLon && typeof centerLatLon.lat === 'number') {
        params.set('observer_lat', String(centerLatLon.lat));
        params.set('observer_lon', String(centerLatLon.lon));
      }
    }
  } catch (e) {
    // ignore
  }

  let res;
  try {
    res = await fetch(`/api/countries_stream?${params.toString()}`);
  } catch (e) {
    console.warn('Countries stream fetch failed', e);
    setStatus('Failed to fetch country outlines', 'error', 8000);
    countryStreamInProgress = false;
    return;
  }
  if (!res.ok) {
    const txt = await res.text();
    console.warn('Countries stream failed', txt);
    setStatus('Failed to load country outlines from server', 'error', 8000);
    countryStreamInProgress = false;
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

      if (obj.geometry && (obj.geometry.type === 'LineString' || obj.geometry.type === 'MultiLineString')) {
        lastCountryData.push(obj);
      }

      // expect feature with geometry LineString/MultiLineString
      const geom = obj.geometry;
      if (!geom) continue;
      if (DEBUG_COUNTRY_STREAM) {
        try {
          console.debug('countries_stream: parsed feature', { type: geom.type, props: obj.properties && Object.keys(obj.properties).slice(0,5) });
        } catch (e) {}
      }
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
        const dot = toPoint.dot(camDir);
        const inFrustum = frustum.containsPoint(worldPos);
        if (DEBUG_COUNTRY_STREAM) {
          console.debug('countries_stream: cull-check', { repLat, repLon, dot, inFrustum });
        }
        // Apply lightweight client-side culling only when enabled. When disabled,
        // we'll keep all streamed segments so the server-side culling (if any)
        // or a full dataset can be displayed.
        if (observerCullingEnabled) {
          if (dot <= 0) continue; // behind globe
          // frustum test: skip if outside view frustum
          if (!inFrustum) continue;
        }
      }
      if (geom.type === 'LineString') {
        renderCountryLine(geom.coordinates, 0xffffff, 1, countryBordersPending);
        addedCountryGeoms++;
        if (DEBUG_COUNTRY_STREAM && addedCountryGeoms <= 20) console.debug('countries_stream: added segment', { idx: addedCountryGeoms, points: geom.coordinates.length });
        if (addedCountryGeoms % 40 === 0) setStatus(`Loading country outlines… ${addedCountryGeoms} segments rendered`, 'loading', null);
      } else if (geom.type === 'MultiLineString') {
        for (const part of geom.coordinates) {
          renderCountryLine(part, 0xffffff, 1, countryBordersPending);
          addedCountryGeoms++;
          if (DEBUG_COUNTRY_STREAM && addedCountryGeoms <= 20) console.debug('countries_stream: added segment (multi)', { idx: addedCountryGeoms, points: part.length });
        }
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
          const passesCull = observerCullingEnabled ? (toPoint.dot(camDir) > 0 && frustum.containsPoint(worldPos)) : true;
          if (passesCull) {
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
  // swap pending borders into view (dispose old borders)
  try {
    if (countryBordersPending && countryBordersPending.children.length > 0) {
      swapCountryBorders(countryBordersPending);
    } else {
      // nothing streamed; dispose pending and fall back to a full (non-stream) request
      if (countryBordersPending) { disposeCountryGroup(countryBordersPending); countryBordersPending = null; }
      if (addedCountryGeoms === 0) {
        // Stream returned no segments — try the non-streaming endpoint as a fallback.
        // Request highest detail (simplify=0.0).
        console.warn('countries_stream returned no segments; falling back to full /api/countries');
        try {
          fetchCountries(0.0).catch(err => console.warn('fallback fetchCountries failed', err));
        } catch (e) {
          console.warn('Fallback fetchCountries invocation failed', e);
        }
        // set cooldown to avoid repeated fallback attempts
        countryFetchCooldownUntil = Date.now() + Math.max(COUNTRY_FETCH_COOLDOWN_MS, 2000);
      }
    }
  } catch (e) {
    console.warn('Failed to swap country borders', e);
  } finally {
    countryStreamInProgress = false;
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
  // If simplification has been disabled globally, return full coordinates.
  if (!POLYGON_SIMPLIFICATION_ENABLED) return coords;
  if (!coords || coords.length <= maxPoints) return coords;
  const n = coords.length;
  const step = Math.ceil(n / maxPoints);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(coords[i]);
  if (out[out.length - 1] !== coords[n - 1]) out.push(coords[n - 1]);
  return out;
}
// Preventive splitting function for large areas
// Preventive splitting function for large areas - FIXED VERSION
async function fetchSplitOverpassQueries(lat, lon, radiusMeters, recursionDepth = 0) {
  const MAX_RECURSION_DEPTH = 3;
  
  // Base case: stop recursion if we've gone too deep or radius is small enough
  if (recursionDepth >= MAX_RECURSION_DEPTH || radiusMeters <= 1000) {
    console.log(`Base case reached: depth=${recursionDepth}, radius=${radiusMeters}`);
    await fetchOverpassStream(lat, lon, radiusMeters, recursionDepth);
    return;
  }

  // Calculate split parameters
  const radiusDeg = radiusMeters / 111320;
  const splitRadius = radiusMeters / 3;
  
  console.log(`Splitting ${radiusMeters}m area (depth ${recursionDepth}) into 4 parts of ${splitRadius}m each`);
  
  const splits = [
    { latOffset: -0.15, lonOffset: -0.15, name: 'SW' },
    { latOffset: -0.15, lonOffset: 0.15, name: 'SE' },  
    { latOffset: 0.15, lonOffset: -0.15, name: 'NW' },
    { latOffset: 0.15, lonOffset: 0.15, name: 'NE' }
  ];
  
  let successfulSplits = 0;
  let failedSplits = 0;
  
  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const splitLat = lat + (split.latOffset * radiusDeg);
    const splitLon = lon + (split.lonOffset * radiusDeg);
    
    console.log(`Fetching split ${split.name} at (${splitLat.toFixed(6)}, ${splitLon.toFixed(6)}) with radius ${splitRadius}m`);
    setStatus(`Loading area part ${i + 1}/4...`, 'loading', 3000);
    
    // Add delay between requests
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    try {
      // Recursive call with increased depth counter
      await fetchSplitOverpassQueries(splitLat, splitLon, splitRadius, recursionDepth + 1);
      successfulSplits++;
      console.log(`✓ Split ${split.name} completed successfully`);
    } catch (err) {
      console.warn(`✗ Split query ${split.name} failed:`, err);
      failedSplits++;
    }
  }
  
  console.log(`Preventive splitting completed: ${successfulSplits}/4 splits successful, ${failedSplits} failed`);
  if (successfulSplits > 0) {
    setStatus(`Loaded ${successfulSplits} area parts successfully`, 'info', 4000);
  } else if (failedSplits > 0) {
    setStatus('Failed to load area parts - try zooming in closer', 'error', 5000);
  }
}

// Modified fetchOverpassStream with recursion depth parameter
async function fetchOverpassStream(lat, lon, radiusMeters, recursionDepth = 0, timeoutMs = 25000) {
  const MAX_RECURSION_DEPTH = 3;
  
  // Only split if we haven't recursed too deep AND radius is still too large
  if (radiusMeters > OVERPASS_SPLIT_THRESHOLD && recursionDepth < MAX_RECURSION_DEPTH) {
    console.log(`Splitting large radius: ${radiusMeters}m (depth ${recursionDepth})`);
    setStatus('Splitting large area into smaller queries...', 'loading', 5000);
    try {
      await fetchSplitOverpassQueries(lat, lon, radiusMeters, recursionDepth);
      return; // Stop the original large query
    } catch (err) {
      console.error('Split Overpass queries failed:', err);
      setStatus('Failed to load area - try zooming in', 'error', 5000);
      return;
    }
  }
  
  // If we're at max recursion depth but radius is still large, warn and proceed cautiously
  if (radiusMeters > OVERPASS_SPLIT_THRESHOLD && recursionDepth >= MAX_RECURSION_DEPTH) {
    console.warn(`Max recursion depth reached with large radius: ${radiusMeters}m`);
    setStatus('Area very large - loading with reduced detail', 'warning', 4000);
    // Continue with the request but we know it might fail
  }

  // Cancel any ongoing request
  if (currentOverpassController) {
    currentOverpassController.abort();
    console.log('Cancelled previous Overpass request');
  }
  
  currentOverpassController = new AbortController();
  
  clearFeatures();
  const cacheKey = makeOverpassCacheKey(lat, lon, radiusMeters);
  
  const qs = new URLSearchParams({ 
    lat: String(lat), 
    lon: String(lon), 
    radius: String(radiusMeters) 
  });
  
  // attach observer center for server-side culling
  try {
    if (observerCullingEnabled) {
      const centerLatLon = getSubSatelliteLatLon();
      if (centerLatLon && typeof centerLatLon.lat === 'number') {
        qs.set('observer_lat', String(centerLatLon.lat));
        qs.set('observer_lon', String(centerLatLon.lon));
      }
    }
  } catch (e) {}
  
  let res;
  try {
    setStatus('Requesting Overpass stream — waiting for server...', 'loading', null);
    res = await abortableFetch(`/api/overpass_stream?${qs.toString()}`, { 
      method: 'GET',
      signal: currentOverpassController.signal
    }, timeoutMs);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Overpass stream request cancelled during fetch');
      setStatus('Overpass stream cancelled', 'info', 3000);
      return;
    }
    if (err.message && err.message.includes('abort')) {
      setStatus('Overpass stream timed out (server did not respond)', 'error', 8000);
      return;
    }
    setStatus('Overpass stream request failed', 'error', 8000);
    throw err;
  }
  
  if (!res.ok) {
    const txt = await res.text();
    setStatus('Overpass stream request failed (server error)', 'error', 8000);
    
    // handle 429 specially
    if (res.status === 429) {
      overpassCooldownUntil = Date.now() + OVERPASS_COOLDOWN_DEFAULT_MS;
      try { overpassCache.delete(cacheKey); } catch (e) {}
      setStatus('Overpass rate limit reached — pausing requests for 60s', 'error', 8000);
      return;
    }
    throw new Error('Overpass stream failed: ' + txt);
  }
  
  // ... rest of the stream processing code remains the same ...
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let featureCount = 0;
  
  // Client-side culling preparation
  const camDir = new THREE.Vector3(); 
  camera.getWorldDirection(camDir);
  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
  
  // helper to read with idle timeout
  async function readChunkWithTimeout(ms) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('stream-read-timeout')), ms));
    return Promise.race([readPromise, timeoutPromise]);
  }
  
  try {
    while (true) {
      // Check for cancellation
      if (currentOverpassController.signal.aborted) {
        console.log('Overpass stream cancelled during processing');
        await reader.cancel();
        return;
      }
      
      let done, value;
      try {
        const r = await readChunkWithTimeout(OVERPASS_STREAM_IDLE_MS);
        ({ done, value } = r);
      } catch (e) {
        if (currentOverpassController.signal.aborted) {
          console.log('Overpass stream cancelled during chunk read');
          await reader.cancel();
          return;
        }
        // idle timeout or other read error
        console.warn('Overpass stream read idle or error, cancelling:', e && e.message);
        setStatus('No data from Overpass stream — aborting', 'error', 6000);
        await reader.cancel();
        return;
      }
      
      if (done) break;
      
      buf += decoder.decode(value, { stream: true });
      let lines = buf.split('\n');
      buf = lines.pop();
      
      for (const line of lines) {
        if (currentOverpassController.signal.aborted) {
          console.log('Overpass stream cancelled during line processing');
          await reader.cancel();
          return;
        }
        
        if (!line.trim()) continue;
        
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          console.warn('Failed to parse NDJSON line', e, line);
          continue;
        }
        
        // Handle errors and metadata
        if (obj._error) {
          console.warn('Overpass tile error', obj);
          
          if (obj._error.includes('tile') || obj._error.includes('full') || obj._error.includes('too large')) {
            console.warn('Tile map full error detected, clearing cache and suggesting smaller area');
            overpassCache.clear();
            setStatus('Area too dense — try zooming in for more detail', 'error', 6000);
            await reader.cancel();
            return;
          }
          
          // Handle rate limiting
          try {
            const details = String(obj.details || '').toLowerCase();
            if (details.includes('429') || details.includes('too many requests') || details.includes('504') || details.includes('gateway')) {
              overpassCooldownUntil = Date.now() + OVERPASS_COOLDOWN_DEFAULT_MS;
              try { overpassCache.delete(cacheKey); } catch (e) {}
              setStatus('Overpass rate limit or server timeout reached — pausing for 60s', 'error', 8000);
              await reader.cancel();
              return;
            }
          } catch (e) {}
          continue;
        }
        
        if (obj._meta) {
          if (obj._meta && obj._meta.message) {
            setStatus(obj._meta.message, 'loading', null);
          }
          continue;
        }
        
        // Process GeoJSON feature
        const geom = obj.geometry;
        if (!geom) continue;
        
        // Apply client-side culling
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
          if (observerCullingEnabled) {
            if (toPoint.dot(camDir) <= 0) continue;
            if (!frustum.containsPoint(worldPos)) continue;
          }
        }
        
        // Render feature
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
        
        // Update progress
        if (featureCount > 0 && featureCount % 200 === 0) {
          setStatus(`Streaming OSM features… ${featureCount} features received`, 'loading', null);
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name !== 'AbortError') {
      console.error('Error processing Overpass stream:', streamErr);
      setStatus('Error processing Overpass stream', 'error', 6000);
    }
  } finally {
    try { 
      await reader.cancel(); 
    } catch (e) { 
      /* ignore cancellation errors */ 
    }
  }
  
  // Parse final buffer
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
  currentOverpassController = null;
}

// Also update the regular fetchOverpass function to use the same pattern
async function fetchOverpass(lat, lon, radiusMeters) {
  // Cancel any ongoing request
  if (currentOverpassController) {
    currentOverpassController.abort();
    console.log('Cancelled previous Overpass request');
  }
  
  currentOverpassController = new AbortController();
  
  // Check for large radius and split if needed
  if (radiusMeters > OVERPASS_SPLIT_THRESHOLD) {
    console.log('Preventive splitting for large radius:', radiusMeters);
    setStatus('Splitting large area into smaller queries...', 'loading', 5000);
    try {
      await fetchSplitOverpassQueries(lat, lon, radiusMeters, 0);
      return; // Stop the original large query
    } catch (err) {
      console.error('Split Overpass queries failed:', err);
      setStatus('Failed to load area - try zooming in', 'error', 5000);
    }
    return;
  }

  setStatus('Preparing OSM request — computing radius and method...', 'loading', 8000);
  const cacheKey = makeOverpassCacheKey(lat, lon, radiusMeters);
  
  try {
    const qs = new URLSearchParams({ 
      lat: String(lat), 
      lon: String(lon), 
      radius: String(radiusMeters) 
    });
    
    // attach observer center for server-side culling
    try {
      if (observerCullingEnabled) {
        const centerLatLon = getSubSatelliteLatLon();
        if (centerLatLon && typeof centerLatLon.lat === 'number') {
          qs.set('observer_lat', String(centerLatLon.lat));
          qs.set('observer_lon', String(centerLatLon.lon));
        }
      }
    } catch (e) {}
    
    setStatus('Requesting Overpass (synchronous) — waiting for server...', 'loading', 15000);
    
    const res = await abortableFetch(`/api/overpass?${qs.toString()}`, { 
      method: 'GET',
      signal: currentOverpassController.signal 
    }, 25000);
    
    if (!res.ok) {
      // handle rate-limit specially
      if (res.status === 429 || res.status === 504) {
        overpassCooldownUntil = Date.now() + OVERPASS_COOLDOWN_DEFAULT_MS;
        try { overpassCache.delete(cacheKey); } catch (e) {}
        setStatus('Overpass rate limit reached — pausing requests for 60s', 'error', 8000);
        return;
      }
      const txt = await res.text();
      try { overpassCache.delete(cacheKey); } catch (e) {}
      throw new Error('Overpass API request failed: ' + txt);
    }
    
    const geojson = await res.json();
    
    // === ADD THIS: Store the OSM data globally ===
    lastOsmData = geojson;
    console.log('Stored OSM data:', geojson.features?.length || 0, 'features');
    
    // Client-side culling preparation
    const camDir = new THREE.Vector3(); 
    camera.getWorldDirection(camDir);
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    clearFeatures();
    
    // Process features with culling
    for (const feat of geojson.features || []) {
      const geom = feat.geometry;
      if (!geom) continue;
      
      // determine representative lat/lon for culling
      let repLat = null, repLon = null;
      if (feat.properties && feat.properties.centroid && feat.properties.centroid.length >= 2) {
        repLon = parseFloat(feat.properties.centroid[0]);
        repLat = parseFloat(feat.properties.centroid[1]);
      } else {
        const rep = geometryRepresentativeLatLon(geom);
        if (rep) { repLat = rep.lat; repLon = rep.lon; }
      }
      
      // Apply culling if enabled
      if (repLat !== null && repLon !== null) {
        const worldPos = latLonToVector3(repLat, repLon, (modelScaledRadius || RADIUS) + 0.006);
        const toPoint = worldPos.clone().sub(camera.position).normalize();
        if (observerCullingEnabled) {
          if (toPoint.dot(camDir) <= 0) continue; // behind globe
          if (!frustum.containsPoint(worldPos)) continue; // outside view
        }
      }
      
      // Render based on geometry type
      if (geom.type === 'Point') {
        const [lon, lat] = geom.coordinates;
        renderPoint(lat, lon, 0xff5533, 0.02);
      } else if (geom.type === 'LineString') {
        renderLine(geom.coordinates, 0x00ff88);
      } else if (geom.type === 'Polygon') {
        renderPolygon(geom.coordinates, 0x009988);
      }
    }
    
    setStatus(`Loaded ${geojson.features?.length || 0} OSM features`, 'info', 4000);
    
  } catch (err) {
    // Don't log if it was a cancellation
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch/parse Overpass data', err);
      try { overpassCache.delete(cacheKey); } catch (e) {}
      setStatus('Failed to load Overpass data: ' + err.message, 'error', 6000);
    }
  } finally {
    currentOverpassController = null;
  }
}

// Geolocation: center on user's current position
// Modify the locate-me handler to ensure icons load
document.getElementById('locate-me').addEventListener('click', async () => {
  setStatus('Requesting device location…', 'loading', 10000);
  
  if (!navigator.geolocation) {
    setStatus('Geolocation not supported by your browser', 'error', 5000);
    return;
  }
  
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 60000,
        timeout: 10000
      });
    });
    
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    
    // Clear previous data
    clearAllFeatures();
    clearOverpassCache();
    clearIconMarkers();
    lastIconRequestTime = 0;
    lastIconLocationKey = null;
    
    if (currentOverpassController) {
      currentOverpassController.abort();
      currentOverpassController = null;
    }
    
    // Fly to location and load data
    await new Promise((resolve) => {
      flyToLatLon(lat, lon, 3.0, 900, resolve);
    });
    
    // Load OSM data first
    await requestVisibleData(lat, lon, { 
      immediate: true, 
      customRadius: 1000,
      forceIcons: true
    });
    
    // Wait a bit for data to load, then send to AI
    setTimeout(async () => {
      try {
        setStatus('Analyzing location data with AI...', 'loading', 10000);
        
        const allData = passAllDataTo(null); // Get data without immediate callback
        
        if (!allData || (!allData.osmData && !allData.countryData)) {
          setStatus('No data available for AI analysis', 'error', 5000);
          return;
        }
        
        const aiService = new AIService();
        const result = await aiService.submit(allData);
        
        console.log('AI Analysis Result:', result);
        setStatus('AI analysis completed!', 'info', 5000);
        
        // You can display the result in your UI here
        // For example: displayAnalysisResult(result);
        
      } catch (error) {
        console.error('AI Analysis failed:', error);
        setStatus('AI analysis failed - check console for details', 'error', 5000);
      }
    }, 3000);
    
  } catch (error) {
    console.error('Geolocation failed:', error);
    setStatus('Failed to get device location', 'error', 6000);
  }
});

// helpers: convert 3D vector to lat/lon
function vector3ToLatLon(v) {
  const r = v.length() || 1;
  // latitude from asin for numerical stability
  const lat = Math.asin(v.y / r) * (180 / Math.PI);
  // reconstruct longitude from x/z using the same convention as latLonToVector3
  let lon = Math.atan2(v.z, -v.x) * (180 / Math.PI) - 180;
  // normalize longitude to [-180, 180]
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return { lat, lon };
}

// compute the sub-satellite point (latitude/longitude) from the current camera
// by intersecting the camera ray with the globe. Falls back to controls.target
// if there's no intersection (e.g. camera inside the globe).
function getSubSatelliteLatLon() {
  try {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const o = camera.position.clone();
    const d = dir.clone().normalize();
    const R = (modelScaledRadius || RADIUS);
    const od = o.dot(d);
    const oo = o.dot(o);
    const disc = od * od - (oo - R * R);
    if (disc < 0) {
      // no intersection; fall back to controls.target
      const center = controls.target.clone();
      return vector3ToLatLon(center);
    }
    // smallest positive t
    const t = -od - Math.sqrt(disc);
    const point = o.add(d.multiplyScalar(t));
    return vector3ToLatLon(point);
  } catch (e) {
    try { return vector3ToLatLon(controls.target.clone()); } catch (er) { return null; }
  }
}

// map camera distance to Overpass search radius (meters)
function cameraDistanceToRadius(distance) {
  // More conservative mapping to avoid large queries
  const minD = 1.5, maxD = 10;
  const minR = 100, maxR = 800;  // Reduced from 2000 to 800
  const t = Math.min(1, Math.max(0, (distance - minD) / (maxD - minD)));
  // invert so smaller distance => smaller radius
  const v = 1 - t;
  return Math.round(minR + v * (maxR - minR));
}

// compute an appropriate simplification level for country outlines
// larger radius -> larger simplify (coarser). Returned value is a heurisitc
// the server expects a 'simplify' number where larger means more simplification.
function computeSimplifyForRadius(radiusMeters) {
  // When polygon simplification is disabled, request zero simplification
  // from the server (i.e. highest detail) and don't perform client-side
  // reduction of coordinates.
  if (!POLYGON_SIMPLIFICATION_ENABLED) return 0.0;
  const minR = 200, maxR = 10000;
  const t = Math.min(1, Math.max(0, (radiusMeters - minR) / (maxR - minR)));
  // map t in [0,1] -> simplify in [0.05 (detailed), 4.0 (very coarse)]
  const simplify = 0.05 + t * (4.0 - 0.05);
  return simplify;
}

// track last country-outline request to avoid redundant streaming requests
let lastCountriesFetch = { lat: null, lon: null, radius: null, simplify: null };

// Cooldown to avoid repeatedly requesting country outlines after empty streams
const COUNTRY_FETCH_COOLDOWN_MS = 3000; // ms
let countryFetchCooldownUntil = 0;
// Guard to prevent concurrent country-outline streaming
let countryStreamInProgress = false;

function shouldFetchCountries(newLat, newLon, newRadius, newSimplify) {
  // respect a short cooldown if a recent stream returned no segments
  if (Date.now() < (countryFetchCooldownUntil || 0)) return false;
  // don't start a new stream while one is already in progress
  if (countryStreamInProgress) return false;
  if (lastCountriesFetch.lat === null) return true;
  const dLat = Math.abs((lastCountriesFetch.lat || 0) - newLat);
  const dLon = Math.abs((lastCountriesFetch.lon || 0) - newLon);
  const metersMoved = Math.sqrt((dLat * 111320) ** 2 + (dLon * 111320) ** 2);
  // Be less aggressive about suppressing country refreshes. Reduce the
  // movement threshold so outline updates trigger more readily during
  // navigation/zoom. Also consider simplify changes as before.
  const simplifyChanged = lastCountriesFetch.simplify === null ? true : (Math.abs((lastCountriesFetch.simplify || 0) - newSimplify) / (lastCountriesFetch.simplify || 1) > 0.35);
  return metersMoved > 200 || simplifyChanged;
}

/**
 * Centralized request pipeline for visible data (Overpass features, country outlines, icons).
 * Accepts a lat/lon (sub-satellite) or null to use current controls target. Computes radius
 * from camera distance, throttles/uses cache where appropriate, and triggers streaming
 * country outlines and Overpass requests. Also triggers icon loading at high LOD when
 * the requested radius is small enough.
 */
async function requestVisibleData(lat = null, lon = null, options = {}) {
  // determine center lat/lon if not provided
  let centerLat = lat, centerLon = lon;
  if (centerLat === null || centerLon === null) {
    const sub = getSubSatelliteLatLon() || {};
    centerLat = sub.lat; centerLon = sub.lon;
  }

  // build target vector for distance/radius calculation
  let targetVec = null;
  if (typeof centerLat === 'number' && typeof centerLon === 'number') targetVec = latLonToVector3(centerLat, centerLon, modelScaledRadius || RADIUS);
  else targetVec = controls.target.clone();

  const dist = camera.position.distanceTo(targetVec);
  const radius = options.customRadius || cameraDistanceToRadius(dist);

  // Overpass fetch for OSM features (throttled via scheduleOverpassFetch)
  try {
    if (shouldFetch(centerLat, centerLon, radius)) {
      lastFetch = { lat: centerLat, lon: centerLon, radius };
      scheduleOverpassFetch(centerLat, centerLon, radius);
    }
  } catch (e) {
    console.warn('requestVisibleData: overpass scheduling failed', e);
  }

  // Country outlines streaming with computed simplify
  try {
    // Always request highest detail from server (no simplification)
    const simplify = 0.0;
    if (shouldFetchCountries(centerLat, centerLon, radius, simplify)) {
      lastCountriesFetch = { lat: centerLat, lon: centerLon, radius, simplify };
      // Render country outlines all at once (non-segmented) at highest detail
      fetchCountries(0.0).catch(err => console.warn('fetchCountries error', err));
    }
  } catch (e) {
    console.warn('requestVisibleData: country stream failed', e);
  }

  // Icon loading: only when zoomed sufficiently OR forced
  try {
    if (radius <= ICON_OSM_RADIUS_MAX || options.forceIcons) {
      // Reset throttle when forcing icons
      if (options.forceIcons) {
        lastIconRequestTime = 0;
        lastIconLocationKey = null;
      }
      
      // ensure existing icons are cleared (caller may already have cleared)
      clearIconMarkers();
      // load and place icons (this will add sprite markers)
      loadOsmFeaturesAt(centerLat, centerLon, radius).catch(err => {
        console.warn('Failed to load OSM features for icons', err);
        setStatus('Failed to load icons', 'error', 4000);
      });
    } else {
      if (!options || !options.silent) setStatus('Skipping icon load: area too large—zoom in to load icons', 'info', 4000);
    }
  } catch (e) {
    console.warn('requestVisibleData: icon load failed', e);
  }
}

// Update icon sprites/markers each frame so they keep reasonable pixel sizes
function updateIconMarkers() {
  if (!iconMarkers || iconMarkers.length === 0) return;
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  for (const m of iconMarkers) {
    if (!m) continue;
    const wp = m.position || (m.userData && m.userData.worldPos) || null;
    if (!wp) continue;
    const toPoint = wp.clone().sub(camera.position).normalize();
    const facing = toPoint.dot(camDir) > 0.05;
    m.visible = !!facing;
    // scale by distance so icons are legible at different zooms
    const dist = camera.position.distanceTo(wp) || 1;
    const base = m.userData && m.userData.baseScale ? m.userData.baseScale : 0.08;
    const scale = Math.min(Math.max(base * (dist * 0.12), 0.02), 0.3);
    try {
      if (m.type === 'Sprite') m.scale.set(scale, scale, 1);
      else m.scale && m.scale.set && m.scale.set(scale, scale, scale);
      // ensure icon materials respect depthTest so they can be occluded by globe when behind
      if (m.material && typeof m.material.depthTest !== 'undefined') m.material.depthTest = true;
    } catch (e) { /* ignore scale errors */ }
  }
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

// Smooth camera fly-to (animates camera position and controls.target)
function flyToLatLon(lat, lon, distanceFactor = 3.5, duration = 900, onComplete) {
  try {
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const endTarget = latLonToVector3(lat, lon, modelScaledRadius || RADIUS);
    const endCamPos = endTarget.clone().multiplyScalar(distanceFactor);
    const t0 = performance.now();
    function step() {
      const t = Math.min(1, (performance.now() - t0) / duration);
      // easeOutCubic
      const e = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(startPos, endCamPos, e);
      controls.target.lerpVectors(startTarget, endTarget, e);
      controls.update();
      if (t < 1) requestAnimationFrame(step);
      else {
        try { if (typeof onComplete === 'function') onComplete(); } catch (e) { /* ignore */ }
      }
    }
    requestAnimationFrame(step);
  } catch (e) { console.warn('flyToLatLon failed', e); if (typeof onComplete === 'function') onComplete(); }
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
    if (inOverpassCooldown()) {
      const remaining = Math.ceil((overpassCooldownUntil - Date.now()) / 1000);
      setStatus(`Overpass rate limit active — waiting ${remaining}s before retrying`, 'error', 4000);
      return;
    }
    // delegate to unified requester which computes LOD, schedules streaming
    // and optionally fetches icons. This centralizes the fetching logic.
    try {
      const sub = getSubSatelliteLatLon();
      const { lat, lon } = sub || { lat: null, lon: null };
      requestVisibleData(lat, lon);
    } catch (e) {
      console.warn('scheduleFetchForControls: requestVisibleData failed', e);
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
  // update icon sprite scales/visibility to maintain readable size
  updateIconMarkers();

  // compute ms stats
  let avg = 0, min = Infinity, max = 0;
  for (const t of frameTimes) { avg += t; if (t < min) min = t; if (t > max) max = t; }
  const n = frameTimes.length || 1;
  avg = avg / n;
  if (min === Infinity) min = 0;
  // update UI
  fpsCounter.innerHTML = `FPS: ${smoothedFps.toFixed(1)} &nbsp;|&nbsp; frame: ${dt.toFixed(1)} ms<br>avg: ${avg.toFixed(1)} ms (min ${min.toFixed(1)} / max ${max.toFixed(1)})`;
  // throttled debug overlay update
  const nowMs = Date.now();
  if (nowMs - lastDebugUpdate > DEBUG_UPDATE_MS) {
    lastDebugUpdate = nowMs;
    updateDebugOverlay();
  }
}

animate();

// fetch and render country borders via streaming — request only the visible
// hemisphere/area at an appropriate simplification level so we don't pull
// the entire globe at high detail on startup.
// We'll request outlines centered on the current sub-satellite point with
// a simplify value computed from camera radius; scheduleFetchForControls
// will fetch updates as the user moves/zooms.
try {
  const sub = getSubSatelliteLatLon() || { lat: 0, lon: 0 };
  const dist = camera.position.distanceTo(controls.target || new THREE.Vector3());
  const radius = cameraDistanceToRadius(dist);
  const simplify = computeSimplifyForRadius(radius);
    // set lastCountriesFetch so schedule logic can skip redundant requests
    // note: we request full-detail from the server (simplify=0.0)
    lastCountriesFetch = { lat: sub.lat, lon: sub.lon, radius, simplify: 0.0 };
    // Render full country outlines at startup (non-segmented) with highest detail
    fetchCountries(0.0);
} catch (e) {
  // fallback to coarse globe request if something goes wrong
    fetchCountries(0.0);
}

/* TEST ICONS WORK, uncomment this if you want to see test values
setTimeout(() => {
    testIconPlacementAtKnownLocations();
}, 2000); 
//*/

// -----------------------------------------------------------
// Utilities
// -----------------------------------------------------------
function lonLatToMeters(lon, lat) {
    const RADIUS = 6378137.0;  // Earth's radius in meters (WGS84)
    const x = lon * RADIUS * Math.PI / 180.0;
    const y = Math.log(Math.tan((90 + lat) * Math.PI / 360.0)) * RADIUS;
    return { x, y };
}
/*
async function getElevation(lat, lon) {
    // Get elevation (m) for given coordinates using OpenTopoData SRTM90m
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${lat},${lon}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
        return data.results[0].elevation ?? 0.0;
    }
    return 0.0;
} */

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

     /**
     * Extract all 'way' and 'node' elements from full JSON
     * node coordinates into lat/lon points.
     * Returns a list of objects like:
     * { points: [...], tags: {...}, type: 'way' }
     * You can filter by tag (e.g. 'building', 'highway')
     */
function extractElements(osmJson) {
    const elements = osmJson.elements || [];
    const extracted = [];
    
    // Priority categories (in order of importance)
    const priorityCategories = [
        // Emergency & Healthcare (highest priority)
        { tags: ['amenity', 'emergency'], values: ['hospital', 'clinic', 'police', 'fire_station', 'ambulance_station', 'pharmacy'] },
        
        // Public Services & Government
        { tags: ['amenity', 'office', 'building'], values: ['townhall', 'courthouse', 'library', 'post_office', 'government'] },
        
        // Education
        { tags: ['amenity'], values: ['school', 'university', 'college', 'kindergarten'] },
        
        // Transportation
        { tags: ['amenity', 'railway', 'aeroway', 'highway'], values: ['bus_station', 'station', 'terminal', 'bus_stop'] },
        
        // Utilities & Essential Services
        { tags: ['amenity'], values: ['drinking_water', 'toilets', 'charging_station'] },
        
        // Commercial & Food
        { tags: ['amenity', 'shop'], values: ['restaurant', 'cafe', 'supermarket', 'bank'] },
        
        // Tourism & Leisure
        { tags: ['tourism', 'leisure'], values: ['hotel', 'museum', 'park', 'sports_centre'] },
        
        // Religious & Cultural
        { tags: ['amenity', 'historic', 'building'], values: ['place_of_worship', 'monument', 'castle'] }
    ];
    
    // Only process nodes for icons
    for (const el of elements) {
        if (el.type === "node" && el.tags && Object.keys(el.tags).length > 0) {
            // Check if this element matches any priority category
            let isPriority = false;
            let priorityScore = 0;
            
            for (let i = 0; i < priorityCategories.length; i++) {
                const category = priorityCategories[i];
                const categoryPriority = priorityCategories.length - i; // Higher score for more important categories
                
                for (const tag of category.tags) {
                    if (el.tags[tag] && category.values.includes(el.tags[tag])) {
                        isPriority = true;
                        priorityScore = Math.max(priorityScore, categoryPriority);
                        break;
                    }
                }
                if (isPriority) break;
            }
            
            if (isPriority) {
                extracted.push({
                    points: [{ lat: el.lat, lon: el.lon }],
                    tags: el.tags,
                    id: el.id,
                    type: el.type,
                    priority: priorityScore
                });
            }
        }
    }
    
    // Sort by priority (highest first)
    extracted.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    console.log(`Extracted ${extracted.length} priority elements for icons`);
    
    // Log some examples for debugging
    if (extracted.length > 0) {
        console.log('Top priority elements:', extracted.slice(0, 5).map(el => ({
            tags: el.tags,
            priority: el.priority
        })));
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
    
    console.log('Processing element tags for icon:', tags);
    
    // Check each tag in priority order
    if (tags.amenity) {
        const amenityValue = tags.amenity;
        if (iconMap.amenity && iconMap.amenity[amenityValue]) {
            return iconMap.amenity[amenityValue];
        }
        return iconMap.amenity._default;
    }
    
    if (tags.shop) {
        return iconMap.shop._default;
    }
    
    if (tags.tourism) {
        return iconMap.tourism._default;
    }
    
    if (tags.leisure) {
        return iconMap.leisure._default;
    }
    
    if (tags.building) {
        return iconMap.building._default;
    }
    
    if (tags.natural) {
        return iconMap.natural._default;
    }
    
    if (tags.emergency) {
        const emergencyValue = tags.emergency;
        if (iconMap.emergency && iconMap.emergency[emergencyValue]) {
            return iconMap.emergency[emergencyValue];
        }
        return iconMap.emergency._default;
    }
    
    if (tags.office) {
        return iconMap.office._default;
    }
    
    if (tags.historic) {
        return iconMap.historic._default;
    }
    
    if (tags.man_made) {
        return iconMap.man_made._default;
    }
    
    // New tags added
    if (tags.highway) {
        return iconMap.highway._default;
    }
    
    if (tags.military) {
        return iconMap.military._default;
    }
    
    if (tags.aerialway) {
        return iconMap.aerialway._default;
    }
    
    if (tags.aeroway) {
        return iconMap.aeroway._default;
    }
    
    if (tags.power) {
        return iconMap.power._default;
    }
    
    if (tags.public_transport) {
        return iconMap.public_transport._default;
    }
    
    if (tags.water) {
        return iconMap.water._default;
    }
    
    // Skip elements that don't have relevant tags for icons
    console.log('No relevant tags found for icon, skipping element');
    return null;
}

async function processElement(element, iconMap) {
    /**
     * Process a full OSM JSON string.
     * Returns a unified list of all elements, each with:
     * - id, points, center, xy, base_elev
     * - height/min_height/effective_height (if any)
     * - tags
     */
    try {
        // Calculate centroid
        const lat = element.points.reduce((acc, p) => acc + p.lat, 0) / element.points.length;
        const lon = element.points.reduce((acc, p) => acc + p.lon, 0) / element.points.length;
        
    // Get elevation with error handling. Skip expensive elevation lookups for very large OSM payloads.
    let baseElev = 0.0;
    /*
    try {
      if (ELEVATION_ENABLED && lastOsmElementsCount > 0 && lastOsmElementsCount <= ELEVATION_BATCH_THRESHOLD) {
        baseElev = await getElevation(lat, lon);
      } else {
        if (lastOsmElementsCount > ELEVATION_BATCH_THRESHOLD) {
          if (DEBUG_COUNTRY_STREAM) console.warn('Skipping per-element elevation due to large OSM payload', lastOsmElementsCount);
        }
        baseElev = 0.0;
      }
    } catch (elevErr) {
      console.warn(`Elevation API failed for (${lat}, ${lon}):`, elevErr);
      baseElev = 0.0;
    } */
        
        const heightInfo = isBuilding(element) ? parseHeight(element.tags) : {
            height: 0.0,
            min_height: 0.0,
            effective_height: 0.0
        };

        const icon = getIconForElement(element, iconMap);
        const xy = lonLatToMeters(lon, lat);

        return {
            id: element.id,
            points: element.points,
            centroid: { lat, lon },
            xy,
            base_elev: baseElev,
            ...heightInfo,
            tags: element.tags,
            icon,
            type: element.type
        };
    } catch (error) {
        console.error('Error processing element:', element.id, error);
        return null;
    }
}
        // Abortable fetch helper with timeout (ms)
        async function abortableFetch(input, init = {}, timeoutMs = 20000) {
          const controller = new AbortController();
          const signal = controller.signal;
          const id = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(input, Object.assign({}, init, { signal }));
            clearTimeout(id);
            return res;
          } catch (err) {
            clearTimeout(id);
            throw err;
          }
        }

// Test function to verify icons are working
// Test function to verify icons are working by loading actual OSM data
// Test function to verify icons are working by loading actual OSM data
function testIconPlacement() {
  // Clear existing icons
  clearIconMarkers();
  
  // Use known urban coordinates instead of current view
  const testLocations = [
    { lat: 40.7128, lon: -74.0060, name: "New York" },
    { lat: 51.5074, lon: -0.1278, name: "London" },
    { lat: 35.6762, lon: 139.6503, name: "Tokyo" }
  ];
  
  // Test the first location
  const testLocation = testLocations[0];
  const lat = testLocation.lat;
  const lon = testLocation.lon;
  const radius = 500;
  
  console.log(`Testing icon placement at (${lat}, ${lon}) with ${radius}m radius`);
  setStatus(`Loading OSM icons in ${testLocation.name}...`, 'loading', 5000);
  
  // Also fly to the location so you can see the icons
  flyToLatLon(lat, lon, 3.0, 1000, () => {
    // Call the function that loads actual OSM data and places icons
    loadOsmFeaturesAt(lat, lon, radius)
      .then(() => {
        console.log('Test icon placement completed');
        setStatus(`Test completed - loaded OSM icons in ${testLocation.name}`, 'info', 5000);
      })
      .catch(err => {
        console.error('Test icon placement failed:', err);
        setStatus('Test failed - check console for errors', 'error', 5000);
      });
  });
}

// Alternative test function that uses specific known locations
// Alternative test function that uses specific known locations
function testIconPlacementAtKnownLocations() {
  // Clear existing data more thoroughly
  clearAllFeatures();
  clearOverpassCache();
  clearIconMarkers();
  
  // Reset icon throttle
  lastIconRequestTime = 0;
  lastIconLocationKey = null;
  
  // Cancel any ongoing requests
  if (currentOverpassController) {
    currentOverpassController.abort();
    currentOverpassController = null;
  }
  
  // Test at multiple known locations with urban areas
  const testLocations = [
    { lat: 40.7128, lon: -74.0060, name: "New York", radius: 500 },
    { lat: 51.5074, lon: -0.1278, name: "London", radius: 500 },
    { lat: 35.6762, lon: 139.6503, name: "Tokyo", radius: 500 },
    { lat: 48.8566, lon: 2.3522, name: "Paris", radius: 500 }
  ];
  
  console.log('Testing icon placement at multiple known locations');
  setStatus('Loading OSM icons at test locations...', 'loading', 8000);
  
  // Load icons for each test location with delays
  let completed = 0;
  testLocations.forEach((location, index) => {
    setTimeout(() => {
      // Reset throttle for each new location
      lastIconRequestTime = 0;
      lastIconLocationKey = null;
      
      loadOsmFeaturesAt(location.lat, location.lon, location.radius)
        .then(() => {
          completed++;
          console.log(`Completed loading icons for ${location.name}`);
          
          if (completed === testLocations.length) {
            setStatus(`Test completed - loaded OSM icons at ${testLocations.length} locations`, 'info', 5000);
          }
        })
        .catch(err => {
          completed++;
          console.error(`Failed to load icons for ${location.name}:`, err);
          
          if (completed === testLocations.length) {
            setStatus(`Test completed with some errors - check console`, 'error', 5000);
          }
        });
    }, index * 5000); // 5 second delay between requests to ensure throttle doesn't block
  });
}

// Call this to test icon placement
// testIconPlacement();

// -----------------------------------------------------------
// Main entry point
// -----------------------------------------------------------
async function getOsmJson(lat, lon, radius = 300) {
    try {
        if (inOverpassCooldown()) {
            throw new Error('Overpass cooldown active');
        }
        
        const overpassUrl = "https://overpass-api.de/api/interpreter";
        
        // COMPREHENSIVE OPTIMIZED QUERY - All important civic infrastructure
        const query = `
[out:json][timeout:15];
(
  // Healthcare facilities
  node(around:${radius},${lat},${lon})[amenity~"^(hospital|clinic|doctors|dentist|pharmacy|health_centre|social_facility)$"];
  
  // Emergency services
  node(around:${radius},${lat},${lon})[amenity~"^(police|fire_station|ambulance_station|fire_hydrant)$"];
  node(around:${radius},${lat},${lon})[emergency~"^(ambulance_station|fire_station|police|lifeguard_station|first_aid|defibrillator)$"];
  
  // Public buildings & government
  node(around:${radius},${lat},${lon})[amenity~"^(townhall|courthouse|public_building|library|post_office|post_box|prison)$"];
  node(around:${radius},${lat},${lon})[building~"^(townhall|civic|public|government|courthouse)$"];
  node(around:${radius},${lat},${lon})[office~"^(government|administrative)$"];
  
  // Education
  node(around:${radius},${lat},${lon})[amenity~"^(school|university|college|kindergarten|childcare)$"];
  
  // Religious buildings
  node(around:${radius},${lat},${lon})[amenity~"^(place_of_worship)$"];
  node(around:${radius},${lat},${lon})[building~"^(church|cathedral|mosque|temple|synagogue|shrine)$"];
  
  // Transportation hubs
  node(around:${radius},${lat},${lon})[amenity~"^(bus_station|taxi|ferry_terminal|bicycle_rental|car_rental)$"];
  node(around:${radius},${lat},${lon})[railway~"^(station|halt|tram_stop)$"];
  node(around:${radius},${lat},${lon})[aeroway~"^(terminal|gate)$"];
  node(around:${radius},${lat},${lon})[highway~"^(bus_stop)$"];
  
  // Utilities & public services
  node(around:${radius},${lat},${lon})[amenity~"^(drinking_water|water_point|toilets|recycling|shelter|charging_station)$"];
  
  // Commercial & food
  node(around:${radius},${lat},${lon})[amenity~"^(restaurant|cafe|bar|pub|fast_food|food_court|marketplace|cinema|theatre|nightclub)$"];
  node(around:${radius},${lat},${lon})[shop~"^(supermarket|convenience|mall|department_store|bakery|butcher|greengrocer)$"];
  
  // Tourism & leisure
  node(around:${radius},${lat},${lon})[tourism~"^(hotel|hostel|motel|museum|attraction|viewpoint|information)$"];
  node(around:${radius},${lat},${lon})[leisure~"^(park|sports_centre|stadium|golf_course|swimming_pool|fitness_centre)$"];
  
  // Historic & cultural
  node(around:${radius},${lat},${lon})[historic~"^(castle|monument|memorial|archaeological_site|ruins)$"];
  
  // Financial
  node(around:${radius},${lat},${lon})[amenity~"^(bank|atm|bureau_de_change)$"];
);
out body;
>;
out skel qt;
`;

        console.log('Fetching COMPREHENSIVE OSM data for icons...');
        const response = await fetch(overpassUrl, {
            method: "POST",
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: `data=${encodeURIComponent(query)}`
        });
        
        if (!response.ok) {
            if (response.status === 429) {
                overpassCooldownUntil = Date.now() + OVERPASS_COOLDOWN_DEFAULT_MS;
                setStatus('Overpass rate limit: delaying icon load for 60s', 'error', 8000);
                throw new Error('Overpass rate limited (429)');
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('COMPREHENSIVE OSM data received:', data.elements?.length || 0, 'elements');
        return data;
    } catch (err) {
        console.error('Failed to fetch comprehensive OSM data:', err);
        throw err;
    }
}

async function processOsmJson(jsonString) {
    /**
     * Process a full OSM JSON string.
     * Returns a unified list of all elements, each with:
     * - id, points, center, xy, base_elev
     * - height/min_height/effective_height (if any)
     * - tags
     */
    try {
        const osmData = JSON.parse(jsonString);
        // detect Overpass error payloads (e.g., tile_too_large)
        if (osmData && osmData._error) {
            console.warn('Overpass returned error for OSM query:', osmData);
            setStatus(`OSM query error: ${osmData._error} (elements: ${osmData.elements || 0})`, 'error', 8000);
            // record and bail out early
            lastOsmElementsCount = osmData.elements?.length || 0;
            return [];
        }
        lastOsmElementsCount = osmData.elements?.length || 0;
    console.log('OSM Data structure:', {
      elementsCount: lastOsmElementsCount,
      elementTypes: [...new Set(osmData.elements?.map(el => el.type) || [])]
    });
        // If the server returned an extremely large number of elements, skip processing to avoid UI freeze
        const MAX_OSM_ELEMENTS_PROCESS = 20000;
        if (lastOsmElementsCount > MAX_OSM_ELEMENTS_PROCESS) {
            console.warn('OSM payload too large, skipping processing:', lastOsmElementsCount);
            setStatus('OSM payload too large — zoom in to request a smaller area', 'error', 8000);
            return [];
        }
        
        const allElements = extractElements(osmData);
        console.log('Filtered elements by tags:', allElements.length);
        
        // Log some sample elements to see what we're working with
        if (allElements.length > 0) {
            console.log('Sample elements:', allElements.slice(0, 3));
        }
        
        const processed = [];
        for (const el of allElements) {
            const result = await processElement(el, ICON_MAP);
            if (result) {
                processed.push(result);
            }
        }
        
        console.log(`Successfully processed ${processed.length} elements`);
        return processed;
    } catch (error) {
        console.error('Error processing OSM JSON:', error);
        throw error;
    }
}

// -----------------------------------------------------------
// ICON_MAP
// -----------------------------------------------------------
// Modify the loadOsmFeaturesAt function to reset the timer when location changes
async function loadOsmFeaturesAt(lat, lon, radius = 300) {
    // Only throttle if it's the SAME location, not when location changes
    const locationKey = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const now = Date.now();
    
    // Reset the timer if we're at a new location
    if (locationKey !== lastIconLocationKey) {
        lastIconRequestTime = 0; // Reset throttle for new location
        lastIconLocationKey = locationKey;
    }
    
    if (now - lastIconRequestTime < MIN_ICON_REQUEST_INTERVAL) {
        console.log('Skipping icon request - too frequent for same location');
        return;
    }
    lastIconRequestTime = now;
    
    try {
        // Clear previous icons first
        clearIconMarkers();
        
        setStatus('Loading important locations...', 'loading', 3000);
        
        const osmJson = await getOsmJson(lat, lon, radius);
        const elements = await processOsmJson(JSON.stringify(osmJson));

        // Use priority to determine which icons to show
        const maxIcons = 40; // Reasonable limit
        const iconsToShow = elements
            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
            .slice(0, maxIcons);
        
        let placedCount = 0;
        for (const el of iconsToShow) {
            if (el.icon && el.centroid) {
                addIconMarker(el.centroid.lat, el.centroid.lon, el.icon, 0.08);
                placedCount++;
            }
        }

        console.log(`Placed ${placedCount} priority OSM icons near (${lat}, ${lon})`);
        
        // Show summary of what was found
        const categories = {};
        iconsToShow.forEach(el => {
            const mainTag = Object.keys(el.tags || {})[0];
            if (mainTag) {
                categories[mainTag] = (categories[mainTag] || 0) + 1;
            }
        });
        
        const categorySummary = Object.entries(categories)
            .map(([tag, count]) => `${count} ${tag}`)
            .join(', ');
            
        setStatus(`Found ${placedCount} important locations: ${categorySummary}`, 'info', 5000);
        
    } catch (err) {
        console.error("Failed to load OSM features:", err);
        setStatus('Failed to load important locations', 'error', 3000);
    }
}

let lastIconLocationKey = null;


function addIconMarker(lat, lon, imageUrl, elevation) {
  // Use the same coordinate system as your globe (radius = 1)
  const radius = (modelScaledRadius || RADIUS) + 0.001; // Slightly above surface + elevation offset

  const offsetLat = lat + (Math.random() * 0.01 - 0.005); // ±0.005 degrees
  const offsetLon = lon + (Math.random() * 0.01 - 0.005); // ±0.005 degrees

  // Use your existing latLonToVector3 function for consistency
  const position = latLonToVector3(offsetLat, offsetLon, radius);
  console.log(`Loading icon from: ${imageUrl}`);
  console.log(`Full URL would be: ${new URL(imageUrl, window.location.origin).href}`);
  
  // Create a sprite for the icon with proper error handling
  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(
    imageUrl,
    (texture) => {
      console.log('SUCCESS: Icon texture loaded: ', imageUrl);
      const material = new THREE.SpriteMaterial({ 
        map: texture, 
        transparent: true,
        // enable depth testing so icons are occluded by nearer globe geometry
        depthTest: true,
        // avoid writing to depth buffer so icons don't block other objects
        depthWrite: false
      });
      const sprite = new THREE.Sprite(material);

      // Larger scale to ensure visibility on globe; tweak as needed
      const scale = 0.08; // Experiment with this value
      sprite.scale.set(scale, scale, 1);
      // store base scale so updateIconMarkers can adjust consistently
      sprite.userData.baseScale = scale;
      // Avoid frustum culling for small sprites (ensures they are always considered)
      sprite.frustumCulled = false;
      sprite.position.copy(position);
      
      // Ensure icons render above other geometry
      sprite.renderOrder = 9999;
      
      scene.add(sprite);
      iconMarkers.push(sprite);
      console.log(`Icon placed at (${lat}, ${lon})`);
    },
    undefined, // onProgress callback
    (err) => {
      console.error('Failed to load icon:', imageUrl, err);
      // Create a fallback sphere marker
      createFallbackMarker(position);
    }
  );
}

// Fallback marker for missing icons
function createFallbackMarker(position) {
  const geometry = new THREE.SphereGeometry(0.01, 8, 8);
  const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.copy(position);
  scene.add(marker);
  marker.userData.baseScale = 0.04;
  iconMarkers.push(marker);
}

function clearIconMarkers() {
  for (const marker of iconMarkers) {
    scene.remove(marker);
    if (marker.geometry) marker.geometry.dispose();
    if (marker.material) {
      if (marker.material.map) marker.material.map.dispose();
      marker.material.dispose();
    }
  }
  iconMarkers = [];
}


const ICON_MAP = {
    "amenity": { 
        "bar": "/static/icons/amenity_recreational.svg",
        "bbq": "/static/icons/amenity_recreational.svg",
        "brothel": "/static/icons/amenity_recreational.svg",
        "cafe": "/static/icons/amenity_recreational.svg",
        "cinema": "/static/icons/amenity_recreational.svg",
        "food_court": "/static/icons/amenity_recreational.svg",
        "marketplace": "/static/icons/amenity_recreational.svg",
        "nightclub": "/static/icons/amenity_recreational.svg",
        "restaurant": "/static/icons/amenity_recreational.svg",
        "swinger_club": "/static/icons/amenity_recreational.svg",
        "theatre": "/static/icons/amenity_recreational.svg",
        "vending_machine": "/static/icons/amenity_recreational.svg",
        "bicycle_parking": "/static/icons/amenity_vehicle.svg",
        "bicycle_rental": "/static/icons/amenity_vehicle.svg",
        "car_rental": "/static/icons/amenity_vehicle.svg",
        "car_sharing": "/static/icons/amenity_vehicle.svg",
        "fuel": "/static/icons/amenity_vehicle.svg",
        "parking": "/static/icons/amenity_vehicle.svg",
        "charging_station": "/static/icons/amenity_charging_station.svg",
        "clinic": "/static/icons/health.svg",
        "dentist": "/static/icons/health.svg",
        "doctors": "/static/icons/health.svg",
        "hospital": "/static/icons/health.svg",
        "pharmacy": "/static/icons/health.svg",
        "college": "/static/icons/amenity_education.svg",
        "kindergarten": "/static/icons/amenity_education.svg",
        "school": "/static/icons/amenity_education.svg",
        "courthouse": "/static/icons/amenity_public_building.svg",
        "fire_station": "/static/icons/emergency_fire_station.svg",
        "police": "/static/icons/emergency_police.svg",
        "ferry_terminal": "/static/icons/amenity_ferry_terminal.svg",
        "grave_yard": "/static/icons/amenity_grave_yard.svg",
        "library": "/static/icons/amenity_library.svg",
        "place_of_worship": "/static/icons/amenity_place_of_worship.svg",
        "post_box": "/static/icons/amenity_post.svg",
        "post_office": "/static/icons/amenity_post.svg",
        "prison": "/static/icons/amenity_prison.svg",
        "public_building": "/static/icons/amenity_public_building.svg",
        "recycling": "/static/icons/amenity_recycling.svg",
        "shelter": "/static/icons/amenity_shelter.svg",
        "taxi": "/static/icons/amenity_taxi.svg",
        "telephone": "/static/icons/amenity_telephone.svg",
        "toilets": "/static/icons/amenity_toilets.svg",
        "townhall": "/static/icons/amenity_public_building.svg",
        "drinking_water": "/static/icons/water.svg",
        "water_point": "/static/icons/water.svg",
        "_default": "/static/icons/amenity.svg"
    },
    "natural": { "_default": "/static/icons/natural.svg" },
    "emergency": {
        "ambulance_station": "/static/icons/emergency_ambulance_station.svg",
        "fire_station": "/static/icons/emergency_fire_station.svg",
        "lifeguard_station": "/static/icons/emergency_lifeguard_station.svg",
        "police": "/static/icons/emergency_police.svg",
        "first_aid": "/static/icons/emergency_first_aid.svg",
        "defibrillator": "/static/icons/emergency_first_aid.svg",
        "assembly_point": "/static/icons/emergency_assembly_point.svg",
        "_default": "/static/icons/emergency.svg"
    },
    "aerialway":   { "_default": "/static/icons/aerialway.svg" },
    "aeroway":     { "_default": "/static/icons/aerialway.svg" },
    "barrier":     { "_default": "/static/icons/barrier.svg" },
    "boundary":    { "_default": "/static/icons/barrier.svg" },
    "building":    { "_default": "/static/icons/building.svg" },
    "craft":       { "_default": "/static/icons/craft.svg" },
    "geological":  { "_default": "/static/icons/geological.svg" },
    "healthcare":  { "_default": "/static/icons/health.svg" },
    "highway":     { "_default": "/static/icons/highway.svg" },
    "historic":    { "_default": "/static/icons/historic.svg" },
    "landuse":     { "_default": "/static/icons/landuse.svg" },
    "leisure":     { "_default": "/static/icons/leisure.svg" },
    "man_made":    { "_default": "/static/icons/man_made.svg" },
    "military":    { "_default": "/static/icons/military.svg" },
    "office":      { "_default": "/static/icons/office.svg" },
    "place":       { "_default": "/static/icons/place.svg" },
    "power":       { "_default": "/static/icons/power.svg" },
    "public_transport": { "_default": "/static/icons/public_transport.svg" },
    "railway":     { "_default": "/static/icons/route.svg" },
    "route":       { "_default": "/static/icons/route.svg" },
    "shop":        { "_default": "/static/icons/shop.svg" },
    "telecom":     { "_default": "/static/icons/telecom.svg" },
    "tourism":     { "_default": "/static/icons/tourism.svg" },
    "water":       { "_default": "/static/icons/water.svg" },
    "waterway":    { "_default": "/static/icons/water.svg" },
    "_global_default": { "_default": "/static/icons/default.svg" }
};