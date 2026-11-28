# 1) Build stage
# Node 22 matches CI (pipeline.yml builds and tests on 22); Node 20 is past end of life.
FROM node:22-alpine AS builder

# Create app directory
WORKDIR /app

# Install dependencies first (leverages Docker layer caching)
COPY package*.json ./
# Throttled so the install survives a slow link: npm's default ~15 parallel
# tarball downloads split thin bandwidth until every one hits ETIMEDOUT, and
# npm then dies with "Exit handler never called!". Three sockets, a 10-minute
# per-request timeout and patient retries cost nothing on a fast link (CI).
RUN npm ci --no-audit --no-fund \
      --maxsockets=3 \
      --fetch-timeout=600000 \
      --fetch-retries=6 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000

# Copy the rest of the source and build
COPY . .
RUN npm run build -- --debug

# Precompress every text asset once, at build time (plan 45): nginx's
# gzip_static serves the .gz to browsers that accept it, so the 5 MB of
# JavaScript goes over the wire at about a quarter of its size with no
# per-request CPU. Files under 1 KB aren't worth a second copy.
RUN find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.html' -o -name '*.json' -o -name '*.txt' \) \
      -size +1k -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;


# 2) Runtime stage
# nginx 1.30 is the supported stable line. Move with it: an old line stops
# getting rebuilt (1.28-alpine froze at 1.28.3-r1 with five fixable CRITICAL
# nginx CVEs, so CD's Trivy gate rejected every UI release). The `apk upgrade`
# picks up Alpine security fixes published after the base image was cut.
FROM nginx:1.30-alpine

RUN apk upgrade --no-cache

ENV BFF_BASE_URL=http://dialogue_bridge:8002

# Copy the compiled static files from previous stage
COPY --from=builder /app/dist /usr/share/nginx/html

# The release tag, passed in by CD (`--build-arg APP_VERSION=v0.15.14`), served
# as /version.txt. The deploy job polls it to confirm the new UI is live. A
# static file rather than an nginx template variable: the Dennis TLS entrypoint
# renders the template, and an unsubstituted variable would stop nginx booting.
ARG APP_VERSION=dev
RUN printf '%s\n' "$APP_VERSION" > /usr/share/nginx/html/version.txt

# Shim that loads swarm secrets from /run/secrets/* into env vars before exec'ing
# the next command. Required because nginx envsubst can't read files directly.
COPY load-secrets-and-exec.sh /usr/local/bin/load-secrets-and-exec.sh
RUN chmod +x /usr/local/bin/load-secrets-and-exec.sh

# Remove default Nginx config; the base nginx entrypoint renders templates from env vars.
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# The shared security headers the server block and the cached static locations
# include. Outside conf.d on purpose: conf.d/*.conf is loaded at http level.
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
