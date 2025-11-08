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

if __name__ == '__main__':
        print("Working")
        app.run(debug=True)
