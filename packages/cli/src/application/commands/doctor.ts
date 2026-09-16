/**
 * `graphdog doctor` -- everything installed, and anything wrong with it.
 *
 * One command rather than one per subsystem, because the question after an
 * upgrade is "is any of what I set up broken now", and answering it in pieces
 * means nobody asks it. It exits non-zero when something is broken, so it can
 * run in CI or at the end of an upgrade script.
 */

import { ExitCode, UsageError, envelope, runDoctor, type DoctorReportDto } from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import type { CommandSpec } from "../../infrastructure/argv.ts";
import { renderDoctorReport } from "../../infrastructure/render/human-renderer.ts";

export const doctorSpec: CommandSpec = {
  name: "doctor",
  summary: "Report what is installed and anything that is broken",
  usage: "graphdog doctor [--json]",
  options: {},
  examples: ["graphdog doctor"],
};

export async function runDoctorCommand(context: CommandContext): Promise<CommandResult> {
  if (context.parsed.positionals.length > 0) {
    throw new UsageError("doctor: takes no arguments", {
      usage: doctorSpec.usage,
      received: context.parsed.positionals,
    });
  }

  const report = await runDoctor({ cwd: context.cwd, logger: context.logger });
  const dto: DoctorReportDto = {
    ...envelope("doctor_report"),
    graphdog_version: report.version,
    node_version: report.node,
    healthy: report.healthy,
    findings: report.findings.map((finding) => ({
      section: finding.section,
      label: finding.label,
      detail: finding.detail,
      status: finding.status,
      remedy: finding.remedy,
    })),
  };

  return {
    json: dto,
    human: renderDoctorReport(dto),
    // The report ran and what it checked is not clean: the same shape of
    // outcome as a build that indexed most of its files.
    ...(report.healthy ? {} : { exitCode: ExitCode.PARTIAL }),
  };
}
