/**
 * 가상 양식 PDF 생성기 (개발·테스트용, A4 가정).
 *
 *   node scripts/make-pdfs.ts        → data/fixtures/*.pdf 생성
 *
 * 한글은 시스템 폰트(AppleGothic.ttf)를 서브셋 임베드한다. 실제 양식 도착 시 폐기.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { FIXTURES, type Fixture } from "./fixtures.ts";

const FONT_PATH = "/System/Library/Fonts/Supplemental/AppleGothic.ttf";
const OUT_DIR = join(process.cwd(), "data", "fixtures");

const INK = rgb(0.1, 0.12, 0.16);
const MUTE = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.78, 0.8, 0.83);
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

interface Ctx {
  page: PDFPage;
  font: PDFFont;
}

function text(
  { page, font }: Ctx,
  s: string,
  x: number,
  y: number,
  size = 11,
  color = INK,
): void {
  page.drawText(s, { x, y, size, font, color });
}

/** 라벨 : 값  한 줄 (밑줄 있는 폼 필드). */
function labeledRow(ctx: Ctx, label: string, value: string, x: number, y: number, w = 360): void {
  text(ctx, label, x, y, 10.5, MUTE);
  text(ctx, value, x + 96, y, 12);
  ctx.page.drawLine({
    start: { x: x + 90, y: y - 4 },
    end: { x: x + 90 + w, y: y - 4 },
    thickness: 0.6,
    color: LINE,
  });
}

// ── 신청서 고정폼 ───────────────────────────────────────
function drawApplication(ctx: Ctx, fx: Fixture): void {
  const { page } = ctx;
  const { expect: e } = fx;
  const x = 70;
  page.drawRectangle({ x: 50, y: 760, width: 495, height: 52, color: rgb(0.95, 0.96, 0.98) });
  text(ctx, "숭실대학교 교직원 자율교육 수강 신청서", x, 780, 17);
  text(ctx, "SOONGSIL UNIVERSITY · 자율교육 관리", x, 766, 9, MUTE);

  text(ctx, "■ 신청인", x, 720, 11, MUTE);
  labeledRow(ctx, "성명", e.name, x, 692);
  labeledRow(ctx, "소속 부서", e.department ?? "", x, 662);

  text(ctx, "■ 교육 내용", x, 616, 11, MUTE);
  labeledRow(ctx, "교육명", e.education_name, x, 588);
  labeledRow(ctx, "예상 수강료", won(e.amount), x, 558);
  labeledRow(ctx, "교육 기관", "한국능률협회 평생교육원", x, 528);

  text(ctx, "■ 신청 사유", x, 482, 11, MUTE);
  text(ctx, "담당 직무 역량 강화를 위해 위 교육 과정 수강을 신청합니다.", x, 456, 11);

  text(ctx, `신청일: 2026-07-15    신청인: ${e.name} (인)`, x, 380, 11, MUTE);
  text(ctx, "※ 임의 생성 데이터 — 실제 인물·기관과 무관", x, 90, 9, MUTE);
}

// ── 이수증 폼 A: 표 형식 ────────────────────────────────
function drawCertA(ctx: Ctx, fx: Fixture): void {
  const { page } = ctx;
  const { expect: e } = fx;
  const x = 60;
  text(ctx, "교 육 이 수 확 인 서", x, 780, 20);
  text(ctx, "발급기관: 한국능률협회 평생교육원", x, 754, 10, MUTE);

  const rows: [string, string][] = [
    ["이수자", e.name],
    ["과정명", e.education_name],
    ["수강료", won(e.amount)],
    ["이수시간", `${e.hours}시간`],
    ["이수일자", "2026-07-14"],
  ];
  let y = 700;
  for (const [k, v] of rows) {
    page.drawRectangle({ x, y: y - 8, width: 150, height: 30, color: rgb(0.94, 0.95, 0.97) });
    page.drawRectangle({ x: x + 150, y: y - 8, width: 325, height: 30, borderColor: LINE, borderWidth: 0.6 });
    page.drawRectangle({ x, y: y - 8, width: 150, height: 30, borderColor: LINE, borderWidth: 0.6 });
    text(ctx, k, x + 14, y, 11, MUTE);
    text(ctx, v, x + 164, y, 12);
    y -= 30;
  }
  text(ctx, "위 사람은 상기 과정을 성실히 이수하였음을 확인합니다.", x, y - 24, 11);
  text(ctx, "2026-07-14   한국능률협회 평생교육원장 (직인)", x, y - 60, 10, MUTE);
  text(ctx, "※ 임의 생성 데이터", x, 90, 9, MUTE);
}

