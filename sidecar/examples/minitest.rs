use tantivy::tokenizer::TokenStream;
use tantivy::Index;
use tantivy::schema::{Schema, TextOptions, TextFieldIndexing, IndexRecordOption};

fn main() -> tantivy::Result<()> {
    let mut sb = Schema::builder();
    let indexing = TextFieldIndexing::default().set_tokenizer("raw").set_index_option(IndexRecordOption::WithFreqs);
    let text_field = sb.add_text_field("text", TextOptions::default().set_indexing_options(indexing));
    let schema = sb.build();
    let index = Index::create_in_ram(schema);
    let tm = index.tokenizers();
    let mut tok = tm.get("raw").unwrap();
    let mut stream = tok.token_stream("web_search search the web for current information");
    let mut n = 0;
    while stream.advance() {
        let t = stream.token();
        println!("token: {:?}", &t.text);
        n += 1;
    }
    println!("total tokens: {n}");
    Ok(())
}
