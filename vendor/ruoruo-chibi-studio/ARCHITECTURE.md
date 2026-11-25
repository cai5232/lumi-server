# 架构与维护约定

`ruoruo-chibi-studio` 不是零散的绘图提示词集合，而是一条完整闭环：

```text
可编辑源表示（.chibi.json） → 确定性渲染器（render.mjs） → SVG 成品 → 规则自检（lint / check） → 无脚本降级路线（B 路线）
```

为了防止仓库在持续扩展时出现规则漂移、字段膨胀和职责重叠，新增功能与维护修改统一遵守以下约定。

## 1. 唯一权威职责（Canonical Source of Truth）

新增或修改任何规则时，先确认它的唯一事实来源，其他文件只做摘要与链接，不长期维护多份独立副本：

| 文件 / 目录 | 唯一权威职责 | 不应承担的职责 |
| :--- | :--- | :--- |
| [SKILL.md](SKILL.md) | 任务路由、核心工作流、少量不可违反的硬约束 | 不堆砌专题细则，保持轻入口 |
| `references/` | 专题创作方法：骨架颜色（[drawing.md](references/drawing.md)）、物种与装饰（[parts.md](references/parts.md)）、姿势转向（[pose.md](references/pose.md)）、成品构图（[finish.md](references/finish.md)）、渲染字段（[output.md](references/output.md)）、视觉自查（[review.md](references/review.md)） | 不与 schema/renderer 各自维护冲突定义 |
| [schema/ruoruo-chibi.schema.json](schema/ruoruo-chibi.schema.json) | 数据结构合法性、字段类型、数值范围、必填关系、格式版本 | 不承担美术教程与主观审美判断 |
| `scripts/render.mjs` | 合法 `.chibi.json` 到 SVG 的确定性执行语义 | 不做未记录的隐式破坏性改动 |
| `templates/` | 物种原始造型、点位、层级与默认几何事实 | 不当教学手册 |
| `snippets/` | 与渲染器逐字一致的官方滤镜与衬底副本（B 路线专用） | 不手工改写滤镜，由 `scripts/snippets.mjs` 与 `scripts/backdrop-snippets.mjs` 同步生成 |
| `scripts/lint.mjs` / `scripts/check.mjs` | 语义校验、仓库资产与文档一致性检查 | 不做主观视觉评分门禁 |

## 2. 校验分层：Schema vs Lint vs 视觉自查

- **Schema ERROR（格式不合法）**：字段类型错误、缺必填字段、enum 非法、数值越界、顶层未知字段。
- **Lint ERROR（格式合法，但画法语义不成立）**：`clip` 或 `mirror` 目标不存在、五官未裁进头、动作声明与实际几何不一致、破坏核心结构约束。
- **Lint WARN（可渲染，但疑似误写或质量隐患）**：可疑部件字段或拼写近似、Figma 导出名残留、不推荐但仍合法的写法。
- **视觉自查（[review.md](references/review.md)）**：可爱度、互动自然度、构图呼吸感与物种辨识度，属于创作自评，不作为 CI 确定性失败条件。

## 3. 格式版本与扩展红线（`ruoruo-chibi@0.1`）

- **向后兼容变更**：新增完全可选字段、新增不影响旧文件的生成器脚本、新增模板或色卡。
- **破坏性变更（Breaking）**：修改已有字段语义或默认值、改动坐标系/镜面对称/遮罩规则、导致旧资产在渲染器更新后悄悄改变外观。凡涉及破坏性变更，必须记录在 [CHANGELOG.md](CHANGELOG.md) 并评估升版至 `ruoruo-chibi@0.2` 或提供迁移脚本。
- **克制扩展原则**：不把 `ruoruo-chibi` 做成通用 SVG 描述语言。新增装饰或便利效果时，优先写成输出基础形状的脚本生成器（如 `scripts/backdrop.mjs`、`scripts/kit.mjs`、`scripts/sit.mjs`），而不是继续往 `part` 上堆积新的专属字段。

## 4. 双路线能力矩阵（Full vs Restricted）

| 能力 | A 路线（可运行 Node） | B 路线（无脚本 / 只读环境） |
| :--- | :--- | :--- |
| 改色与基础部件调整 | 完整（改 `.chibi.json` 重渲） | 完整（直接改模板 `.svg`） |
| 转向与姿态（`view` / `bodyView` / `pose`） | 完整（几何自动计算） | 有限（手工改点位与图层） |
| Schema 与规则自检 | 完整（`lint.mjs` / `check.mjs`） | 无（按 [review.md](references/review.md) 自查） |
| 油画棒 / 贴纸 / 笔刷滤镜 | 原生（`--pastel` / 顶层字段） | 须整段复制 [snippets/](snippets/)，拿不到则交光滑版 |
| 部件拼装 / 一键坐下 / 一键衬底 | 原生（`kit.mjs` / `sit.mjs` / `backdrop.mjs`） | 衬底可复制 [snippets/衬底/](snippets/衬底/)，其余手工 |

## 5. 中长期演进触发线（按需启动，不做过度重构）

- **动作校验抽象**：当 `action` 新增第 2、3 种正式动作（如趴下、拥抱）时，再从 `scripts/check.mjs` 抽取通用的动作不变量模型。
- **反向测试与渲染回归**：后续改动校验器或渲染器核心几何前，优先补充 `tests/invalid/` 负样本与代表性黄金 SVG 回归样本。
- **模块拆分**：当单文件维护成本明显上升时，再按内部层级（几何 → 原语 → 变换 → 组合 → 滤镜 → 序列化）拆入 `scripts/lib/`，保持现有 CLI 命令和参数向后稳定。
