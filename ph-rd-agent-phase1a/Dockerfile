# Builds and runs the P&H R&D Agent worker + operations console as ONE service.
FROM node:22-slim AS build
WORKDIR /app
COPY worker/package.json worker/package-lock.json worker/
RUN cd worker && npm ci
COPY worker worker
COPY supabase supabase
RUN cd worker && npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/worker/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
