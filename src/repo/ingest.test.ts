import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import { FakeParser } from "../ai/fakeParser";
import {
  ingestFiles,
  attachPending,
  dismissPending,
  resolveApplicationAsExisting,
  resolveApplicationAsNew,
} from "./ingest";
import { transitionCase } from "./cases";
import { getCaseView, getAllCaseViews, getPendingDocuments, getAttachableCases } from "./queries";
import type { ExtractedFields } from "../domain/flags";
import type { InputFile, ParsedDocument } from "../ai/types";

const file = (name: string): InputFile => ({ name, bytes: new Uint8Array(), mime: "application/pdf" });

function fields(
  o: Partial<Record<keyof ExtractedFields, [string | number, "HIGH" | "MID" | "LOW"]>>,
): ExtractedFields {
  const out: ExtractedFields = {};
  for (const [k, [value, confidence]] of Object.entries(o)) {
    out[k as keyof ExtractedFields] = { value, confidence };
  }
  return out;
}

const application = (f: ExtractedFields): ParsedDocument => ({ detectedKind: "APPLICATION", fields: f });
const completion = (f: ExtractedFields): ParsedDocument => ({ detectedKind: "COMPLETION", fields: f });

describe("ingestFiles", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("신청서 → 새 직원과 심사 건을 만든다", async () => {
    const parser = new FakeParser({
      "a.pdf": application(fields({ name: ["김테스트", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["도커 실무", "HIGH"], amount: [90000, "HIGH"] })),
    });
    const [r] = await ingestFiles(db, parser, [file("a.pdf")], "APPLICATION");
    expect(r.outcome).toBe("CREATED_CASE");
    const view = getCaseView(db, r.caseId!)!;
    expect(view.name).toBe("김테스트");
    expect(view.status).toBe("SCREENING");
    expect(view.educationName).toBe("도커 실무");
    expect(view.expectedCost).toBe(90000);
  });

  it("같은 이름의 신청서 두 건은 직원 하나에 건 둘로 붙는다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["박중복", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["교육1", "HIGH"], amount: [10000, "HIGH"] })),
      "a2.pdf": application(fields({ name: ["박중복", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["교육2", "HIGH"], amount: [20000, "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    const v1 = getCaseView(db, rs[0].caseId!)!;
    const v2 = getCaseView(db, rs[1].caseId!)!;
    expect(v1.employeeId).toBe(v2.employeeId);
    expect(v1.id).not.toBe(v2.id);
  });

  it("저신뢰 필드가 있는 신청서는 검토 필요 큐로 간다", async () => {
    const parser = new FakeParser({
      "low.pdf": application(fields({ name: ["최저신뢰", "HIGH"], education_name: ["애매교육", "LOW"], amount: [50000, "LOW"] })),
    });
    const [r] = await ingestFiles(db, parser, [file("low.pdf")], "APPLICATION");
    const view = getCaseView(db, r.caseId!)!;
    expect(view.flags.minConfidence).toBe("LOW");
    expect(view.flags.needsReview).toBe(true);
    expect(view.bucket).toBe("REVIEW");
  });

  it("이수증 → 이수 대기 중인 같은 이름·교육 건에 매칭되고 서류 도착 처리된다", async () => {
    const parser = new FakeParser({
      "app.pdf": application(fields({ name: ["이매칭", "HIGH"], education_name: ["엑셀 실무", "HIGH"], amount: [40000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["이매칭", "HIGH"], education_name: ["엑셀 실무", "HIGH"], amount: [40000, "HIGH"], hours: [16, "HIGH"] })),
    });
    const [app] = await ingestFiles(db, parser, [file("app.pdf")], "APPLICATION");
    transitionCase(db, app.caseId!, "APPROVE"); // 심사 → 이수 대기
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("MATCHED_CASE");
    expect(cert.caseId).toBe(app.caseId);
    const view = getCaseView(db, app.caseId!)!;
    expect(view.status).toBe("AWAITING_REFUND");
    expect(view.completion?.hours?.value).toBe(16);
  });

  it("맞는 이수 대기 건이 없는 이수증도 버리지 않고 보관함에 담는다(수동 첨부용)", async () => {
    const parser = new FakeParser({
      "orphan.pdf": completion(fields({ name: ["없는사람", "HIGH"], education_name: ["무엇", "HIGH"], amount: [1000, "HIGH"] })),
    });
    const [r] = await ingestFiles(db, parser, [file("orphan.pdf")], "COMPLETION");
    expect(r.outcome).toBe("PENDING_REVIEW");
    expect(r.caseId).toBeUndefined();
    expect(getAllCaseViews(db)).toHaveLength(0); // 건은 만들지 않음

    const pending = getPendingDocuments(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].candidates).toHaveLength(0); // 후보 없음 → UI가 전체 목록에서 고르게 함
    expect(pending[0].name).toBe("없는사람");
  });

  it("승인 전(심사 대기) 건만 있으면 이수증은 매칭되지 않는다", async () => {
    const parser = new FakeParser({
      "app.pdf": application(fields({ name: ["김심사", "HIGH"], education_name: ["교육", "HIGH"], amount: [30000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["김심사", "HIGH"], education_name: ["교육", "HIGH"], amount: [30000, "HIGH"], hours: [8, "HIGH"] })),
    });
    await ingestFiles(db, parser, [file("app.pdf")], "APPLICATION"); // 승인 안 함 → SCREENING
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("PENDING_REVIEW"); // 자동 첨부 안 됨 — 보관함에서 처리
  });

  it("AI 판별이 매니저가 고른 칸과 다르면 지정대로 처리하되 경고를 붙인다", async () => {
    const parser = new FakeParser({
      // 제목이 '교육 보고서'라 AI 가 이수증으로 본 사전 승인 신청서
      "confusing.pdf": completion(fields({ name: ["최혼동", "HIGH"], education_name: ["교육", "HIGH"], amount: [10000, "HIGH"] })),
    });
    const [r] = await ingestFiles(db, parser, [file("confusing.pdf")], "APPLICATION");
    expect(r.outcome).toBe("CREATED_CASE"); // 매니저 지정이 이긴다
    expect(r.note).toContain("AI는 이수증으로 판별");
    expect(getCaseView(db, r.caseId!)!.name).toBe("최혼동");
  });

  it("이름을 못 읽은 신청서끼리는 묶이지 않는다(남남이 한 사람이 되면 안 됨)", async () => {
    const parser = new FakeParser({}); // 미등록 → UNKNOWN + 빈 필드
    const rs = await ingestFiles(db, parser, [file("x1.pdf"), file("x2.pdf")], "APPLICATION");
    expect(rs.every((r) => r.outcome === "CREATED_CASE")).toBe(true);
    const views = rs.map((r) => getCaseView(db, r.caseId!)!);
    expect(views[0].employeeId).not.toBe(views[1].employeeId);
  });

  it("이름 앞뒤·중간 공백만 다르면 같은 직원으로 본다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["권민성", "HIGH"], department: ["인사총무팀", "HIGH"], education_name: ["교육1", "HIGH"] })),
      "a2.pdf": application(fields({ name: [" 권민성 ", "HIGH"], department: ["인사총무팀", "HIGH"], education_name: ["전혀 다른 교육", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    expect(rs[1].outcome).toBe("CREATED_CASE");
    expect(getCaseView(db, rs[0].caseId!)!.employeeId).toBe(getCaseView(db, rs[1].caseId!)!.employeeId);
  });

  it("이름은 같은데 부서가 다르면 자동 병합도 신규 생성도 하지 않고 보류한다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["도커", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["회계팀", "HIGH"], education_name: ["세무 실무", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    expect(rs[1].outcome).toBe("PENDING_REVIEW");
    expect(rs[1].caseId).toBeUndefined();
    expect(getAllCaseViews(db)).toHaveLength(1); // 두 번째 건은 만들어지지 않음

    const [p] = getPendingDocuments(db);
    expect(p.holdReason).toBe("DEPT_MISMATCH");
    expect(p.sameNameEmployees).toHaveLength(1);
    expect(p.sameNameEmployees[0].department).toBe("전산팀");
  });

  it("부서 표기 구분자만 다르면 같은 부서로 보고 보류하지 않는다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["전세용", "HIGH"], department: ["총무·인사팀", "HIGH"], education_name: ["교육1", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["전세용", "HIGH"], department: ["총무 인사팀", "HIGH"], education_name: ["전혀 다른 교육", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    expect(rs[1].outcome).toBe("CREATED_CASE");
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("부서가 문서에 없으면 부서를 근거로 갈라놓지 않는다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["김무부서", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["교육1", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["김무부서", "HIGH"], education_name: ["전혀 다른 교육", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    expect(rs[1].outcome).toBe("CREATED_CASE");
    expect(getCaseView(db, rs[0].caseId!)!.employeeId).toBe(getCaseView(db, rs[1].caseId!)!.employeeId);
  });

  it("같은 사람이 같은 교육을 또 신청하면 중복으로 보류한다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["박중복", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["엑셀 실무 과정", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["박중복", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["엑셀 실무 과정", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    expect(rs[1].outcome).toBe("PENDING_REVIEW");
    expect(getAllCaseViews(db)).toHaveLength(1);

    const [p] = getPendingDocuments(db);
    expect(p.holdReason).toBe("DUPLICATE");
    expect(p.conflict?.caseId).toBe(rs[0].caseId);
  });

  it("이전 건이 반려됐으면 같은 교육이라도 중복으로 막지 않는다(재신청)", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["최반려", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["엑셀 실무 과정", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["최반려", "HIGH"], department: ["총무팀", "HIGH"], education_name: ["엑셀 실무 과정", "HIGH"] })),
    });
    const [a1] = await ingestFiles(db, parser, [file("a1.pdf")], "APPLICATION");
    transitionCase(db, a1.caseId!, "REJECT", { reason: "직무 무관" });
    const [a2] = await ingestFiles(db, parser, [file("a2.pdf")], "APPLICATION");
    expect(a2.outcome).toBe("CREATED_CASE");
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("교육명이 어긋나도 단일 후보면 첨부하고, 대조 단계가 불일치를 잡는다", async () => {
    const parser = new FakeParser({
      "app.pdf": application(fields({ name: ["박상이", "HIGH"], education_name: ["계약·회계 실무", "HIGH"], amount: [50000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["박상이", "HIGH"], education_name: ["회계 결산 실무 과정", "HIGH"], amount: [50000, "HIGH"], hours: [12, "HIGH"] })),
    });
    const [app] = await ingestFiles(db, parser, [file("app.pdf")], "APPLICATION");
    transitionCase(db, app.caseId!, "APPROVE");
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("MATCHED_CASE");
    const view = getCaseView(db, app.caseId!)!;
    expect(view.flags.mismatches.some((m) => m.field === "education_name")).toBe(true);
    expect(view.bucket).toBe("REVIEW");
  });

  it("동명이인 + 뚜렷한 교육명 차이 → 맞는 건에 자동 매칭된다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["이동명", "HIGH"], education_name: ["쿠버네티스 운영 실무", "HIGH"], amount: [90000, "HIGH"] })),
      "a2.pdf": application(fields({ name: ["이동명", "HIGH"], education_name: ["재무제표 분석 실무", "HIGH"], amount: [80000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["이동명", "HIGH"], education_name: ["재무제표 분석 실무", "HIGH"], amount: [80000, "HIGH"], hours: [20, "HIGH"] })),
    });
    const [a1, a2] = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    transitionCase(db, a1.caseId!, "APPROVE");
    transitionCase(db, a2.caseId!, "APPROVE");
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("MATCHED_CASE");
    expect(cert.caseId).toBe(a2.caseId); // 재무제표 건
    expect(getCaseView(db, a2.caseId!)!.status).toBe("AWAITING_REFUND");
    expect(getCaseView(db, a1.caseId!)!.status).toBe("IN_PROGRESS"); // 쿠버네티스 건은 그대로
  });

  it("동명이인 + 애매한 교육명 → 후보 보관(PENDING_REVIEW), 자동 첨부하지 않는다", async () => {
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 고급 함수", "HIGH"], amount: [40000, "HIGH"] })),
      "a2.pdf": application(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 기초 함수", "HIGH"], amount: [40000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 중급 함수", "HIGH"], amount: [40000, "HIGH"], hours: [8, "HIGH"] })),
    });
    const [a1, a2] = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    transitionCase(db, a1.caseId!, "APPROVE");
    transitionCase(db, a2.caseId!, "APPROVE");
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("PENDING_REVIEW");
    // 어느 건에도 자동 첨부되지 않음
    expect(getCaseView(db, a1.caseId!)!.status).toBe("IN_PROGRESS");
    expect(getCaseView(db, a2.caseId!)!.status).toBe("IN_PROGRESS");
    // 보관함에 후보 2건과 함께 담긴다
    const pending = getPendingDocuments(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].candidates.map((c) => c.caseId).sort()).toEqual([a1.caseId, a2.caseId].sort());
    expect(pending[0].educationName).toBe("엑셀 중급 함수");
  });
});

