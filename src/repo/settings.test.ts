import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import { getOverdueWeeks, setOverdueWeeks, getSetting, setSetting } from "./settings";

describe("settings repo", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("경과 기준은 미설정 시 기본 4주", () => {
    expect(getOverdueWeeks(db)).toBe(4);
  });

  it("경과 기준을 저장·조회한다", () => {
    setOverdueWeeks(db, 6);
    expect(getOverdueWeeks(db)).toBe(6);
    setOverdueWeeks(db, 3); // 덮어쓰기(upsert)
    expect(getOverdueWeeks(db)).toBe(3);
  });

  it("경과 기준은 1~52주로 제한된다", () => {
    setOverdueWeeks(db, 0);
    expect(getOverdueWeeks(db)).toBe(1);
    setOverdueWeeks(db, 100);
    expect(getOverdueWeeks(db)).toBe(52);
  });

  it("임의 키-값 upsert", () => {
    expect(getSetting(db, "x")).toBeUndefined();
    setSetting(db, "x", "1");
    setSetting(db, "x", "2");
    expect(getSetting(db, "x")).toBe("2");
  });
});
