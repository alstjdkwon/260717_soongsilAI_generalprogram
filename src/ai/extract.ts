import type { Confidence, ExtractedField, ExtractedFields } from "../domain/flags";
import { structured } from "./openai";
import type { DetectedKind } from "./types";

/**
 * OCR 텍스트 → 문서종류 판별 + 필드 추출(필드별 신뢰도).
 *
 * parseApplication/parseCompletion 을 나눠 둔 이유(A4): 실제 신청서 양식이 도착하면
 * `extractApplication` 만 규칙기반 파서로 갈아끼우고 나머지는 그대로 둔다.
 *
 * 신뢰도는 OCR 텍스트에 값이 얼마나 또렷이 잡혔는지로 모델이 매긴다 —
 * 가려지거나 뭉개진 값은 LOW → 인제스트가 검토 필요 큐로 라우팅한다.
 */

// value 는 문자열로 받고(스키마 단순화), 금액·시간만 숫자로 변환한다.
// present 는 "그 항목이 이 문서에 아예 없는가"를 가른다 — 없는 항목(이수증의 수강료 등)을
// 추출 실패(저신뢰)로 오인하면 멀쩡한 서류가 '원본 대조 필요'로 잘못 뜬다.
const RAW_FIELD = {
  type: "object",
  properties: {
    present: { type: "boolean" },
    value: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["HIGH", "MID", "LOW"] },
  },
  required: ["present", "value", "confidence"],
  additionalProperties: false,
} as const;

interface RawField {
  present: boolean;
  value: string | null;
  confidence: Confidence;
}

function schemaOf(keys: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, RAW_FIELD])),
    required: keys,
    additionalProperties: false,
  };
}

function toField(raw: RawField | undefined, numeric: boolean): ExtractedField | undefined {
  if (!raw) return undefined;
  // 문서에 원래 없는 항목은 필드 자체를 빼서 신뢰도 계산·대조에서 제외한다.
  if (!raw.present) return undefined;
  const trimmed = raw.value?.trim() ?? "";
  const empty = trimmed === "";
  let value: string | number | null = empty ? null : trimmed;
  if (numeric && !empty) {
    const n = Number(String(raw.value).replace(/[^\d.-]/g, ""));
    value = Number.isFinite(n) ? n : null;
  }
  // 값이 비면 신뢰도는 LOW 로 강등 — 빈 칸을 고신뢰로 넘기지 않는다.
  return { value, confidence: value == null ? "LOW" : raw.confidence };
}

export async function classifyKind(text: string): Promise<DetectedKind> {
  const { kind } = await structured<{ kind: DetectedKind }>({
    schemaName: "doc_kind",
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["APPLICATION", "COMPLETION", "REPORT", "UNKNOWN"] } },
      required: ["kind"],
      additionalProperties: false,
    },
    system:
      "너는 한국 대학의 교직원 자율교육 서류를 분류한다. " +
      "제목이 아니라 **문서의 목적과 시제**로 판단하라 — 기관마다 양식 이름이 제각각이라 제목은 믿을 수 없다.\n" +
      "- APPLICATION: 교육을 듣기 전에 승인·지원을 받으려는 문서. 신청자·교육명·교육기간·수강료와 함께 " +
      "수강 사유나 기대 효과·업무 적용 계획이 미래형('~하고자 합니다', '~할 예정')으로 적혀 있다. " +
      "제목이 '교육보고서', '교육계획서', '수강 품의' 등이어도 내용이 사전 승인 요청이면 APPLICATION 이다.\n" +
      "- COMPLETION: 교육을 마쳤음을 발급기관이 증명하는 문서(이수증·수료증·이수확인서). " +
      "발급기관·이수시간·수료일·직인이 있고 '위 사람은 ~ 이수하였음' 같은 증명 문구가 핵심이다.\n" +
      "- REPORT: 교육을 마친 뒤 본인이 배운 내용·결과를 사후 보고하는 문서. 과거형('~을 배웠다', '~에 적용했다')으로 " +
      "실제 수강 결과를 서술한다.\n" +
      "- UNKNOWN: 위 셋 어디에도 해당하지 않을 때만.\n" +
      "핵심 구분: 교육을 아직 안 들었고 승인을 구하는 문서면 APPLICATION, 다 듣고 증명받은 문서면 COMPLETION, " +
      "다 듣고 스스로 결과를 보고하는 문서면 REPORT. 반드시 하나만 고른다.",
    user: `다음 OCR 텍스트의 문서 종류를 판별하라:\n\n${text}`,
    effort: "low",
  });
  return kind;
}

async function extractFields(
  text: string,
  keys: (keyof ExtractedFields)[],
  label: string,
): Promise<ExtractedFields> {
  const raw = await structured<Record<string, RawField>>({
    schemaName: "fields",
    schema: schemaOf(keys as string[]),
    system:
      `너는 한국 대학 교직원 자율교육 ${label}에서 필드를 추출한다. ` +
      "각 필드마다 present / value / confidence 를 매긴다.\n" +
      "present 는 '그 항목이 이 문서에 원래 있는가'다 — 추출 성공 여부가 아니다.\n" +
      "- 문서에 그 항목 자체가 없으면(항목명도 값도 없음) present=false, value=null, confidence=LOW. " +
      "예: 이수증·수료증에는 수강료가 적히지 않는 경우가 많다. 이건 정상이며 오류가 아니다.\n" +
      "- 항목은 있는데 가려짐·번짐·잘림으로 값을 못 읽으면 present=true, value=null, confidence=LOW. " +
      "이건 사람이 원본을 확인해야 하는 경우다.\n" +
      "- 값을 읽었으면 present=true 이고, 또렷하면 HIGH, 일부 흐릿해 애매하면 MID.\n" +
      "추정해서 지어내지 마라. 금액·시간은 숫자만(단위·콤마 제외).",
    user: `다음 OCR 텍스트에서 필드를 추출하라:\n\n${text}`,
    effort: "medium",
  });

  const out: ExtractedFields = {};
  for (const k of keys) {
    const numeric = k === "amount" || k === "hours";
    const f = toField(raw[k], numeric);
    if (f) out[k] = f;
  }
  return out;
}

/** 신청서 필드 추출 — 실제 양식 도착 시 규칙기반으로 교체될 지점(A4). */
export function extractApplication(text: string): Promise<ExtractedFields> {
  return extractFields(text, ["name", "department", "education_name", "amount"], "수강 신청서");
}

/** 이수증/결과보고서 필드 추출 — 폼이 제각각이라 LLM 유지. */
export function extractCompletion(text: string): Promise<ExtractedFields> {
  return extractFields(text, ["name", "education_name", "amount", "hours"], "이수증");
}
