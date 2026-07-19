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
# Railway 가 PORT 환경변수를 자동 주입한다 (보통 8080).
# 여기서 고정하지 않고 Railway 가 준 값을 그대로 쓴다.
ENV HOSTNAME="0.0.0.0"

# standalone 빌드 결과물만 복사 (경량)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# 런타임에 필요한 스키마 파일 복사
COPY --from=builder /app/src/db/schema.sql ./src/db/schema.sql

# data/ 디렉터리 생성 (Railway Volume 마운트 포인트)
RUN mkdir -p /app/data

# Railway는 PORT 환경변수를 주입하고, EXPOSE가 있으면 포트가 꼬일 수 있으므로 제거함
CMD ["node", "server.js"]
