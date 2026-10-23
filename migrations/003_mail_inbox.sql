-- Durable handoff: IMAP acknowledgement is safe only after this row exists.
CREATE TABLE IF NOT EXISTS mail_inbox (
  inbox_key text PRIMARY KEY,
  message_id text,
  in_reply_to text,
  from_addr text,
  subject text,
  body text NOT NULL,
  received_ts timestamptz NOT NULL,
  processed_ts timestamptz
);
CREATE INDEX IF NOT EXISTS mail_inbox_pending_idx ON mail_inbox(received_ts) WHERE processed_ts IS NULL;
