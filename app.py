from flask import Flask, render_template, request, jsonify, Response
import time
import os
import json
import math
import logging
import requests
import traceback
from functools import lru_cache
import urllib  # or: from urllib import parse as urllib_parse
from shapely.geometry import shape, Point

app = Flask(__name__)

# --- Overpass tuning constants ---
OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
TILE_DEG = 0.01                 # smaller tile size (deg). Lower -> more tiles, fewer elements per tile
MAX_ELEMENTS_PER_TILE = 3000    # threshold to subdivide tile (safe lower than your prior 5000)
MAX_RETRIES = 5                 # increased retries
BACKOFF_BASE = 1.5              # exponential backoff multiplier
REQUEST_TIMEOUT = 45            # increased timeout (seconds per Overpass request)
DEFAULT_TAG_FILTERS = ['["building"]']  # restrict to building while debugging dense areas

logger = logging.getLogger(__name__)

def clamp_lat(lat):
    try:
        lat = float(lat)
        return max(-90.0, min(90.0, lat))
    except Exception:
        return None

def clamp_lon(lon):
    try:
        lon = float(lon)
        # normalize into [-180,180)
        return ((lon + 180.0) % 360.0) - 180.0
    except Exception:
        return None

def format_coord(v):
    return f"{float(v):.8f}"

def normalize_and_split_bbox(minlat, minlon, maxlat, maxlon):
    """
    Validate/clamp coords and return a list of valid bbox tuples.
    Splits across the antimeridian if needed.
    Returns empty list if bbox is invalid or too small.
    """
    try:
        a = clamp_lat(minlat); b = clamp_lon(minlon)
        c = clamp_lat(maxlat); d = clamp_lon(maxlon)
        if a is None or b is None or c is None or d is None:
            return []
        # ensure min <= max in latitude; if reversed swap
        if a > c:
            a, c = c, a
        # if lat range too small, skip
        if abs(c - a) < 1e-7:
            return []
        # handle antimeridian: if lon range crosses 180/-180 boundary
        if b <= d:
            if abs(d - b) < 1e-7:
                return []
            return [(a, b, c, d)]
        else:
            # split into two boxes: b..180 and -180..d
            if (180.0 - b) >= 1e-7:
                left = (a, b, c, 180.0)
            else:
                left = None
            if (d + 180.0) >= 1e-7:
                right = (a, -180.0, c, d)
            else:
                right = None
            out = []
            if left: out.append(left)
            if right: out.append(right)
            return out
    except Exception:
        return []

def build_overpass_query_for_bbox(minlat, minlon, maxlat, maxlon, tag_filters=None):
    """Build Overpass QL with validated/split/ formatted coords."""
    bboxes = normalize_and_split_bbox(minlat, minlon, maxlat, maxlon)
    if not bboxes:
        raise ValueError("invalid bbox")
    # treat empty list as not-provided -> fall back to defaults
    filters = tag_filters if (tag_filters is not None and len(tag_filters) > 0) else DEFAULT_TAG_FILTERS

    # Build a single combined body by joining each bbox's selection with semicolons.
    # Each bbox contributes "node[tag](area);way[tag](area);relation[tag](area);"
    selection_parts = []
    for (a, b, c, d) in bboxes:
        area = f"({format_coord(a)},{format_coord(b)},{format_coord(c)},{format_coord(d)})"
        for t in filters:
            selection_parts.append(f'node{t}{area};')
            selection_parts.append(f'way{t}{area};')
            selection_parts.append(f'relation{t}{area};')

    # defensive: ensure we actually built something
    if not selection_parts:
        raise ValueError("No selection parts generated for Overpass query (empty tag filters?)")

    # join into one group and wrap once
    query_body = "".join(selection_parts)
    q = f"[out:json][timeout:{REQUEST_TIMEOUT}];({query_body})(._;>;);out geom;"
    return q

def normalize_lon(lon):
    """Normalize longitude into range [-180, 180)."""
    try:
        return ((float(lon) + 180.0) % 360.0) - 180.0
    except Exception:
        return lon

