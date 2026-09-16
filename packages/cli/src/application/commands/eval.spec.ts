import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ExitCode, type EvaluationReportDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { evalSpec, runEval } from "./eval.ts";

const DATASET = {
  version: 1,
  name: "auth",
  corpus: "demo",
  queries: [
    { id: "jwks", query: "JWKS", relevant: [{ ref: "docs/keys.md", grade: 3 }] },
    { id: "rotation", query: "token rotation", relevant: ["docs/token.md"] },
  ],
};

async function builtProject(dataset: unknown = DATASET): Promise<string> {
  const root = await makeProject({
    ...FIXTURE_DOCS,
    "eval/auth.json": JSON.stringify(dataset, null, 2),
  });
  await run(initSpec, runInit, root, ["demo"]);
  await run(addSpec, runAdd, root, ["./docs"]);
  await run(buildSpec, (context) => runBuild(context, true), root, []);
  return root;
}

const evaluate = (cwd: string, argv: readonly string[]) => run(evalSpec, runEval, cwd, argv);

describe("cli/application/commands/eval", () => {
  describe("running a dataset", () => {
    it("measures the corpus and reports the headline metrics", async () => {
      const root = await builtProject();
      try {
        const report = (await evaluate(root, ["eval/auth.json"])).json as EvaluationReportDto;
        assert.equal(report.kind, "evaluation_report");
        assert.equal(report.summary.queries, 2);
        assert.equal(report.summary.recall_at_k, 1, "both answers are findable in this corpus");
      } finally {
        await cleanup(root);
      }
    });

    it("takes the corpus from the dataset, so a checked-in dataset needs no flags", async () => {
      const root = await builtProject();
      try {
        const report = (await evaluate(root, ["eval/auth.json"])).json as EvaluationReportDto;
        assert.equal(report.corpus, "demo");
      } finally {
        await cleanup(root);
      }
    });

    it("lets --corpus override the dataset's own corpus", async () => {
      const root = await builtProject();
      try {
        const report = (await evaluate(root, ["eval/auth.json", "--corpus", "demo"]))
          .json as EvaluationReportDto;
        assert.equal(report.corpus, "demo");
      } finally {
        await cleanup(root);
      }
    });

    it("exits 0 when no gate was asked for", async () => {
      const root = await builtProject();
      try {
        assert.equal((await evaluate(root, ["eval/auth.json"])).exitCode, undefined);
      } finally {
        await cleanup(root);
      }
    });

    it("honours --top-k as the metric cutoff", async () => {
      const root = await builtProject();
      try {
        const report = (await evaluate(root, ["eval/auth.json", "--top-k", "3"]))
          .json as EvaluationReportDto;
        assert.equal(report.k, 3);
      } finally {
        await cleanup(root);
      }
    });

    it("renders a table a person can read", async () => {
      const root = await builtProject();
      try {
        const result = await evaluate(root, ["eval/auth.json"]);
        assert.match(result.human, /recall@10/);
        assert.match(result.human, /mrr/);
        assert.match(result.human, /latency/);
      } finally {
        await cleanup(root);
      }
    });
  });

  describe("gates", () => {
    it("exits with the gate code when a threshold is not met", async () => {
      const impossible = {
        ...DATASET,
        queries: [{ id: "nope", query: "JWKS", relevant: ["docs/does-not-exist.md"] }],
      };
      const root = await builtProject(impossible);
      try {
        const result = await evaluate(root, ["eval/auth.json", "--fail-under", "recall=0.9"]);
        assert.equal(result.exitCode, ExitCode.GATE_FAILED);
        const report = result.json as EvaluationReportDto;
        assert.equal(report.status, "failed");
        assert.equal(report.gate_failures[0]?.metric, "recall");
      } finally {
        await cleanup(root);
      }
    });

    it("exits 0 when the threshold is met", async () => {
      const root = await builtProject();
      try {
        const result = await evaluate(root, ["eval/auth.json", "--fail-under", "recall=0.9"]);
        assert.equal(result.exitCode, undefined);
        assert.equal((result.json as EvaluationReportDto).status, "ok");
      } finally {
        await cleanup(root);
      }
    });

    it("accepts several --fail-under flags", async () => {
      const root = await builtProject();
      try {
        const result = await evaluate(root, [
          "eval/auth.json",
          "--fail-under",
          "recall=0.9",
          "--fail-under",
          "mrr=0.9",
        ]);
        assert.equal(result.exitCode, undefined);
      } finally {
        await cleanup(root);
      }
    });

    it("rejects a misspelled metric rather than gating nothing", async () => {
      const root = await builtProject();
      try {
        await assert.rejects(
          () => evaluate(root, ["eval/auth.json", "--fail-under", "recal=0.9"]),
          /unknown metric/,
        );
      } finally {
        await cleanup(root);
      }
    });

    it("rejects a threshold that is not a fraction", async () => {
      const root = await builtProject();
      try {
        await assert.rejects(
          () => evaluate(root, ["eval/auth.json", "--fail-under", "recall=90"]),
          /0 to 1/,
        );
      } finally {
        await cleanup(root);
      }
    });
  });

  describe("baselines", () => {
    it("writes a report with --out that --baseline reads back", async () => {
      const root = await builtProject();
      try {
        await evaluate(root, ["eval/auth.json", "--out", "eval/baseline.json"]);
        const written = JSON.parse(await readFile(join(root, "eval/baseline.json"), "utf8"));
        assert.equal(written.kind, "evaluation_report");

        const result = await evaluate(root, ["eval/auth.json", "--baseline", "eval/baseline.json"]);
        const report = result.json as EvaluationReportDto;
        assert.equal(result.exitCode, undefined, "a run compared against itself has not regressed");
        assert.ok((report.comparison?.length ?? 0) >= 5);
        assert.ok(report.comparison?.every((delta) => delta.delta === 0 || delta.delta === null));
      } finally {
        await cleanup(root);
      }
    });

    it("fails when the run fell below the baseline", async () => {
      const root = await builtProject();
      try {
        // A baseline that claims perfection on metrics this corpus cannot reach.
        await makeBaseline(root, { recall_at_k: 1, precision_at_k: 1, mrr: 1, ndcg_at_k: 1 });
        const result = await evaluate(root, ["eval/auth.json", "--baseline", "eval/high.json"]);
        assert.equal(result.exitCode, ExitCode.GATE_FAILED);
        assert.ok(
          (result.json as EvaluationReportDto).gate_failures.some(
            (failure) => failure.kind === "regression",
          ),
        );
      } finally {
        await cleanup(root);
      }
    });

    it("forgives a drop inside --tolerance", async () => {
      const root = await builtProject();
      try {
        await makeBaseline(root, { recall_at_k: 1, precision_at_k: 1, mrr: 1, ndcg_at_k: 1 });
        const result = await evaluate(root, [
          "eval/auth.json",
          "--baseline",
          "eval/high.json",
          "--tolerance",
          "1",
        ]);
        assert.equal(result.exitCode, undefined);
      } finally {
        await cleanup(root);
      }
    });

    it("refuses a missing baseline rather than silently skipping the comparison", async () => {
      // In CI, "nothing regressed" and "the comparison never ran" must not look
      // the same.
      const root = await builtProject();
      try {
        await assert.rejects(
          () => evaluate(root, ["eval/auth.json", "--baseline", "eval/absent.json"]),
          /baseline not found/,
        );
      } finally {
        await cleanup(root);
      }
    });

    it("refuses a baseline that is not JSON", async () => {
      const root = await makeProject({
        ...FIXTURE_DOCS,
        "eval/auth.json": JSON.stringify(DATASET),
        "eval/broken.json": "{ not json",
      });
      await run(initSpec, runInit, root, ["demo"]);
      await run(addSpec, runAdd, root, ["./docs"]);
      await run(buildSpec, (context) => runBuild(context, true), root, []);
      try {
        await assert.rejects(
          () => evaluate(root, ["eval/auth.json", "--baseline", "eval/broken.json"]),
          /not valid JSON/,
        );
      } finally {
        await cleanup(root);
      }
    });
  });

  describe("bad input", () => {
    it("requires a dataset argument", async () => {
      const root = await builtProject();
      try {
        await assert.rejects(() => evaluate(root, []), /a dataset file is required/);
      } finally {
        await cleanup(root);
      }
    });

    it("reports a missing dataset file by path", async () => {
      const root = await builtProject();
      try {
        await assert.rejects(
          () => evaluate(root, ["eval/absent.json"]),
          /evaluation dataset not found/,
        );
      } finally {
        await cleanup(root);
      }
    });

    it("names the offending entry when the dataset is malformed", async () => {
      const root = await builtProject({
        version: 1,
        name: "broken",
        queries: [{ id: "a", query: "" }],
      });
      try {
        await assert.rejects(() => evaluate(root, ["eval/auth.json"]), /queries\[0\]\.query/);
      } finally {
        await cleanup(root);
      }
    });

    it("warns when the dataset judges refs the corpus does not have", async () => {
      const root = await builtProject({
        version: 1,
        name: "stale",
        corpus: "demo",
        queries: [{ id: "gone", query: "JWKS", relevant: ["docs/renamed.md"] }],
      });
      try {
        const report = (await evaluate(root, ["eval/auth.json"])).json as EvaluationReportDto;
        assert.ok(report.warnings.some((warning) => warning.code === "eval_unknown_ref"));
      } finally {
        await cleanup(root);
      }
    });
  });
});

/** Write a hand-made baseline report at `eval/high.json`. */
async function makeBaseline(root: string, summary: Record<string, number>): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "eval/high.json"), JSON.stringify({ summary }), "utf8");
}
