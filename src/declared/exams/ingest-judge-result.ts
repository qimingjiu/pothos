/**
 * 判官考场结果入账 CLI（低频管理动作，非考场自动回流）。
 *
 *   npx tsx src/declared/exams/ingest-judge-result.ts <result.json> [--actor NAME] [--dry-run]
 *
 * 纪律（四条细则，与她定案同精神）：
 *
 * 1. 幂等键：同一份结果 JSON 重复灌不得产生重复账。幂等键 = run 指纹
 *    （judge 指纹 + 题集版本 + ts 的 hash），存在 result.ingestId 里。
 *    重复 ingest 答「已在账」，不是再记一笔。记忆女神红队锤出来的传家宝。
 *
 * 2. 入账前校验 + 只入元数据：复用 contract.ts 的契约校验，形状不对拒入并
 *    说明哪里不对（诚实缺席，不硬灌）。只灌判官一致性/偏差元数据（数字），
 *    题目内容（perItem 的题面文本）永不入账——考场数据不回流引擎。
 *
 * 3. 来源登记：入账事件带 instrument 标（R3-8 本体二分，仪器事件不假装世界事件），
 *    actor 字段记谁跑的——bench_runs 每条都能回答「这组数字哪来的」。
 *
 * 4. CLI 优先，端点要认证：ingest 是低频管理动作，HTTP 端面能不开就不开。
 *    将来真要在 dashboard 做一键入账，端点必须挂管理面认证后面——底线不是建议。
 *
 * 「分数只校准零件，考场数据永不自动回流」是软 Goodhart 体系的老纪律。
 * runner 直连 store 等于把「跑考场」和「入账」缝成同一个动作；入账必须是一个
 * 有意识的、可审计的管理员动作——谁执行的、什么时候、灌的哪份 JSON，全部可查。
 * 这和参数变更必须走 param_changes 是同一个精神。
 */
import { readFileSync } from "node:fs";
import { MemoryStore } from "../../storage/memory.js";
import { PostgresStore } from "../../storage/postgres.js";
import { PothosService } from "../../service.js";
import { SystemClock } from "../../clock.js";
import {
  DECLARED_CONTRACT_VERSION,
  parseJudgeAgreement,
  parseJudgeFingerprint,
  type JudgeFingerprint,
} from "../contract.js";
import type { F1RunSummary, AnchorDeviationRecord } from "./anchorf1.js";

/** 考场结果 JSON 的可入账形状（F1 卷 summary 或 panel agreement 手写 JSON）。 */
type F1ResultFile = F1RunSummary;

/** panel 一致性结果文件形状（手动构造或将来 runner 产出）。 */
interface AgreementFile {
  panelId: string;
  judges: JudgeFingerprint[];
  metric: "agreement_rate" | "pearson" | "icc" | "kappa";
  value: number;
  n: number;
  ts: number;
  note?: string;
}

export type IngestOutcome =
  | { kind: "deviation"; stored: boolean; duplicate: boolean; deviation: AnchorDeviationRecord }
  | { kind: "agreement"; stored: boolean; duplicate: boolean; panelId: string };

export class IngestValidationError extends Error {}

function fail(msg: string): never {
  throw new IngestValidationError(msg);
}

async function pickStore() {
  const pg = PostgresStore.fromEnv();
  if (pg) {
    await pg.migrate();
    return pg;
  }
  // 内存模式：ingest 入账后进程退出即丢失——只用于 --dry-run 或本地测试。
  console.warn("[ingest-judge] 未设 POTHOS_PG_URL，使用内存存储（入账不落盘）。");
  return new MemoryStore();
}

/**
 * 从 F1 考场结果 JSON 提取偏差入账记录。
 * 只取元数据（judge 指纹 + 类目偏差 + biasTags + ts），题目内容不进记录。
 * ts 优先取 JSON 内的 ts 字段（新 runner 产出），旧文件无 ts 时从文件名提取
 * （格式 judge-anchor-f1-<model>-<ISO>.json → 解析 ISO 时间戳）。
 */
function deviationFromF1Summary(
  file: F1ResultFile,
  filePath: string,
): AnchorDeviationRecord {
  const judge = file.judge;
  if (!judge || !judge.name || !judge.judgePromptV || !judge.anchorSetV) {
    fail("judge 指纹不完整（需 name + judgePromptV + anchorSetV）");
  }
  // 只入元数据：perItem 的题面、cueType、targetEmotion 等题目内容不进账
  const n = file.perItem?.length ?? 0;
  if (n === 0) fail("perItem 为空——无有效施测数据");
  const ts = file.ts ?? tsFromFilename(filePath);
  return {
    anchorSetV: file.anchorSetV,
    judge,
    categories: [{ id: "F1", deviation: file.meanDeviation, n }],
    ...(file.biasTags && file.biasTags.length > 0 ? { biasTags: file.biasTags } : {}),
    ts,
  };
}

