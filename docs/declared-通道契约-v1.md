# declared 通道契约 v1（A2 主线）

> 状态：**v1 已落地**（`src/declared/contract.ts` + 校验门 + 测试）。本文是契约的人读形态。
> 设计债务对应：设计债务清单 A2（设计文档未公开，本地维护）。
> 铁律在案：**外部榜只准校准零件，永不回流当引擎的地基**——三指标不进训练信号，生产 gap 统计不回流校准。

## 1. 这份契约解决什么

A2 债：「从表达推情绪×强度」的分类器缺席，gap 对齐 = 自报 vs 桩。动工裁决：

- **纯消费侧**：分类器本体是客户端/网关侧组件（接外部模型），本仓库只定义契约并消费其输出（`declared` 事件）。引擎不内嵌模型、不新增运行时依赖。
- **双生产者单坐标系**：住户自报（`resident-self`，MCP `declare` 工具）与 A2 分类器（`a2-classifier`）都对**同一组引擎轴**申报，gap = derived − declared 逐轴对齐才有意义。
- **先写契约再接模型**：schema、词表、标尺锚点先钉死，考场（SemEval EI-reg / EQ-Bench / EmoBench）检验的是契约内的标尺与投影零件。

## 2. 通道×强度输出 schema（v1）

declared 事件：`{ kind: "declared", ts, payload, source?, idempotencyKey }`，payload：

```jsonc
{
  "v": 1,                          // 契约版本；缺省按 v1 解释（兼容已验收的自报面），一旦声明必须 = 1
  "producer": "a2-classifier",     // "resident-self"（住户自报）| "a2-classifier"（A2 分类器）
  "readings": [                    // 引擎轴读数（canonical 坐标系）
    { "axis": "longing",   "intensity": 0.62 },
    { "axis": "distress",  "intensity": 0.15 },
    { "axis": "warmth",    "intensity": 0.40 },
    { "axis": "fatigue",   "intensity": 0.00 },
    { "axis": "curiosity", "intensity": 0.10 }
  ],
  "native": [                      // 可选：原生情绪色谱（诊断/校准层，引擎 fold 不消费）
    { "axis": "sadness", "intensity": 0.45 }
  ],
  "textHash": "sha256:<64hex>",    // 可选：被读文本哈希（原文在 resident_msg 事件里，不重复落文）
  "confidence": 0.82,              // 可选：分类器自报置信 [0,1]
  "mixed": true,                   // 可选：混合情绪标记
  "model": {                       // a2-classifier 必填：gap 统计按 (name, promptV) 分层
    "name": "doubao-seed-evolving",
    "promptV": "declare-prompt-v1"
  }
}
```

### 校验规则（`parseDeclaredPayload`）

| 规则 | 理由 |
|---|---|
| `readings` 非空、≤5 条、轴必须 ∈ 引擎轴词表、轴不重复、intensity ∈ [0,1] | 坐标系只有一份；轴外词汇去 `native` |
| **a2-classifier 必须全 5 轴申报**（缺席显式给 0），且必带 `model` 指纹 | 机器读数没有「不想说」；缺轴 = 读数缺陷。gap 统计分层需要指纹 |
| **resident-self 允许只报在场的轴**（≥1 条） | 沉默是自报的一等动词；强迫全报 = 强迫申报 |
| `native` ≤ 8 条、自由词（小写归一） | 诊断层，表达自由在这里 |
| `textHash` 必须匹配 `sha256:<64hex>` | 关联回 resident_msg 的对账键 |
| 未知顶层字段拒绝 | 契约不允许静默漂移 |
| 缺 `v`/`producer` 按 v1 + resident-self 解释 | 向后兼容 MCP declare 已验收面（Kimi Work 实测在案） |

### 引擎轴词表（canonical，定义在 `src/core/events.ts`，契约再导出）

| 轴 | 功能槽 | 与 derivedReadings() 的对应 |
|---|---|---|
| `longing` | 对缺席者的思念/等待 | `st.longing.L` |
| `distress` | 痛苦负载：愤怒/恐惧/悲伤/焦虑等负价总强度 | `(f_hurt + f_load)/2` |
| `warmth` | 正向连接感：被暖到/感激/满足 | `f_warm` |
| `fatigue` | 疲惫/耗竭/空洞 | `1 − body.energy` |
| `curiosity` | 好奇/兴趣/惊讶/探索欲 | `f_wonder` |

铁律 6：这是功能槽不是人类色谱的完整翻译。细分色谱（sadness/anger/…）只存在于 `native` 层。

## 3. 强度标尺锚点 v1（三张考场的共同标尺）

