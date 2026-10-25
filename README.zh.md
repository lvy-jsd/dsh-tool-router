# dsh-tool-router

面向「无限多工具目录」的检索与路由插件。

`dsh-tool-manager` 给模型提供了目录和按需加载，但模型仍要自己猜关键词、花好几轮去搜索。
这个插件补上了让**无限多**目录真正可用的检索层，工具和技能都支持：

- **`tools_find(query)`** — 按意图返回排序后的匹配工具（BM25，无需模型，始终可用）。
- **`tools_route(query)`** — 返回排序后的匹配工具，并一步加载（路由器）。
- **`skills_find(query)`** — 在整个技能目录上按意图返回排序后的匹配技能。
- **`skills_route(query)`** — 找到最匹配的技能，一步返回其完整说明。

技能和工具是同样的「渐进式披露」结构：索引里只放便宜的摘要（名字 + 描述），
完整内容按需加载。所以处理无限多工具目录的同一层检索，也能处理无限多技能目录。

## 为什么

规模上去后，两件事会坏掉：上下文窗口被工具 schema 占满；模型在一堆扁平工具里选不准。
解法是「渐进式披露 + 检索」：只暴露一个便宜的索引，按意图在需要时检索出具体工具。
这个插件就是那层检索，建在 `dsh-tool-manager` 之上。

## 工作原理

- **Rust 侧车，tantivy BM25。** 索引放在一个 Rust 侧车进程里（`sidecar/`），
  通过 Unix socket 通信，协议是行分隔 JSON。热路径是原生的：建索引和排序搜索都在
  侧车里跑，这里的 TypeScript 只是薄客户端。侧车由插件 spawn，并设置了
  `PR_SET_PDEATHSIG`，插件退出时侧车自动退出，不会留下孤儿进程。
- **JS BM25 兜底。** 进程内保留一个无依赖的 JS BM25 索引作为始终可用的基线。
  侧车二进制缺失（比如没有预编译二进制的平台）或进程挂掉时，自动回退到它，
  搜索不会因此坏掉。
- **可选模型重排。** 配置 `config.model`（`{ provider, model }`）后，`tools_route`
  会用模型对 BM25 候选做重排，这样即使自然语言意图和工具名没有任何共同词也能命中。
  模型一旦失败就回退到 BM25 顺序，路由器不会因此坏掉。
- **上下文预算。** `tools_route` 会报告已加载工具 schema 的 token 成本，
  对照可配置的预算（`maxBudget`，默认 20000）。

存在 `dsh-tool-manager` 的 `toolCatalog` 服务时，它会复用该目录、加载路径和 token 统计；
不存在时回退到原始工具 schema，此时 `tools_route` 只做检索。

## 安装

```sh
npm install @lvy-jsd/dsh-tool-router
```

npm 包自带 linux-x64 的预编译侧车二进制（`sidecar/bin/`）。其他平台上插件自动用
JS BM25 兜底。要从源码构建侧车（需要 Rust 工具链）：

```sh
cd sidecar && cargo build --release
```

插件优先使用 `sidecar/bin/tool-router-sidecar`（随包发布），其次
`sidecar/target/release/tool-router-sidecar`（开发构建）。

## 配置

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `model` | `{ provider, model }` | 关 | 用于 `tools_route` 候选重排的模型 |
| `maxTokens` | number | 24 | 重排调用的最大 token |
| `topK` | number | 8 | 默认返回条数 |
| `maxBudget` | number | 20000 | 已加载工具 schema 的 token 预算 |
| `k1`, `b` | number | 1.5, 0.75 | BM25 参数（JS 兜底） |
| `sidecar` | `{ bin, socket, timeoutMs }` | 自动 | 侧车二进制路径、socket 路径、请求超时 |

## 许可证

MIT
