import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 홈 디렉터리에 다른 lockfile 이 있어 워크스페이스 루트 추론이 빗나감 → 명시 고정.
  turbopack: { root },
};

export default nextConfig;