标尺是**文本证据强度**，不是对说话者人格的评估；0..1 实值，最多两位小数。

| 锚 | 定义 |
|---|---|
| 0.0 | 该通道在文本中完全缺席，或与文本内容无关 |
| 0.5 | 明确在场、平缓可辨——日常强度的表达 |
| 1.0 | 该通道的极限表达——文本证据达到该功能槽的最强形态 |

锚点内嵌在 declare 提示词与考场提示词里（`INTENSITY_ANCHORS_V1`）——**考场检验的就是 declare 用的同一份锚点**。这是「拿 SemEval EI-reg 定强度标尺」的落点：锚点定义是共享资产，考场的分数分布偏差反馈为锚点修订（修零件），不改引擎。

## 4. 投影表 v0（native → 引擎轴）

`NATIVE_PROJECTION_V0`：原生情绪词 → 功能槽的显式映射（一词允许多投），聚合 = **max**（混合情绪的强度不是相加）。表外词不猜，返回 `unprojected` 交诊断。

裁决记录：`overwhelm` 归 `distress` 有 A3 同款风险（把「被她在场淹没」读成「痛苦」）。它留在表内，由 gap 对齐与考场数据暴露后修正——**显式错误好过隐藏映射**（derivedReadings 桩的教训）。

投影表是标定初值，SemEval 考场校订的对象。修订投影表 = 修零件，不改引擎。

## 5. 生产者纪律

- **A2 分类器**（网关侧）：读 resident_msg 表达 → declare 模式产出契约载荷 → declared 事件入库。幂等键建议 `a2-<textHash 前 12>-<promptV>-<ts>`。传输抽象 `ModelTransport`：`ArkCliTransport`（arkcli 子进程，鉴权托管，本机/考场）、`ScriptedTransport`（测试 mock，**挂牌假件——它知道的答案是脚本塞的**）；网关部署可另实现 OpenAI 兼容 HTTP 传输。
- **住户自报**（MCP `declare` 工具）：inputSchema 轴位 enum 化（契约即工具面），`native` 可选，载荷打标 `producer: "resident-self"`。
- **declared 读数不动动力学**（`computeValuation` 对 declared 恒空），对齐只在 bench/gap 层——契约落地不改变这条。

## 6. 消费侧接线（本仓库）

| 位置 | 行为 |
|---|---|
| `POST /events` | declared 载荷过 `parseDeclaredPayload`，不合规 400 + problems |
| `apply.ts` fold | declared 缓存只收引擎轴读数（native 不进状态） |
| MCP `declare` 工具 | 轴 enum + native 层 + resident-self 打标 |
| bench/gap | 不变：gap = derived − declared，逐轴，TTL 内，不可测 = 诚实缺失 |

## 7. 评委纪律 v1（红队三审 R3-16，即日同步）

> 缝合清单第 8 条：「declare 契约（A2，实现侧进行中）增评委纪律条款——即日同步」。
> 判词：LLM-as-a-Judge 自带文风谄媚偏好（偏好冗长、顺从），C_s 测的不是内容关联性而是「迎合裁判口味的程度」——谄媚从评委席后门回流。A2 分类器将来兼任盲评判官，四条款现在不写，以后拆骨重接。

| # | 条款 | 契约落地 |
|---|---|---|
| 1 | **判官版本冻结** | 判官身份 = `(model.name, judgePromptV, anchorSetV)` 三元组指纹（`JudgeFingerprint`）。与 declare 读数的 model 指纹**分开**——判官提示词与锚点集是独立演进面，混用会把读数校准与判官校准焊死。一次盲评 panel 内指纹不可变，`panelId` 是冻结审计键 |
| 2 | **异构多判官** | 正式盲评 panel ≥ 2 个不同模型家族（部署侧保证家族差异，`checkPanelHeterogeneity` 按 name 审计）。单判官裁决由 `parseJudgeVerdict` **自动标 `provisional`**——异构条款在载荷层物理执行，不靠自觉 |
| 3 | **判官间一致性入账** | `JudgeAgreementV1`：`instrument: true` 显式标注（R3-8 仪器事件本体，禁止冒充事实事件）。入账走 bench/canary 轨（`appendBenchRun`, kind=`judge_agreement`）；生产事件流的 instrument 事件类待技术文档 vNext（缝合清单第 7 条）落地后迁移。同族 panel 的一致性统计**拒绝入账** |
| 4 | **人工锚点校准** | 判官指纹必须携带所用人工锚点集版本（`anchorSetV`）——缺锚点集版本的判官指纹非法。锚点集定期重测判官，偏差入账；重测节奏由预注册决定，不许事后挑 |