# improve fetch_overpass_with_retries to surface response text on HTTP errors
def fetch_overpass_with_retries(query, max_retries=MAX_RETRIES):
    """POST to Overpass with retries and exponential backoff. Returns parsed JSON or raises."""
    attempt = 0
    backoff = 1.0
    while True:
        try:
            # debug log query preview
            app.logger.debug("Overpass query preview: %s", (query[:800] + '...') if isinstance(query, str) and len(query) > 800 else query)
            resp = requests.post(OVERPASS_ENDPOINT, data={'data': query}, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as he:
            # include response body for diagnostics
            body = ''
            try:
                body = resp.text
            except Exception:
                body = str(he)
            attempt += 1
            logger.warning("Overpass HTTP error (attempt %d/%d): %s -- %s", attempt, max_retries, he, body[:400])
            if attempt >= max_retries:
                raise RuntimeError(f"Overpass HTTP error: {he} -- {body}") from he
            time.sleep(backoff)
            backoff *= BACKOFF_BASE
        except Exception as e:
            attempt += 1
            logger.warning("Overpass request failed (attempt %d/%d): %s", attempt, max_retries, str(e))
            if attempt >= max_retries:
                raise
            time.sleep(backoff)
            backoff *= BACKOFF_BASE

def subdivide_bbox(minlat, minlon, maxlat, maxlon):
    """Split bbox into 4 quads and return list of bboxes."""
    midlat = (minlat + maxlat) / 2.0
    midlon = (minlon + maxlon) / 2.0
    return [
        (minlat, minlon, midlat, midlon),
        (minlat, midlon, midlat, maxlon),
        (midlat, minlon, maxlat, midlon),
        (midlat, midlon, maxlat, maxlon)
    ]

def elements_count_from_overpass_json(data):
    try:
        return len(data.get('elements', []))
    except Exception:
        return 0

def stream_overpass_tiles(minlat, minlon, maxlat, maxlon, tag_filters=None, tile_deg=TILE_DEG):
    """
    Generator: iterates tiles covering bbox, validates each tile bbox and skips invalid/small tiles.
    Query each tag/filter separately to avoid producing large/complex combined QL strings.
    Uses a small cache (fetch_overpass_cached) to avoid re-requesting identical tiles.
    """
    # compute tile grid using floats
    lat = float(minlat)
    maxlat = float(maxlat)
    minlon = float(minlon)
    maxlon = float(maxlon)

    # avoid degenerate global loops
    if math.isnan(lat) or math.isnan(maxlat) or math.isnan(minlon) or math.isnan(maxlon):
        return

    # defensive: ensure we use a non-empty filter list
    filters = tag_filters if (tag_filters and len(tag_filters) > 0) else DEFAULT_TAG_FILTERS

    while lat < maxlat:
        next_lat = min(lat + tile_deg, maxlat)
        lon = minlon
        while lon < maxlon:
            next_lon = min(lon + tile_deg, maxlon)
            # validate and skip invalid tiny tiles early
            valid_boxes = normalize_and_split_bbox(lat, lon, next_lat, next_lon)
            if not valid_boxes:
                lon = next_lon
                continue
            for vb in valid_boxes:
                (v_minlat, v_minlon, v_maxlat, v_maxlon) = vb
                # Query each filter separately to avoid complex combined queries
                for t in filters:
                    # Build simple per-element-type queries (node / way / relation) to avoid complex grouping/parsing errors.
                    area = f"({format_coord(v_minlat)},{format_coord(v_minlon)},{format_coord(v_maxlat)},{format_coord(v_maxlon)})"
                    queries = [
                        (f"node{t}{area};out geom;", "node"),
                        (f"way{t}{area};(._;>;);out geom;", "way"),
                        (f"relation{t}{area};(._;>;);out geom;", "relation"),
                    ]
                    for q_body, q_type in queries:
                        q = f"[out:json][timeout:{REQUEST_TIMEOUT}];{q_body}"
                        try:
                            app.logger.debug("Overpass single-query preview (%s): %s", q_type, (q[:800] + '...') if isinstance(q, str) and len(q) > 800 else q)
                            # Try cache first
                            try:
                                data = fetch_overpass_cached(q)
                                app.logger.debug("Overpass cache hit for tile %s filter %s type %s", str(vb), str(t), q_type)
                            except Exception as cache_exc:
                                app.logger.debug("Overpass cache miss / error: %s", cache_exc)
                                data = fetch_overpass_with_retries(q)
                            count = elements_count_from_overpass_json(data)
                            if count > MAX_ELEMENTS_PER_TILE:
                                for sub in subdivide_bbox(v_minlat, v_minlon, v_maxlat, v_maxlon):
                                    yield from stream_overpass_tiles(sub[0], sub[1], sub[2], sub[3], tag_filters=[t], tile_deg=tile_deg / 2.0)
                            else:
                                for el in data.get('elements', []):
                                    if 'type' not in el or 'id' not in el:
                                        continue
                                    feat = {'type':'Feature', 'id': f"{el.get('type')}/{el.get('id')}", 'properties': el.get('tags') or {}}
                                    if el.get('type') == 'node' and 'lat' in el and 'lon' in el:
                                        feat['geometry'] = {'type':'Point', 'coordinates':[el['lon'], el['lat']]}
                                    elif el.get('geometry'):
                                        coords = [[pt['lon'], pt['lat']] for pt in el['geometry']]
                                        feat['geometry'] = {'type':'LineString', 'coordinates': coords}
                                    yield feat
                        except ValueError as ve:
                            app.logger.debug("Skipping invalid tile bbox %s: %s", str(vb), ve)
                            yield {'_error': 'invalid_tile_bbox', 'bbox': list(vb)}
                        except Exception as e:
                            tb = traceback.format_exc()
                            app.logger.error(
                                "Overpass tile failed for bbox [%s] filter %s type %s: %s\nQuery preview: %s\nTraceback:\n%s",
                                str(vb), str(t), q_type, str(e)[:400],
                                (q[:1000] + '...') if (isinstance(q, str) and len(q) > 1000) else (q or ''),
                                tb
                            )
                            preview = None
                            if isinstance(q, str):
                                preview = q[:800] + ('...' if len(q) > 800 else '')
                            yield {'_error': str(e), 'bbox': list(vb), 'query_preview': preview}
            lon = next_lon
        lat = next_lat

@app.route('/')
def home():
    return render_template('home.html')


@app.route('/about')
def about():
    return render_template('about.html')


@app.route('/test')
def test():
    return render_template('test.html')


@app.route('/contact')
def contact():
    return render_template('contact.html')


@app.route('/map')
def map_view():
    # page that renders a Three.js globe and allows markers over the earth
    return render_template('map.html')


@app.route('/api/overpass')
def api_overpass():
    """
    Synchronous Overpass endpoint. Accepts either bbox=minlat,minlon,maxlat,maxlon
    or lat/lon/radius (meters). Optional tags param (comma-separated keys) to restrict results.
    """
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)
    tags_param = request.args.get('tags')  # e.g. "building,amenity"
    tag_filters = None
    if tags_param:
        parts = [p.strip() for p in tags_param.split(',') if p.strip()]
        tag_filters = [f'["{p}"]' for p in parts] if parts else None

    if bbox:
        try:
            minlat, minlon, maxlat, maxlon = [float(x) for x in bbox.split(',')]
        except Exception:
            return jsonify({'error':'invalid bbox'}), 400
    elif lat is not None and lon is not None and radius is not None:
        # convert radius to degree bbox (approx)
        lat_delta = radius / 111320.0
        lon_delta = radius / (111320.0 * max(1e-6, abs(math.cos(math.radians(lat)))))
        minlat, maxlat = lat - lat_delta, lat + lat_delta
        minlon, maxlon = lon - lon_delta, lon + lon_delta
    else:
        return jsonify({'error':'provide bbox or lat+lon+radius'}), 400

    # Normalize longitudes into [-180,180]
    minlon = normalize_lon(minlon)
    maxlon = normalize_lon(maxlon)

    # If bbox crosses the antimeridian after normalization (minlon > maxlon),
    # split into two queries and merge results.
    bboxes = []
    if minlon <= maxlon:
        bboxes.append((minlat, minlon, maxlat, maxlon))
    else:
        # split into two: [minlon..180] and [-180..maxlon]
        bboxes.append((minlat, minlon, maxlat, 180.0))
        bboxes.append((minlat, -180.0, maxlat, maxlon))

    features = []
    try:
        for (mlat, mlon, xlat, xlon) in bboxes:
            q = build_overpass_query_for_bbox(mlat, mlon, xlat, xlon, tag_filters=tag_filters)
            data = fetch_overpass_with_retries(q)
            for el in data.get('elements', []):
                feat = {'type':'Feature', 'id': f"{el.get('type')}/{el.get('id')}", 'properties': el.get('tags') or {}}
                if el.get('type') == 'node' and 'lat' in el and 'lon' in el:
                    feat['geometry'] = {'type':'Point', 'coordinates':[el['lon'], el['lat']]}
                elif el.get('geometry'):
                    coords = [[pt['lon'], pt['lat']] for pt in el['geometry']]
                    feat['geometry'] = {'type':'LineString', 'coordinates': coords}
                features.append(feat)
        return jsonify({'type':'FeatureCollection','features':features})
    except Exception as e:
        return jsonify({'error': str(e)}), 502

