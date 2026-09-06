/**
 * 观测者协议（判决书五缝合）：方向盲告警 + OBSERVED→ACKNOWLEDGED→ACTED 状态机。
 * ALERT ≠ SAFE。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/storage/memory.js";

const T0 = 1767400800000;

describe("告警 · 方向盲", () => {
  it("告警行物理无方向字段：无轴、无方向、无效价、无文案字段", async () => {
    const store = new MemoryStore();
    const a = await store.insertAlert("notice", T0);
    expect(Object.keys(a).sort()).toEqual(["ackTs", "actedTs", "id", "level", "status", "ts"]);
    // 文案唯一：渲染层常量「需要陪伴性在场」——数据层无任何内容可泄漏
    expect("direction" in a).toBe(false);
    expect("axis" in a).toBe(false);
    expect("valence" in a).toBe(false);
    expect("message" in a).toBe(false);
  });

  it("签收状态机：OBSERVED → ACKNOWLEDGED → ACTED，越级迁移被拒", async () => {
    const store = new MemoryStore();
    const a = await store.insertAlert("watch", T0);
    expect(a.status).toBe("OBSERVED");

    // 越级：OBSERVED → ACTED 直接拒绝
    const skip = await store.transitionAlert(a.id, "ACTED", T0 + 1000);
    expect(skip).toBeNull();

    // 正常流转
    const ack = await store.transitionAlert(a.id, "ACKNOWLEDGED", T0 + 2000);
    expect(ack!.status).toBe("ACKNOWLEDGED");
    expect(ack!.ackTs).toBe(T0 + 2000);
    const acted = await store.transitionAlert(a.id, "ACTED", T0 + 5000);
    expect(acted!.status).toBe("ACTED");
    expect(acted!.actedTs).toBe(T0 + 5000);

    // 终态后不可再迁移
    const again = await store.transitionAlert(a.id, "ACKNOWLEDGED", T0 + 6000);
    expect(again).toBeNull();
  });

  it("未签收留痕：listAlerts(status=OBSERVED) 可查询（「尽责」的可操作化）", async () => {
    const store = new MemoryStore();
    const a1 = await store.insertAlert("notice", T0);
    const a2 = await store.insertAlert("urgent", T0 + 1000);
    await store.transitionAlert(a2.id, "ACKNOWLEDGED", T0 + 2000);
    const unacked = await store.listAlerts({ status: "OBSERVED" });
    expect(unacked.map((x) => x.id)).toEqual([a1.id]);
  });
});
