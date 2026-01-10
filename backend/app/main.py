from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

import math
from functools import lru_cache
import time
import json
import os

# Documentation for this I believe
app = FastAPI(
    title = "PlanetPulse Map API",
    description = "API designed to gather information and produce results based on location data",
    version = "0.1.0",
    docs_url = "/docs",
    redoc_url = "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"], # GET, POST, PUT
    allow_headers=["*"], # additional information to send
)

# if designed so that we run the import if we run the main python file directly
if __name__ == "__main__":
        import uvicorn # webserver
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