@app.route('/api/overpass_stream')
def api_overpass_stream():
    """
    Streaming NDJSON Overpass endpoint that tiles the requested bbox and streams features.
    Query params:
      - bbox or lat/lon/radius
      - tags (optional comma-separated tag keys, e.g. tags=building,amenity)
      - tile_deg (optional override)
    """
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)
    tags_param = request.args.get('tags')
    tile_deg = request.args.get('tile_deg', type=float) or TILE_DEG

    tag_filters = None
    if tags_param:
        parts = [p.strip() for p in tags_param.split(',') if p.strip()]
        tag_filters = [f'["{p}"]' for p in parts] if parts else None

    if bbox:
        try:
            minlat, minlon, maxlat, maxlon = [float(x) for x in bbox.split(',')]
        except Exception:
            return jsonify({'_error':'invalid bbox'}), 400
    elif lat is not None and lon is not None and radius is not None:
        lat_delta = radius / 111320.0
        lon_delta = radius / (111320.0 * max(1e-6, abs(math.cos(math.radians(lat)))))
        minlat, maxlat = lat - lat_delta, lat + lat_delta
        minlon, maxlon = lon - lon_delta, lon + lon_delta
    else:
        return jsonify({'_error':'provide bbox or lat+lon+radius'}), 400

    # Normalize longitudes
    minlon = normalize_lon(minlon)
    maxlon = normalize_lon(maxlon)

    # if crosses antimeridian, produce two bbox ranges
    bboxes = []
    if minlon <= maxlon:
        bboxes.append((minlat, minlon, maxlat, maxlon))
    else:
        bboxes.append((minlat, minlon, maxlat, 180.0))
        bboxes.append((minlat, -180.0, maxlat, maxlon))

    def generate():
        yield json.dumps({'_meta':{'status':'start','bbox':[minlat,minlon,maxlat,maxlon]}}) + '\n'
        for (mlat, mlon, xlat, xlon) in bboxes:
            for feat in stream_overpass_tiles(mlat, mlon, xlat, xlon, tag_filters=tag_filters, tile_deg=tile_deg):
                try:
                    yield json.dumps(feat) + '\n'
                except Exception as e:
                    yield json.dumps({'_error': str(e)}) + '\n'
        yield json.dumps({'_meta':{'status':'done'}}) + '\n'

    return Response(generate(), mimetype='application/x-ndjson')



