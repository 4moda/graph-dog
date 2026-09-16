/**
 * The single SQLite file that *is* a GraphDog corpus.
 *
 * Everything lives here: documents and their full text, chunks, dense vectors,
 * BM25 postings, the relation graph, build failures and exclusions. The
 * predecessor spread this across ChromaDB, a GraphML file, a separate SQLite
 * full-text database and a JSON state file, none of which could be updated
 * together; an interrupted build left the four disagreeing, and there was no
 * way to detect it. One file with one transaction removes that class of bug and
 * makes "portable corpus" mean "copy this file".
 */

export const CORPUS_FILENAME = "corpus.sqlite3";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    uri        TEXT NOT NULL,
    spec       TEXT NOT NULL,
    revision   TEXT,
    indexed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS documents (
    ref          TEXT PRIMARY KEY,
    source_id    TEXT NOT NULL,
    title        TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size         INTEGER NOT NULL,
    mtime        REAL NOT NULL,
    revision     TEXT,
    indexed_at   TEXT NOT NULL,
    total_lines  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    page_breaks  TEXT NOT NULL DEFAULT '[]',
    tags         TEXT NOT NULL DEFAULT '[]',
    links        TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);

CREATE TABLE IF NOT EXISTS chunks (
    chunk_id     TEXT PRIMARY KEY,
    ref          TEXT NOT NULL,
    ordinal      INTEGER NOT NULL,
    text         TEXT NOT NULL,
    start_char   INTEGER NOT NULL,
    end_char     INTEGER NOT NULL,
    start_line   INTEGER NOT NULL,
    end_line     INTEGER NOT NULL,
    page         INTEGER,
    heading_path TEXT NOT NULL DEFAULT '',
    token_count  INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_chunks_ref ON chunks(ref);

CREATE TABLE IF NOT EXISTS vectors (
    chunk_id TEXT PRIMARY KEY,
    vec      BLOB NOT NULL
) STRICT;

-- Document frequency per term, recomputed after each build. Kept as a table
-- rather than derived per query so a search never scans the postings twice.
-- Each chunk's nearest others, kept so an update recomputes only the lists a
-- change can have reached rather than all of them. Derived data: dropping the
-- table costs one slow build, never a wrong answer.
CREATE TABLE IF NOT EXISTS neighbors (
    chunk_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    score    REAL NOT NULL,
    PRIMARY KEY (chunk_id, other_id)
) STRICT;

CREATE TABLE IF NOT EXISTS terms (
    term TEXT PRIMARY KEY,
    df   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS postings (
    term     TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    tf       INTEGER NOT NULL,
    PRIMARY KEY (term, chunk_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_postings_chunk ON postings(chunk_id);

CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    label   TEXT NOT NULL,
    ref     TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_nodes_ref ON nodes(ref);

CREATE TABLE IF NOT EXISTS edges (
    src    TEXT NOT NULL,
    dst    TEXT NOT NULL,
    kind   TEXT NOT NULL,
    weight REAL NOT NULL,
    PRIMARY KEY (src, dst, kind)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS failures (
    ref     TEXT NOT NULL,
    stage   TEXT NOT NULL,
    code    TEXT NOT NULL,
    message TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (ref, stage)
) STRICT;

CREATE TABLE IF NOT EXISTS exclusions (
    ref     TEXT NOT NULL,
    reason  TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (ref, reason)
) STRICT;
`;
