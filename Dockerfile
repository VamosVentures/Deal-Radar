# Vamos Deal Radar — container image.
# Not deployed by this repo; prepared so a future hosting decision is
# easier. Build only — see TECHNICAL_HANDOFF.md for persistent-volume
# and backup requirements before running this anywhere real.

# ── Build stage ─────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Fail the image build if the app itself is broken — the same gate
# used everywhere else in this project.
RUN npm run typecheck && npm test -- --run && npm run lint && npm run build

# ── Runtime stage ───────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY src/types.ts ./src/types.ts
COPY src/lib/scoring.ts ./src/lib/scoring.ts
COPY src/data ./src/data

# server/.data holds the SQLite database and its backups/ subfolder —
# mount a persistent volume here in any real deployment, or the data
# (and every backup) disappears with the container.
RUN mkdir -p /app/server/.data \
  && addgroup --system --gid 1001 dealradar \
  && adduser --system --uid 1001 --gid 1001 dealradar \
  && chown -R dealradar:dealradar /app/server/.data
VOLUME ["/app/server/.data"]
USER dealradar

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
