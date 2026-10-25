# AGENTS.md

提交、Issue 和 PR 按
[CONTRIBUTING.md](CONTRIBUTING.md)。这里只留代理需要的约束。

## 文档

- 产品范围和商业：`docs/设计文档.md`
- 裁决：`docs/gameplay-design.md`
- 玩家听到的话和时序：`docs/交互设计.md`
- 部署、存储、接口和模型约束：`docs/架构设计.md`
- 三份冲突时，范围和商业以产品为准，裁决以玩法为准，说法以交互为准。架构设计不改写这三条。

## 代码

`README.md` 里的跑法和 `src/game` 仍是旧咒语
demo。不要按当前产品文档去改这套实现，也不要把旧实现写回三份设计文档。`src/game`
不属于新目录，语音接入改为调用引擎之后删除。

新目录是 `src/engine`、`src/adapter`、`src/speech`。搬迁前的快照是 tag
`old-demo`。

改完 Markdown 或 TypeScript 后跑 `deno fmt`。声称检查通过之前跑
`deno task check`。
