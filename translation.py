import math
import requests

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

def process_building(building):
    lat = sum(p['lat'] for p in building['points']) / len(building['points'])
    lon = sum(p['lon'] for p in building['points']) / len(building['points'])
    base_elev = get_elevation(lat, lon)
    height = parse_height(building['tags'])  # parse from OSM
    return {
        'points': building['points'],
        'base_elev': base_elev,
        'height': height
    }