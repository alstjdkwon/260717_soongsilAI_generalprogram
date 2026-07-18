import type { Confidence } from "../domain/flags";
import { structured } from "./openai";

/**
 * 직무 부합 근거 생성 — 담당업무 ↔ 교육명이 얼마나 맞는지 한두 문장 근거 + 신뢰도.
 *
 * 콜드스타트 해법(개발계획 §2 Phase 5): 세영 님 교정을 few-shot 으로 주입해
 * "이 조직이 무엇을 직무 연관으로 인정하는가"의 판단 기준을 점점 학습한다.
 * 부합 판단은 애매함이 크므로 reasoning effort 는 high.
 */

export interface RationaleInput {
  name: string;
  department: string | null;
  jobRole: string | null;
  educationName: string | null;
}

/** 세영 님이 교정한 과거 사례 — few-shot 예시로 쓴다. */
export interface CorrectionExample {
  jobRole: string | null;
  educationName: string | null;
  correction: string; // 세영 님이 고쳐 쓴 근거문
}

export interface RationaleResult {
  rationale: string;
  confidence: Confidence;
}

function fewShotBlock(examples: CorrectionExample[]): string {
  if (examples.length === 0) return "";
  const lines = examples
    .map(
      (e, i) =>
        `${i + 1}) 담당업무「${e.jobRole ?? "?"}」· 교육「${e.educationName ?? "?"}」\n   → 세영 님 교정본: ${e.correction}`,
    )
    .join("\n");
  return (
    "\n\n아래는 세영 님이 직접 고쳐 쓴 과거 근거문이다. 세영 님이 무엇을 직무 연관으로 인정/불인정하는지, " +
    "어떤 어조와 근거 방식을 선호하는지 이 사례들에서 학습해 같은 기준으로 판단하라:\n" +
    lines
  );
}

export async function generateFitRationale(
  input: RationaleInput,
  corrections: CorrectionExample[] = [],
): Promise<RationaleResult> {
  const result = await structured<RationaleResult>({
    schemaName: "fit_rationale",
    schema: {
      type: "object",
      properties: {
        rationale: { type: "string" },
        confidence: { type: "string", enum: ["HIGH", "MID", "LOW"] },
      },
      required: ["rationale", "confidence"],
      additionalProperties: false,
    },
    system:
      "너는 한국 대학 교직원의 자율교육 신청을 심사하는 담당자를 돕는다. " +
      "직원의 담당업무와 신청 교육명을 보고, 둘의 직무 연관성 근거를 한국어 1~2문장으로 쓴다. " +
      "연관이 뚜렷하면 confidence HIGH, 간접적/해석 여지가 있으면 MID, 연관을 찾기 어려우면 LOW. " +
      "단정하지 말고 심사자가 판단할 근거를 제시하는 어조로. 없는 사실을 지어내지 마라." +
      fewShotBlock(corrections),
    user:
      `직원: ${input.name} (${input.department ?? "부서 미상"})\n` +
      `담당업무: ${input.jobRole ?? "미상"}\n` +
      `신청 교육: ${input.educationName ?? "미상"}\n\n` +
      "위 교육이 담당업무와 직무상 부합하는지 근거와 신뢰도를 제시하라.",
    effort: "high",
  });
  return result;
}
