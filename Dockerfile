FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM dependencies AS web-build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ENTRA_CLIENT_ID
ARG NEXT_PUBLIC_ENTRA_TENANT_ID
ARG NEXT_PUBLIC_ENTRA_API_SCOPE
ARG NEXT_PUBLIC_ENTRA_REDIRECT_URI
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_ENTRA_CLIENT_ID=$NEXT_PUBLIC_ENTRA_CLIENT_ID \
    NEXT_PUBLIC_ENTRA_TENANT_ID=$NEXT_PUBLIC_ENTRA_TENANT_ID \
    NEXT_PUBLIC_ENTRA_API_SCOPE=$NEXT_PUBLIC_ENTRA_API_SCOPE \
    NEXT_PUBLIC_ENTRA_REDIRECT_URI=$NEXT_PUBLIC_ENTRA_REDIRECT_URI \
    NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
RUN npm run build --workspace=web
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=web"]

FROM dependencies AS api-build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=api-build --chown=node:node /app /app
COPY --chown=node:node apps/api apps/api
USER node
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace=api"]
