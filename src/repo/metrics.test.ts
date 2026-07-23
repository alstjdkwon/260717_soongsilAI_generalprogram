import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import { createEmployee, createCase } from "./cases";
import { saveRationale, saveCorrection } from "./reviews";
import {
  median,
  decisionSeconds,
  leadTimeDays,
  rationaleAdoption,
  overdueCases,
  caseRawRows,
  fieldRawRows,
  rationaleRawRows,
} from "./metrics";

/** 지표 계산용 건 하나. 시드 여부·판단시간·날짜를 직접 박는다. */
function makeCase(
  db: DB,
  o: {
    isSeed?: boolean;
    decisionSeconds?: number;
    createdAt?: string;
    approvedAt?: string;
    rejectedAt?: string;
    status?: string;
  } = {},
): number {
  const emp = createEmployee(db, { name: `직원${Math.random()}` });
  const id = createCase(db, { employee_id: emp.id, education_name: "교육" }).id;
  db.prepare(
    `UPDATE cases SET is_seed = ?, decision_seconds = ?, created_at = COALESCE(?, created_at),
            approved_at = ?, rejected_at = ?, status = COALESCE(?, status) WHERE id = ?`,
  ).run(
    o.isSeed ? 1 : 0,
    o.decisionSeconds ?? null,
    o.createdAt ?? null,
    o.approvedAt ?? null,
    o.rejectedAt ?? null,
    o.status ?? null,
    id,
  );
  return id;
}

describe("median", () => {
  it("홀수 개는 가운데 값", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("짝수 개는 가운데 두 값의 평균", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("빈 배열은 null", () => {
    expect(median([])).toBeNull();
  });
  it("원본 배열을 정렬로 훼손하지 않는다", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("판단 소요시간", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("값이 있는 건만 세고, 중앙값·최소·최대를 낸다", () => {
    makeCase(db, { decisionSeconds: 95 });
    makeCase(db, { decisionSeconds: 190 });
    makeCase(db, { decisionSeconds: 880 });
    makeCase(db); // 아직 결정 안 한 건 — 분모에서 빠져야 한다

    const d = decisionSeconds(db, "real");
    expect(d.n).toBe(3);
    expect(d.median).toBe(190); // 평균(388)이 아니라 중앙값
    expect(d.min).toBe(95);
    expect(d.max).toBe(880);
  });

  it("시드 건은 real 스코프에서 빠지고 all 에서는 잡힌다", () => {
    makeCase(db, { decisionSeconds: 100, isSeed: true });
    makeCase(db, { decisionSeconds: 200 });

    expect(decisionSeconds(db, "real").n).toBe(1);
    expect(decisionSeconds(db, "real").median).toBe(200);
    expect(decisionSeconds(db, "all").n).toBe(2);
  });
});

describe("리드타임", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("승인·반려 중 있는 쪽까지의 일수를 센다", () => {
    makeCase(db, { createdAt: "2026-08-10 09:00:00", approvedAt: "2026-08-12 09:00:00" }); // 2일
    makeCase(db, { createdAt: "2026-08-10 09:00:00", rejectedAt: "2026-08-14 09:00:00" }); // 4일
    makeCase(db, { createdAt: "2026-08-10 09:00:00" }); // 미결정 → 제외

    const d = leadTimeDays(db, "real");
    expect(d.n).toBe(2);
    expect(d.median).toBe(3);
  });
});

describe("AI 근거 채택률", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("교정 저장을 누른 건만 분모에 넣는다", () => {
    const adopted = makeCase(db);
    saveRationale(db, adopted, "AI 초안.", "HIGH");
    saveCorrection(db, adopted, "AI 초안."); // 그대로 저장 → 채택

    const edited = makeCase(db);
    saveRationale(db, edited, "AI 초안.", "HIGH");
    saveCorrection(db, edited, "사람이 고친 문장."); // → 수정

    const untouched = makeCase(db);
    saveRationale(db, untouched, "AI 초안.", "HIGH"); // 저장 안 누름 → 분모에서 빠져야 한다

    const a = rationaleAdoption(db, "real");
    expect(a.n).toBe(2); // 3이 아니라 2
    expect(a.adopted).toBe(1);
    expect(a.rate).toBe(0.5);
  });

  it("앞뒤 공백 차이는 채택으로 본다", () => {
    const id = makeCase(db);
    saveRationale(db, id, "AI 초안.", "HIGH");
    saveCorrection(db, id, "  AI 초안.  ");
    expect(rationaleAdoption(db, "real").adopted).toBe(1);
  });
});

describe("방치·지연", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("이수 대기 중 기준 주수를 넘긴 건만 센다", () => {
    const now = Date.parse("2026-08-30T00:00:00Z");
    makeCase(db, { status: "IN_PROGRESS", approvedAt: "2026-07-01 00:00:00" }); // 8주 경과
    makeCase(db, { status: "IN_PROGRESS", approvedAt: "2026-08-28 00:00:00" }); // 이틀
    makeCase(db, { status: "SCREENING" }); // 이수 대기 아님 → 분모 제외

    const o = overdueCases(db, "real", now);
    expect(o.n).toBe(2);
    expect(o.overdue).toBe(1);
    expect(o.limitWeeks).toBe(4); // 기본값
  });
});

describe("원시데이터 행", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("건별 행에 리드타임이 계산돼 붙는다", () => {
    makeCase(db, { createdAt: "2026-08-10 00:00:00", approvedAt: "2026-08-12 12:00:00", decisionSeconds: 120 });
    const [row] = caseRawRows(db, "real");
    expect(row.lead_days).toBe(2.5);
    expect(row.decision_seconds).toBe(120);
  });

  it("필드 비교가 일치·수정·삭제·AI누락을 구분한다", () => {
    const caseId = makeCase(db);
    const orig = JSON.stringify({
      name: { value: "김철수", confidence: "HIGH" },
      hours: { value: 8, confidence: "LOW" },
      amount: { value: 90000, confidence: "HIGH" },
    });
    const final = JSON.stringify({
      name: { value: "김철수", confidence: "HIGH" }, // 일치
      hours: { value: 16, confidence: "HIGH" }, // 수정
      department: { value: "전산팀", confidence: "HIGH" }, // AI 누락 → 사람이 채움
      // amount 는 사라짐 → 삭제
    });
    db.prepare(
      `INSERT INTO documents (case_id, kind, extracted_fields, extracted_original) VALUES (?, 'APPLICATION', ?, ?)`,
    ).run(caseId, final, orig);

    const byField = new Map(fieldRawRows(db, "real").map((r) => [r.field, r.verdict]));
    expect(byField.get("name")).toBe("일치");
    expect(byField.get("hours")).toBe("수정");
    expect(byField.get("amount")).toBe("삭제(문서에 없음)");
    expect(byField.get("department")).toBe("AI누락(사람이 채움)");
  });

  it("근거 비교가 미검토를 채택과 구분한다", () => {
    const untouched = makeCase(db);
    saveRationale(db, untouched, "AI 초안.", "HIGH");
    const adopted = makeCase(db);
    saveRationale(db, adopted, "AI 초안.", "HIGH");
    saveCorrection(db, adopted, "AI 초안.");

    const rows = rationaleRawRows(db, "real");
    expect(rows.find((r) => r.case_id === untouched)?.same).toBe("미검토");
    expect(rows.find((r) => r.case_id === adopted)?.same).toBe("채택");
  });
});
