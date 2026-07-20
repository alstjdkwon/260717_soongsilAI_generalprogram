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
ENV HOSTNAME="0.0.0.0"

# standalone 빌드 결과물만 복사 (경량)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# 로컬 데이터를 _seed_data 로 번들 (Volume 이 비어 있을 때만 복사됨)
COPY --from=builder /app/data /app/_seed_data

# 엔트리포인트 스크립트
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

# data/ 디렉터리 생성 (Railway Volume 마운트 포인트)
RUN mkdir -p /app/data

CMD ["./entrypoint.sh"]
