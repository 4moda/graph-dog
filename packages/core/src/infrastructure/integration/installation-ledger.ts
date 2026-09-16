/**
 * Reading and writing `~/.graphdog/installed.json`.
 *
 * The file records what every install wrote so that an uninstall removes
 * exactly that, and nothing else. It is the last thing an uninstall touches,
 * so a run interrupted partway leaves a ledger that still describes what is
 * still there rather than one that has forgotten it.
 *
 * A ledger that cannot be read is treated as an empty one -- see `parseLedger`.
 * Every artifact can also be found from its own fixed name, so losing this file
 * costs precision, never the ability to uninstall.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { EMPTY_LEDGER, parseLedger, type Ledger } from "../../domain/model/installation.ts";
import { homeWorkspace } from "../config/workspace.ts";

export const LEDGER_FILENAME = "installed.json";

export function ledgerPath(): string {
  return join(homeWorkspace().root, LEDGER_FILENAME);
}

export async function readLedger(path: string = ledgerPath()): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LEDGER;
    throw error;
  }
  try {
    return parseLedger(JSON.parse(text) as unknown);
  } catch {
    return EMPTY_LEDGER;
  }
}

/** Write the ledger, or delete the file once it holds nothing. */
export async function writeLedger(ledger: Ledger, path: string = ledgerPath()): Promise<void> {
  if (ledger.installations.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}
