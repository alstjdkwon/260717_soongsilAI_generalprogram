import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getDb } from "../../../../../db/serverDb";

/**
 * 업로드된 원본 문서를 그대로 내려준다 — 상세화면에서 PDF를 보며 추출값과 대조하기 위한 것.
 * 파일은 data/ 아래에만 있으므로, 경로가 그 밖으로 나가면 거부한다.
 */
const DATA_DIR = join(process.cwd(), "data");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isInteger(docId)) return new Response("bad id", { status: 400 });

  const row = getDb()
    .prepare("SELECT file_path FROM documents WHERE id = ?")
    .get(docId) as { file_path: string | null } | undefined;
  if (!row?.file_path) return new Response("not found", { status: 404 });

  const abs = resolve(DATA_DIR, row.file_path);
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + sep)) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const bytes = await readFile(abs);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        // inline 이라야 브라우저 내장 뷰어로 열린다(다운로드가 아니라).
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // 시드 문서처럼 실물 파일이 없는 경우 — 화면은 팩시밀리로 폴백한다.
    return new Response("file missing", { status: 404 });
  }
}
