# --- build ---------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime -------------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The generated client is tied to this node_modules tree, so it is regenerated
# here rather than copied across from the build stage. The prisma CLI is a
# runtime dependency on purpose: the api container runs `prisma migrate deploy`
# on startup.
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY start-hosted.sh ./

USER node

EXPOSE 4000

# The worker runs from this same image with the command overridden in compose.
# Render overrides it with start-hosted.sh (see render.yaml).
CMD ["node", "dist/server.js"]
