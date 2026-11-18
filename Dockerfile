FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY server/package.json server/tsconfig.json ./server/
COPY client/package.json client/tsconfig.json client/vite.config.ts ./client/

RUN npm ci

COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_URL=/app/data/patrol.db

EXPOSE 3001
CMD ["npm", "run", "start"]
