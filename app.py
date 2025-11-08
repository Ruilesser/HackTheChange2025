from flask import Flask, redirect, url_for, request, render_template
from markupsafe import escape
import mysql.connector

app = Flask(__name__) 

@app.route('/about')
def about():
        #return 'This is the about page and what we do'
        return render_template('about.html')

if __name__ == '__main__':
        print("Working")
        app.run(debug=True)