@lru_cache(maxsize=64)
def fetch_overpass_cached(q_text):
    """Cached Overpass fetch. q_text (string) is used as cache key."""
    url = 'https://overpass-api.de/api/interpreter'
    r = requests.post(url, data={'data': q_text}, timeout=30)
    r.raise_for_status()
    return r.json()


@lru_cache(maxsize=8)
def load_countries_geojson(local_path):
    """Load geojson from local path or return None."""
    if os.path.exists(local_path):
        try:
            with open(local_path, 'r', encoding='utf-8') as fh:
                return json.load(fh)
        except Exception:
            return None
    return None


@lru_cache(maxsize=8)
def get_country_boundaries(simplify_tol=0.1):
    """Return a GeoJSON FeatureCollection of country boundaries (LineStrings).

    simplify_tol: tolerance in degrees for shapely.simplify (default 0.1)
    """
    # Try local asset first
    local_file = os.path.join(app.static_folder or 'static', 'assets', 'countries.geojson')
    gj = load_countries_geojson(local_file)
    if gj is None:
        # attempt to download from a few known public sources (fall back if one fails)
        candidate_urls = [
            'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
            'https://raw.githubusercontent.com/datasets/geo-boundaries-world-110m/master/countries.geojson',
            'https://raw.githubusercontent.com/datasets/geo-boundaries-simplified/master/countries.geojson'
        ]
        gj = None
        for url in candidate_urls:
            try:
                app.logger.info('Attempting to download countries geojson from %s', url)
                r = requests.get(url, timeout=20)
                r.raise_for_status()
                gj = r.json()
                # persist a local copy for future runs
                try:
                    os.makedirs(os.path.dirname(local_file), exist_ok=True)
                    with open(local_file, 'w', encoding='utf-8') as fh:
                        json.dump(gj, fh)
                    app.logger.info('Saved countries geojson to %s', local_file)
                except Exception as e:
                    app.logger.warning('Failed to save countries geojson locally: %s', e)
                break
            except Exception as e:
                app.logger.warning('Failed to download countries geojson from %s: %s', url, e)

        if gj is None:
            app.logger.error('All attempts to obtain countries geojson failed; returning empty feature collection')
            # return an empty FeatureCollection instead of None so client receives a 200 and can continue
            return {'type': 'FeatureCollection', 'features': []}

    # Try to use Shapely for assembling/simplifying boundaries; if not available,
    # fall back to extracting polygon exteriors directly from the GeoJSON.
    features = []
    try:
        from shapely.geometry import shape
        shapely_available = True
    except Exception as e:
        shapely_available = False
        app.logger.info('Shapely not available for country boundaries: %s', e)

    for feat in gj.get('features', []):
        props = feat.get('properties', {}) or {}
        geom_json = feat.get('geometry')
        if not geom_json:
            continue

        if shapely_available:
            try:
                geom = shape(geom_json)
                if simplify_tol and simplify_tol > 0:
                    geom = geom.simplify(simplify_tol, preserve_topology=True)
                boundary = geom.boundary
                if boundary.is_empty:
                    continue
                if boundary.geom_type == 'LineString':
                    coords = [[float(x), float(y)] for x, y in boundary.coords]
                    features.append({
                        'type': 'Feature',
                        'geometry': {'type': 'LineString', 'coordinates': coords},
                        'properties': {'name': props.get('ADMIN') or props.get('NAME') or props.get('name')}
                    })
                else:
                    for part in boundary:
                        coords = [[float(x), float(y)] for x, y in part.coords]
                        features.append({
                            'type': 'Feature',
                            'geometry': {'type': 'LineString', 'coordinates': coords},
                            'properties': {'name': props.get('ADMIN') or props.get('NAME') or props.get('name')}
                        })
            except Exception:
                continue
        else:
            # shapely not available: extract exteriors directly from GeoJSON polygons
            gtype = geom_json.get('type')
            coords = geom_json.get('coordinates')
            if not coords:
                continue
            if gtype == 'Polygon':
                exterior = coords[0]
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'LineString', 'coordinates': [[float(x), float(y)] for x, y in exterior]},
                    'properties': {'name': props.get('ADMIN') or props.get('NAME') or props.get('name')}
                })
            elif gtype == 'MultiPolygon':
                for poly in coords:
                    exterior = poly[0]
                    features.append({
                        'type': 'Feature',
                        'geometry': {'type': 'LineString', 'coordinates': [[float(x), float(y)] for x, y in exterior]},
                        'properties': {'name': props.get('ADMIN') or props.get('NAME') or props.get('name')}
                    })
            else:
                # other geometries: ignore
                continue

    return {'type': 'FeatureCollection', 'features': features}


