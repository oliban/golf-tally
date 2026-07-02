# Static site served by nginx — no Node, no database, no volume.
FROM nginx:1.27-alpine

# Custom config: correct MIME for .webmanifest, no-cache on the HTML/SW so
# updates land immediately, long cache for hashed-ish static assets.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# App files
COPY index.html styles.css app.js courses.js manifest.webmanifest sw.js /usr/share/nginx/html/
COPY icons/ /usr/share/nginx/html/icons/

EXPOSE 80
