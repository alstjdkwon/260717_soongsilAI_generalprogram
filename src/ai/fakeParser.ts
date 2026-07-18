import type { DocumentParser, InputFile, ParsedDocument } from "./types";

/**
 * 결정적 파서 — 파일명으로 미리 정해둔 결과를 돌려준다.
 * 네트워크 없이 인제스트 로직을 단위 테스트하고, 오프라인 데모를 돌리는 데 쓴다.
 */
export class FakeParser implements DocumentParser {
  constructor(private readonly responses: Record<string, ParsedDocument>) {}

  async parse(file: InputFile): Promise<ParsedDocument> {
    const hit = this.responses[file.name];
    if (hit) return hit;
    // 등록되지 않은 파일은 "판별 실패"로 — 인제스트가 검토 큐로 라우팅하는 경로를 탄다.
    return { detectedKind: "UNKNOWN", fields: {} };
  }
}
