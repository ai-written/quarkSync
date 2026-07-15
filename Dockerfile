FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js config.example.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p /app/config /app/logs /app/downloads

VOLUME ["/app/config"]
VOLUME ["/app/logs"]
VOLUME ["/app/downloads"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "index.js", "schedule"]
