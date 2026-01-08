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

app = FastAPI()
MAX_CONTENT_LENGTH = 50 * 1024 * 1024 
templates = Jinja2Templates(directory="templates")