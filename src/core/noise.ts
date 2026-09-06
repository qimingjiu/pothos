/**
 * 确定性噪声器官（设计草案 §5「噪声是器官」，技术文档 §5）。
 *
 * 纪律：
 * - 零依赖、可序列化——RNG 内部状态（白噪声种子 + 粉红滤波寄存器）存进引擎状态，
 *   fold 才能在崩溃恢复后逐位复现（M0 验收）。
 * - 粉红噪声 = Paul Kellet 经济滤波器（7 寄存器 IIR），1/f 风味（◆ 开放：具体谱形待定）。
 */

/** mulberry32 单步：输入当前 32 位状态，返回新状态。纯函数，便于序列化。 */
export function mulberryStep(s: number): { s: number; u: number } {
  s = (s + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
  return { s, u };
}

export interface RngState {
  s: number;
  /** Kellet 粉红滤波寄存器 b0..b6 */
  pink: [number, number, number, number, number, number, number];
}

export class Rng {
  constructor(public state: RngState) {}

  static seed(seed: number): Rng {
    return new Rng({
      s: seed | 0,
      pink: [0, 0, 0, 0, 0, 0, 0],
    });
  }

  /** [0,1) 均匀白噪声。 */
  uniform(): number {
    const r = mulberryStep(this.state.s);
    this.state.s = r.s;
    return r.u;
  }

  uniformIn(a: number, b: number): number {
    return a + (b - a) * this.uniform();
  }

  /** Box-Muller 正态。确定性：消耗恰好 2 个 uniform。 */
  normal(mu = 0, sigma = 1): number {
    const u1 = Math.max(this.uniform(), 1e-12);
    const u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    return mu + sigma * r * Math.cos(2 * Math.PI * u2);
  }

  /**
   * 粉红噪声采样（Kellet 滤波器）。输出大致 [-1,1]，方差经 PINK_SCALE 归一。
   * 滤波寄存器是 Rng 状态的一部分 → 可序列化、可复现。
   */
  pink(): number {
    const w = this.uniform() * 2 - 1;
    const p = this.state.pink;
    p[0] = 0.99886 * p[0] + w * 0.0555179;
    p[1] = 0.99332 * p[1] + w * 0.0750759;
    p[2] = 0.969 * p[2] + w * 0.153852;
    p[3] = 0.8665 * p[3] + w * 0.3104856;
    p[4] = 0.55 * p[4] + w * 0.5329522;
    p[5] = -0.7616 * p[5] - w * 0.016898;
    const out = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + w * 0.5362;
    p[6] = w * 0.115926;
    return out / PINK_SCALE;
  }
}

/** Kellet 原始输出的近似标准差，用于归一到 [-1,1] 量级。 */
export const PINK_SCALE = 3.2;
