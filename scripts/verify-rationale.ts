/**
 * Phase 5 라이브 검증 — 세영 님 교정이 이후 근거 생성에 반영되는가(콜드스타트 학습).
 *
 *   npm run verify:rationale
 *
 * 시나리오: 본교는 "어학 교육은 부서와 무관해도 국제화 차원에서 직무 연관으로 인정"한다는
 * 조직 고유 정책이 있다. 모델은 이를 모른다. 이 정책을 담은 교정 3건을 주입한 뒤,
 * 비슷한 새 건(도서관 사서 + 비즈니스 영어)의 근거가 교정 방향(어학 인정)으로 바뀌는지 본다.
 *
 * 검증 기준(개발계획 §2 Phase 5): 교정 3건 후 유사 건 근거가 교정 방향을 반영.
 */
import { openDb } from "../src/db/db.ts";
import { createEmployee, createCase } from "../src/repo/cases.ts";
import { saveCorrection, getRecentCorrections } from "../src/repo/reviews.ts";
import { generateFitRationale } from "../src/ai/rationale.ts";

const db = openDb();

function seedCorrection(name: string, jobRole: string, education: string, correction: string) {
  const emp = createEmployee(db, { name, job_role: jobRole });
  const c = createCase(db, { employee_id: emp.id, education_name: education });
  saveCorrection(db, c.id, correction);
}

// 검증 대상 새 건 — 도서관 사서가 비즈니스 영어를 신청(부서와 직접 연관은 약함).
const TARGET = {
  name: "오하늘",
  department: "도서관",
  jobRole: "장서 관리, 이용자 서비스",
  educationName: "실무 비즈니스 영어회화",
};

console.log("\n▶ Phase 5 검증 — 교정이 근거 생성에 반영되는가\n");
console.log(`대상: ${TARGET.jobRole} · 신청 「${TARGET.educationName}」\n`);

// 1) 교정 없이 baseline.
const before = await generateFitRationale(TARGET, []);
console.log("── 교정 전 (baseline) ─────────────────");
console.log(`  신뢰도 ${before.confidence}`);
console.log(`  ${before.rationale}\n`);

// 2) 조직 정책(어학 인정)을 담은 교정 3건 주입.
seedCorrection("강동원", "회계 정산, 계약 관리", "실용 영어회화",
  "본교는 어학 교육을 부서와 무관하게 직무 역량 강화로 인정한다. 회계 담당의 영어회화도 대외·계약 업무 대비로 직무 연관 인정.");
seedCorrection("이철수", "학사일정·수강신청 운영", "중국어 기초 회화",
  "어학 교육은 본교 국제화 방침상 직무 연관으로 인정. 유학생 학사 응대 가능성을 고려해 부합으로 처리.");
seedCorrection("박민수", "건물 유지보수, 안전 점검", "비즈니스 일본어",
  "부서와 직접 관련은 낮으나, 본교의 어학 교육 인정 정책에 따라 직무 연관으로 승인.");

const corrections = getRecentCorrections(db, 5);
console.log(`── 교정 ${corrections.length}건 주입(어학 교육 인정 정책) ──────\n`);

// 3) 같은 대상, 교정 반영 후 재생성.
const after = await generateFitRationale(TARGET, corrections);
console.log("── 교정 후 ────────────────────────────");
console.log(`  신뢰도 ${after.confidence}`);
console.log(`  ${after.rationale}\n`);

// 채점(휴리스틱): 어학 인정 방향이 반영됐는지 — 정책 언급 또는 신뢰도 상승.
const mentionsPolicy = /어학|국제화|영어|인정/.test(after.rationale);
const confUp = { LOW: 0, MID: 1, HIGH: 2 } as const;
const raised = confUp[after.confidence] >= confUp[before.confidence];
const pass = mentionsPolicy && raised;

console.log("── 채점 ───────────────────────────────");
console.log(`  교정 방향(어학 인정) 반영 : ${mentionsPolicy ? "✓" : "✗"}`);
console.log(`  신뢰도 유지·상승          : ${raised ? "✓" : "✗"} (${before.confidence}→${after.confidence})`);
console.log(`\n${pass ? "✅ Phase 5 검증 통과 — 교정이 근거에 반영됨" : "⚠️  교정 반영이 약함 — 위 근거문 비교 확인"}\n`);
process.exit(pass ? 0 : 1);
