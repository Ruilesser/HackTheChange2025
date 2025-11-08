import math

def lonLatToMeters(lon, lat):
    RADIUS = 6378137.0  # Earth's radius in meters (WGS84)
    x = lon * RADIUS * math.pi / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) * RADIUS
    return {"x": x, "y": y}
