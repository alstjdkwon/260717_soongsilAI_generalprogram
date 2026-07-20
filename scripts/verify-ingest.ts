/**
 * Phase 3 라이브 검증 — 가상 PDF 전량을 실제 파이프라인(Upstage OCR + OpenAI)에 투입한다.
 *
 *   node --env-file=.env scripts/verify-ingest.ts     (= npm run verify:ingest)
 *
 * 채점(개발계획 §2 Phase 3 검증 기준):
 *   1) 문서 종류 판별 100%           — 신청서/이수증을 정확히 가르는가
 *   2) 추출 오류가 저신뢰로 플래그    — 열화 스캔(comp-03)의 가려진 필드가 LOW 로 잡히는가
 *   3) 신청→새 건 / 이수증→기존 건 매칭이 정상 동작하는가
 *
 * 시드 데이터를 오염시키지 않도록 인메모리 DB 를 쓴다(운영 app.db 와 분리).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { LlmParser } from "../src/ai/llmParser.ts";
import { ingestFiles } from "../src/repo/ingest.ts";
import { transitionCase } from "../src/repo/cases.ts";
import { getCaseView } from "../src/repo/queries.ts";
import type { InputFile } from "../src/ai/types.ts";
import type { ExtractedFields } from "../src/domain/flags.ts";
import { FIXTURES, type Fixture } from "./fixtures.ts";

const FIX_DIR = join(process.cwd(), "data", "fixtures");

function load(fx: Fixture): InputFile {
  return { name: fx.file, bytes: readFileSync(join(FIX_DIR, fx.file)), mime: "application/pdf" };
}

function fieldCell(fields: ExtractedFields | undefined, key: keyof ExtractedFields): string {
  const f = fields?.[key];
  if (!f) return "·";
  const conf = f.confidence === "HIGH" ? "고" : f.confidence === "MID" ? "중" : "저";
  return `${f.value ?? "∅"}[${conf}]`;
}

async function main(): Promise<void> {
  const db = openDb();
  const parser = new LlmParser();

  const apps = FIXTURES.filter((f) => f.kind === "APPLICATION");
  const comps = FIXTURES.filter((f) => f.kind === "COMPLETION");

  console.log(`\n▶ 라이브 파이프라인 검증 — ${FIXTURES.length}개 문서\n`);

  // 1) 신청서 인제스트 → 각 건 승인(이수 대기로) → 이수증이 매칭될 수 있게.
  const appResults = await ingestFiles(db, parser, apps.map(load), "APPLICATION");
  for (const r of appResults) {
    if (r.outcome === "CREATED_CASE" && r.caseId) transitionCase(db, r.caseId, "APPROVE");
  }
  // 2) 이수증 인제스트.
  const compResults = await ingestFiles(db, parser, comps.map(load), "COMPLETION");

  const byFile = new Map([...appResults, ...compResults].map((r) => [r.file, r]));

  // ── 채점 ────────────────────────────────────────────
  let kindOk = 0;
  const rows: string[] = [];
  for (const fx of FIXTURES) {
    const r = byFile.get(fx.file)!;
    const kindMatch = r.detectedKind === fx.kind;
    if (kindMatch) kindOk++;
    const view = r.caseId ? getCaseView(db, r.caseId) : undefined;
    const src = fx.kind === "APPLICATION" ? view?.application : view?.completion;
    rows.push(
      [
        `${kindMatch ? "✓" : "✗"} ${fx.file}`,
        `판별 ${r.detectedKind}${kindMatch ? "" : ` (기대 ${fx.kind})`}`,
        r.outcome,
        `이름 ${fieldCell(src, "name")}`,
        `교육 ${fieldCell(src, "education_name")}`,
        `금액 ${fieldCell(src, "amount")}`,
        fx.kind === "COMPLETION" ? `시간 ${fieldCell(src, "hours")}` : "",
        fx.degrade ? "◀ 열화(저신뢰 기대)" : "",
      ]
        .filter(Boolean)
        .join("  ·  "),
    );
  }
  console.log(rows.join("\n"));

  // 열화 건이 실제로 저신뢰로 플래그됐는지.
  const degraded = FIXTURES.find((f) => f.degrade)!;
  const dr = byFile.get(degraded.file)!;
  const dv = dr.caseId ? getCaseView(db, dr.caseId) : undefined;
  const degradedLow = dv?.completion?.amount?.confidence === "LOW" || dv?.completion?.hours?.confidence === "LOW";
  const degradedFlagged = dv?.flags.needsReview === true;

  // 매칭 결과.
  const created = [...appResults].filter((r) => r.outcome === "CREATED_CASE").length;
  const matched = [...compResults].filter((r) => r.outcome === "MATCHED_CASE").length;

  console.log("\n── 채점 ─────────────────────────────");
  console.log(`  문서 종류 판별   : ${kindOk}/${FIXTURES.length} ${kindOk === FIXTURES.length ? "✓ 100%" : "✗"}`);
  console.log(`  신청서→새 건     : ${created}/${apps.length}`);
  console.log(`  이수증→기존 건   : ${matched}/${comps.length}`);
  console.log(`  열화 저신뢰 플래그: ${degradedLow ? "✓ LOW 감지" : "✗ 저신뢰 미감지"} · 검토큐 ${degradedFlagged ? "✓" : "✗"} (${degraded.file})`);

  const pass = kindOk === FIXTURES.length && degradedLow && degradedFlagged && matched === comps.length;
  console.log(`\n${pass ? "✅ Phase 3 검증 통과" : "⚠️  일부 기준 미달 — 위 표 확인"}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("검증 실패:", e);
  process.exit(1);
});
