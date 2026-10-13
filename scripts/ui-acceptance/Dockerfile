FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts/ui-acceptance ./scripts/ui-acceptance
RUN npx prisma generate
USER node
CMD ["node", "--import", "tsx", "scripts/ui-acceptance/server.ts"]
