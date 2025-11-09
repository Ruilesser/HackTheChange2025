from flask import Flask, render_template, request, jsonify, Response
import requests
import math
from functools import lru_cache
import time
import json
import os

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024 


# Helpers for spherical math and geometry rep extraction
def _latlon_to_unit_vec(lat, lon):
    """Convert geographic lat,lon to a unit 3D vector (x,y,z) on a unit sphere.

    Uses the same convention as client latLonToVector3 (right-handed mapping).
    """
    phi = math.radians(90.0 - float(lat))
    theta = math.radians(float(lon) + 180.0)
    x = -(math.sin(phi) * math.cos(theta))
    z = math.sin(phi) * math.sin(theta)
    y = math.cos(phi)
    return (x, y, z)


def _rep_latlon_from_geom(geom):
    """Return a representative (lat, lon) tuple for a GeoJSON geometry.

    For Point -> direct coords, LineString -> midpoint, Polygon/MultiLine -> center of longest part.
    Returns (lat, lon) or (None, None) if not available.
    """
    if not geom:
        return (None, None)
    gtype = geom.get('type')
    coords = geom.get('coordinates')
    try:
        if gtype == 'Point':
            lon, lat = coords[0], coords[1]
            return (lat, lon)
        if gtype == 'LineString':
            if not coords:
                return (None, None)
            mid = coords[len(coords) // 2]
            lon, lat = mid[0], mid[1]
            return (lat, lon)
        if gtype == 'Polygon':
            exterior = coords[0] if coords else None
            if exterior:
                mid = exterior[len(exterior) // 2]
                lon, lat = mid[0], mid[1]
                return (lat, lon)
        if gtype == 'MultiLineString' or gtype == 'MultiPolygon':
            best = None
            best_len = -1
            for part in coords:
                if not part:
                    continue
                if len(part) > best_len:
                    best_len = len(part)
                    best = part
            if best:
                mid = best[len(best) // 2]
                lon, lat = mid[0], mid[1]
                return (lat, lon)
    except Exception:
        return (None, None)
    return (None, None)


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
    """Query Overpass API for elements tagged with 'reconstruction' or 'building'.

    Query parameters (one of):
      - bbox=minlat,minlon,maxlat,maxlon  (preferred)
      - lat, lon, radius (meters) -> server computes bbox

    Returns GeoJSON FeatureCollection with simple properties (tags).
    """
    # Temporarily disable Overpass queries: return an empty FeatureCollection so
    # the client can render local GeoJSON (countries) without external calls.
    return jsonify({'type': 'FeatureCollection', 'features': []})


@app.route('/api/overpass_stream')
def api_overpass_stream():
    """Stream Overpass results as NDJSON by tiling the requested bbox.

    Query params: same as /api/overpass (bbox or lat+lon+radius)
    Returns newline-delimited GeoJSON Feature objects as they are produced.
    """
    # Temporarily disable Overpass streaming: return an empty NDJSON stream.
    def gen():
        yield json.dumps({"_meta": {"status": "done", "features": 0}}) + "\n"
    return Response(gen(), mimetype='application/x-ndjson')


@app.route('/api/overpass_chunks')
def api_overpass_chunks():
    """Stream Overpass results in prioritized chunks based on nearest country to the requested center.

    Behavior:
      - Compute center from bbox or lat/lon/radius.
      - Find nearest country centroid and sort tile chunks by distance to that centroid.
      - For each tile: emit a tile_summary NDJSON line with element count.
      - If tile small enough, emit full features for the tile; otherwise skip full fetch.

    Query params: same as /api/overpass_stream plus optional max_depth, max_requests
    """
    # Temporarily disable the chunked Overpass implementation and return an
    # immediate empty NDJSON stream so the client doesn't perform heavy calls.
    def gen():
        yield json.dumps({"_meta": {"status": "done", "requested_tiles": 0, "requests_made": 0}}) + "\n"
    return Response(gen(), mimetype='application/x-ndjson')



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


@lru_cache(maxsize=4)
def get_country_index():
    """Return a list of country records with computed centroids: [{'name': str, 'centroid': (lat, lon)}].

    Uses the original countries.geojson if available and Shapely when possible. Falls back to averaged coords.
    """
    local_file = os.path.join(app.static_folder or 'static', 'assets', 'countries.geojson')
    gj = load_countries_geojson(local_file)
    if not gj:
        # try to use the simplified boundaries as a fallback
        simplified = get_country_boundaries()
        feats = simplified.get('features', [])
        out = []
        for f in feats:
            name = (f.get('properties') or {}).get('name') or None
            geom = f.get('geometry') or {}
            # approximate centroid from line coordinates
            latc, lonc = None, None
            try:
                coords = geom.get('coordinates', [])
                if coords and isinstance(coords[0][0], (list, tuple)):
                    ring = coords[0]
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    lonc = sum(xs) / len(xs)
                    latc = sum(ys) / len(ys)
            except Exception:
                pass
            if name and latc is not None:
                out.append({'name': name, 'centroid': (latc, lonc)})
        return out

    # Try shapely for accurate centroids
    try:
        from shapely.geometry import shape
        use_shapely = True
    except Exception:
        use_shapely = False

    records = []
    for feat in gj.get('features', []):
        props = feat.get('properties', {}) or {}
        name = props.get('ADMIN') or props.get('NAME') or props.get('name') or None
        geom_json = feat.get('geometry')
        if not geom_json or not name:
            continue
        latc, lonc = None, None
        if use_shapely:
            try:
                g = shape(geom_json)
                c = g.representative_point()
                lonc, latc = float(c.x), float(c.y)
            except Exception:
                latc, lonc = None, None
        else:
            # fallback: average of first polygon exterior
            try:
                gtype = geom_json.get('type')
                coords = geom_json.get('coordinates')
                if gtype == 'Polygon' and coords:
                    ring = coords[0]
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    lonc = sum(xs) / len(xs)
                    latc = sum(ys) / len(ys)
                elif gtype == 'MultiPolygon' and coords:
                    ring = coords[0][0]
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    lonc = sum(xs) / len(xs)
                    latc = sum(ys) / len(ys)
            except Exception:
                latc, lonc = None, None
        if latc is not None:
            records.append({'name': name, 'centroid': (latc, lonc)})
    return records



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

    # Allow optional bbox or lat/lon+radius to return only the visible subset
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)

    data = get_country_boundaries(simplify_tol=simplify)
    if data is None or 'features' not in data:
        return jsonify({'type': 'FeatureCollection', 'features': []})

    # If no spatial filter requested, return full collection
    if not bbox and (lat is None or lon is None or radius is None):
        return jsonify(data)

    # compute bbox from lat/lon/radius when provided
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

    # Try shapely to robustly test intersection. If not available, fallback to bbox-coordinate check.
    try:
        from shapely.geometry import shape, box
        shapely_ok = True
    except Exception:
        shapely_ok = False

    filtered = []
    if shapely_ok:
        target_box = box(minlon, minlat, maxlon, maxlat)
        for feat in data.get('features', []):
            geom = feat.get('geometry')
            if not geom:
                continue
            try:
                gshape = shape(geom)
                if gshape.intersects(target_box):
                    filtered.append(feat)
            except Exception:
                # on error, include the feature conservatively
                filtered.append(feat)
    else:
        # Fallback: check coordinates for any point inside bbox
        def any_in_ring(ring):
            for lonv, latv in ring:
                if minlat <= latv <= maxlat and minlon <= lonv <= maxlon:
                    return True
            return False

        for feat in data.get('features', []):
            geom = feat.get('geometry')
            if not geom:
                continue
            gtype = geom.get('type')
            coords = geom.get('coordinates')
            included = False
            try:
                if gtype == 'LineString':
                    if any_in_ring(coords): included = True
                elif gtype == 'MultiLineString':
                    for part in coords:
                        if any_in_ring(part):
                            included = True; break
            except Exception:
                included = True
            if included:
                filtered.append(feat)

    return jsonify({'type': 'FeatureCollection', 'features': filtered})


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

    # NOTE: visibility/backface culling disabled on server — always stream country features

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
                    # Always yield the feature (no server-side visibility culling).
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
                    # Fallback: always yield (no server-side visibility culling)
                    yield json.dumps(out) + "\n"
                    count += 1
            except Exception as e:
                app.logger.debug('Skipping country feature due to error: %s', e)
                continue
        # final meta
        yield json.dumps({"_meta": {"status": "done", "features": count}}) + "\n"

    return Response(gen(), mimetype='application/x-ndjson')


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
