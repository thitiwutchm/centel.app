# Railway: serve the static PWA with Caddy. Railway sets $PORT.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html styles.css app.js sw.js manifest.webmanifest /srv/
COPY icons /srv/icons
