# Railway: serve the static PWA with Caddy. Railway sets $PORT.
FROM caddy:2-alpine
COPY . /srv/
RUN mv /srv/Caddyfile /etc/caddy/Caddyfile
