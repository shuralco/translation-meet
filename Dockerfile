FROM node:20-bullseye-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production --no-audit --prefer-offline

COPY public ./public
COPY server.js ./server.js
COPY README.md ./README.md

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
