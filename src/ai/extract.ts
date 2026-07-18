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
const RAW_FIELD = {
  type: "object",
  properties: {
    value: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["HIGH", "MID", "LOW"] },
  },
  required: ["value", "confidence"],
  additionalProperties: false,
} as const;

interface RawField {
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
      "수강 '신청서'면 APPLICATION, '이수증/수료증/이수확인서'면 COMPLETION, '결과보고서'면 REPORT, " +
      "판단이 어려우면 UNKNOWN. 반드시 하나만 고른다.",
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
      "각 필드에 값과 신뢰도(HIGH/MID/LOW)를 매긴다. " +
      "OCR 텍스트에 값이 또렷하면 HIGH, 일부 가려지거나 뭉개져 애매하면 MID, " +
      "가림·번짐·중복표기로 확신이 어렵거나 값이 안 보이면 LOW. " +
      "추정하지 말고, 안 보이면 value 를 null 로 두고 confidence 를 LOW 로 하라. " +
      "금액·시간은 숫자만(단위·콤마 제외).",
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
