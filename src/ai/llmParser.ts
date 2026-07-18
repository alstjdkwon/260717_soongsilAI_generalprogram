import type { DocumentParser, InputFile, ParsedDocument } from "./types";
import { ocr } from "./upstage";
import { classifyKind, extractApplication, extractCompletion } from "./extract";

/**
 * 운영 파서 — Upstage OCR 로 텍스트화 → OpenAI 로 종류 판별 → 종류별 필드 추출.
 * 인제스트는 DocumentParser 에만 의존하므로, 이 클래스가 실제 AI 파이프라인을 캡슐화한다.
 */
export class LlmParser implements DocumentParser {
  async parse(file: InputFile): Promise<ParsedDocument> {
    const text = await ocr(file);
    const detectedKind = await classifyKind(text);

    let fields = {};
    if (detectedKind === "APPLICATION") {
      fields = await extractApplication(text);
    } else if (detectedKind === "COMPLETION" || detectedKind === "REPORT") {
      fields = await extractCompletion(text);
    }
    return { detectedKind, fields, rawText: text };
  }
}
