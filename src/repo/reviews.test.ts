import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import { createEmployee, createCase } from "./cases";
import { getReview, saveRationale, saveCorrection, getRecentCorrections } from "./reviews";

function makeCase(db: DB, name: string, jobRole: string, educationName: string): number {
  const emp = createEmployee(db, { name, job_role: jobRole });
  return createCase(db, { employee_id: emp.id, education_name: educationName }).id;
}

describe("reviews repo", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("근거문 저장·조회 — 행이 없으면 만들고, 있으면 덮어쓴다", () => {
    const caseId = makeCase(db, "김테스트", "전산 운영", "도커 실무");
    saveRationale(db, caseId, "전산 운영과 컨테이너 교육은 직접 부합.", "HIGH");
    expect(getReview(db, caseId)?.fit_rationale).toBe("전산 운영과 컨테이너 교육은 직접 부합.");
    expect(getReview(db, caseId)?.fit_confidence).toBe("HIGH");

    saveRationale(db, caseId, "다시 본 근거.", "MID");
    expect(getReview(db, caseId)?.fit_rationale).toBe("다시 본 근거.");
    expect(getReview(db, caseId)?.fit_confidence).toBe("MID");
  });

  it("교정은 화면 근거문을 대체하고 신뢰도를 HIGH로 올리며 correction에 남는다", () => {
    const caseId = makeCase(db, "이교정", "회계", "엑셀 실무");
    saveRationale(db, caseId, "AI 초안 근거.", "LOW");
    saveCorrection(db, caseId, "  회계 담당에게 엑셀 실무는 필수 역량으로 부합.  ");
    const r = getReview(db, caseId)!;
    expect(r.correction).toBe("회계 담당에게 엑셀 실무는 필수 역량으로 부합.");
    expect(r.fit_rationale).toBe("회계 담당에게 엑셀 실무는 필수 역량으로 부합."); // 교정본이 근거문이 됨
    expect(r.fit_confidence).toBe("HIGH");
  });

  it("최근 교정만, 최신 우선으로 few-shot 예시를 돌려준다", () => {
    const c1 = makeCase(db, "직원1", "시설 안전", "산업안전 교육");
    const c2 = makeCase(db, "직원2", "홍보", "영상 편집");
    const c3 = makeCase(db, "직원3", "입시 상담", "심리 상담 기법");
    saveRationale(db, c2, "초안", "MID"); // 교정 없음 → few-shot 제외
    saveCorrection(db, c1, "안전 담당에게 산업안전은 직결.");
    saveCorrection(db, c3, "입시 상담과 심리 상담 기법은 상담 역량으로 부합.");

    const ex = getRecentCorrections(db, 5);
    expect(ex).toHaveLength(2); // 교정 있는 2건만
    expect(ex[0].educationName).toBe("심리 상담 기법"); // 최신 우선
    expect(ex[0].jobRole).toBe("입시 상담");
    expect(ex[1].educationName).toBe("산업안전 교육");
  });

  it("limit로 few-shot 개수를 제한한다", () => {
    for (let i = 0; i < 4; i++) {
      const c = makeCase(db, `직원${i}`, `직무${i}`, `교육${i}`);
      saveCorrection(db, c, `교정${i}`);
    }
    expect(getRecentCorrections(db, 2)).toHaveLength(2);
  });
});
