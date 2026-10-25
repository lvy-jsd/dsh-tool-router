# dsh-tool-router

Retrieval and routing over an unbounded DSH catalog of tools and skills.

`dsh-tool-manager` gives the model a directory and on-demand loading, but the model
still has to guess the right keywords and spend turns searching. This plugin adds the
retrieval layer that makes an **unbounded** catalog usable — for both tools and skills:

- **`tools_find(query)`** — ranked tool matches by intent (BM25, model-free, always available).
- **`tools_route(query)`** — ranked tool matches, then loads them in one step (the router).
- **`skills_find(query)`** — ranked skill matches by intent over the whole skill catalog.
- **`skills_route(query)`** — finds the best skill and returns its full instructions in one step.

Skills have the same progressive-disclosure shape as tools: a cheap summary (name +
description) is indexed, and the full body is loaded on demand. So the same retrieval
layer that handles an unbounded tool catalog also handles an unbounded skill catalog.

## Why

At scale, two things break: the context window fills with tool schemas, and the model
can no longer pick the right tool from a huge flat list. The fix is progressive
disclosure plus retrieval: expose a cheap index, retrieve the specific tool on demand
by intent. This plugin is that retrieval layer, built on top of `dsh-tool-manager`.

## How it works

- **Rust sidecar, tantivy BM25.** The index lives in a small Rust sidecar process
  (`sidecar/`) that speaks line-delimited JSON over a Unix socket. The hot path is
  native: indexing and ranked search run in the sidecar, while the TypeScript here is
  a thin client. The sidecar is spawned by the plugin and exits with it
  (`PR_SET_PDEATHSIG`), so there is no orphan process.
- **JS BM25 fallback.** A dependency-free JS BM25 index is kept in-process as the
  always-available baseline. If the sidecar binary is missing (e.g. a platform with
  no prebuilt binary) or the process dies, retrieval falls back to it automatically —
  search never breaks.
- **Optional model re-rank.** When `config.model` is set (`{ provider, model }`),
  `tools_route` re-ranks the BM25 candidates with the model, so a natural-language
  intent that shares no words with a tool name still finds it. Any model failure falls
  back to the BM25 order, so the router never breaks.
- **Context budget.** `tools_route` reports the token cost of the loaded tool schemas
  against a configurable budget (`maxBudget`, default 20000).

It consumes `dsh-tool-manager`'s `toolCatalog` service when present (reusing the
catalog, the load path, and the token accounting). Without it, it falls back to the raw
tool schemas; `tools_route` then only retrieves.

## Install

```sh
npm install @lvy-jsd/dsh-tool-router
```

The npm package ships a prebuilt sidecar binary for linux-x64 under `sidecar/bin/`.
On other platforms the plugin runs on the JS BM25 fallback. To build the sidecar from
source (needs a Rust toolchain):

```sh
cd sidecar && cargo build --release
```

The plugin prefers `sidecar/bin/tool-router-sidecar` (shipped) over
`sidecar/target/release/tool-router-sidecar` (dev build).

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | `{ provider, model }` | off | Model used to re-rank `tools_route` candidates |
| `maxTokens` | number | 24 | Max tokens for the re-rank call |
| `topK` | number | 8 | Default number of results |
| `maxBudget` | number | 20000 | Token budget for loaded tool schemas |
| `k1`, `b` | number | 1.5, 0.75 | BM25 parameters (JS fallback) |
| `sidecar` | `{ bin, socket, timeoutMs }` | auto | Sidecar binary path, socket path, request timeout |

## License

MIT
