from flask import Flask, redirect, url_for, request, render_template, jsonify
from markupsafe import escape
import requests\


app = Flask(__name__) 


@app.route('/about')
def about():
        #return 'This is the about page and what we do'
        return render_template('about.html')

# OpenStreetMap API
#V----------------------------------------------------------------------------------------V
"""
search_location GET
"""
@app.route('/search')
def search_location():
        query = request.args.get('q', 'Calgary, Alberta') # DEFAULT values

        url = "https://nominatim.openstreetmap.org/search"
        params = {
                'q': query,
                'format': 'json',
                'limit': 5
        }
        headers = {
                'User-Agent': 'HackTheChange2025 (defaultEmail@gmail.com)'
        }
        
        response = requests.get(url, params=params, headers=headers)
        data = response.json()
        
        return jsonify(data)

"""
reverse coordinates to address GET
"""
@app.route('/revese')
def reverse_coords():
        lat = request.args.get('lat')
        long = request.args.get('lon')

        # input validation
        if not lat or not long:
                return jsonify({'error':  'lat and long parameters are invalid format OR missing'}), 400
        
        url = "https://nominatim.openstreetmap.org/reverse"
        params = {
                'lat': lat,
                'lon': long,
                'format': 'json'
        }
        headers = {
                'User-Agent': 'HackTheChange2025 (defaultEmail@gmail.com)'
        }
        
        response = requests.get(url, params=params, headers=headers)
        data = response.json()
        
        return jsonify(data)
#^----------------------------------------------------------------------------------------^
# Overpass API
#V----------------------------------------------------------------------------------------V
"""
Overpass API - Get features around a point
"""
@app.route('/overpass')
def overpass_query():
        lat = request.args.get('lat')
        long = request.args.get('lon')
        radius = request.args.get('radius', '1000')  # default 1000 meters <-- dynamically enter the zoom scale from our main map page
        
        # input validation
        if not lat or not long:
                return jsonify({'error': 'lat and lon parameters are required'}), 400
        
        try:
                lat = float(lat)
                long = float(long)
                radius = int(radius)
        except ValueError:
                return jsonify({'error': 'Invalid parameter format'}), 400
        
        url = "https://overpass-api.de/api/interpreter"
        
        overpass_query = f"""
        [out:json];
        (
          node(around:{radius},{lat},{long});
          way(around:{radius},{lat},{long});
          relation(around:{radius},{lat},{long});
        );
        out body;
        >;
        out skel qt;
        """
        
        response = requests.post(url, data={'data': overpass_query})
        data = response.json()
        
        return jsonify(data)

"""
Overpass API - Get specific amenities (restaurants, parks, etc.)
"""
@app.route('/overpass/amenities')
def overpass_amenities():
        lat = request.args.get('lat')
        long = request.args.get('lon')
        radius = request.args.get('radius', '1000')
        amenity_type = request.args.get('type', 'restaurant')  # restaurant, hospital, school, etc.
        
        if not lat or not long:
                return jsonify({'error': 'lat and lon parameters are required'}), 400
        
        try:
                lat = float(lat)
                long = float(long)
                radius = int(radius)
        except ValueError:
                return jsonify({'error': 'Invalid parameter format'}), 400
        
        url = "https://overpass-api.de/api/interpreter"
        
        # Query for specific amenity types
        overpass_query = f"""
        [out:json];
        (
          node["amenity"="{amenity_type}"](around:{radius},{lat},{long});
          way["amenity"="{amenity_type}"](around:{radius},{lat},{long});
        );
        out body;
        >;
        out skel qt;
        """
        
        response = requests.post(url, data={'data': overpass_query})
        data = response.json()
        
        return jsonify(data)
#^----------------------------------------------------------------------------------------^


if __name__ == '__main__':
        print("Working")
        app.run(debug=True)