@app.route('/api/countries')
def api_countries():
    """Return simplified country boundaries as GeoJSON FeatureCollection.

    Query params:
      - simplify: float degrees (default 0.1)
    """
    try:
        simplify = float(request.args.get('simplify', 0.1))
    except Exception:
        simplify = 0.1

    data = get_country_boundaries(simplify_tol=simplify)
    if data is None:
        # fallback to empty collection (shouldn't happen with updated get_country_boundaries)
        return jsonify({'type': 'FeatureCollection', 'features': []})
    return jsonify(data)


@app.route('/api/countries_stream')
def api_countries_stream():
    """Stream country boundaries as NDJSON, filtered by bbox or lat/lon+radius.

    Query params (one of):
      - bbox=minlat,minlon,maxlat,maxlon
      - lat, lon, radius (meters)
      - simplify (float degrees, optional)

    Returns newline-delimited GeoJSON Feature objects (LineString) with properties including 'name'.
    """
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)

    try:
        simplify = float(request.args.get('simplify', 0.1))
    except Exception:
        simplify = 0.1

    if not bbox and (lat is None or lon is None or radius is None):
        return jsonify({"error": "Provide bbox or lat+lon+radius"}), 400

    if not bbox:
        lat_delta = radius / 111320.0
        lon_delta = radius / (111320.0 * max(0.00001, abs(math.cos(math.radians(lat)))) )
        minlat = lat - lat_delta
        maxlat = lat + lat_delta
        minlon = lon - lon_delta
        maxlon = lon + lon_delta
    else:
        try:
            parts = [float(p) for p in bbox.split(',')]
            if len(parts) != 4:
                raise ValueError()
            minlat, minlon, maxlat, maxlon = parts
        except Exception:
            return jsonify({"error": "Invalid bbox format. Use minlat,minlon,maxlat,maxlon"}), 400

    # Load country boundaries (cached)
    countries = get_country_boundaries(simplify_tol=simplify)
    if not countries or 'features' not in countries:
        # return empty stream
        def empty_gen():
            yield json.dumps({"_meta": {"status": "done", "features": 0}}) + "\n"
        return Response(empty_gen(), mimetype='application/x-ndjson')

    # Try shapely to robustly test intersection. If not available, fallback to bbox-coordinate check.
    try:
        from shapely.geometry import shape, box
        shapely_ok = True
    except Exception:
        shapely_ok = False

    target_box = None
    if shapely_ok:
        target_box = box(minlon, minlat, maxlon, maxlat)

    def gen():
        count = 0
        for feat in countries.get('features', []):
            geom = feat.get('geometry')
            props = feat.get('properties', {}) or {}
            if not geom:
                continue
            try:
                if shapely_ok:
                    gshape = shape(geom)
                    if not gshape.intersects(target_box):
                        continue
                    # compute centroid and priority (area) for label placement and collision
                    try:
                        cent = gshape.representative_point().coords[0]
                        c_lon, c_lat = float(cent[0]), float(cent[1])
                    except Exception:
                        try:
                            c = gshape.centroid
                            c_lon, c_lat = float(c.x), float(c.y)
                        except Exception:
                            c_lon, c_lat = None, None
                    try:
                        priority = float(abs(gshape.area))
                    except Exception:
                        priority = 0.0
                    # If intersects, yield the feature (keep properties) and add centroid/priority
                    out_props = dict(props)
                    if c_lon is not None and c_lat is not None:
                        out_props['centroid'] = [c_lon, c_lat]
                    out_props['label_priority'] = priority
                    out = { 'type': 'Feature', 'geometry': json.loads(json.dumps(geom)), 'properties': out_props }
                    yield json.dumps(out) + "\n"
                    count += 1
                else:
                    # fallback: simple coordinate check - if any coordinate falls inside bbox, include
                    included = False
                    gtype = geom.get('type')
                    coords = geom.get('coordinates')
                    if not coords:
                        continue
                    def any_in_ring(ring):
                        for lon, lat in ring:
                            if minlat <= lat <= maxlat and minlon <= lon <= maxlon:
                                return True
                        return False
                    if gtype == 'LineString':
                        if any_in_ring(coords):
                            included = True
                    elif gtype == 'MultiLineString':
                        for part in coords:
                            if any_in_ring(part):
                                included = True
                                break
                    if not included:
                        continue
                    # fallback centroid: average of coordinates (approx)
                    c_lon, c_lat = None, None
                    try:
                        all_pts = []
                        gtype = geom.get('type')
                        if gtype == 'LineString':
                            all_pts = geom.get('coordinates', [])
                        elif gtype == 'MultiLineString':
                            for part in geom.get('coordinates', []):
                                all_pts.extend(part or [])
                        if all_pts:
                            sumx = 0.0; sumy = 0.0
                            for lon, lat in all_pts:
                                sumx += float(lon); sumy += float(lat)
                            c_lon = sumx / len(all_pts); c_lat = sumy / len(all_pts)
                    except Exception:
                        c_lon, c_lat = None, None
                    out_props = dict(props)
                    if c_lon is not None and c_lat is not None:
                        out_props['centroid'] = [c_lon, c_lat]
                    # priority fallback: number of points
                    out_props['label_priority'] = float(len(all_pts) if 'all_pts' in locals() else 0)
                    out = { 'type': 'Feature', 'geometry': json.loads(json.dumps(geom)), 'properties': out_props }
                    yield json.dumps(out) + "\n"
                    count += 1
            except Exception as e:
                app.logger.debug('Skipping country feature due to error: %s', e)
                continue
        # final meta
        yield json.dumps({"_meta": {"status": "done", "features": count}}) + "\n"

    return Response(gen(), mimetype='application/x-ndjson')


