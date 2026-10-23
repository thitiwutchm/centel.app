# Railway: serve the static PWA with Caddy. Railway sets $PORT.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY . /srv/
