import type { ExtractedFields } from "../domain/flags";

/**
 * 파서 계층 — 원본 파일(bytes)을 "문서종류 + 추출필드"로 바꾼다.
 *
 * 인제스트(repo/ingest)는 이 인터페이스에만 의존한다. 그래서:
 *  - 테스트·오프라인 데모는 FakeParser 를 꽂고 (네트워크 0, 결정적),
 *  - 운영은 LlmParser(Upstage OCR + OpenAI) 를 꽂고,
 *  - 실제 신청서 양식이 도착하면(A4) parseApplication 만 규칙기반으로 교체한다.
 */

/** AI 가 판별한 문서 종류. 확신이 없으면 UNKNOWN → 인제스트가 검토 큐로 보낸다. */
export type DetectedKind = "APPLICATION" | "COMPLETION" | "REPORT" | "UNKNOWN";

export interface InputFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface ParsedDocument {
  detectedKind: DetectedKind;
  fields: ExtractedFields;
  /** OCR 원문 — 감사·디버그용(선택). */
  rawText?: string;
}

export interface DocumentParser {
  parse(file: InputFile): Promise<ParsedDocument>;
}