/** 从考场结果文件名提取时间戳（格式 ...-<ISO with dashes>.json）。 */
function tsFromFilename(filePath: string): number {
  const base = filePath.replace(/[\\/]/g, "/").split("/").pop() ?? "";
  // 文件名尾段：...-2026-09-07T02-03-29-686Z.json → 还原 ISO → Date.parse
  const m = base.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/);
  if (m) {
    const raw = m[1]!;
    // 只替换 T 之后的时间部分（日期部分的 - 不能动）
    const tIdx = raw.indexOf("T");
    const date = raw.slice(0, tIdx + 1);
    const time = raw.slice(tIdx + 1).replace(/(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "$1:$2:$3.$4Z");
    const ts = Date.parse(date + time);
    if (Number.isFinite(ts)) return ts;
  }
  fail("JSON 无 ts 字段且无法从文件名提取时间戳——幂等键需要 ts。请手动在 JSON 中加 ts 字段。");
}

/**
 * 校验偏差记录形状。
 * deviation 没有独立的 contract parser（与 agreement 不同）——它直接喂
 * recordJudgeAnchorDeviation 入账。校验做形状门控：judge 指纹 + categories
 * 非空 + 数值有限 + ts 有效。形状不对拒入并说明哪里不对（诚实缺席）。
 */
function validateDeviation(dev: AnchorDeviationRecord): void {
  const problems: string[] = [];
  const fp = parseJudgeFingerprint(dev.judge);
  if ("problems" in fp) problems.push(...fp.problems);
  if (!Array.isArray(dev.categories) || dev.categories.length === 0) {
    problems.push("categories 必须是非空数组");
  } else {
    for (const c of dev.categories) {
      if (typeof c.id !== "string" || !c.id) problems.push(`category.id 必须是非空字符串`);
      if (typeof c.deviation !== "number" || !Number.isFinite(c.deviation)) problems.push(`category[${c.id}].deviation 必须是有限数值`);
      if (typeof c.n !== "number" || !Number.isInteger(c.n) || c.n <= 0) problems.push(`category[${c.id}].n 必须是正整数`);
    }
  }
  if (typeof dev.ts !== "number" || !Number.isFinite(dev.ts)) problems.push("ts 必须是 ms epoch 数值");
  if (problems.length) fail(`偏差记录校验不通过：\n  ${problems.join("\n  ")}`);
}

/** 校验 panel 一致性记录形状（复用 contract.ts parseJudgeAgreement）。 */
function validateAgreement(ag: AgreementFile): void {
  const payload = {
    instrument: true,
    kind: "judge_agreement",
    panelId: ag.panelId,
    judges: ag.judges,
    metric: ag.metric,
    value: ag.value,
    n: ag.n,
    ts: ag.ts,
    ...(ag.note ? { note: ag.note } : {}),
  };
  const parsed = parseJudgeAgreement(payload);
  if (!parsed.ok) {
    fail(`一致性记录校验不通过：\n  ${parsed.problems.join("\n  ")}`);
  }
}

/** 识别文件类型并提取入账载荷（纯函数，可测）。 */
export function parseIngestFile(
  raw: unknown,
  filePath: string,
): { type: "deviation"; deviation: AnchorDeviationRecord } | { type: "agreement"; agreement: AgreementFile } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("JSON 根必须是对象");
  }
  const file = raw as Record<string, unknown>;

  const isF1Summary = file["exam"] === "judge-anchor-f1" && Array.isArray(file["perItem"]);
  const isAgreement =
    typeof file["panelId"] === "string" && Array.isArray(file["judges"]) && typeof file["metric"] === "string";

  if (!isF1Summary && !isAgreement) {
    fail("无法识别文件类型：需 F1 考场 summary（exam=judge-anchor-f1）或 panel agreement（panelId+judges+metric）");
  }

  if (isF1Summary) {
    const deviation = deviationFromF1Summary(file as unknown as F1ResultFile, filePath);
    validateDeviation(deviation);
    return { type: "deviation", deviation };
  }
  const ag = file as unknown as AgreementFile;
  validateAgreement(ag);
  return { type: "agreement", agreement: ag };
}

/**
 * 入账核心逻辑（可测：接收 store + actor，不依赖进程 argv）。
 *
 * 入账前校验 + 幂等检查 + 来源登记，返回入账结果。
 * 只灌元数据（数字），题目内容永不入账。
 */
