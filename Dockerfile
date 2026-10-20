FROM node:24-bookworm-slim

ARG IMAGE_REVISION
LABEL org.opencontainers.image.revision=$IMAGE_REVISION
ENV IMAGE_REVISION=$IMAGE_REVISION

WORKDIR /app

# The preflight reads this build-owned file. Runtime env files can override ENV,
# so process.env.IMAGE_REVISION is not immutable image evidence.
RUN printf '%s\n' "$IMAGE_REVISION" > /app/.image-revision

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

RUN npm ci

RUN DATABASE_URL="postgresql://trader:traderpass@localhost:5432/ai_trader" npx prisma generate

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start"]
