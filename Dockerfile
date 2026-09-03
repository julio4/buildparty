FROM node:24.14.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24.14.0-alpine
WORKDIR /app
ENV NODE_ENV=production STATIC_DIR=/app/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY db ./db
EXPOSE 3001
CMD ["sh", "-c", "node --import tsx src/migrate.ts && node --import tsx src/server.ts"]
