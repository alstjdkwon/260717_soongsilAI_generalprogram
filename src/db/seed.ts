import type { DB } from "./db";
import type { CaseStatus } from "../domain/status";
import type { ExtractedFields } from "../domain/flags";

/**
 * 가상 시드 데이터 (기획서 §8: 명백한 가상값 + "임의 생성 데이터" 표시).
 * 각 상태를 골고루 + 저신뢰·불일치·경과 케이스를 일부러 포함해
 * AI 없이도 할일 큐/칸반/상세가 전부 동작하게 만든다.
 */

function ts(daysAgo: number, now: number): string {
  const d = new Date(now - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

interface SeedEmployee {
  name: string;
  department: string;
  job_role: string;
  remaining_points: number;
}

interface SeedCase {
  employee: string; // 이름으로 참조
  education_name: string;
  expected_cost: number;
  status: CaseStatus;
  reject_reason?: string;
  reapplyOf?: string; // 이전 반려 건 교육명 (재신청 연결)
  createdDaysAgo: number;
  approvedDaysAgo?: number;
  docsArrivedDaysAgo?: number;
  refundedDaysAgo?: number;
  rejectedDaysAgo?: number;
  application?: ExtractedFields;
  completion?: ExtractedFields;
  fit_rationale?: string;
}

const EMPLOYEES: SeedEmployee[] = [
  { name: "홍길동", department: "총무팀", job_role: "문서·자산 관리, 물품 구매", remaining_points: 12 },
  { name: "김영희", department: "전산팀", job_role: "교내 시스템 운영, 정보보안", remaining_points: 8 },
  { name: "이철수", department: "교무처", job_role: "학사일정·수강신청 운영", remaining_points: 20 },
  { name: "박민수", department: "시설관리팀", job_role: "건물 유지보수, 안전 점검", remaining_points: 5 },
  { name: "최지은", department: "입학처", job_role: "입시 홍보, 지원자 상담", remaining_points: 15 },
  { name: "정수현", department: "연구지원팀", job_role: "연구비 관리, 과제 행정", remaining_points: 18 },
  { name: "강동원", department: "총무팀", job_role: "회계 정산, 계약 관리", remaining_points: 10 },
  { name: "윤서연", department: "인사팀", job_role: "채용, 교직원 복무 관리", remaining_points: 22 },
  { name: "임재현", department: "기획처", job_role: "예산 편성, 대학평가 대응", remaining_points: 9 },
  { name: "오하늘", department: "도서관", job_role: "장서 관리, 이용자 서비스", remaining_points: 14 },
];

function f(
  over: Partial<Record<keyof ExtractedFields, [string | number, "HIGH" | "MID" | "LOW"]>>,
): ExtractedFields {
  const out: ExtractedFields = {};
  for (const [k, [value, confidence]] of Object.entries(over)) {
    out[k as keyof ExtractedFields] = { value, confidence };
  }
  return out;
}

const CASES: SeedCase[] = [
  // ── 심사 대기 (처리 대기) ─────────────────────────────
  {
    employee: "홍길동", education_name: "공공데이터 분석 실무", expected_cost: 70000,
    status: "SCREENING", createdDaysAgo: 2,
    application: f({ name: ["홍길동", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["공공데이터 분석 실무", "HIGH"], amount: [70000, "HIGH"] }),
    fit_rationale: "총무팀 담당업무(문서·자산 관리)와 '공공데이터 분석 실무'는 자산 데이터 정리·집계 역량으로 직접 연결됨. 신뢰도: 중.",
  },
  {
    employee: "이철수", education_name: "엑셀 고급 함수와 자동화", expected_cost: 55000,
    status: "SCREENING", createdDaysAgo: 1,
    application: f({ name: ["이철수", "HIGH"], department: ["교무처", "HIGH"], education_name: ["엑셀 고급 함수와 자동화", "HIGH"], amount: [55000, "HIGH"] }),
    fit_rationale: "학사일정·수강신청 운영은 대량 데이터 반복 작업이 많아 엑셀 자동화 교육과 부합. 신뢰도: 고.",
  },
  {
    employee: "정수현", education_name: "연구윤리와 과제 정산 실무", expected_cost: 90000,
    status: "SCREENING", createdDaysAgo: 4,
    application: f({ name: ["정수현", "HIGH"], department: ["연구지원팀", "HIGH"], education_name: ["연구윤리와 과제 정산 실무", "HIGH"], amount: [90000, "HIGH"] }),
    fit_rationale: "연구비 관리·과제 행정 담당자에게 정산 실무 교육은 직무 정확히 부합. 신뢰도: 고.",
  },
  // ── 심사 대기 · 저신뢰 (검토 필요) ────────────────────
  {
    employee: "박민수", education_name: "산업안전 관리자 양성과정", expected_cost: 120000,
    status: "SCREENING", createdDaysAgo: 3,
    application: f({ name: ["박민수", "HIGH"], department: ["시설관리팀", "MID"], education_name: ["산업안전 관리자 양성과정", "LOW"], amount: [120000, "LOW"] }),
    fit_rationale: "건물 유지보수·안전 점검 직무와 산업안전 교육은 부합. 다만 교육명·금액 추출 신뢰도가 낮아 원본 확인 필요. 신뢰도: 저.",
  },
  // ── 이수 대기 (경과 없음) ─────────────────────────────
  {
    employee: "최지은", education_name: "카피라이팅과 콘텐츠 기획", expected_cost: 60000,
    status: "IN_PROGRESS", createdDaysAgo: 10, approvedDaysAgo: 8,
    application: f({ name: ["최지은", "HIGH"], department: ["입학처", "HIGH"], education_name: ["카피라이팅과 콘텐츠 기획", "HIGH"], amount: [60000, "HIGH"] }),
  },
  {
    employee: "오하늘", education_name: "저작권과 디지털 아카이빙", expected_cost: 45000,
    status: "IN_PROGRESS", createdDaysAgo: 14, approvedDaysAgo: 12,
    application: f({ name: ["오하늘", "HIGH"], department: ["도서관", "HIGH"], education_name: ["저작권과 디지털 아카이빙", "HIGH"], amount: [45000, "HIGH"] }),
  },
  // ── 이수 대기 · 경과 (경과 알림) ──────────────────────
  {
    employee: "김영희", education_name: "정보보안 관리사 대비", expected_cost: 150000,
    status: "IN_PROGRESS", createdDaysAgo: 45, approvedDaysAgo: 42,
    application: f({ name: ["김영희", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["정보보안 관리사 대비", "HIGH"], amount: [150000, "HIGH"] }),
  },
  {
    employee: "임재현", education_name: "대학평가 지표 분석 워크숍", expected_cost: 80000,
    status: "IN_PROGRESS", createdDaysAgo: 38, approvedDaysAgo: 35,
    application: f({ name: ["임재현", "HIGH"], department: ["기획처", "HIGH"], education_name: ["대학평가 지표 분석 워크숍", "HIGH"], amount: [80000, "HIGH"] }),
  },
  // ── 환급 대기 (처리 대기) ─────────────────────────────
  {
    employee: "이철수", education_name: "학사행정 실무 심화", expected_cost: 65000,
    status: "AWAITING_REFUND", createdDaysAgo: 30, approvedDaysAgo: 28, docsArrivedDaysAgo: 2,
    application: f({ name: ["이철수", "HIGH"], department: ["교무처", "HIGH"], education_name: ["학사행정 실무 심화", "HIGH"], amount: [65000, "HIGH"] }),
    completion: f({ name: ["이철수", "HIGH"], education_name: ["학사행정 실무 심화", "HIGH"], amount: [65000, "HIGH"], hours: [16, "HIGH"] }),
  },
  // ── 환급 대기 · 금액 불일치 (검토 필요) ───────────────
  {
    employee: "홍길동", education_name: "공공데이터 분석 심화", expected_cost: 70000,
    status: "AWAITING_REFUND", createdDaysAgo: 33, approvedDaysAgo: 30, docsArrivedDaysAgo: 1,
    application: f({ name: ["홍길동", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["공공데이터 분석 심화", "HIGH"], amount: [70000, "HIGH"] }),
    completion: f({ name: ["홍길동", "HIGH"], education_name: ["공공데이터 분석 심화", "HIGH"], amount: [85000, "HIGH"], hours: [20, "HIGH"] }),
  },
  // ── 환급 대기 · 교육명 불일치 (검토 필요) ─────────────
  {
    employee: "강동원", education_name: "계약·회계 실무", expected_cost: 50000,
    status: "AWAITING_REFUND", createdDaysAgo: 36, approvedDaysAgo: 33, docsArrivedDaysAgo: 3,
    application: f({ name: ["강동원", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["계약·회계 실무", "HIGH"], amount: [50000, "HIGH"] }),
    completion: f({ name: ["강동원", "MID"], education_name: ["회계 결산 실무 과정", "MID"], amount: [50000, "HIGH"], hours: [12, "MID"] }),
  },
  // ── 완료 ─────────────────────────────────────────────
  {
    employee: "윤서연", education_name: "채용 브랜딩 실무", expected_cost: 75000,
    status: "DONE", createdDaysAgo: 60, approvedDaysAgo: 58, docsArrivedDaysAgo: 40, refundedDaysAgo: 35,
    application: f({ name: ["윤서연", "HIGH"], department: ["인사팀", "HIGH"], education_name: ["채용 브랜딩 실무", "HIGH"], amount: [75000, "HIGH"] }),
    completion: f({ name: ["윤서연", "HIGH"], education_name: ["채용 브랜딩 실무", "HIGH"], amount: [75000, "HIGH"], hours: [16, "HIGH"] }),
  },
  {
    employee: "최지은", education_name: "SNS 채널 운영 전략", expected_cost: 40000,
    status: "DONE", createdDaysAgo: 70, approvedDaysAgo: 68, docsArrivedDaysAgo: 50, refundedDaysAgo: 45,
    application: f({ name: ["최지은", "HIGH"], department: ["입학처", "HIGH"], education_name: ["SNS 채널 운영 전략", "HIGH"], amount: [40000, "HIGH"] }),
    completion: f({ name: ["최지은", "HIGH"], education_name: ["SNS 채널 운영 전략", "HIGH"], amount: [40000, "HIGH"], hours: [8, "HIGH"] }),
  },
  // ── 반려 ─────────────────────────────────────────────
  {
    employee: "박민수", education_name: "바리스타 2급 자격과정", expected_cost: 130000,
    status: "REJECTED", createdDaysAgo: 25, rejectedDaysAgo: 23,
    reject_reason: "담당업무(시설 유지보수·안전)와 직무 관련성을 확인하기 어려움. 직무 연관 근거를 보완해 재신청 요망.",
    application: f({ name: ["박민수", "HIGH"], department: ["시설관리팀", "HIGH"], education_name: ["바리스타 2급 자격과정", "HIGH"], amount: [130000, "HIGH"] }),
  },
  // ── 반려 후 재신청 (심사 대기 · prev 연결) ────────────
  {
    employee: "박민수", education_name: "시설 안전관리 실무", expected_cost: 110000,
    status: "SCREENING", createdDaysAgo: 1, reapplyOf: "바리스타 2급 자격과정",
    application: f({ name: ["박민수", "HIGH"], department: ["시설관리팀", "HIGH"], education_name: ["시설 안전관리 실무", "HIGH"], amount: [110000, "HIGH"] }),
    fit_rationale: "이전 반려 사유(직무 관련성)를 반영한 재신청. 건물 안전 점검 담당과 '시설 안전관리 실무'는 직접 부합. 신뢰도: 고.",
  },
];

export function seedDb(db: DB, now = Date.now()): void {
  const insertEmp = db.prepare(
    `INSERT INTO employees (name, department, job_role, remaining_points) VALUES (?, ?, ?, ?)`,
  );
  const empId = new Map<string, number>();
  for (const e of EMPLOYEES) {
    const { lastInsertRowid } = insertEmp.run(e.name, e.department, e.job_role, e.remaining_points);
    empId.set(e.name, Number(lastInsertRowid));
  }

  // is_seed = 1 — 이 건들은 날짜가 임의로 백필된 데모 데이터다. 성과 보고서 집계에서
  // WHERE is_seed = 0 으로 걸러내 실사용 기록만 세도록 표시해 둔다.
  const insertCase = db.prepare(
    `INSERT INTO cases
       (employee_id, education_name, expected_cost, status, reject_reason, prev_case_id,
        created_at, approved_at, docs_arrived_at, refunded_at, rejected_at, is_seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO documents (case_id, kind, detected_kind, extracted_fields, extracted_original, file_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertReview = db.prepare(
    `INSERT INTO reviews (case_id, fit_rationale, fit_confidence, ai_rationale) VALUES (?, ?, ?, ?)`,
  );
  // 근거문 끝의 "신뢰도: 고/중/저" 를 배지용 신뢰도로 뽑는다.
  const confOf = (text: string): "HIGH" | "MID" | "LOW" =>
    /신뢰도:\s*고/.test(text) ? "HIGH" : /신뢰도:\s*저/.test(text) ? "LOW" : "MID";

  // 재신청 연결용: 반려 건의 caseId 를 교육명으로 찾을 수 있게 기록
  const rejectedCaseId = new Map<string, number>();

  for (const c of CASES) {
    const prevId = c.reapplyOf ? rejectedCaseId.get(c.reapplyOf) ?? null : null;
    const { lastInsertRowid } = insertCase.run(
      empId.get(c.employee)!,
      c.education_name,
      c.expected_cost,
      c.status,
      c.reject_reason ?? null,
      prevId,
      ts(c.createdDaysAgo, now),
      c.approvedDaysAgo != null ? ts(c.approvedDaysAgo, now) : null,
      c.docsArrivedDaysAgo != null ? ts(c.docsArrivedDaysAgo, now) : null,
      c.refundedDaysAgo != null ? ts(c.refundedDaysAgo, now) : null,
      c.rejectedDaysAgo != null ? ts(c.rejectedDaysAgo, now) : null,
    );
    const caseId = Number(lastInsertRowid);
    if (c.status === "REJECTED") rejectedCaseId.set(c.education_name, caseId);

    if (c.application) {
      const json = JSON.stringify(c.application);
      insertDoc.run(caseId, "APPLICATION", "APPLICATION", json, json, `seed/${caseId}-application.pdf`);
    }
    if (c.completion) {
      const json = JSON.stringify(c.completion);
      insertDoc.run(caseId, "COMPLETION", "COMPLETION", json, json, `seed/${caseId}-completion.pdf`);
    }
    if (c.fit_rationale) {
      insertReview.run(caseId, c.fit_rationale, confOf(c.fit_rationale), c.fit_rationale);
    }
  }
}

export function isEmpty(db: DB): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM employees").get() as { n: number };
  return row.n === 0;
}
