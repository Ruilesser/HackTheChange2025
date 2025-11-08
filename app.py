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


if __name__ == '__main__':
        print("Working")
        app.run(debug=True)
