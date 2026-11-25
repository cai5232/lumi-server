# 更新日志（Changelog）

本文件记录 `ruoruo-chibi-studio` 的格式语义、渲染器行为、仓库结构与工具链变更。格式版本号为 `ruoruo-chibi@0.1`：已发布字段语义不静默改变，向后不兼容变更将明确标注迁移说明。

## [0.1.0] - 2026-11-24

### 仓库规范与分发
- 新增 `.gitattributes` 统一全仓文本为 LF 换行符，消除跨平台（Windows / Linux）无意义 diff。
- 新增极简零依赖 `package.json`（ESM，声明 `node >= 20` 及 `check` / `snippets` / `pack` 维护脚本）并补全 `.gitignore`。
- 新增双轨 [LICENSE](LICENSE)：工具与校验脚本采用 MIT 协议，画风、底稿、例图与创作文档采用 CC BY-NC 4.0（署名、非商用）。
- 升级 [.github/workflows/check.yml](.github/workflows/check.yml) 为 Node 20 / 22 / 24 多版本矩阵检查。
- 新增零依赖打包脚本 `scripts/pack-skill.mjs`，支持一键生成带英文顶层目录、UTF-8 编码、剔除开发杂项的轻量沙盒 Skill zip。

### 文档与架构整理
- 统一 [SKILL.md](SKILL.md) frontmatter `name` 为 `ruoruo-chibi-studio`。
- 将原 `references/parts.md` 拆分为 [references/parts.md](references/parts.md)（物种与装饰）与 [references/finish.md](references/finish.md)（成品方向与构图），减轻 Agent 按需阅读时的上下文负担。
- 新增 [ARCHITECTURE.md](ARCHITECTURE.md)，明确各类文件的唯一权威职责、Schema / Lint 边界、版本兼容策略与 A/B 路线能力矩阵。
- 升级 [README.md](README.md) 首页画廊与源码到成品的流程展示，清理脚本内指向仓外本机路径的残留注释。
