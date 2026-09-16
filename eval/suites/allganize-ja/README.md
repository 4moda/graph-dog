# allganize-ja

The gating evaluation suite: fifteen Japanese public-sector PDFs, and the
hand-written questions about them from
[allganize/RAG-Evaluation-Dataset-JA](https://huggingface.co/datasets/allganize/RAG-Evaluation-Dataset-JA),
each judged by the page that answers it.

Chosen over GraphDog's own docs because the documents are real, written by
people other than GraphDog's authors, and do not change when GraphDog's docs
do; and because the questions were written by someone else, so they do not echo
the documents' wording the way self-authored queries do.

## What is in it

| File | What |
|---|---|
| `suite.json` | the suite: its corpus, dataset and baseline |
| `documents/` | the fifteen PDFs, unmodified copies of the publishers' files |
| `documents.lock.json` | each PDF's publisher, source URL, licence, page count, size and SHA-256 |
| `NOTICE.md` | attribution for every document, as its licence requires |
| `dataset.json` | the questions about them, in GraphDog's dataset format |
| `baseline.json` | the scores CI holds the current build to |

Questions whose answer sits in an image are left out: GraphDog extracts text
and does not read images, so those questions would measure a capability it does
not claim. Each remaining question carries a note, `<domain> · <context type>`,
saying whether the answer is in a paragraph or a table, and the runner breaks
results down by both.

## How the documents were chosen

By rule, never by how well GraphDog does on them -- choosing on results would
make the suite grade itself. A document is eligible when:

1. its site's terms allow redistribution with attribution -- the Public Data
   License 1.0 or its equivalent, on a site whose terms page was read
2. at least three questions that are not answered by an image target it
3. it can be downloaded as a PDF from its publisher
4. it has the page count the dataset records, so it is the edition the
   questions were written against
5. at least nine pages in ten have a text layer
6. its text carries no notice that overrides the site's terms -- reproduction
   reserved, or the work presented as its authors' personal view

Then, for each of the dataset's five domains, the shortest, the middle and the
longest eligible document: three per domain, spanning volume (10 to 84 pages)
and field. Three rather than two because dropping the image-answered questions
left only 37 otherwise: at that size one rank slipping from first to second
moves MRR by 0.014, above the gate's tolerance, and the gate would fire on
noise.
`scripts/eval/build-allganize-suite.mjs` applies the rule and regenerates the
documents, the lock, the dataset and the notice.

## Running it

```console
npm run eval -- --suite allganize-ja            # against the baseline
npm run eval -- --suite allganize-ja --record   # after a change that should move it
```

The PDFs are committed, so the suite does not depend on the publishers keeping
them online, or unchanged. Every run checks them against the SHA-256s in the
lock; a file that is missing, altered or unexpected stops the run instead of
quietly evaluating a different corpus.

## Licences

- **Questions and page judgments:** from allganize/RAG-Evaluation-Dataset-JA,
  released by Allganize under the MIT License; see `LICENSE` in this directory.
  `dataset.json` holds the questions about the ten selected documents,
  unchanged apart from whitespace trimmed at either end.
- **Documents:** redistributed unmodified under their publishers' terms --
  the Public Data License 1.0 or the Ministry of Internal Affairs and
  Communications' equivalent -- with the attribution those terms require in
  `NOTICE.md`. Third-party material inside a document is outside those terms;
  none of the ten carries a notice reserving such rights, and a document whose
  rights holder objects should be removed and the suite rebuilt.
