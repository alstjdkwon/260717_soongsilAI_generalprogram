import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// node:sqlite 는 Node 24 빌트인. 번들러(Vite·Turbopack)가 정적 import 해석에 실패하므로
// 타입만 정적 import 하고(컴파일 시 제거됨), 런타임 로드는 process.getBuiltinModule 로 우회한다.
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");

// 스키마는 소스 트리에 있고, 두 실행 환경(Next·vitest) 모두 프로젝트 루트에서 돈다.
const SCHEMA_PATH = join(process.cwd(), "src", "db", "schema.sql");

export type DB = DatabaseSync;

/**
 * DB 연결을 열고 스키마를 적용한다.
 * @param path 파일 경로. 생략 시 인메모리(테스트용).
 */
export function openDb(path = ":memory:"): DB {
  const db = new DatabaseSyncCtor(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}
