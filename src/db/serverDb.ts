import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, type DB } from "./db";
import { isEmpty, seedDb } from "./seed";

export const DB_PATH = join(process.cwd(), "data", "app.db");

// Next dev 는 HMR 로 모듈을 다시 평가하므로 연결을 globalThis 에 캐시한다.
const g = globalThis as unknown as { __appDb?: DB };

export function getDb(): DB {
  if (!g.__appDb) {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    const db = openDb(DB_PATH);
    if (isEmpty(db)) seedDb(db);
    g.__appDb = db;
  }
  return g.__appDb;
}