// ── 이수증 폼 B: 증서(서술) 형식 ────────────────────────
function drawCertB(ctx: Ctx, fx: Fixture): void {
  const { expect: e } = fx;
  const cx = 297; // 중앙 정렬 기준
  const center = (s: string, y: number, size: number, color = INK) => {
    const w = ctx.font.widthOfTextAtSize(s, size);
    text(ctx, s, cx - w / 2, y, size, color);
  };
  ctx.page.drawRectangle({ x: 40, y: 60, width: 515, height: 730, borderColor: rgb(0.6, 0.5, 0.2), borderWidth: 2.5 });
  center("修 了 證 書", 720, 30);
  center("이수증서", 690, 13, MUTE);
  center(`성명 :  ${e.name}`, 610, 16);
  center("위 사람은 아래 교육과정을 이수하였기에 이 증서를 수여함", 560, 11, MUTE);
  center(`「${e.education_name}」`, 510, 17);
  center(`총 ${e.hours}시간 이수  ·  수강료 ${won(e.amount)}`, 470, 13);
  center("2026년 7월 14일", 360, 12, MUTE);
  center("디지털역량교육센터", 330, 14);
  center("※ 임의 생성 데이터", 100, 9, MUTE);
}

// ── 이수증 폼 C: 열화 스캔(가림·회전 스탬프·노이즈) ─────
function drawCertC(ctx: Ctx, fx: Fixture): void {
  const { page } = ctx;
  const { expect: e } = fx;
  const x = 64;
  text(ctx, "수 료 증 (재발급)", x, 782, 19);
  text(ctx, "평생교육진흥원 · 스캔 원본", x, 758, 10, MUTE);

  labeledRow(ctx, "성명", e.name, x, 700, 320);
  labeledRow(ctx, "교육과정", e.education_name, x, 662, 320);
  // 열화: 금액·시간은 값을 아예 남기지 않고(텍스트 레이어도 없음) 얼룩만 → OCR·텍스트추출 모두 복구 불가 → 저신뢰(LOW).
  labeledRow(ctx, "수강료", "", x, 624, 320);
  labeledRow(ctx, "이수시간", "", x, 586, 320);
  page.drawRectangle({ x: x + 92, y: 618, width: 78, height: 22, color: rgb(0.08, 0.08, 0.09) });
  page.drawRectangle({ x: x + 92, y: 580, width: 60, height: 22, color: rgb(0.1, 0.1, 0.11) });
  text(ctx, "발급일 2026-07-13", x, 540, 10, MUTE);
  // 회전 스탬프가 교육명을 가로지름
  page.drawText("재 발 급", { x: 200, y: 600, size: 52, font: ctx.font, color: rgb(0.7, 0.18, 0.18), opacity: 0.4, rotate: degrees(20) });
  // 스캔 노이즈 반점
  const spots = [[120, 500], [300, 470], [420, 690], [180, 640], [360, 610], [90, 560]];
  for (const [sx, sy] of spots) {
    page.drawRectangle({ x: sx, y: sy, width: 3, height: 2, color: rgb(0.3, 0.3, 0.3), opacity: 0.4 });
  }
  text(ctx, "※ 임의 생성 데이터", x, 90, 9, MUTE);
}

const RENDERERS: Record<string, (ctx: Ctx, fx: Fixture) => void> = {
  APPLICATION: drawApplication,
  CERT_A: drawCertA,
  CERT_B: drawCertB,
  CERT_C: drawCertC,
};

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const fontBytes = readFileSync(FONT_PATH);

  for (const fx of FIXTURES) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    const page = doc.addPage([595, 842]);
    RENDERERS[fx.form]({ page, font }, fx);
    const bytes = await doc.save();
    writeFileSync(join(OUT_DIR, fx.file), bytes);
    console.log(`  ✓ ${fx.file}  (${fx.form}${fx.degrade ? ", 열화" : ""})`);
  }
  console.log(`\n${FIXTURES.length}개 생성 → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
