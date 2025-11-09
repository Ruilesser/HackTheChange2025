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
def get_icon_for_element(element, icon_map):
    """
    Assign an icon based on tags:
    - Recreational amenities get generic recreational icon
    - Other amenities use value-specific icons if available, otherwise default
    - Natural uses one generic icon
    - Emergency uses value-specific icons
    - Other keys use default per key or global fallback
    """
    tags = element.get('tags', {})

    for key, value in tags.items():
        # --- Amenity ---
        if key == 'amenity':
            recreation_list = [
                "bar", "bbq", "brothel", "cafe", "cinema", "food_court",
                "marketplace", "nightclub", "restaurant", "swinger_club",
                "theatre", "vending_machine"
            ]
            if value in recreation_list:
                return icon_map['amenity'].get(value, icon_map['amenity']['_default'])
            # Non-recreation amenities: use value-specific icon if exists, else default
            return icon_map['amenity'].get(value, icon_map['amenity']['_default'])

        # --- Emergency ---
        if key == 'emergency':
            return icon_map['emergency'].get(value, icon_map['emergency']['_default'])

        # --- Natural ---
        if key == 'natural':
            return icon_map['natural']['_default']

        # --- Other keys ---
        if key in icon_map:
            return icon_map[key].get('_default', icon_map['_global_default']['_default'])

    # --- Global fallback ---
    return icon_map['_global_default']['_default']


def process_element(element, icon_map):
    """Compute center, elevation, and height (if any)."""
    lat = sum(p['lat'] for p in element['points']) / len(element['points'])
    lon = sum(p['lon'] for p in element['points']) / len(element['points'])
    base_elev = get_elevation(lat, lon)

    height_info = parse_height(element['tags']) if is_building(element) else {
        "height": 0.0,
        "min_height": 0.0,
        "effective_height": 0.0 # USE THIS
    }

    icon = get_icon_for_element(element, icon_map)
    xy = lonLatToMeters(lon, lat)

    return {
        'id': element['id'],
        'points': element['points'],
        'centroid': {'lat': lat, 'lon': lon},
        'xy': xy, # this is the coordinates to use on the map
        'base_elev': base_elev,
        **height_info,
        'tags': element['tags'],
        'icon': icon
    }

# -----------------------------------------------------------
# Main entry point
# -----------------------------------------------------------
def process_osm_json(json_string):
    """
    Process a full OSM JSON string.
    Returns a unified list of all elements, each with:
      - id, points, center, xy, base_elev
      - height/min_height/effective_height (if any)
      - tags
    """
    osm_data = json.loads(json_string)
    all_elements = extract_elements(osm_data)
    processed = [process_element(el, ICON_MAP) for el in all_elements]
    return processed
# for any buildings with height, please use effective_height

