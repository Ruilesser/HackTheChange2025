from flask import Flask, render_template, request, jsonify, Response
import requests
import math
from functools import lru_cache
import time
import json
import os

app = Flask(__name__)


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
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)  # meters

    if not bbox and (lat is None or lon is None or radius is None):
        return jsonify({"error": "Provide bbox or lat+lon+radius"}), 400

    if not bbox:
        # approximate degree offsets for radius (works for small radii)
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

    start_time = time.time()

    bbox_str = f"{minlat},{minlon},{maxlat},{maxlon}"

    overpass_q = f"""
[out:json][timeout:25];
(
    node["reconstruction"]({bbox_str});
    way["reconstruction"]({bbox_str});
    relation["reconstruction"]({bbox_str});
    node["building"]({bbox_str});
    way["building"]({bbox_str});
    relation["building"]({bbox_str});
);
(._;>;);
out geom;
"""
    # server-side cache to avoid repeated heavy Overpass queries
    try:
        data = fetch_overpass_cached(overpass_q)
    except Exception as e:
        return jsonify({"error": "Overpass request failed", "details": str(e)}), 502

    # basic protection: avoid returning extremely large payloads
    elems = data.get('elements', [])
    if len(elems) > 5000:
        return jsonify({"error": "Too many elements in area. Reduce bbox or radius."}), 413

    # Build lookup maps for nodes, ways and relations
    nodes = {}
    ways = {}
    relations = []
    for el in elems:
        t = el.get('type')
        if t == 'node':
            nid = el.get('id')
            latn = el.get('lat')
            lonn = el.get('lon')
            if latn is None or lonn is None:
                continue
            nodes[nid] = (latn, lonn)
        elif t == 'way':
            wid = el.get('id')
            geom = el.get('geometry')
            if not geom:
                # sometimes ways don't have geometry, skip
                continue
            coords = [[p['lon'], p['lat']] for p in geom]
            ways[wid] = coords
        elif t == 'relation':
            relations.append(el)

    # Use Shapely to assemble multipolygons more robustly
    try:
        from shapely.geometry import LineString, Polygon, Point, MultiLineString
        from shapely.ops import linemerge, polygonize, unary_union
    except Exception as e:
        # Shapely not available -> fallback to simple assembly
        app.logger.warning('Shapely not available, falling back to simple assembly: %s', e)
        features = []
        used_way_ids = set()
        for wid, coords in ways.items():
            if len(coords) >= 4 and coords[0] == coords[-1]:
                feat = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]}, "properties": {}}
            else:
                feat = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {}}
            features.append(feat)
        for nid, (latn, lonn) in nodes.items():
            feat = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lonn, latn]}, "properties": {}}
            features.append(feat)
        geojson = {"type": "FeatureCollection", "features": features}
        return jsonify(geojson)

    features = []
    used_way_ids = set()

    # Process relations first: build polygons using polygonize from merged way segments
    for rel in relations:
        tags = rel.get('tags', {}) or {}
        members = rel.get('members', []) or []
        outer_lines = []
        inner_lines = []
        for m in members:
            if m.get('type') == 'way':
                ref = m.get('ref')
                role = m.get('role') or ''
                coords = ways.get(ref)
                if coords:
                    # Convert way coords to shapely LineString (lon,lat)
                    try:
                        ls = LineString(coords)
                        if not ls.is_empty:
                            if role == 'inner':
                                inner_lines.append(ls)
                            else:
                                outer_lines.append(ls)
                    except Exception:
                        continue
                    used_way_ids.add(ref)

        if not outer_lines:
            continue

        try:
            merged = linemerge(outer_lines) if len(outer_lines) > 1 else outer_lines[0]
            # polygonize returns polygons formed by the lines
            polys = list(polygonize(merged))
            # if no polygons found, try unioning lines and polygonize
            if not polys:
                unioned = unary_union(outer_lines)
                polys = list(polygonize(unioned))
        except Exception:
            polys = []

        # Map inner lines to holes by finding containing polygon
        inner_rings = [list(ls.coords) for ls in inner_lines]
        for poly in polys:
            holes = []
            for ring in inner_rings:
                try:
                    ring_poly = Polygon(ring)
                    if poly.contains(ring_poly.representative_point()):
                        holes.append(ring)
                except Exception:
                    continue
            exterior = list(poly.exterior.coords)
            hole_coords = [list(r) for r in holes]
            # build geojson polygon coordinates (list of rings)
            coords = [ [[float(x), float(y)] for x,y in exterior] ]
            for h in hole_coords:
                coords.append([[float(x), float(y)] for x,y in h])
            features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords}, "properties": tags})

    # add standalone ways (not part of relations)
    for wid, coords in ways.items():
        if wid in used_way_ids:
            continue
        try:
            if len(coords) >= 4 and coords[0] == coords[-1]:
                poly = Polygon(coords)
                if not poly.is_empty:
                    features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ [[float(x), float(y)] for x,y in poly.exterior.coords] ]}, "properties": {}})
                    continue
            # fallback: line
            features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[float(x), float(y)] for x,y in coords]}, "properties": {}})
        except Exception:
            continue

    # add nodes not part of ways
    node_coords_in_ways = set()
    for coords in ways.values():
        for lon, lat in coords:
            node_coords_in_ways.add((lat, lon))
    for nid, (latn, lonn) in nodes.items():
        if (latn, lonn) in node_coords_in_ways:
            continue
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(lonn), float(latn)]}, "properties": {}})

    geojson = {"type": "FeatureCollection", "features": features}
    elapsed = time.time() - start_time
    app.logger.debug(f"Overpass query time: {elapsed:.2f}s, features: {len(features)}")
    return jsonify(geojson)


