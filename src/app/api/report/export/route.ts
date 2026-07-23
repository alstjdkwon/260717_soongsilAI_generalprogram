import ExcelJS from "exceljs";
import { getDb } from "../../../../db/serverDb";
import { caseRawRows, fieldRawRows, rationaleRawRows, type Scope } from "../../../../repo/metrics";
import { CASE_STATUS } from "../../../../domain/status";

/**
 * 성과 지표의 원시 데이터 — 리포트 화면의 숫자를 손으로 재계산해 검증하기 위한 산출물.
 * 화면의 각 지표가 어느 시트로 검증되는지 1:1 로 대응한다.
 *
 * 이름·부서는 넣지 않는다. 교차검증에는 ID 와 수치면 충분하고,
 * 개인정보가 없어야 공모전 증빙자료로 그대로 첨부할 수 있다.
 */

const HEADER_FILL = "FF0066CC"; // Action Blue — 기존 export 와 동일

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle" };
}

/** 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD'. 화면용 shortDate('7월 12일')와는 다른 포맷이다. */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

export async function GET(request: Request) {
  const scope: Scope = new URL(request.url).searchParams.get("scope") === "all" ? "all" : "real";
  const db = getDb();

  const workbook = new ExcelJS.Workbook();

  // 시트 1: 건별 — 판단 소요시간·리드타임·방치 검증용
  const cases = workbook.addWorksheet("건별", { views: [{ state: "frozen", ySplit: 1 }] });
  cases.columns = [
    { header: "건번호", key: "case_id", width: 8 },
    { header: "시드여부", key: "is_seed", width: 9 },
    { header: "상태", key: "status", width: 12 },
    { header: "접수일", key: "created_at", width: 12 },
    { header: "승인일", key: "approved_at", width: 12 },
    { header: "반려일", key: "rejected_at", width: 12 },
    { header: "환급일", key: "refunded_at", width: 12 },
    { header: "판단소요(초)", key: "decision_seconds", width: 12 },
    { header: "리드타임(일)", key: "lead_days", width: 12 },
  ];
  styleHeader(cases);
  for (const r of caseRawRows(db, scope)) {
    cases.addRow({
      case_id: r.case_id,
      is_seed: r.is_seed ? "시드" : "실사용",
      status: CASE_STATUS[r.status as keyof typeof CASE_STATUS] ?? r.status,
      created_at: day(r.created_at),
      approved_at: day(r.approved_at),
      rejected_at: day(r.rejected_at),
      refunded_at: day(r.refunded_at),
      decision_seconds: r.decision_seconds ?? "",
      lead_days: r.lead_days ?? "",
    });
  }

  // 시트 2: 필드비교 — AI 추출 원본 ↔ 최종값
  const fields = workbook.addWorksheet("필드비교", { views: [{ state: "frozen", ySplit: 1 }] });
  fields.columns = [
    { header: "문서번호", key: "document_id", width: 9 },
    { header: "건번호", key: "case_id", width: 8 },
    { header: "필드", key: "field", width: 14 },
    { header: "AI 추출값", key: "ai_value", width: 22 },
    { header: "AI 신뢰도", key: "ai_confidence", width: 10 },
    { header: "최종값", key: "final_value", width: 22 },
    { header: "판정", key: "verdict", width: 18 },
  ];
  styleHeader(fields);
  for (const r of fieldRawRows(db, scope)) fields.addRow(r);

  // 시트 3: 근거비교 — AI 원문 ↔ 교정본 (채택률 검증용)
  const rationale = workbook.addWorksheet("근거비교", { views: [{ state: "frozen", ySplit: 1 }] });
  rationale.columns = [
    { header: "건번호", key: "case_id", width: 8 },
    { header: "AI 근거 원문", key: "ai_rationale", width: 60 },
    { header: "교정본", key: "correction", width: 60 },
    { header: "판정", key: "same", width: 10 },
  ];
  styleHeader(rationale);
  for (const r of rationaleRawRows(db, scope)) rationale.addRow(r);

  const buffer = await workbook.xlsx.writeBuffer();
  const label = scope === "all" ? "시드포함" : "실사용";
  const filename = `자율교육_성과원시데이터_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new Response(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "no-store",
    },
  });
}
