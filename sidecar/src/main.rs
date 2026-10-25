//! tool-router-sidecar: a BM25 retrieval engine for the dsh-tool-router plugin.
//!
//! It owns the inverted index (tantivy) and serves line-delimited JSON requests
//! over a Unix domain socket. The TypeScript plugin is a thin client: it pushes
//! the tool/skill catalog on change and asks for ranked hits on each query.
//!
//! Protocol (one JSON object per line, request then response):
//!   {"op":"ping"}
//!   {"op":"index","name":"tools","docs":[{"ref":{...},"text":"..."}]}
//!   {"op":"search","index":"tools","query":"...","limit":8}
//!   {"op":"stats"}
//!
//! Tokenization mirrors the plugin's JS baseline exactly: lowercase, runs of
//! [a-z0-9_]+, and every CJK / wide character as its own token. The text is
//! pre-tokenized here and indexed with tantivy's "whitespace" tokenizer, so
//! the term streams match the JS implementation and the two agree on what a
//! query means.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{IndexRecordOption, Schema, TextFieldIndexing, TextOptions};
use tantivy::{doc, Index};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Mirror of the plugin's JS `tokenize`: lowercase, [a-z0-9_]+ runs, and each
/// character above U+2E7F (CJK and friends) as a standalone token.
fn tokenize(text: &str) -> String {
    let flat = text.to_lowercase();
    let mut out = String::new();
    let mut run = String::new();
    let mut wide = String::new();
    for ch in flat.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            run.push(ch);
        } else {
            if !run.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&run);
                run.clear();
            }
            if (ch as u32) > 0x2e7f {
                wide.push(ch);
                wide.push(' ');
            }
        }
    }
    if !run.is_empty() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&run);
    }
    if !wide.is_empty() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(wide.trim_end());
    }
    out
}

/// One named index (tools or skills): the tantivy index plus the refs aligned
/// to doc ids (tantivy assigns doc ids in insertion order for a fresh index).
struct NamedIndex {
    index: Index,
    refs: Vec<Value>,
}

fn build_index(docs: &[(Value, String)]) -> tantivy::Result<NamedIndex> {
    let mut schema_builder = Schema::builder();
    // "whitespace" splits on ASCII whitespace and does not lowercase. We
    // pre-tokenize (lowercase + CJK char-split) and join with spaces, so this
    // splits our pre-tokenized text back into the exact tokens we produced.
    let indexing = TextFieldIndexing::default()
        .set_tokenizer("whitespace")
        .set_index_option(IndexRecordOption::WithFreqs);
    let text_field = schema_builder
        .add_text_field("text", TextOptions::default().set_indexing_options(indexing));
    let schema = schema_builder.build();
    let index = Index::create_in_ram(schema);
    let mut writer = index.writer_with_num_threads(1, 20_000_000)?;
    for (_ref, text) in docs {
        let tokenized = tokenize(text);
        writer.add_document(doc!(text_field => tokenized))?;
    }
    writer.commit()?;
    let refs = docs.iter().map(|(r, _)| r.clone()).collect();
    Ok(NamedIndex { index, refs })
}

fn search_index(ni: &NamedIndex, query: &str, limit: usize) -> tantivy::Result<Vec<(usize, f32)>> {
    let tokenized = tokenize(query);
    if tokenized.is_empty() || ni.refs.is_empty() {
        return Ok(Vec::new());
    }
    let reader = ni.index.reader()?;
    let searcher = reader.searcher();
    let text_field = ni.index.schema().get_field("text")?;
    let query_parser = QueryParser::for_index(&ni.index, vec![text_field]);
    let query = query_parser.parse_query(&tokenized)?;
    let top_docs = searcher
        .search(&query, &TopDocs::with_limit(limit).order_by_score())?;
    Ok(top_docs
        .into_iter()
        .map(|(score, addr)| (addr.doc_id as usize, score))
        .collect())
}

#[derive(Deserialize, Clone)]
struct Doc {
    #[serde(rename = "ref")]
    ref_val: Value,
    text: String,
}

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    index: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    docs: Option<Vec<Doc>>,
}

#[derive(Serialize)]
struct Hit {
    id: usize,
    score: f32,
}

