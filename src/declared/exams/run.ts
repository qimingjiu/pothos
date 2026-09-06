/**
 * 考场 CLI：npx tsx src/declared/exams/run.ts <exam> [opts]
 *
 *   semeval  --model M [--n 40] [--emotion anger,fear] [--concurrency 4]
 *   eqbench  --model M [--n 60] [--offset 0] [--concurrency 4]
 *   emobench --model M [--n 25] [--concurrency 4]
 *
 * 数据目录固定 exams/data/（不入库）；结果落 exams/results/。
 * 铁律在案：分数只校准零件（锚点/投影/选型），永不回流引擎。
 */
import { ArkCliTransport } from "../classifier.js";
import { DeclaredClassifier } from "../classifier.js";
import { runSemevalEIReg } from "./semeval.js";
import { runEQBench } from "./eqbench.js";
import { runEmoBench } from "./emobench.js";

const DATA_DIR = "exams/data";

function arg(name: string, def: string): string;
function arg(name: string, def?: string): string | undefined;
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? def;
}

async function main(): Promise<void> {
  const exam = process.argv[2];
  const model = arg("model", "doubao-seed-evolving");
  const promptV = arg("promptV", "v1") === "v2" ? "v2" : "v1";
  const concurrency = Number(arg("concurrency", "4"));
  const transport = new ArkCliTransport({ model, timeoutMs: 180_000 });
  console.log(`考场=${exam} 模型=${model} promptV=${promptV} 并发=${concurrency}`);

  if (exam === "semeval") {
    const n = Number(arg("n", "40"));
    const emotions = arg("emotion")?.split(",");
    const clf = new DeclaredClassifier(transport, { promptV });
    const { file } = await runSemevalEIReg(clf, DATA_DIR, { nPerEmotion: n, concurrency, emotions });
    console.log(`结果：${file}`);
  } else if (exam === "eqbench") {
    const n = Number(arg("n", "60"));
    const offset = Number(arg("offset", "0"));
    const clf = new DeclaredClassifier(transport, { promptV });
    const { file } = await runEQBench(clf, DATA_DIR, { n, offset, concurrency });
    console.log(`结果：${file}`);
  } else if (exam === "emobench") {
    const n = Number(arg("n", "25"));
    const { file } = await runEmoBench(transport, DATA_DIR, { nPerQuadrant: n, concurrency });
    console.log(`结果：${file}`);
  } else {
    console.error("用法：run.ts <semeval|eqbench|emobench> [--model M] [--n N] [--emotion e1,e2] [--offset N] [--concurrency C]");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
