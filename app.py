from flask import Flask, redirect, url_for, request, render_template
from markupsafe import escape

app = Flask(__name__) 

@app.route('/about')
def about():
    #return 'This is the about page and what we do'
    return render_template('about.html')

@app.route('/test')
def test():
    #return 'This is the about page and what we do'
    return render_template('test.html')

@app.route('/contact')
def contact():
    #return 'This is the about page and what we do'
    return render_template('contact.html')

@app.route('/map')
def map():
    #return 'This is the about page and what we do'
    return render_template('map.html')

@app.route('/')
def home():
     return render_template('home.html')

if __name__ == '__main__':
    print("Working")
    app.run(debug=True)
