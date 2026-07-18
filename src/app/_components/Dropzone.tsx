"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import { uploadDocuments, type UploadState } from "../actions";
import type { IngestResult } from "../../repo/ingest";

const INITIAL: UploadState = { results: [] };

const OUTCOME: Record<IngestResult["outcome"], { label: string; cls: string }> = {
  CREATED_CASE: { label: "새 건 생성", cls: "ok" },
  MATCHED_CASE: { label: "기존 건 매칭", cls: "ok" },
  PENDING_REVIEW: { label: "후보 확인 필요", cls: "warn" },
  UNMATCHED: { label: "미매칭", cls: "warn" },
  UNKNOWN: { label: "판별 실패", cls: "warn" },
};

export function Dropzone() {
  const [state, action, pending] = useActionState(uploadDocuments, INITIAL);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    action(fd);
  }

  return (
    <label
      className={`drop-zone dz${dragging ? " dz-over" : ""}${pending ? " dz-busy" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!pending) submit(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        disabled={pending}
        onChange={(e) => submit(e.target.files)}
      />

      {pending ? (
        <>
          <h1 className="t-hero">AI가 문서를 읽는 중…</h1>
          <p className="sub t-lead">Upstage OCR로 텍스트화하고, 종류를 판별해 필드를 뽑고 있습니다. 몇 초 걸립니다.</p>
        </>
      ) : state.results.length > 0 || state.error ? (
        <>
          <h1 className="t-hero">처리 완료</h1>
          {state.error ? (
            <p className="sub t-lead" style={{ color: "#ff8a8a" }}>{state.error}</p>
          ) : (
            <ul className="dz-results">
              {state.results.map((r, i) => (
                <li key={i}>
                  <span className={`dz-badge ${OUTCOME[r.outcome].cls}`}>{OUTCOME[r.outcome].label}</span>
                  <span className="dz-file">{r.file}</span>
                  <span className="dz-note">{r.note}</span>
                  {r.caseId && (
                    <Link href={`/case/${r.caseId}`} className="dz-link">건 열기 →</Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="hint t-caption">계속하려면 다시 끌어다 놓거나 클릭해 파일을 고르세요.</p>
        </>
      ) : (
        <>
          <h1 className="t-hero">PDF를 끌어다 놓으세요</h1>
          <p className="sub t-lead">신청서·이수증 구분 없이 한 번에. AI가 문서 종류를 판별해 새 건을 만들거나 기존 건에 맞춥니다.</p>
          <p className="hint t-caption">여기를 클릭해 파일을 골라도 됩니다. 여러 개 한꺼번에 가능.</p>
        </>
      )}
    </label>
  );
}