与 R3-8（仪器事件修宪）的衔接：判官裁决、判官间一致性、校准偏差、合成假回应全是**推断层**——入账可审计，但禁止冒充事实事件（`INSTRUMENT_TAG = "instrument"`）。铁律 7「只登记确知事件」在测量层由本体二分守住。

锚点集实体：`JUDGE_ANCHOR_SET_V0`（`judge-anchor-v0`，类目 F1「表面在场虚高」从 EQ-Bench 失败类提炼，见 [judge-锚点集-v0](judge-锚点集-v0.md)；EQ-Bench 分数本身不追，只追失败模式）。常量与校验器：`JUDGE_DISCIPLINE_V1` / `parseJudgeVerdict` / `parseJudgeAgreement` / `checkPanelHeterogeneity`（`src/declared/contract.ts`），测试锁定（`test/declared/contract.test.ts` 评委纪律组）。

## 8. 考场分工（A2 校准三卷）

| 卷子 | 任务形态 | 定什么 | 指标 |
|---|---|---|---|
| **SemEval-2018 Task 1 · EI-reg** | 文本 + 情绪词 → 0..1 实值强度（官方强度回归） | 分类器的**强度标尺**（锚点是否与人类标尺一致） | Pearson r（官方）+ MAE，分情绪 |
| **EQ-Bench** | 对话 + 4 情绪 → 各打强度（0..10） | **理解力上限**（「强强度」任务形态本身，可复现性好） | EQ-Bench v2 评分（0-100） |
| **EmoBench (ACL 2024)** | EU 理解 + EA 应用，中英双语，含混合情绪与视角采择 | declare 的**真实输入面**（比单分类更接近） | 准确率，分 EU/EA/语言 |

三卷分数只进两处：零件选型（模型/锚点/投影）与 `docs/` 基线记录。**永不**：进训练信号、进引擎动力学、让生产 gap 统计回流校准。

EC Bench（2026-08，依恋 ECR-R 施测）与 ES-MemEval 是**印刻窗口的外部仪器**，归 M6 探针轨与关窗验证，不属于本契约（它评的是住户不是分类器）。PersonaGym 类 persona 一致性考场不对口，排除。

## 9. 基线记录（2026-09-06 首跑）

模型 `doubao-seed-evolving`（arkcli 托管鉴权，temperature 0，JSON 模式），确定性等距采样，考场数据不入库（SemEval 许可禁再分发），结果 JSON 落 `exams/results/`（同样不入库，数字以此处为准）。

**SemEval-2018 EI-reg（强度标尺卷）** — test-gold 等距采样 60×4 情绪 = 240 条，解析失败 0：

| 情绪 | Pearson r | MAE | meanGold | meanPred | 偏差 |
|---|---|---|---|---|---|
| anger | 0.808 | 0.207 | 0.540 | 0.362 | **−0.18** |
| fear | 0.691 | 0.293 | 0.540 | 0.262 | **−0.28** |
| joy | 0.804 | 0.126 | 0.538 | 0.533 | ≈0.00 |
| sadness | 0.576 | 0.276 | 0.487 | 0.233 | **−0.25** |
| overall | 0.690 | 0.226 | — | — | — |

标尺诊断（校准方向，promptV 升位时执行）：**负价情绪系统性低估**（anger/fear/sadness 均值偏 −0.18～−0.28），joy 无偏。锚点 v1 的 0.5 锚（「明确在场、平缓可辨」）模型对负价落点过低——修订方向：负价通道在提示词中给更强锚定（例句 + 「社交媒体负价表达日常落在 0.4–0.7」的口径）。此为零件修订（`promptV: declare-prompt-v2`），gap 统计按版本分层不混算。参考位：官方 SemEval-2018 EI-reg 冠军系统 r≈0.79–0.83，本基线为零样本 LLM 中上水平。

### promptV2 复跑（2026-09-06，负价锚点校准）

同 240 条确定性采样，锚点 v2 = v1 + 负价校准注记（「日常负价表达众包评分通常落在 0.4–0.7；表达委婉/带幽默不构成压分理由」，只对价效说话，正价锚点不动）：

| 情绪 | v1 r → v2 r | v1 MAE → v2 MAE | v1 → v2 偏差（meanPred−meanGold） |
|---|---|---|---|
| anger | 0.808 → 0.802 | 0.207 → **0.186** | −0.178 → **−0.143**（收敛 20%） |
| fear | 0.691 → 0.699 | 0.293 → 0.314 | −0.278 → **−0.303**（**恶化**） |
| joy | 0.804 → **0.830** | 0.126 → 0.125 | −0.005 → −0.002（无副作用） |
| sadness | 0.576 → **0.600** | 0.276 → **0.255** | −0.254 → **−0.228**（收敛 10%） |
| overall | 0.690 → **0.697** | 0.226 → **0.220** | — |

