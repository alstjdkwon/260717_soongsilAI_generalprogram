"use client";

import { useFormStatus } from "react-dom";
import { ThinkingOrb } from "thinking-orbs";

/** AI 근거 생성 버튼 — 생성 중엔 orb로 진행 중임을 보여준다. */
export function RationaleSubmit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? (
        <span className="rationale-submit-pending">
          <ThinkingOrb state="solving" size={20} theme="light" aria-label="근거 생성 중" />
          생성 중…
        </span>
      ) : (
        label
      )}
    </button>
  );
}