@app.route('/api/country_info')
def api_country_info():
    """Return metadata for a named country:
       - bbox (minlon,minlat,maxlon,maxlat)
       - centroid [lon,lat]
       - basic properties from local geojson (if available)
       - external data from restcountries (population, area, flag, cca2)
       - placeholder 'icons' array (can be populated by your packaging pipeline)
    """
    name = request.args.get('country')
    if not name:
        return jsonify({'error': 'country param required'}), 400

    # try to find country in local geojson
    local_file = os.path.join(app.static_folder or 'static', 'assets', 'countries.geojson')
    gj = load_countries_geojson(local_file)
    country_feat = None
    if gj and 'features' in gj:
        lname = name.lower()
        for f in gj['features']:
            props = (f.get('properties') or {})
            cand = (props.get('ADMIN') or props.get('NAME') or props.get('name') or '').lower()
            if cand == lname:
                country_feat = f
                break

    bbox = None
    centroid = None
    props = {}
    # compute bbox/centroid if shapely available and feature found
    try:
        from shapely.geometry import shape
        if country_feat and country_feat.get('geometry'):
            s = shape(country_feat['geometry'])
            minx, miny, maxx, maxy = s.bounds
            bbox = [minx, miny, maxx, maxy]  # lon/min, lat/min, lon/max, lat/max
            r = s.representative_point()
            centroid = [float(r.x), float(r.y)]
            props = dict(country_feat.get('properties') or {})
    except Exception:
        # fallback: try to compute centroid/bbox from coordinates
        if country_feat and country_feat.get('geometry'):
            geom = country_feat['geometry']
            coords = []
            def walk(c):
                if isinstance(c[0], (float,int)):
                    coords.append((float(c[0]), float(c[1])))
                else:
                    for p in c:
                        walk(p)
            try:
                walk(geom.get('coordinates', []))
                if coords:
                    xs = [c[0] for c in coords]; ys = [c[1] for c in coords]
                    bbox = [min(xs), min(ys), max(xs), max(ys)]
                    centroid = [(sum(xs)/len(xs)), (sum(ys)/len(ys))]
                    props = dict(country_feat.get('properties') or {})
            except Exception:
                pass

    # fetch RestCountries summary (best-effort)
    rest = {}
    try:
        # prefer fullText search for exact match; fall back to name search
        qname = urllib.parse.quote(name)
        url = f'https://restcountries.com/v3.1/name/{qname}?fullText=true'
        r = requests.get(url, timeout=10)
        if r.ok:
            arr = r.json()
            if isinstance(arr, list) and len(arr) > 0:
                c = arr[0]
                rest = {
                    'population': c.get('population'),
                    'area': c.get('area'),
                    'cca2': c.get('cca2'),
                    'cca3': c.get('cca3'),
                    'currencies': list((c.get('currencies') or {}).keys()),
                    'flag': (c.get('flags') or {}).get('svg') or (c.get('flags') or {}).get('png')
                }
        else:
            # try a loose name search
            url2 = f'https://restcountries.com/v3.1/name/{qname}'
            r2 = requests.get(url2, timeout=8)
            if r2.ok:
                arr2 = r2.json()
                if isinstance(arr2, list) and len(arr2) > 0:
                    c = arr2[0]
                    rest = {
                        'population': c.get('population'),
                        'area': c.get('area'),
                        'cca2': c.get('cca2'),
                        'cca3': c.get('cca3'),
                        'currencies': list((c.get('currencies') or {}).keys()),
                        'flag': (c.get('flags') or {}).get('svg') or (c.get('flags') or {}).get('png')
                    }
    except Exception:
        rest = {}

    # placeholder icons: your packaging step can produce a list of {lat,lon,type,url,label}
    icons = []  # example: [{'lat':51.0,'lon':-114.0,'type':'linus','url':'/static/assets/icons/linus-xyz.png','label':'Project A'}]

    resp = {
        'country': name,
        'bbox': bbox,
        'centroid': centroid,
        'properties': props,
        'rest': rest,
        'icons': icons
    }
    return jsonify(resp)


@app.route('/favicon.ico')
def favicon():
    # return a small inline SVG as favicon to avoid 404 in dev
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
           '<rect width="16" height="16" fill="#0b1020"/>'
           '<circle cx="8" cy="8" r="5" fill="#4db6ac"/></svg>')
    return Response(svg, mimetype='image/svg+xml')


if __name__ == '__main__':
    print("Working")
    # enable threaded to improve responsiveness for concurrent requests in dev
    app.run(debug=True, threaded=True)


