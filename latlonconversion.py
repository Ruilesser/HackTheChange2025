from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates

import requests
import math
from functools import lru_cache
import time
import json
import os

# Helpers for spherical math and geometry rep extraction
def _latlon_to_unit_vec(lat, lon):
    """Convert geographic lat,lon to a unit 3D vector (x,y,z) on a unit sphere.

    Uses the same convention as client latLonToVector3 (right-handed mapping).
    """
    lat = math.radians(lat)
    lon = math.radians(lon)

    x = math.cos(lat) * math.cos(lon)
    y = math.sin(lat)
    z = math.cos(lat) * math.sin(lon)
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