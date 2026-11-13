// Schema version 1. Runtime migrations own the executable DDL.
export const schemaVersion = 1;
export const migration1 = `
CREATE TABLE runtime_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  agent_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  cloud_environment TEXT NOT NULL,
  boot_id TEXT NOT NULL
) STRICT;

CREATE TABLE work_contexts (
  context_id TEXT PRIMARY KEY,
  caller_key TEXT NOT NULL,
  project_id TEXT,
  boot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('open','closed','expired')),
  pwd TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE INDEX contexts_project ON work_contexts(project_id, status);
CREATE INDEX contexts_expiry ON work_contexts(status, expires_at);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  caller_key TEXT NOT NULL,
  context_id TEXT NOT NULL,
  project_id TEXT,
  boot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'accepted','preparing_inputs','running','waiting_input','cancelling',
    'succeeded','failed','cancelled','interrupted'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('inline','script','replay')),
  script_name TEXT,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  code_ref TEXT,
  input_ref TEXT,
  result_ref TEXT,
  logs_ref TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  stop_json TEXT CHECK (stop_json IS NULL OR json_valid(stop_json)),
  cleanup_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cleanup_json)),
  accepted_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  deadline_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((ended_at IS NOT NULL) =
    (status IN ('succeeded','failed','cancelled','interrupted')))
) STRICT;
CREATE INDEX runs_history ON runs(accepted_at DESC, run_id DESC);
CREATE INDEX runs_status ON runs(status, accepted_at DESC, run_id DESC);
CREATE INDEX runs_script ON runs(script_name, accepted_at DESC, run_id DESC);
CREATE INDEX runs_context ON runs(context_id, accepted_at DESC, run_id DESC);
CREATE INDEX runs_project ON runs(project_id, accepted_at DESC, run_id DESC);
CREATE INDEX runs_retention ON runs(ended_at, run_id) WHERE ended_at IS NOT NULL;

CREATE TABLE run_requests (
  caller_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (caller_key, request_id)
) STRICT;
CREATE INDEX requests_expiry ON run_requests(expires_at);
CREATE INDEX requests_run ON run_requests(run_id);

CREATE TABLE run_waits (
  wait_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  status TEXT NOT NULL CHECK (status IN ('waiting','consumed','expired','cancelled')),
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('none','preparing','failed','consumed')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  input_digest TEXT,
  input_ref TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK ((status = 'consumed') = (delivery_state = 'consumed'))
) STRICT;
CREATE UNIQUE INDEX waits_one_active ON run_waits(run_id) WHERE status = 'waiting';
CREATE INDEX waits_run ON run_waits(run_id, created_at);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  origin_run_id TEXT,
  caller_key TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  method TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  maintenance_request_id TEXT UNIQUE,
  approved_revision TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  detail_ref TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
CREATE INDEX operations_run ON operations(origin_run_id, created_at, operation_id);
CREATE INDEX operations_active ON operations(status, created_at);

CREATE TABLE managed_resources (
  resource_id TEXT PRIMARY KEY,
  origin_run_id TEXT,
  owner_run_id TEXT REFERENCES runs(run_id),
  caller_key TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  lifetime TEXT NOT NULL CHECK (lifetime IN ('run','instance','background')),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  diagnostic_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diagnostic_json)),
  created_at INTEGER NOT NULL,
  handed_off_at INTEGER,
  closed_at INTEGER,
  CHECK (lifetime != 'background' OR owner_run_id IS NULL)
) STRICT;
CREATE INDEX resources_owner ON managed_resources(owner_run_id, closed_at);
CREATE INDEX resources_source ON managed_resources(kind, closed_at);

CREATE TABLE transfers (
  transfer_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES managed_resources(resource_id),
  caller_key TEXT NOT NULL,
  origin_run_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('upload','download')),
  status TEXT NOT NULL CHECK (status IN (
    'preparing','pending','transferring','cancelling',
    'succeeded','failed','cancelled','expired','interrupted'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
  result_ref TEXT,
  claim_deadline_at INTEGER,
  transfer_deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
CREATE INDEX transfers_history ON transfers(created_at DESC, transfer_id DESC);

CREATE TABLE mcp_tasks (
  task_id TEXT PRIMARY KEY,
  caller_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  status TEXT NOT NULL,
  result_ref TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_expiry ON mcp_tasks(expires_at);
CREATE INDEX tasks_run ON mcp_tasks(run_id);

CREATE TABLE agent_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE close_receipts (
  context_id TEXT PRIMARY KEY,
  project_id TEXT,
  caller_key TEXT NOT NULL,
  closed_revision INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  closed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX close_expiry ON close_receipts(expires_at);
`;
