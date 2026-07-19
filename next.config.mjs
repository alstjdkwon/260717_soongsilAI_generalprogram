import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker(Railway) 배포용: standalone 빌드 — node_modules 없이 실행 가능.
  output: "standalone",
  // 홈 디렉터리에 다른 lockfile 이 있어 워크스페이스 루트 추론이 빗나감 → 명시 고정.
  turbopack: { root },
};

export default nextConfig;
