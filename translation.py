import math
import requests
import json

def lonLatToMeters(lon, lat):
    RADIUS = 6378137.0  # Earth's radius in meters (WGS84)
    x = lon * RADIUS * math.pi / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) * RADIUS
    return {"x": x, "y": y}

def get_elevation(lat, lon):
    # This uses USGS 90m resolution horizontally, works for this projects accuracy
    url = f"https://api.opentopodata.org/v1/srtm90m?locations={lat},{lon}"
    r = requests.get(url)
    data = r.json()
    if 'results' in data and len(data['results']) > 0:
        return data['results'][0]['elevation']
    return 0.0

def parse_height(tags):
    """Parse height from OSM tags."""
    height = tags.get("height")
    if height:
        try:
            return float(height.lower().replace("m", "").strip()) # in case JSON inconsistent with m
        except ValueError:
            pass

    levels = tags.get("building:levels")
    if levels:
        try:
            return float(levels) * 3  # assume 3 m per floor
        except ValueError:
            pass

    return 10.0  # default height for buildings (such as houses not having heights)


# --- Extraction + Processing ----------------------------------------

def extract_elements(osm_json):
    """
    Extract all 'way' elements from full JSON
    
    node coordinates into lat/lon points.
    
    Returns a list of dicts like:
        { 'points': [...], 'tags': {...}, 'type': 'way' }
    You can later filter by tag (e.g. 'building', 'highway', etc.)
    """
    elements = osm_json.get('elements', [])
    nodes = {n['id']: n for n in elements if n['type'] == 'node'}

    extracted = []

    for x in elements:
        if x['type'] == 'way':
            points = []
            for node_id in x['nodes']:
                node = nodes.get(node_id)
                if node:
                    points.append({'lat': node['lat'], 'lon': node['lon']})
            if points:
                extracted.append({
                    'points': points,
                    'tags': x.get('tags', {}),
                    'id': x.get('id'),
                    'type': x['type']
                })
    return extracted

# condition for is building because we want height
def is_building(element):
    """Check if the OSM element represents a building."""
    tags = element.get('tags', {})
    return 'building' in tags

def process_building(building):
    """Compute centroid, base elevation, and height for one building."""
    lat = sum(p['lat'] for p in building['points']) / len(building['points'])
    lon = sum(p['lon'] for p in building['points']) / len(building['points'])
    base_elev = get_elevation(lat, lon)
    height = parse_height(building['tags'])
    return {
        'points': building['points'],
        'base_elev': base_elev,
        'height': height,
        'tags': building['tags']
    }


# CALL THIS THIS IS THE ONE YOU WANT
def process_osm_json(json_string):
    """
    Process a full Overpass JSON string:
    - Extracts all elements (ways)
    - Processes buildings (adds elevation + height)
    - Returns both building data and other features with coordinates
    """
    osm_data = json.loads(json_string)
    all_elements = extract_elements(osm_data)

    # Buildings (with height/elevation info)
    buildings = [el for el in all_elements if is_building(el)]
    processed_buildings = [process_building(b) for b in buildings]

    # Non-building features (roads, parks, etc.)
    other_features = [el for el in all_elements if not is_building(el)]

    return {
        "buildings": processed_buildings,
        "other_features": other_features  # still contains coords + tags
    }