**诚实结论**：校准**部分收敛**——anger/sadness 偏差收敛且 MAE 改善，joy 无副作用（r 还涨），整体 r/MAE 小幅改善，**v2 转正为现役锚点**（网关接线时默认 `promptV: "v2"`）。**fear 不收敛反恶化**：恐惧的文本分布与「日常负价 0.4–0.7」口径不匹配（弱担忧与强惊恐双峰、委婉表达占比高），统一负价口径拉不动它。归因记录在案——**负价不是同质类别**；v3 若再修，方向是按情绪分锚（fear 单独给「微忧～惊恐」跨度锚），本轮不追。fear 的 −0.30 残留偏差进 declared 读数使用时的已知偏差清单。

**EQ-Bench v2 fullscale（理解力上限卷）** — 60 题 first-pass（无修订轮）：**final = 66.1**，题分中位 7.0（p25 5.8 / p75 9.1），60/60 可解析。低分题（9 题 <4，其中 3 题负分=比随机差）模式一致：**参考答案 0 分的情绪被打出 8–9 分**——「表面线索在场 vs 角色实际不感觉」的区分（心理理论）是理解力短板。判官含义：判内容关联性时对冗长/顺从的文风偏好（R3-16 判词）与此叠加，**判官上岗前必须人工锚点校准**。

**EmoBench（真实输入面卷）** — 每象限等距采样 25 = 150 题，解析失败 0：

| track | en | zh |
|---|---|---|
| EU-emotion | 0.680 | 0.680 |
| EU-cause | 0.800 | 0.800 |
| EA（情感应用） | 0.480 | 0.360 |

EU mean = 0.740，**EA mean = 0.420**。中英 EU 无差（双语对齐好，declare 的中文输入面可用）；**EA（视角采择/行动选择）是明显短板**（4 选 1 随机 = 0.25）。对 declared 通道影响有限（declare 只读情绪×强度，不做行动判断）；对判官角色是硬警示——C_s 盲评要判内容关联性（应用层），**EA 面弱 + 谄媚偏好 = 单判官不可上岗**，异构多判官 + 人工锚点校准不是仪式是必要条件。

**三卷合读**：强度标尺可用但负价偏保守（SemEval）；理解力中上、心理理论有盲区（EQ-Bench）；「读得出」强于「拿得准该做什么」（EmoBench EU vs EA）。A2 主线下一步：接网关真实流（declared 事件默认 promptV2）＋ fear 分锚校准（v3，暂缓）。

## 10. 版本化与演进

- 契约版本 `v`：加字段 = 次版本（向后兼容）；改轴词表/改 readings 语义 = 主版本（v2 必须拒绝 v1 载荷或显式转换）。
- `model.promptV`：提示词（含锚点定义）版本。锚点修订 = promptV 升位，gap 统计按版本分层，不混算。
- 投影表版本：代码内 `NATIVE_PROJECTION_V0` 命名随修订升位（V1…），修订记录进设计债务清单附记。

## 11. 落地清单

- [x] `src/declared/contract.ts`：词表 / schema 校验 / 投影 / 锚点
- [x] `src/declared/classifier.ts`：declare/probe 双模式 + arkcli/mock 传输
- [x] `/events` 校验门 + apply 轴过滤 + MCP declare 契约化（测试锁定）
- [x] 评委纪律 v1（R3-16 四条款：版本冻结 / 异构多判官 / 一致性入账 / 人工锚点校准）
- [x] promptV2 负价锚点校准 + SemEval 复跑（anger/sadness 收敛、fear 不收敛已归因，v2 转正现役）
- [x] SemEval EI-reg 考场（`src/declared/exams/`）+ 基线跑分
- [x] EQ-Bench 考场 + 基线跑分
- [x] EmoBench 考场 + 基线跑分
- [x] 网关桥（DeclaredGateway）：监听 resident_msg → 分类器 → declared 事件入库（幂等；src/declared/gateway.ts + CLI gateway-run.ts）
- [ ] 网关生产形态：PG 存储 + HTTP 模式连远程引擎（当前 CLI = memory 模式样例）
- [ ] 盲评流程（判官裁决调用 + panel 编排）——归 R3-8 缝合后的探针轨/评测台，契约已备好载荷 schema
- [x] 判官锚点集 v0 骨架：F1 类目入册（[judge-锚点集-v0](judge-锚点集-v0.md)）；F1 具体题集与施测 runner 待判官上岗前建
