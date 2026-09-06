import { ManualClock } from "../src/clock.js";
import { MemoryStore } from "../src/storage/memory.js";
import { PothosService } from "../src/service.js";
import type { RawEvent } from "../src/core/events.js";

export const T0 = 1767400800000; // 2026-01-03T00:00:00Z（固定时基，测试确定性）

export function makeService(opts: { clock?: ManualClock; token?: string } = {}): {
  svc: PothosService;
  store: MemoryStore;
  clock: ManualClock;
} {
  const clock = opts.clock ?? new ManualClock(T0);
  const store = new MemoryStore();
  const svc = new PothosService(store, clock);
  return { svc, store, clock };
}

let seq = 0;
export function rawEvent(partial: Partial<RawEvent> & { kind: RawEvent["kind"]; ts: number }): RawEvent {
  seq += 1;
  return {
    payload: {},
    tags: [],
    idempotencyKey: `test-${seq}-${Math.random().toString(36).slice(2)}`,
    ...partial,
  };
}
