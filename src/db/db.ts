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
  migrate(db);
  return db;
}

/**
 * 이미 만들어진 DB 파일에 뒤늦게 추가된 컬럼을 채운다.
 * schema.sql 은 CREATE TABLE IF NOT EXISTS 라서 기존 테이블에는 새 컬럼이 생기지 않는다.
 */
function migrate(db: DB): void {
  addColumn(db, "pending_documents", "hold_reason", "TEXT");
  addColumn(db, "pending_documents", "declared_kind", "TEXT");
  // 성과 측정용 (공모전 보고서). 자세한 용도는 schema.sql 주석 참고.
  addColumn(db, "cases", "is_seed", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "cases", "decision_seconds", "INTEGER");
  addColumn(db, "documents", "extracted_original", "TEXT");
  addColumn(db, "reviews", "ai_rationale", "TEXT");
}

function addColumn(db: DB, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
