#!/usr/bin/env node
/**
 * Build the `allganize-ja` evaluation suite from its source dataset.
 *
 * Source: allganize/RAG-Evaluation-Dataset-JA on Hugging Face (MIT), pinned
 * below by revision. It pairs 65 public Japanese PDFs with 300 hand-written
 * questions, each naming the file and the page that answers it.
 *
 * A person runs this when the suite is built or rebuilt; CI does not. It
 * writes everything an evaluation run needs, all committed:
 *
 *   documents/           the selected PDFs, unmodified
 *   documents.lock.json  where each came from, its licence, and its SHA-256
 *   dataset.json         the questions about them, in GraphDog's dataset format
 *   NOTICE.md            attribution for every document, as its licence requires
 *
 * The PDFs are committed rather than fetched so the suite survives a publisher
 * moving or replacing a file. That makes redistribution a selection criterion:
 * only documents whose publisher's terms allow it are eligible.
 *
 * Documents are chosen by rule, never by how well GraphDog does on them --
 * choosing on results would make the suite grade itself. A document is
 * eligible when:
 *
 *   1. its site's terms allow redistribution with attribution (REDISTRIBUTABLE_SITES)
 *   2. at least four questions target it
 *   3. it can be downloaded as a PDF
 *   4. its page count matches the dataset's, so it is the edition the questions
 *      were written against
 *   5. at most a tenth of its pages lack a text layer
 *   6. its text carries no notice reserving reproduction or presenting it as
 *      its authors' personal work (RESERVED_NOTICE) -- such a notice overrides
 *      the site's default terms
 *
 * Then, per domain, the shortest and the longest eligible document.
 *
 *   node scripts/eval/build-allganize-suite.mjs
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "allganize/RAG-Evaluation-Dataset-JA";
const REVISION = "c3a756711f108324d6f27f27093ad2c5eb53f7be";
const SUITE = join(REPO, "eval", "suites", "allganize-ja");
const DOCUMENTS = join(SUITE, "documents");
const CACHE = join(REPO, "eval", ".cache", "allganize-ja");
const CORPUS_SOURCE = "allganize";
const DOMAINS = ["finance", "it", "manufacturing", "public", "retail"];
const MIN_QUESTIONS = 4;
const MAX_SPARSE_SHARE = 0.1;
/** A page with fewer visible characters than this is treated as having no text layer. */
const SPARSE_PAGE_CHARS = 20;

/**
 * Sites whose terms, read when the suite was built, allow their content to be
 * copied and redistributed with attribution: the Public Data License 1.0, or
 * the Ministry of Internal Affairs and Communications' equivalent. A site is
 * listed only after its terms page has been read; sites not listed are not
 * eligible, which errs on the side of leaving a document out.
 */
const REDISTRIBUTABLE_SITES = {
  "www.mof.go.jp": { publisher: "財務省", licence: "公共データ利用規約（第1.0版）", terms: "https://www.mof.go.jp/about_mof/notice/index.html" },
  "www.fsa.go.jp": { publisher: "金融庁", licence: "公共データ利用規約（第1.0版）", terms: "https://www.fsa.go.jp/rules/" },
  "www.soumu.go.jp": { publisher: "総務省", licence: "総務省 開放データ利用規約（第1.0版）", terms: "https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html" },
  "www.digital.go.jp": { publisher: "デジタル庁", licence: "公共データ利用規約（第1.0版）", terms: "https://www.digital.go.jp/copyright-policy" },
  "www.maff.go.jp": { publisher: "農林水産省", licence: "公共データ利用規約（第1.0版）", terms: "https://www.maff.go.jp/j/use/link.html" },
  "www.mhlw.go.jp": { publisher: "厚生労働省", licence: "公共データ利用規約（第1.0版）", terms: "https://www.mhlw.go.jp/chosakuken/index.html" },
  "www.pmda.go.jp": { publisher: "独立行政法人医薬品医療機器総合機構", licence: "公共データ利用規約（第1.0版）", terms: "https://www.pmda.go.jp/0048.html" },
  "www.env.go.jp": { publisher: "環境省", licence: "公共データ利用規約（第1.0版）", terms: "https://www.env.go.jp/mail.html" },
  "www5.cao.go.jp": { publisher: "内閣府", licence: "公共データ利用規約（第1.0版）", terms: "https://www.cao.go.jp/notice/rule.html" },
  "www.nta.go.jp": { publisher: "国税庁", licence: "公共データ利用規約（第1.0版）", terms: "https://www.nta.go.jp/chuijiko/copy.htm" },
};