fn index_sizes(state: &Mutex<HashMap<String, NamedIndex>>) -> HashMap<String, u64> {
    state
        .lock()
        .map(|guard| {
            guard
                .iter()
                .map(|(k, v)| (k.clone(), v.refs.len() as u64))
                .collect()
        })
        .unwrap_or_default()
}

fn handle(req: &Request, state: &Mutex<HashMap<String, NamedIndex>>) -> Value {
    match req.op.as_str() {
        "ping" => json!({
            "ok": true,
            "version": VERSION,
            "indexes": index_sizes(state),
        }),
        "index" => {
            let name = req.name.clone().unwrap_or_default();
            let docs = req.docs.clone().unwrap_or_default();
            let pairs: Vec<(Value, String)> = docs.into_iter().map(|d| (d.ref_val, d.text)).collect();
            match build_index(&pairs) {
                Ok(ni) => {
                    let count = ni.refs.len() as u64;
                    if let Ok(mut guard) = state.lock() {
                        guard.insert(name, ni);
                    }
                    json!({ "ok": true, "count": count })
                }
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "search" => {
            let name = req.index.clone().unwrap_or_default();
            let query = req.query.clone().unwrap_or_default();
            let limit = req.limit.unwrap_or(8).max(1);
            match state.lock() {
                Ok(guard) => match guard.get(&name) {
                    Some(ni) => match search_index(ni, &query, limit) {
                        Ok(hits) => {
                            let hits: Vec<Hit> =
                                hits.into_iter().map(|(id, score)| Hit { id, score }).collect();
                            json!({ "ok": true, "hits": hits })
                        }
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    },
                    None => json!({ "ok": false, "error": format!("no index {:?}", name) }),
                },
                Err(_) => json!({ "ok": false, "error": "state lock poisoned" }),
            }
        }
        "stats" => json!({ "ok": true, "indexes": index_sizes(state) }),
        other => json!({ "ok": false, "error": format!("unknown op {:?}", other) }),
    }
}

fn handle_connection(stream: UnixStream, state: &Mutex<HashMap<String, NamedIndex>>) {
    let reader = match stream.try_clone() {
        Ok(r) => BufReader::new(r),
        Err(_) => return,
    };
    let mut writer = BufWriter::new(stream);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = json!({ "ok": false, "error": format!("bad request: {e}") });
                if writeln!(writer, "{}", resp).is_err() {
                    break;
                }
                continue;
            }
        };
        let mut resp = handle(&req, state);
        if let Some(id) = req.id {
            if let Some(obj) = resp.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
        }
        if writer.write_all(resp.to_string().as_bytes()).is_err() {
            break;
        }
        if writer.write_all(b"\n").is_err() {
            break;
        }
        let _ = writer.flush();
    }
}

/// Ask the kernel to send SIGTERM when our parent (the DSH node process) dies,
/// so an orphaned sidecar does not linger after a DSH restart.
#[cfg(target_os = "linux")]
fn set_pdeathsig() {
    // PR_SET_PDEATHSIG = 1, SIGTERM = 15.
    unsafe {
        libc::prctl(1, 15);
    }
}

#[cfg(not(target_os = "linux"))]
fn set_pdeathsig() {}

fn main() {
    set_pdeathsig();
    let args: Vec<String> = std::env::args().collect();
    let mut socket_path: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--socket" && i + 1 < args.len() {
            socket_path = Some(args[i + 1].clone());
            i += 1;
        }
        i += 1;
    }
    let socket_path = match socket_path {
        Some(p) => p,
        None => {
            eprintln!("tool-router-sidecar: --socket <path> is required");
            std::process::exit(2);
        }
    };
    let path = Path::new(&socket_path);
    let _ = std::fs::remove_file(path); // clear a stale socket from a previous run
    let listener = match UnixListener::bind(path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("tool-router-sidecar: bind {socket_path} failed: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("tool-router-sidecar {VERSION} listening on {socket_path}");
    let state: Arc<Mutex<HashMap<String, NamedIndex>>> = Arc::new(Mutex::new(HashMap::new()));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || handle_connection(stream, &state));
            }
            Err(e) => eprintln!("tool-router-sidecar: accept error: {e}"),
        }
    }
}