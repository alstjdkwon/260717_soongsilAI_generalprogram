#!/bin/sh
# Docker 컨테이너 시작 시 실행되는 엔트리포인트.
# Railway Volume 이 비어 있으면 이미지에 번들된 초기 데이터를 복사한다.

DATA_DIR="/app/data"
SEED_DIR="/app/_seed_data"

# Volume 마운트된 /app/data 에 app.db 가 없으면 초기 데이터 복사
if [ ! -f "$DATA_DIR/app.db" ] && [ -d "$SEED_DIR" ]; then
  echo "[entrypoint] 초기 데이터를 Volume 으로 복사합니다..."
  cp -r "$SEED_DIR"/* "$DATA_DIR/"
  echo "[entrypoint] 복사 완료."
fi

exec node server.js
