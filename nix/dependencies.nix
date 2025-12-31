{
  pkgs,
}:
pkgs.python3.withPackages (
  python-pkgs: with python-pkgs; [
    flask
    psycopg2-binary
    psycopg2
    trueskill
    numpy
    bcrypt
    requests
    flask-wtf
    gunicorn
  ]
)