ICON_MAP = {
    # ------------------- AMENITY -------------------
    "amenity": {
        # --- Recreational amenities (generic icon) ---
        "bar": "icons/amenity_recreational.svg",
        "bbq": "icons/amenity_recreational.svg",
        "brothel": "icons/amenity_recreational.svg",
        "cafe": "icons/amenity_recreational.svg",
        "cinema": "icons/amenity_recreational.svg",
        "food_court": "icons/amenity_recreational.svg",
        "marketplace": "icons/amenity_recreational.svg",
        "nightclub": "icons/amenity_recreational.svg",
        "restaurant": "icons/amenity_recreational.svg",
        "swinger_club": "icons/amenity_recreational.svg",
        "theatre": "icons/amenity_recreational.svg",
        "vending_machine": "icons/amenity_recreational.svg",

        # --- Other amenities with value-specific icons ---
        "bicycle_parking": "icons/amenity_vehicle.svg",
        "bicycle_rental": "icons/amenity_vehicle.svg",
        "car_rental": "icons/amenity_vehicle.svg",
        "car_sharing": "icons/amenity_vehicle.svg",
        "fuel": "icons/amenity_vehicle.svg",
        "parking": "icons/amenity_vehicle.svg",

        "charging_station": "icons/amenity_charging_station.svg",

        "clinic": "icons/health.svg",
        "dentist": "icons/health.svg",
        "doctors": "icons/health.svg",
        "hospital": "icons/health.svg",
        "pharmacy": "icons/health.svg",

        "college": "icons/amenity_education.svg",
        "kindergarten": "icons/amenity_education.svg",
        "school": "icons/amenity_education.svg",

        "courthouse": "icons/amenity_public_building.svg",
        "fire_station": "icons/emergency_fire_station.svg",
        "police": "icons/emergency_police.svg",


        "ferry_terminal": "icons/amenity_ferry_terminal.svg",
        "grave_yard": "icons/amenity_grave_yard.svg",
        "library": "icons/amenity_library.svg",
        "place_of_worship": "icons/amenity_place_of_worship.svg",

        "post_box": "icons/amenity_post.svg",
        "post_office": "icons/amenity_post.svg",

        "prison": "icons/amenity_prison.svg",
        "public_building": "icons/amenity_public_building.svg",
        "recycling": "icons/amenity_recycling.svg",
        "shelter": "icons/amenity_shelter.svg",

        "taxi": "icons/amenity_taxi.svg",

        "telephone": "icons/amenity_telephone.svg",
        "toilets": "icons/amenity_toilets.svg",
        "townhall": "icons/amenity_public_building.svg",

        "drinking_water": "icons/water.svg",
        "water_point": "icons/water.svg",

        # --- Fallback for any other amenity ---
        "_default": "icons/amenity.svg"
    },

    # ------------------- NATURAL (single icon) -------------------
    "natural": {
        "_default": "icons/natural.svg"
    },

    # ------------------- EMERGENCY -------------------
    "emergency": {
        "ambulance_station": "icons/emergency_ambulance_station.svg",
        "fire_station": "icons/emergency_fire_station.svg",
        "lifeguard_station": "icons/emergency_lifeguard_station.svg",
        "police": "icons/emergency_police.svg",
        "first_aid": "icons/emergency_first_aid.svg",
        "defibrillator": "icons/emergency_first_aid.svg",
        "assembly_point": "icons/emergency_assembly_point.svg",
        "_default": "icons/emergency.svg"
    },

    # ------------------- OTHER KEYS (generic default per key) -------------------
    "aerialway":   {"_default": "icons/aerialway.svg"},
    "aeroway":     {"_default": "icons/aerialway.svg"},
    "barrier":     {"_default": "icons/barrier.svg"},
    "boundary":    {"_default": "icons/barrier.svg"},
    "building":    {"_default": "icons/building.svg"},
    "craft":       {"_default": "icons/craft.svg"},
    "geological":  {"_default": "icons/geological.svg"},
    "healthcare":  {"_default": "icons/health.svg"},
    "highway":     {"_default": "icons/highway.svg"},
    "historic":    {"_default": "icons/historic.svg"},
    "landuse":     {"_default": "icons/landuse.svg"},
    "leisure":     {"_default": "icons/leisure.svg"},
    "man_made":    {"_default": "icons/man_made.svg"},
    "military":    {"_default": "icons/military.svg"},
    "office":      {"_default": "icons/office.svg"},
    "place":       {"_default": "icons/place.svg"},
    "power":       {"_default": "icons/power.svg"},
    "public_transport": {"_default": "icons/public_transport.svg"},
    "railway":     {"_default": "icons/route.svg"},
    "route":       {"_default": "icons/route.svg"},
    "shop":        {"_default": "icons/shop.svg"},
    "telecom":     {"_default": "icons/telecom.svg"},
    "tourism":     {"_default": "icons/tourism.svg"},
    "water":       {"_default": "icons/water.svg"},
    "waterway":    {"_default": "icons/water.svg"},
    
    # ------------------- GLOBAL FALLBACK -------------------
    "_global_default": {"_default": "icons/default.svg"}
}

# MUST USE THIS TO GET ICON