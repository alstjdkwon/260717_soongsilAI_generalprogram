import ExcelJS from "exceljs";
import { getDb } from "../../../db/serverDb";
import { getAllCaseViews, BOARD_COLUMNS, type CaseView } from "../../../repo/queries";
import { CASE_STATUS } from "../../../domain/status";

/**
 * 전체 현황(칸반 기준) 전량을 엑셀 파일로 내려준다 — 세영 님이 화면 밖에서 결재·보고에 쓰는 산출물.
 * 사람이 보는 리포트라 employeeId·documents 배열 같은 내부 필드는 뺀다.
 */

const CONFIDENCE_LABEL: Record<string, string> = { HIGH: "고", MID: "중", LOW: "저" };

function shortDate(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10); // 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD'
}

/** 칸반 열 순서(심사대기→…→반려) 대로, 각 열 안에서는 최신 접수 우선 — 화면의 정렬 기준과 통일. */
function sortForExport(views: CaseView[]): CaseView[] {
  const order = new Map(BOARD_COLUMNS.map((s, i) => [s, i]));
  return [...views].sort((a, b) => {
    const byStatus = (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99);
    return byStatus !== 0 ? byStatus : b.createdAt.localeCompare(a.createdAt);
  });
}

export async function GET() {
  const views = sortForExport(getAllCaseViews(getDb()));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("전체현황", { views: [{ state: "frozen", ySplit: 1 }] });

  sheet.columns = [
    { header: "이름", key: "name", width: 12 },
    { header: "부서", key: "department", width: 14 },
    { header: "상태", key: "status", width: 10 },
    { header: "교육명", key: "education", width: 28 },
    { header: "예상비용", key: "cost", width: 12 },
    { header: "잔여포인트", key: "points", width: 10 },
    { header: "접수일", key: "createdAt", width: 12 },
    { header: "승인일", key: "approvedAt", width: 12 },
    { header: "서류도착일", key: "docsArrivedAt", width: 12 },
    { header: "반려사유", key: "rejectReason", width: 28 },
    { header: "확인 필요 사유", key: "reason", width: 32 },
    { header: "AI 신뢰도", key: "confidence", width: 10 },
    { header: "경과일수", key: "ageDays", width: 10 },
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0066CC" } }; // Action Blue
  header.alignment = { vertical: "middle" };

  for (const v of views) {
    sheet.addRow({
      name: v.name,
      department: v.department ?? "",
      status: CASE_STATUS[v.status],
      education: v.educationName ?? "",
      cost: v.expectedCost ?? "",
      points: v.remainingPoints ?? "",
      createdAt: shortDate(v.createdAt),
      approvedAt: shortDate(v.approvedAt),
      docsArrivedAt: shortDate(v.docsArrivedAt),
      rejectReason: v.rejectReason ?? "",
      reason: v.reason ?? "",
      confidence: CONFIDENCE_LABEL[v.flags.minConfidence] ?? "",
      ageDays: v.ageDays,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `자율교육_전체현황_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new Response(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "no-store",
    },
  });
}
