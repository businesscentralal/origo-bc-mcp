FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pm2 && npm cache clean --force
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
COPY ecosystem.config.cjs ./
USER node
EXPOSE 3000
CMD ["pm2-runtime", "ecosystem.config.cjs"]
