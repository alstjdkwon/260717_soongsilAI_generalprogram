-- 자율교육 관리 도구 스키마 (Phase 1)
-- 기록 저장소는 "사람(직원) 중심" — 신청 건이 사람에 딸린다 (기획서 §5 확장 훅).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,          -- 이름
  department       TEXT,                   -- 부서
  job_role         TEXT,                   -- 담당업무 (직무 부합 판단용)
  remaining_points INTEGER,               -- 잔여 포인트
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  -- 확장 훅: 지금은 자율교육만, 인사팀주관/일반은 구조만 (기획서 §5)
  education_type  TEXT NOT NULL DEFAULT 'AUTONOMOUS',
  education_name  TEXT,                    -- 교육명
  expected_cost   INTEGER,                 -- 예상 비용
  status          TEXT NOT NULL DEFAULT 'SCREENING',
  reject_reason   TEXT,                    -- 반려 사유 (반려 시 필수)
  prev_case_id    INTEGER REFERENCES cases(id), -- 재신청 시 이전 반려 건 연결
  created_at      TEXT NOT NULL DEFAULT (datetime('now')), -- 접수일
  approved_at     TEXT,                    -- 승인일
  docs_arrived_at TEXT,                    -- 서류 도착일
  refunded_at     TEXT,                    -- 환급일
  rejected_at     TEXT                     -- 반려일
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_employee ON cases(employee_id);

CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id          INTEGER NOT NULL REFERENCES cases(id),
  kind             TEXT NOT NULL,          -- APPLICATION | COMPLETION | REPORT
  file_path        TEXT,
  detected_kind    TEXT,                   -- AI 문서종류 판별 결과
  extracted_fields TEXT,                   -- JSON: 필드값 + 필드별 신뢰도(HIGH/MID/LOW)
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);

CREATE TABLE IF NOT EXISTS reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  fit_rationale  TEXT,                     -- AI 직무 부합 근거문 (교정 시 교정본으로 대체)
  fit_confidence TEXT,                     -- 근거 신뢰도 HIGH/MID/LOW (Phase 5)
  correction     TEXT,                     -- 세영님 교정 (few-shot 축적용)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 도구 설정 키-값 (Phase 6). 예: overdue_weeks = 이수 대기 경과 알림 기준(주).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 어느 신청 건에 붙일지 애매한 이수증 보관함 (Phase 4).
-- 동명이인·다중 이수대기처럼 자동 매칭이 위험한 경우, 버리지 않고 여기 담아
-- 세영 님이 후보 중 골라 붙이게 한다. 첨부되면 이 행은 삭제되고 documents 로 옮겨진다.
CREATE TABLE IF NOT EXISTS pending_documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL,          -- COMPLETION | REPORT
  file_path        TEXT,
  detected_kind    TEXT,                   -- AI 문서종류 판별 결과
  extracted_fields TEXT,                   -- JSON: documents.extracted_fields 와 동일 형식
  candidate_ids    TEXT,                   -- JSON 배열: 후보 case id (유사도 내림차순)
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