/**
 * A notice in the document itself that overrides its site's default terms:
 * reproduction reserved, or the work presented as its authors' personal view
 * (under the sites' terms, a work not in the organisation's name belongs to
 * its authors). Deliberately broad: a false match only leaves a document out.
 */
const RESERVED_NOTICE = /禁無断|無断複製|無断転載|個人的見解|個人の見解|All rights reserved|Copyright|©/;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/pdf,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8",
};

const nfc = (value) => value.normalize("NFC");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** RFC 4180 CSV: quoted fields may hold commas, quotes and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell !== ""));
  const names = header.map((name) => name.replace(/^﻿/, ""));
  return body.map((cells) => Object.fromEntries(names.map((name, column) => [name, cells[column] ?? ""])));
}

async function fetchSourceFile(name) {
  const url = `https://huggingface.co/datasets/${SOURCE}/resolve/${REVISION}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** Download a PDF once into the cache; null when it cannot be had as a PDF. */
async function fetchPdf(document) {
  const path = join(CACHE, document.domain, document.file);
  try {
    const cached = await readFile(path);
    if (cached.subarray(0, 4).toString("latin1") === "%PDF") return path;
  } catch {
    // not cached yet
  }
  try {
    const response = await fetch(document.url, { headers: BROWSER_HEADERS, redirect: "follow" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || bytes.subarray(0, 4).toString("latin1") !== "%PDF") return null;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
  } catch {
    return null;
  }
}

/**
 * Page count, pages with next to no text, and any reserving notice, read the
 * way GraphDog reads PDFs.
 */
async function inspectPdf(path) {
  const require = createRequire(import.meta.url);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: true,
    verbosity: 0,
    cMapUrl: `${join(root, "cmaps")}${sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${join(root, "standard_fonts")}${sep}`,
  });
  try {
    const document = await task.promise;
    let sparse = 0;
    let notice = null;
    for (let page = 1; page <= document.numPages; page += 1) {
      const text = (await (await document.getPage(page)).getTextContent()).items.map((item) => item.str ?? "").join("");
      const visible = [...text].filter((char) => char.trim() !== "");
      if (visible.length < SPARSE_PAGE_CHARS) sparse += 1;
      const match = notice === null ? RESERVED_NOTICE.exec(text) : null;
      if (match !== null) {
        notice = `page ${page}: …${text.slice(Math.max(0, match.index - 20), match.index + 30).replace(/\s+/g, " ")}…`;
      }
    }
    return { pages: document.numPages, sparse, notice };
  } finally {
    await task.destroy();
  }
}

function noticeFile(documents) {
  const rows = documents.map(
    (document) =>
      `| \`${document.path}\` | ${document.title} | ${document.publisher} | ${document.licence} ([terms](${document.terms})) |`,
  );
  const credits = documents.map((document) => `- 出典：${document.publisher}ウェブサイト（${document.url}）`);
  return [
    "# Documents: sources and licences",
    "",
    "The PDFs under `documents/` are copies of public documents, unmodified, redistributed",
    "under the terms of the sites that publish them. Each is attributed below as those terms",
    "require. The questions about them come from",
    `[${SOURCE}](https://huggingface.co/datasets/${SOURCE}); see \`LICENSE\`.`,
    "",
    "This file is generated by `scripts/eval/build-allganize-suite.mjs`.",
    "",
    "| File | Title | Publisher | Licence |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## 出典",
    "",
    ...credits,
    "",
    "Content inside a document for which a third party holds rights is not covered by its",
    "publisher's terms. None of these documents carries a notice reserving such rights; if a",
    "rights holder objects to a document being here, remove it and rebuild the suite.",
    "",
  ].join("\n");
}