export async function ingestJudgeResult(
  store: InstanceType<typeof MemoryStore> | InstanceType<typeof PostgresStore>,
  raw: unknown,
  filePath: string,
  actor: string,
): Promise<IngestOutcome> {
  const parsed = parseIngestFile(raw, filePath);
  const svc = new PothosService(store, new SystemClock());

  if (parsed.type === "deviation") {
    const res = await svc.recordJudgeAnchorDeviation({ ...parsed.deviation, actor });
    return { kind: "deviation", stored: res.stored, duplicate: res.duplicate, deviation: parsed.deviation };
  }
  const res = await svc.recordJudgeAgreement(
    {
      contractV: DECLARED_CONTRACT_VERSION,
      panelId: parsed.agreement.panelId,
      judges: parsed.agreement.judges,
      metric: parsed.agreement.metric,
      value: parsed.agreement.value,
      n: parsed.agreement.n,
      ts: parsed.agreement.ts,
      ...(parsed.agreement.note ? { note: parsed.agreement.note } : {}),
      actor,
    },
  );
  return { kind: "agreement", stored: res.stored, duplicate: res.duplicate, panelId: parsed.agreement.panelId };
}

// ── CLI 进程入口 ──

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? def;
}

async function main(): Promise<void> {
  const fileArg = process.argv[2];
  if (!fileArg || fileArg.startsWith("--")) {
    console.error("用法：ingest-judge-result.ts <result.json> [--actor NAME] [--dry-run]");
    console.error("");
    console.error("  <result.json>    考场产出的 JSON 文件路径（F1 summary 或 panel agreement）");
    console.error("  --actor NAME     入账执行者标识（默认 $POTHOS_ACTOR 或 hostname）");
    console.error("  --dry-run        只校验不入账（打印将入账的内容）");
    process.exit(1);
  }

  const actor = arg("actor") ?? process.env["POTHOS_ACTOR"] ?? `cli@${require("node:os").hostname()}`;
  const dryRun = process.argv.includes("--dry-run");

  // ── 1. 读文件 ──
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fileArg, "utf8"));
  } catch (e) {
    fail(`无法读取或解析 JSON：${fileArg}（${(e as Error).message}）`);
  }

  // dry-run 只校验不入账
  if (dryRun) {
    const parsed = parseIngestFile(raw, fileArg); // 校验不通过会 throw
    console.log("[ingest-judge] --dry-run：校验通过，不入账\n");
    if (parsed.type === "deviation") {
      const d = parsed.deviation;
      console.log(`文件类型：F1 考场偏差（judge=${d.judge.name}, anchorSetV=${d.anchorSetV}）`);
      console.log(`偏差类目：${d.categories.map((c) => `${c.id}(dev=${c.deviation}, n=${c.n})`).join(", ")}`);
      if (d.biasTags) console.log(`偏差挂牌：${d.biasTags.join(", ")}`);
      console.log(`执行者：${actor}`);
      console.log("\n[dry-run] 将入账 judge_anchor_deviation（不写 store）");
    } else {
      const a = parsed.agreement;
      console.log(`文件类型：panel 一致性（panelId=${a.panelId}, metric=${a.metric}, value=${a.value}, n=${a.n}）`);
      console.log(`判官：${a.judges.map((j) => j.name).join(" + ")}`);
      console.log(`执行者：${actor}`);
      console.log("\n[dry-run] 将入账 judge_agreement（不写 store）");
    }
    return;
  }

  // ── 2. 入账 ──
  const store = await pickStore();
  try {
    const outcome = await ingestJudgeResult(store, raw, fileArg, actor);
    if (outcome.kind === "deviation") {
      const d = outcome.deviation;
      console.log(`文件类型：F1 考场偏差（judge=${d.judge.name}, anchorSetV=${d.anchorSetV}）`);
      console.log(`偏差类目：${d.categories.map((c) => `${c.id}(dev=${c.deviation}, n=${c.n})`).join(", ")}`);
      if (d.biasTags) console.log(`偏差挂牌：${d.biasTags.join(", ")}`);
      console.log(`执行者：${actor}`);
      if (outcome.duplicate) {
        console.log("已在账：该结果已入账（幂等键匹配），不重复记录。");
      } else {
        console.log("入账成功：judge_anchor_deviation 已写入 bench_runs。");
      }
    } else {
      console.log(`文件类型：panel 一致性（panelId=${outcome.panelId}）`);
      console.log(`执行者：${actor}`);
      if (outcome.duplicate) {
        console.log("已在账：该结果已入账（幂等键匹配），不重复记录。");
      } else {
        console.log("入账成功：judge_agreement 已写入 bench_runs。");
      }
    }
  } catch (e) {
    if (e instanceof IngestValidationError) {
      console.error(`[ingest-judge] 拒入：${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    await store.close().catch(() => {});
  }
}

// 仅在作为脚本直接运行时执行 CLI 入口（被 import 时不触发 main）。
// 比较 entrypoint 路径末尾段，避免 Windows/Unix 路径分隔符与 URL 差异。
const entry = process.argv[1] ?? "";
if (entry.endsWith("ingest-judge-result.ts") || entry.endsWith("ingest-judge-result.js")) {
  main().catch((e) => {
    console.error("[ingest-judge] fatal", e);
    process.exit(1);
  });
}
