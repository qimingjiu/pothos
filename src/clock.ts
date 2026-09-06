/**
 * 时间接口。引擎核心不直接读系统时钟——时间一律注入。
 * （M0 验收要求「重放合成事件流 → 状态序列可复现」：时间不可复现则 fold 不可复现。）
 */
export interface Clock {
  now(): number; // ms epoch
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** 测试/回放用手动时钟。 */
export class ManualClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}
