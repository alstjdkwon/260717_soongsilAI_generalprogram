import type { InputFile } from "./types";

const ENDPOINT = "https://api.upstage.ai/v1/document-digitization";

/**
 * Upstage OCR — PDF/이미지를 텍스트로. 문서 종류가 제각각이어도 픽셀에서 글자를 읽는다(A3).
 * 응답의 `text` 필드에 전체 인식 텍스트가 담긴다.
 */
export async function ocr(file: InputFile): Promise<string> {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new Error("UPSTAGE_API_KEY 환경변수가 없습니다.");

  const form = new FormData();
  form.append("model", "ocr");
  form.append("document", new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }), file.name);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upstage OCR ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}
