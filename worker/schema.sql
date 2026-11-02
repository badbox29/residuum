CREATE TABLE IF NOT EXISTS oplog (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  entity       TEXT    NOT NULL,
  entity_id    TEXT    NOT NULL,
  op           TEXT    NOT NULL,
  payload      TEXT,
  device_id    TEXT,
  client_op_id TEXT    NOT NULL,
  client_at    INTEGER,
  server_at    INTEGER NOT NULL,
  UNIQUE (account_id, client_op_id)
);

CREATE INDEX IF NOT EXISTS idx_oplog_pull ON oplog(account_id, seq);