describe("attachPending / dismissPending", () => {
  // 동명이인으로 보관(PENDING)된 이수증 하나를 만들어 두고 시작한다.
  async function setupPending() {
    const db = openDb();
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 고급 함수", "HIGH"], amount: [40000, "HIGH"] })),
      "a2.pdf": application(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 기초 함수", "HIGH"], amount: [40000, "HIGH"] })),
      "cert.pdf": completion(fields({ name: ["김애매", "HIGH"], education_name: ["엑셀 중급 함수", "HIGH"], amount: [40000, "HIGH"], hours: [8, "HIGH"] })),
    });
    const [a1, a2] = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    transitionCase(db, a1.caseId!, "APPROVE");
    transitionCase(db, a2.caseId!, "APPROVE");
    await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    const pendingId = getPendingDocuments(db)[0].id;
    return { db, a1: a1.caseId!, a2: a2.caseId!, pendingId };
  }

  it("고른 건에 첨부하면 서류 도착으로 넘어가고 보관 행은 사라진다", async () => {
    const { db, a1, a2, pendingId } = await setupPending();
    attachPending(db, pendingId, a2);
    expect(getCaseView(db, a2)!.status).toBe("AWAITING_REFUND");
    expect(getCaseView(db, a2)!.completion?.hours?.value).toBe(8);
    expect(getCaseView(db, a1)!.status).toBe("IN_PROGRESS"); // 안 고른 건은 그대로
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("이름이 안 맞아 후보가 없어도, 이수 대기 건 목록에서 직접 골라 붙일 수 있다", async () => {
    const db = openDb();
    const parser = new FakeParser({
      "app.pdf": application(fields({ name: ["권민성", "HIGH"], education_name: ["LangChain 기본기", "HIGH"], amount: [3000, "HIGH"] })),
      // OCR 이 이름을 못 읽어 다른 이름으로 들어온 이수증
      "cert.pdf": completion(fields({ name: ["(이름 미상)", "HIGH"], education_name: ["LangChain 기본기", "HIGH"], amount: [3000, "HIGH"], hours: [4, "HIGH"] })),
    });
    const [app] = await ingestFiles(db, parser, [file("app.pdf")], "APPLICATION");
    transitionCase(db, app.caseId!, "APPROVE");
    const [cert] = await ingestFiles(db, parser, [file("cert.pdf")], "COMPLETION");
    expect(cert.outcome).toBe("PENDING_REVIEW");

    const pendingId = getPendingDocuments(db)[0].id;
    const options = getAttachableCases(db);
    expect(options.map((o) => o.caseId)).toContain(app.caseId); // 목록에 노출

    attachPending(db, pendingId, app.caseId!); // 사람이 직접 선택
    const view = getCaseView(db, app.caseId!)!;
    expect(view.status).toBe("AWAITING_REFUND");
    expect(view.completion?.hours?.value).toBe(4);
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("보류된 신청서를 '같은 사람'으로 확정하면 기존 직원에 건이 붙는다", async () => {
    const db = openDb();
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["도커", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["정보전산팀", "HIGH"], education_name: ["쿠버네티스", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    const [p] = getPendingDocuments(db);
    const employeeId = p.sameNameEmployees[0].employeeId;

    const caseId = resolveApplicationAsExisting(db, p.id, employeeId)!;
    expect(getCaseView(db, caseId)!.employeeId).toBe(employeeId);
    expect(getCaseView(db, caseId)!.employeeId).toBe(getCaseView(db, rs[0].caseId!)!.employeeId);
    expect(getCaseView(db, caseId)!.educationName).toBe("쿠버네티스");
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("보류된 신청서를 '동명이인'으로 확정하면 별도 직원으로 갈라진다", async () => {
    const db = openDb();
    const parser = new FakeParser({
      "a1.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["전산팀", "HIGH"], education_name: ["도커", "HIGH"] })),
      "a2.pdf": application(fields({ name: ["이동명", "HIGH"], department: ["회계팀", "HIGH"], education_name: ["세무 실무", "HIGH"] })),
    });
    const rs = await ingestFiles(db, parser, [file("a1.pdf"), file("a2.pdf")], "APPLICATION");
    const [p] = getPendingDocuments(db);

    const caseId = resolveApplicationAsNew(db, p.id)!;
    const created = getCaseView(db, caseId)!;
    expect(created.employeeId).not.toBe(getCaseView(db, rs[0].caseId!)!.employeeId);
    expect(created.name).toBe("이동명");
    expect(created.department).toBe("회계팀");
    expect(getPendingDocuments(db)).toHaveLength(0);
  });

  it("버리면 아무 건도 바뀌지 않고 보관 행만 사라진다", async () => {
    const { db, a1, a2, pendingId } = await setupPending();
    dismissPending(db, pendingId);
    expect(getCaseView(db, a1)!.status).toBe("IN_PROGRESS");
    expect(getCaseView(db, a2)!.status).toBe("IN_PROGRESS");
    expect(getPendingDocuments(db)).toHaveLength(0);
  });
});
