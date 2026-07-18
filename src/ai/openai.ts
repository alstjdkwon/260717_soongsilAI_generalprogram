import OpenAI from "openai";

/**
 * OpenAI 구조화 출력 호출 한 겹.
 *  - 판별·추출은 모두 고정 JSON 스키마(strict)로 받아 파싱 실패를 없앤다.
 *  - 모델은 gpt-5.6-terra(내부 도구용) 우선, 미제공 시 5.4 → 5.4-mini 폴백(개발계획 §2).
 *  - reasoning_effort 를 모델이 거부하면 그 인자만 빼고 한 번 더 시도.
 */

const PRIMARY = process.env.OPENAI_MODEL ?? "gpt-5.6-terra";
const FALLBACKS = ["gpt-5.4", "gpt-5.4-mini"];

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY 환경변수가 없습니다.");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export type Effort = "low" | "medium" | "high";

interface StructuredOpts {
  schemaName: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  effort?: Effort;
}

function isModelMissing(e: unknown): boolean {
  const err = e as { status?: number; code?: string; message?: string };
  return err?.status === 404 || err?.code === "model_not_found" || /model/i.test(err?.message ?? "") && err?.status === 400;
}

function isEffortRejected(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? "";
  return /reasoning_effort|unsupported parameter|Unknown parameter/i.test(msg);
}

async function callOnce<T>(model: string, o: StructuredOpts): Promise<T> {
  const base = {
    model,
    messages: [
      { role: "system" as const, content: o.system },
      { role: "user" as const, content: o.user },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: o.schemaName, strict: true, schema: o.schema },
    },
  };
  const params = o.effort ? { ...base, reasoning_effort: o.effort } : base;

  let res;
  try {
    res = await openai().chat.completions.create(params as never);
  } catch (e) {
    if (o.effort && isEffortRejected(e)) {
      res = await openai().chat.completions.create(base as never);
    } else {
      throw e;
    }
  }
  const content = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(content) as T;
}

export async function structured<T>(o: StructuredOpts): Promise<T> {
  const models = [PRIMARY, ...FALLBACKS];
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await callOnce<T>(model, o);
    } catch (e) {
      lastErr = e;
      if (isModelMissing(e)) continue; // 다음 폴백 모델로
      throw e; // 그 외 오류는 즉시 표면화
    }
  }
  throw lastErr;
}
