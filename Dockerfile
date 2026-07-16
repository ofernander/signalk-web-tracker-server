# signalk-web-tracker server
# Node 24 = current Active LTS (2026), well past the 22.5 floor node:sqlite needs.
# slim (Debian) rather than alpine to avoid musl edge cases with the built-in
# sqlite; still small.
FROM node:24-slim

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application source.
COPY src ./src
COPY public ./public

# The sqlite database lives here; mount a volume at this path to persist it.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Plain HTTP inside the container; the reverse proxy terminates TLS.
EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
