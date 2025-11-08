from flask import Flask, render_template, request, jsonify
import requests
import math
from functools import lru_cache
import time

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



@lru_cache(maxsize=64)
def fetch_overpass_cached(q_text):
    """Cached Overpass fetch. q_text (string) is used as cache key."""
    url = 'https://overpass-api.de/api/interpreter'
    r = requests.post(url, data={'data': q_text}, timeout=30)
    r.raise_for_status()
    return r.json()


if __name__ == '__main__':
    print("Working")
    # enable threaded to improve responsiveness for concurrent requests in dev
    app.run(debug=True, threaded=True)