async function main() {
  const documents = parseCsv(await fetchSourceFile("documents.csv")).map((row) => ({
    domain: row.domain,
    file: nfc(row.file_name),
    title: row.title,
    publisher: row.publisher,
    url: row.url,
    declaredPages: Number(row.page),
  }));
  const questions = parseCsv(await fetchSourceFile("rag_evaluation_result.csv")).map((row, index) => ({
    index,
    domain: row.domain,
    file: nfc(row.target_file_name),
    page: Number(row.target_page_no),
    type: row.type,
    question: row.question.trim(),
  }));
  const questionsFor = (document) =>
    questions.filter((question) => question.domain === document.domain && question.file === document.file);

  const excluded = [];
  const eligible = [];
  for (const document of documents) {
    const path = `${document.domain}/${document.file}`;
    const reject = (reason) => excluded.push({ path, reason });
    const site = REDISTRIBUTABLE_SITES[new URL(document.url).hostname];
    const count = questionsFor(document).length;
    if (site === undefined) { reject("its site's terms have not been confirmed to allow redistribution"); continue; }
    if (count < MIN_QUESTIONS) { reject(`${count} question(s), fewer than ${MIN_QUESTIONS}`); continue; }
    const local = await fetchPdf(document);
    if (local === null) { reject("could not be downloaded as a PDF"); continue; }
    const { pages, sparse, notice } = await inspectPdf(local);
    if (pages !== document.declaredPages) { reject(`${pages} pages, not the ${document.declaredPages} the dataset records: a different edition`); continue; }
    if (sparse > MAX_SPARSE_SHARE * pages) { reject(`${sparse} of ${pages} pages have no text layer`); continue; }
    if (notice !== null) { reject(`carries a notice that overrides its site's terms (${notice})`); continue; }
    const bytes = await readFile(local);
    eligible.push({ ...document, ...site, path, local, pages, bytes: bytes.length, sha256: sha256(bytes), questions: count });
  }

  const selected = [];
  for (const domain of DOMAINS) {
    const pool = eligible
      .filter((document) => document.domain === domain)
      .sort((left, right) => left.pages - right.pages || (left.file < right.file ? -1 : 1));
    if (pool.length === 0) throw new Error(`no eligible document in ${domain}`);
    selected.push(...(pool.length === 1 ? pool : [pool[0], pool[pool.length - 1]]));
  }

  await rm(DOCUMENTS, { recursive: true, force: true });
  for (const document of selected) {
    await mkdir(dirname(join(DOCUMENTS, document.path)), { recursive: true });
    await copyFile(document.local, join(DOCUMENTS, document.path));
  }

  const lock = {
    source: { dataset: SOURCE, revision: REVISION, licence: "MIT (questions); each document under its publisher's terms, see NOTICE.md" },
    rule:
      "eligible: site terms allow redistribution, at least 4 questions, downloadable, page count equals the dataset's, " +
      "at most 10% of pages without text, no notice overriding the site's terms; selected: per domain, the shortest and the longest",
    documents: selected.map((document) => ({
      path: document.path,
      domain: document.domain,
      title: document.title,
      publisher: document.publisher,
      url: document.url,
      licence: document.licence,
      terms: document.terms,
      pages: document.pages,
      bytes: document.bytes,
      sha256: document.sha256,
      questions: document.questions,
    })),
  };

  const dataset = {
    version: 1,
    name: "allganize-ja",
    corpus: "allganize-ja",
    description:
      `Questions from ${SOURCE} (MIT, Allganize) at revision ${REVISION.slice(0, 12)}, about ` +
      `${selected.length} of its ${documents.length} documents. Each question is judged by the page that answers it. ` +
      "Notes read '<domain> · <context type>'; the context type says whether the answer is in a paragraph, a table or an image.",
    queries: selected.flatMap((document) =>
      questionsFor(document).map((question) => ({
        id: `aj-${String(question.index + 1).padStart(3, "0")}`,
        query: question.question,
        note: `${question.domain} · ${question.type}`,
        relevant: [{ ref: `${CORPUS_SOURCE}/${document.path}`, grade: 1, page: question.page }],
      })),
    ),
  };

  await writeFile(join(SUITE, "documents.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(SUITE, "dataset.json"), `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(join(SUITE, "NOTICE.md"), noticeFile(lock.documents));

  console.log(`eligible ${eligible.length} of ${documents.length}; selected ${selected.length}, ${dataset.queries.length} questions`);
  for (const document of lock.documents) {
    console.log(`  ${document.path.padEnd(64)} ${String(document.pages).padStart(3)} pages  ${document.questions} questions  ${document.publisher}`);
  }
  console.log("excluded because of a notice in the document:");
  for (const { path, reason } of excluded.filter(({ reason }) => reason.startsWith("carries a notice"))) {
    console.log(`  ${path}: ${reason}`);
  }
  const counts = {};
  for (const { reason } of excluded) {
    const key = reason.startsWith("carries a notice") ? "carries a notice that overrides its site's terms" : reason.replace(/\d+/g, "N");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log("excluded, by reason:", counts);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-allganize-suite: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
