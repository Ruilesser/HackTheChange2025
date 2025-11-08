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
  node["building"]({bbox_str});
  way["building"]({bbox_str});
);
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

    features = []
    elems = elems
    for el in elems:
        tags = el.get('tags', {})
        if el.get('type') == 'node':
            latn = el.get('lat')
            lonn = el.get('lon')
            if latn is None or lonn is None:
                continue
            feat = {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lonn, latn]},
                "properties": tags
            }
            features.append(feat)
        elif el.get('type') == 'way':
            geom = el.get('geometry')
            if not geom:
                continue
            coords = [[p['lon'], p['lat']] for p in geom]
            # if closed ring, treat as polygon
            if len(coords) >= 4 and coords[0] == coords[-1]:
                feat = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]}, "properties": tags}
            else:
                feat = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": tags}
            features.append(feat)
        # relations are ignored for now (could be expanded later)

    geojson = {"type": "FeatureCollection", "features": features}
    # add timing info (debug only) in server logs and return geojson payload
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
