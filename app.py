from flask import Flask, redirect, url_for, request, render_template
from markupsafe import escape
import mysql.connector

app = Flask(__name__) 

if __name__ == '__main__':
    print("Working")
    app.run(debug=True)
