# ── Node 24 (node:sqlite 빌트인 필요) ──
FROM node:24-slim AS base

# ── 의존성 설치 ──
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ── 빌드 ──
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js standalone 빌드
RUN npm run build

# ── 실행 이미지 ──
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Railway 는 PORT 환경변수를 주입한다
ENV PORT=3000

# standalone 빌드 결과물만 복사 (경량)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# data/ 디렉터리 생성 (Railway Volume 마운트 포인트)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
