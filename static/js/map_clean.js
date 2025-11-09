// map_clean.js — consolidated Three.js globe viewer module
import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';

const container = document.getElementById('map-container');
const statusEl = document.getElementById('status');

function setStatus(msg, level = 'info', timeout = 4000) {
  if (!statusEl) { console.log('[status]', level, msg); return; }
  statusEl.textContent = msg || '';
  statusEl.style.color = level === 'error' ? '#ff8888' : (level === 'loading' ? '#ffd166' : '#ddd');
  if (statusEl._clearTimer) clearTimeout(statusEl._clearTimer);
  if (timeout && msg) statusEl._clearTimer = setTimeout(() => { statusEl.textContent = ''; }, timeout);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08121a);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(container.clientWidth, container.clientHeight, false);
renderer.domElement.style.display = 'block';
container.appendChild(renderer.domElement);

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
container.appendChild(fpsCounter);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 0, 3.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 1.5; controls.maxDistance = 8;

scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.6); dirLight.position.set(5,3,5); scene.add(dirLight);

const RADIUS = 1;
const globeMat = new THREE.MeshStandardMaterial({ color: 0x234f6b, roughness: 1, metalness: 0 });
const globe = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 64, 64), globeMat); scene.add(globe);

let countryBorders = new THREE.Group(); let countryLabels = new THREE.Group(); scene.add(countryBorders); scene.add(countryLabels);

function latLonToVector3(lat, lon, radius = RADIUS) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x,y,z);
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill(); }

function createLabelSprite(text) {
  const font = '600 18px sans-serif'; const padding = 8;
  const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); ctx.font = font;
  const metrics = ctx.measureText(text); const w = Math.ceil(metrics.width) + padding * 2; const h = 28 + padding * 2;
  canvas.width = w; canvas.height = h;
  ctx.fillStyle = 'rgba(8,12,20,0.85)'; roundRect(ctx, 0, 0, w, h, 6);
  ctx.fillStyle = '#fff'; ctx.font = font; ctx.textBaseline = 'middle'; ctx.fillText(text, padding, h/2);
  const tex = new THREE.CanvasTexture(canvas); tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sp = new THREE.Sprite(mat); sp.userData = { pixelW: w, pixelH: h }; return sp;
}

function disposeGroup(g) { if (!g) return; for (const c of g.children) { try { if (c.geometry) c.geometry.dispose(); } catch (e) {} try { if (c.material && c.material.map) c.material.map.dispose(); } catch (e) {} } try { scene.remove(g); } catch(e) {} }

function addLine(coords, group, color = 0xffffff, opacity = 1) {
  if (!coords || coords.length < 2) return; const pts = coords.map(([lon,lat])=>latLonToVector3(lat, lon, RADIUS + 0.002)); const arr = new Float32Array(pts.length*3); pts.forEach((p,i)=>{ arr[i*3]=p.x; arr[i*3+1]=p.y; arr[i*3+2]=p.z; }); const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(arr,3)); const mat = new THREE.LineBasicMaterial({ color, transparent: opacity<1, opacity }); const line = new THREE.Line(geom, mat); group.add(line);
}

function renderCountries(geo) {
  disposeGroup(countryBorders); disposeGroup(countryLabels);
  countryBorders = new THREE.Group(); countryLabels = new THREE.Group(); scene.add(countryBorders); scene.add(countryLabels);
  const feats = geo && geo.features ? geo.features : [];
  setStatus(`Loaded ${feats.length} countries`, 'info', 3000);
  for (const f of feats) {
    const geom = f.geometry; if (!geom) continue; const name = (f.properties && (f.properties.ADMIN || f.properties.NAME || f.properties.name)) || 'Unknown';
    if (geom.type === 'LineString') addLine(geom.coordinates, countryBorders, 0xffffff, 0.6);
    else if (geom.type === 'MultiLineString') for (const p of geom.coordinates) addLine(p, countryBorders, 0xffffff, 0.6);
    else if (geom.type === 'Polygon') addLine(geom.coordinates[0], countryBorders, 0xffffff, 0.9);
    else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) addLine(poly[0], countryBorders, 0xffffff, 0.9);
    let lat=null, lon=null;
    if (f.properties && f.properties.centroid && f.properties.centroid.length>=2) { lon = parseFloat(f.properties.centroid[0]); lat = parseFloat(f.properties.centroid[1]); }
    else if (geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0] && geom.coordinates[0].length) { const ring = geom.coordinates[0]; const mid = Math.floor(ring.length/2); lon = ring[mid][0]; lat = ring[mid][1]; }
    if (lat!==null && lon!==null) { const sp = createLabelSprite(name); sp.position.copy(latLonToVector3(lat, lon, RADIUS + 0.03)); sp.scale.set(0.6, 0.18, 1); countryLabels.add(sp); }
  }
}

