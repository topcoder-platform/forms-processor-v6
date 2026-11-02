ARG NODE_VERSION=26.12.1
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY tools ./tools
RUN npm ci
COPY . .
RUN npm run lint && npm run typecheck && npm test && npm run test:dependency-compat && npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM alpine:3.24 AS runtime
ARG NODE_VERSION
WORKDIR /app
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates "nodejs-current~${NODE_VERSION%%.*}" \
    && addgroup -S -g 10001 app \
    && adduser -S -D -u 10001 -G app app
COPY --from=production-dependencies --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY deploy/certs/us-east-1-bundle.pem ./deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
