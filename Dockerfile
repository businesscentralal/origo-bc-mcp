# --- Build stage ----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install PM2 globally for process management + auto-restart
RUN npm install -g pm2 && npm cache clean --force

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY ecosystem.config.cjs ./

# Non-root
USER node
EXPOSE 3000
CMD ["pm2-runtime", "ecosystem.config.cjs"]
