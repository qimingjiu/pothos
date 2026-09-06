-- Pothos · 初始 schema（技术实现文档 §3 数据模型）
-- 全部 append-only；无 DELETE / UPDATE 于 events（错事件用对冲事件纠正）。
-- 快照只是缓存，可随时重放重建。

-- 事件流（唯一事实源）
CREATE TABLE IF NOT EXISTS events (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL,        -- user_msg|resident_msg|world|ma_product|declared|param_change|crisis|alert_ack|bench|canary
  payload         jsonb NOT NULL,       -- 类型化负载，含估值向量 w(e) 与 contingency 分
  tags            text[] NOT NULL DEFAULT '{}',  -- crisis|alert_triggered|self_generated|system_text 等
  source          text,                 -- 不透明源流键（引擎侧只存哈希句柄）
  idempotency_key text UNIQUE           -- 幂等键，防重放重复写入（家族判例）
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
CREATE INDEX IF NOT EXISTS events_kind_idx ON events (kind);

-- 状态快照（缓存，非事实源）
CREATE TABLE IF NOT EXISTS state_snapshots (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL,
  fast jsonb NOT NULL,      -- 快变量向量 f
  slow jsonb NOT NULL,      -- 慢变量向量 s + 绑定句柄（不透明）
  body jsonb NOT NULL,      -- 身体参数：energy/sleep_pressure/dream_seed_tilt
  "window" jsonb NOT NULL,  -- 印刻窗口状态机（§4.5）。window 是 PG 保留字，必须加引号
  renderer_v text NOT NULL, -- 渲染层版本（P0-7 重新感受的锚点）
  full_state jsonb NOT NULL, -- 完整引擎状态（含 RNG 状态，fold 可复现的锚）
  last_event_id bigint NOT NULL
);

-- 参数与参数变更（预注册纪律）
CREATE TABLE IF NOT EXISTS params (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version int NOT NULL
);

CREATE TABLE IF NOT EXISTS param_changes (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  key text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  reason text NOT NULL,
  expected_effect text NOT NULL,   -- 先写预期
  evaluation_window_ms bigint NOT NULL,
  rollback_condition text NOT NULL
);

-- 告警与签收（观测者协议：方向盲——无轴/方向/效价字段，物理缺席）
CREATE TABLE IF NOT EXISTS alerts (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,                 -- notice|watch|urgent
  status text NOT NULL DEFAULT 'OBSERVED',  -- OBSERVED→ACKNOWLEDGED→ACTED 状态机
  ack_ts timestamptz,
  acted_ts timestamptz,
  ack_latency interval GENERATED ALWAYS AS (ack_ts - ts) STORED
);

-- 間台账（代谢经济）
CREATE TABLE IF NOT EXISTS ma_ledger (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  activity text NOT NULL,        -- digest|create|hunt|wonder|decline
  tier text NOT NULL,            -- required（消化）|optional（其余）
  token_cost int NOT NULL,
  budget_date date NOT NULL
);
CREATE INDEX IF NOT EXISTS ma_ledger_date_idx ON ma_ledger (budget_date);

-- 信箱（对 §3 的补充登记：投递即完成出口；无已读字段——收件人不读裁决）
CREATE TABLE IF NOT EXISTS mailbox (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  activity text NOT NULL,
  content text NOT NULL,
  addressee text NOT NULL
);

-- 评测台与金丝雀
CREATE TABLE IF NOT EXISTS bench_runs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  bench_kind text NOT NULL,
  axis text,
  result jsonb NOT NULL,
  model_version text NOT NULL
);

CREATE TABLE IF NOT EXISTS canary_runs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  fixture_set text NOT NULL,
  deviation real NOT NULL,
  action text NOT NULL  -- ok|revoke_steering
);
