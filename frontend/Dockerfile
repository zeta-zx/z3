FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app

RUN apk add git

COPY package*.json ./
RUN npm install

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -S nodejs && adduser -S sveltejs -G nodejs
USER sveltejs

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["node", "build"]