@app.route('/api/overpass_stream')
def api_overpass_stream():
    """Stream Overpass results as NDJSON by tiling the requested bbox.

    Query params: same as /api/overpass (bbox or lat+lon+radius)
    Returns newline-delimited GeoJSON Feature objects as they are produced.
    """
    bbox = request.args.get('bbox')
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    radius = request.args.get('radius', type=float)

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

    # tiling parameters
    lat_span = maxlat - minlat
    lon_span = maxlon - minlon
    tile_deg = 0.02
    nx = min(8, max(1, int(math.ceil(lon_span / tile_deg))))
    ny = min(8, max(1, int(math.ceil(lat_span / tile_deg))))

    def assemble_features_from_elements(elems):
        nodes = {}
        ways = {}
        relations = []
        for el in elems:
            t = el.get('type')
            if t == 'node':
                nid = el.get('id')
                latn = el.get('lat')
                lonn = el.get('lon')
                if latn is None or lonn is None:
                    continue
                nodes[nid] = (latn, lonn)
            elif t == 'way':
                wid = el.get('id')
                geom = el.get('geometry')
                if not geom:
                    continue
                coords = [[p['lon'], p['lat']] for p in geom]
                ways[wid] = coords
            elif t == 'relation':
                relations.append(el)

        try:
            from shapely.geometry import LineString, Polygon
            from shapely.ops import linemerge, polygonize, unary_union
            use_shapely = True
        except Exception:
            use_shapely = False

        features = []
        if use_shapely:
            used_way_ids = set()
            for rel in relations:
                tags = rel.get('tags', {}) or {}
                members = rel.get('members', []) or []
                outer_lines = []
                inner_lines = []
                for m in members:
                    if m.get('type') == 'way':
                        ref = m.get('ref')
                        role = m.get('role') or ''
                        coords = ways.get(ref)
                        if coords:
                            try:
                                ls = LineString(coords)
                                if not ls.is_empty:
                                    if role == 'inner':
                                        inner_lines.append(ls)
                                    else:
                                        outer_lines.append(ls)
                            except Exception:
                                continue
                            used_way_ids.add(ref)

                if not outer_lines:
                    continue
                try:
                    merged = linemerge(outer_lines) if len(outer_lines) > 1 else outer_lines[0]
                    polys = list(polygonize(merged))
                    if not polys:
                        unioned = unary_union(outer_lines)
                        polys = list(polygonize(unioned))
                except Exception:
                    polys = []

                inner_rings = [list(ls.coords) for ls in inner_lines]
                for poly in polys:
                    holes = []
                    for ring in inner_rings:
                        try:
                            ring_poly = Polygon(ring)
                            if poly.contains(ring_poly.representative_point()):
                                holes.append(ring)
                        except Exception:
                            continue
                    exterior = list(poly.exterior.coords)
                    coords = [ [[float(x), float(y)] for x,y in exterior] ]
                    for h in holes:
                        coords.append([[float(x), float(y)] for x,y in h])
                    features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords}, "properties": tags})

            # add standalone ways
            for wid, coords in ways.items():
                if wid in used_way_ids:
                    continue
                try:
                    if len(coords) >= 4 and coords[0] == coords[-1]:
                        poly = Polygon(coords)
                        if not poly.is_empty:
                            features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ [[float(x), float(y)] for x,y in poly.exterior.coords] ]}, "properties": {}})
                            continue
                    features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[float(x), float(y)] for x,y in coords]}, "properties": {}})
                except Exception:
                    continue

            # add standalone nodes
            node_coords_in_ways = set()
            for coords in ways.values():
                for lon, lat in coords:
                    node_coords_in_ways.add((lat, lon))
            for nid, (latn, lonn) in nodes.items():
                if (latn, lonn) in node_coords_in_ways:
                    continue
                features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(lonn), float(latn)]}, "properties": {}})
        else:
            for wid, coords in ways.items():
                if len(coords) >= 4 and coords[0] == coords[-1]:
                    features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]}, "properties": {}})
                else:
                    features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {}})
            for nid, (latn, lonn) in nodes.items():
                features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lonn, latn]}, "properties": {}})

        return features

    def generate():
        for yi in range(ny):
            t_minlat = minlat + (lat_span * yi / ny)
            t_maxlat = minlat + (lat_span * (yi + 1) / ny)
            for xi in range(nx):
                t_minlon = minlon + (lon_span * xi / nx)
                t_maxlon = minlon + (lon_span * (xi + 1) / nx)
                t_bbox = f"{t_minlat},{t_minlon},{t_maxlat},{t_maxlon}"
                q = f"""
[out:json][timeout:25];
(
  node["reconstruction"]({t_bbox});
  way["reconstruction"]({t_bbox});
  relation["reconstruction"]({t_bbox});
  node["building"]({t_bbox});
  way["building"]({t_bbox});
  relation["building"]({t_bbox});
);
(._;>;);
out geom;
"""
                try:
                    d = fetch_overpass_cached(q)
                except Exception as e:
                    yield json.dumps({"_error": "overpass_failed", "details": str(e), "bbox": t_bbox}) + "\n"
                    continue
                elems_t = d.get('elements', [])
                if len(elems_t) > 5000:
                    yield json.dumps({"_error": "tile_too_large", "bbox": t_bbox, "elements": len(elems_t)}) + "\n"
                    continue
                feats = assemble_features_from_elements(elems_t)
                for f in feats:
                    yield json.dumps(f) + "\n"
        yield json.dumps({"_meta": {"status": "done"}}) + "\n"

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
        return jsonify({'error': 'countries data not available (could not download or parse)'}), 500
    return jsonify(data)


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