async function fetchAndRenderCountries() {
  setStatus('Loading countries…','loading',null);
  try { const res = await fetch('/api/countries?simplify=0.0'); if (!res.ok) { setStatus('Failed to load countries','error',4000); console.warn(await res.text()); return; } const geo = await res.json(); renderCountries(geo); console.info('fetchAndRenderCountries: features=', geo.features ? geo.features.length : 0); } catch (e) { console.error('countries fetch failed', e); setStatus('Failed to load countries','error',4000); }
}

// locate-me
document.getElementById('locate-me')?.addEventListener('click', () => {
  setStatus('Requesting location…','loading',8000);
  if (!navigator.geolocation) { setStatus('Geolocation not supported','error',3000); return; }
  navigator.geolocation.getCurrentPosition((pos) => { const lat = pos.coords.latitude, lon = pos.coords.longitude; flyToLatLon(lat, lon, 2.5, 900); addUserMarker(lat, lon); setStatus('Centered on your location','info',3000); }, (err) => { setStatus('Location failed','error',3000); console.warn(err); }, { enableHighAccuracy: true, timeout: 10000 });
});

let userMarker = null;
function addUserMarker(lat, lon) { if (userMarker) try { scene.remove(userMarker); } catch (e) {} const pos = latLonToVector3(lat, lon, RADIUS + 0.02); const sph = new THREE.Mesh(new THREE.SphereGeometry(0.02,8,8), new THREE.MeshBasicMaterial({ color: 0xffcc33 })); sph.position.copy(pos); userMarker = sph; scene.add(userMarker); }

function flyToLatLon(lat, lon, distanceFactor = 3.0, duration = 900) { const startPos = camera.position.clone(); const startTarget = controls.target.clone(); const endTarget = latLonToVector3(lat, lon, RADIUS); const endCam = endTarget.clone().multiplyScalar(distanceFactor); const t0 = performance.now(); function step() { const t = Math.min(1, (performance.now() - t0) / duration); const e = 1 - Math.pow(1 - t, 3); camera.position.lerpVectors(startPos, endCam, e); controls.target.lerpVectors(startTarget, endTarget, e); controls.update(); if (t < 1) requestAnimationFrame(step); } requestAnimationFrame(step); }

function onResize() { renderer.setSize(container.clientWidth, container.clientHeight, false); camera.aspect = container.clientWidth / container.clientHeight; camera.updateProjectionMatrix(); }
window.addEventListener('resize', onResize);

// FPS & animate
const FRAME_HISTORY = 60; const frameTimes = []; let lastFrameTime = performance.now(); let smoothedFps = 0;
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now(); const dt = Math.max(0.001, now - lastFrameTime); lastFrameTime = now; const instFps = 1000.0 / dt; smoothedFps = smoothedFps * 0.93 + instFps * 0.07; frameTimes.push(dt); if (frameTimes.length > FRAME_HISTORY) frameTimes.shift();
  controls.update(); renderer.render(scene, camera);
  for (const s of countryLabels.children) { const d = camera.position.distanceTo(s.position) || 1; const scale = Math.min(Math.max(d * 0.06, 0.25), 1.2); s.scale.set(scale, scale * 0.35, 1); s.lookAt(camera.position); }
  let avg = 0, min = Infinity, max = 0; for (const t of frameTimes) { avg += t; if (t < min) min = t; if (t > max) max = t; } const n = frameTimes.length || 1; avg = avg / n; if (min === Infinity) min = 0; fpsCounter.innerHTML = `FPS: ${smoothedFps.toFixed(1)} | frame: ${dt.toFixed(1)} ms — avg ${avg.toFixed(1)} ms`;
}
animate();

// Start
fetchAndRenderCountries();
