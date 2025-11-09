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
    
    # optional observer for server-side hemisphere/backface culling
    observer_lat = request.args.get('observer_lat', type=float)
    observer_lon = request.args.get('observer_lon', type=float)
    observer_vec = None
    if observer_lat is not None and observer_lon is not None:
        observer_vec = _latlon_to_unit_vec(observer_lat, observer_lon)

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

    # server-side hemisphere/backface culling: if an observer is provided,
    # exclude features whose representative point lies on the far side of the globe
    if observer_vec is not None:
        filtered = []
        for feat in features:
            geom = feat.get('geometry')
            lat_rep, lon_rep = _rep_latlon_from_geom(geom)
            if lat_rep is None or lon_rep is None:
                # keep features we cannot classify
                filtered.append(feat)
                continue
            v = _latlon_to_unit_vec(lat_rep, lon_rep)
            dot = v[0] * observer_vec[0] + v[1] * observer_vec[1] + v[2] * observer_vec[2]
            if dot > 0:
                filtered.append(feat)
        geojson['features'] = filtered

    elapsed = time.time() - start_time
    app.logger.debug(f"Overpass query time: {elapsed:.2f}s, features: {len(geojson.get('features', []))}")
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
    # optional observer for hemisphere/backface culling
    observer_lat = request.args.get('observer_lat', type=float)
    observer_lon = request.args.get('observer_lon', type=float)
    observer_vec = None
    if observer_lat is not None and observer_lon is not None:
        observer_vec = _latlon_to_unit_vec(observer_lat, observer_lon)
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
                    # server-side hemisphere/backface culling per-feature (optional)
                    if observer_vec is not None:
                        geom = f.get('geometry')
                        lat_rep, lon_rep = _rep_latlon_from_geom(geom)
                        if lat_rep is not None and lon_rep is not None:
                            v = _latlon_to_unit_vec(lat_rep, lon_rep)
                            dot = v[0] * observer_vec[0] + v[1] * observer_vec[1] + v[2] * observer_vec[2]
                            if dot <= 0:
                                # behind the globe relative to the observer, skip
                                continue
                    yield json.dumps(f) + "\n"
        yield json.dumps({"_meta": {"status": "done"}}) + "\n"

    return Response(generate(), mimetype='application/x-ndjson')


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

    try:
        max_depth = int(request.args.get('max_depth', 3))
    except Exception:
        max_depth = 3
    try:
        max_requests = int(request.args.get('max_requests', 80))
    except Exception:
        max_requests = 80

    # build tile grid
    lat_span = maxlat - minlat
    lon_span = maxlon - minlon
    tile_deg = float(request.args.get('tile_deg', 0.02))
    nx = min(12, max(1, int(math.ceil(lon_span / tile_deg))))
    ny = min(12, max(1, int(math.ceil(lat_span / tile_deg))))

    # find anchor country nearest to center
    country_idx = get_country_index()
    center_lat = (minlat + maxlat) / 2.0
    center_lon = (minlon + maxlon) / 2.0
    def haversine_m(a_lat, a_lon, b_lat, b_lon):
        # approximate distance in meters
        dlat = math.radians(b_lat - a_lat)
        dlon = math.radians(b_lon - a_lon)
        la = math.radians(a_lat); lb = math.radians(b_lat)
        s = math.sin(dlat/2.0)**2 + math.cos(la)*math.cos(lb)*math.sin(dlon/2.0)**2
        c = 2 * math.atan2(math.sqrt(s), math.sqrt(max(0.0, 1 - s)))
        return 6371000.0 * c

    anchor = None
    bestd = float('inf')
    for c in country_idx:
        try:
            clat, clon = c.get('centroid', (None, None))
            if clat is None: continue
            d = haversine_m(center_lat, center_lon, clat, clon)
            if d < bestd:
                bestd = d; anchor = c
        except Exception:
            continue

    # build list of tiles with center distances to anchor (or to bbox center if no anchor)
    tiles = []
    for yi in range(ny):
        t_minlat = minlat + (lat_span * yi / ny)
        t_maxlat = minlat + (lat_span * (yi + 1) / ny)
        for xi in range(nx):
            t_minlon = minlon + (lon_span * xi / nx)
            t_maxlon = minlon + (lon_span * (xi + 1) / nx)
            t_clat = (t_minlat + t_maxlat) / 2.0
            t_clon = (t_minlon + t_maxlon) / 2.0
            if anchor:
                d = haversine_m(t_clat, t_clon, anchor['centroid'][0], anchor['centroid'][1])
            else:
                d = haversine_m(t_clat, t_clon, center_lat, center_lon)
            tiles.append({'bbox': (t_minlat, t_minlon, t_maxlat, t_maxlon), 'center_dist': d})

    # sort tiles by proximity and stream in that order
    tiles.sort(key=lambda x: x['center_dist'])

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

    def gen():
        req_count = 0
        for tile in tiles:
            t_minlat, t_minlon, t_maxlat, t_maxlon = tile['bbox']
            t_bbox = f"{t_minlat},{t_minlon},{t_maxlat},{t_maxlon}"
            if req_count >= max_requests:
                yield json.dumps({"_error": "request_budget_exceeded", "bbox": t_bbox, "count": req_count}) + "\n"
                break
            # small ids-only query to measure size
            q_ids = f"""
[out:json][timeout:15];
(
  node["reconstruction"]({t_bbox});
  way["reconstruction"]({t_bbox});
  relation["reconstruction"]({t_bbox});
  node["building"]({t_bbox});
  way["building"]({t_bbox});
  relation["building"]({t_bbox});
);
out ids;
"""
            try:
                d_ids = fetch_overpass_cached(q_ids)
                req_count += 1
            except Exception as e:
                yield json.dumps({"_error": "overpass_failed", "details": str(e), "bbox": t_bbox}) + "\n"
                continue
            count = len(d_ids.get('elements', []))
            # always emit a lightweight summary so client can render density hints
            yield json.dumps({"_tile_summary": {"bbox": t_bbox, "elements": count}}) + "\n"
            # if count small, fetch full geometry and yield features
            if count > 0 and count <= 1500:
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
                    req_count += 1
                except Exception as e:
                    yield json.dumps({"_error": "overpass_failed", "details": str(e), "bbox": t_bbox}) + "\n"
                    continue
                try:
                    elems_t = d.get('elements', [])
                    feats = assemble_features_from_elements(elems_t)
                    for f in feats:
                        yield json.dumps(f) + "\n"
                except Exception as e:
                    yield json.dumps({"_error": "assembly_failed", "details": str(e), "bbox": t_bbox}) + "\n"
            # small pause to be polite
            try:
                time.sleep(0.06)
            except Exception:
                pass
        # done
        yield json.dumps({"_meta": {"status": "done", "requested_tiles": len(tiles), "requests_made": req_count}}) + "\n"

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

    # optional server-side observer for hemisphere/backface culling
    observer_lat = request.args.get('observer_lat', type=float)
    observer_lon = request.args.get('observer_lon', type=float)
    observer_vec = None
    if observer_lat is not None and observer_lon is not None:
        observer_vec = _latlon_to_unit_vec(observer_lat, observer_lon)

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
                    # server-side backface culling: if observer provided and centroid exists, skip far-side features
                    if observer_vec is not None and 'centroid' in out_props:
                        try:
                            c_lon, c_lat = float(out_props['centroid'][0]), float(out_props['centroid'][1])
                            v = _latlon_to_unit_vec(c_lat, c_lon)
                            dot = v[0] * observer_vec[0] + v[1] * observer_vec[1] + v[2] * observer_vec[2]
                            if dot <= 0:
                                # not visible from observer hemisphere
                                continue
                        except Exception:
                            pass
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
                    # fallback path: perform same centroid-based backface cull if possible
                    if observer_vec is not None and out_props.get('centroid'):
                        try:
                            c_lon, c_lat = float(out_props['centroid'][0]), float(out_props['centroid'][1])
                            v = _latlon_to_unit_vec(c_lat, c_lon)
                            dot = v[0] * observer_vec[0] + v[1] * observer_vec[1] + v[2] * observer_vec[2]
                            if dot <= 0:
                                continue
                        except Exception:
                            pass
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
