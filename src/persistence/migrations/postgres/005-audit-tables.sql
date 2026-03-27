CREATE TABLE IF NOT EXISTS gateway_audit (
  id BIGSERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  method TEXT NOT NULL,
  decision TEXT NOT NULL,
  params_json TEXT,
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON gateway_audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_method ON gateway_audit(method);
CREATE INDEX IF NOT EXISTS idx_audit_decision ON gateway_audit(decision);
