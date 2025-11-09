import math
import requests
import json

def lonLatToMeters(lon, lat):
    RADIUS = 6378137.0  # Earth's radius in meters (WGS84)
    x = lon * RADIUS * math.pi / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) * RADIUS
    return {"x": x, "y": y}

def get_elevation(lat, lon):
    #Get elevation (m) for given coordinates using OpenTopoData SRTM90m
    url = f"https://api.opentopodata.org/v1/srtm90m?locations={lat},{lon}"
    r = requests.get(url)
    data = r.json()
    if 'results' in data and len(data['results']) > 0:
        return data['results'][0].get('elevation', 0.0)
    return 0.0


# Height parsing ------------------------------------------------
# Building heights
def parse_height(tags):
    """Parse building height and min_height if available."""
    def safe_float(value):
        try:
            return float(value.lower().replace("m", "").strip())
        except Exception:
            return None

    height = safe_float(tags.get("height", ""))
    min_height = safe_float(tags.get("min_height", tags.get("building:min_height", "")))
    levels = safe_float(tags.get("building:levels", ""))
    min_levels = safe_float(tags.get("building:min_level", ""))

    # height if missing
    if height is None and levels is not None:
        height = levels * 3.0
    if min_height is None and min_levels is not None:
        min_height = min_levels * 3.0

    # Fallbacks - check for heights
    if height is None:
        height = 10.0 if "building" in tags else 0.0
    if min_height is None:
        min_height = 0.0

    return {
        "height": height,
        "min_height": min_height,
        "effective_height": max(0.0, height - min_height) # USE THIS FOR HEIGHT ON MAP
    }

# -----------------------------------------------------------
# OSM extraction
# -----------------------------------------------------------
def extract_elements(osm_json):
    """
    Extract all 'way' elements from full JSON
    
    node coordinates into lat/lon points.
    
    Returns a list of dicts like:
        { 'points': [...], 'tags': {...}, 'type': 'way' }
    You can filter by tag (e.g. 'building', 'highway')
    """
    elements = osm_json.get('elements', [])
    nodes = {n['id']: n for n in elements if n['type'] == 'node'}

    extracted = []
    for el in elements:
        if el['type'] == 'way':
            points = [
                {'lat': nodes[nid]['lat'], 'lon': nodes[nid]['lon']}
                for nid in el.get('nodes', [])
                if nid in nodes
            ]
            if points:
                extracted.append({
                    'points': points,
                    'tags': el.get('tags', {}),
                    'id': el.get('id'),
                    'type': el['type']
                })
    return extracted

def is_building(element):
    #True if element is a building (has 'building' tag)
    return 'building' in element.get('tags', {})

# -----------------------------------------------------------
# Processing functions
# -----------------------------------------------------------
def process_element(element):
    """Compute center, elevation, and height (if any)."""
    lat = sum(p['lat'] for p in element['points']) / len(element['points'])
    lon = sum(p['lon'] for p in element['points']) / len(element['points'])
    base_elev = get_elevation(lat, lon)

    height_info = parse_height(element['tags']) if is_building(element) else {
        "height": 0.0,
        "min_height": 0.0,
        "effective_height": 0.0 # USE THIS
    }

    return {
        'id': element['id'],
        'points': element['points'],
        'centroid': {'lat': lat, 'lon': lon},
        'base_elev': base_elev,
        **height_info,
        'tags': element['tags']
    }

# -----------------------------------------------------------
# Main entry point
# -----------------------------------------------------------
def process_osm_json(json_string):
    """
    Process a full OSM JSON string.
    Returns a unified list of all elements, each with:
      - id, points, center, base_elev
      - height/min_height/effective_height (if any)
      - tags
    """
    osm_data = json.loads(json_string)
    all_elements = extract_elements(osm_data)
    processed = [process_element(el) for el in all_elements]
    return processed
# for any buildings with height, please use effective_height