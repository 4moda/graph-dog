import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ExitCode, UsageError, type DoctorReportDto } from "@graphdog/core";

import { cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { doctorSpec, runDoctorCommand } from "./doctor.ts";
import { installSpec, runInstall } from "./install.ts";
import { initSpec, runInit } from "./init.ts";

const roots: string[] = [];
const originalHome = process.env["HOME"];
const originalGraphdogHome = process.env["GRAPHDOG_HOME"];

after(async () => {
  restore("HOME", originalHome);
  restore("GRAPHDOG_HOME", originalGraphdogHome);
  for (const root of roots) await cleanup(root);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function fresh(): Promise<string> {
  const project = await makeProject();
  const home = await makeProject();
  roots.push(project, home);
  process.env["HOME"] = home;
  process.env["GRAPHDOG_HOME"] = join(home, ".graphdog");
  return project;
}

const doctor = (cwd: string) => run(doctorSpec, runDoctorCommand, cwd, []);

describe("cli/application/commands/doctor", () => {
  it("reports every section and exits zero when nothing is broken", async () => {
    const cwd = await fresh();
    const result = await doctor(cwd);
    const report = result.json as DoctorReportDto;

    assert.equal(report.kind, "doctor_report");
    assert.equal(report.healthy, true);
    assert.equal(result.exitCode, undefined, "clean is exit zero");
    assert.deepEqual(
      [...new Set(report.findings.map((finding) => finding.section))].sort(),
      ["agents", "corpora", "extras", "home"],
    );
    assert.match(result.human, /nothing is broken/);
  });

  it("exits non-zero when something is broken, so it can gate an upgrade script", async () => {
    const cwd = await fresh();
    await run(installSpec, runInstall, cwd, ["--platform", "claude", "--project"]);
    await rm(join(cwd, "CLAUDE.md"));

    const result = await doctor(cwd);
    assert.equal((result.json as DoctorReportDto).healthy, false);
    assert.equal(result.exitCode, ExitCode.PARTIAL);
    assert.match(result.human, /something is broken/);
  });

  it("prints the remedy under the finding that needs it", async () => {
    const cwd = await fresh();
    await run(initSpec, runInit, cwd, ["docs"]);
    const result = await doctor(cwd);
    assert.match(result.human, /-> graphdog build --corpus docs/);
  });

  it("takes no arguments", async () => {
    const cwd = await fresh();
    await assert.rejects(() => run(doctorSpec, runDoctorCommand, cwd, ["everything"]), UsageError);
  });
});
