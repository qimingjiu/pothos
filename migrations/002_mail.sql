-- 信件投递 outbox（Huginn 六道门：幂等 + 状态机 + 确知事件；mail-信件通道-v0）
-- 操作状态表（同 alerts）：phase 允许状态机推进；letter_id 幂等主键。

CREATE TABLE IF NOT EXISTS mail_outbox (
  id              bigserial PRIMARY KEY,
  letter_id       text UNIQUE NOT NULL,   -- 幂等主键（Huginn 门 1：同信不重投）
  thread_id       text,                   -- 回信线程句柄
  to_addr         text NOT NULL,          -- 收件地址（部署面给出）
  subject         text NOT NULL,
  body            text NOT NULL,          -- text/plain only（门 4：追踪像素物理缺席）
  phase           text NOT NULL,          -- composed|held|sent|bounced|replied|held_manual
  composed_ts     timestamptz NOT NULL,   -- Date: 头 = 写信时刻（诚实时间之一）
  sent_ts         timestamptz,            -- 引擎侧真实投递记账（她的收到时刻不可知）
  bounce_reason   text,
  message_id      text NOT NULL,          -- 我们的 Message-ID（她回信 In-Reply-To 的匹配键）
  reply_message_id text,                  -- 她回信的 Message-ID（闭环登记）
  attempt_count   int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_outbox_phase_idx ON mail_outbox (phase);
