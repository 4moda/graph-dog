/**
 * Stand-ins for the archive ports, for use-case specs.
 *
 * The codec is JSON rather than gzip, so a test can read and tamper with an
 * archive by editing plain objects; the real codec has its own spec. Excluded
 * from the published build.
 */

import { createHash } from "node:crypto";

import { ArchiveError } from "../domain/errors.ts";
import type {
  ArchiveCodec,
  ArchiveEntry,
  CorpusFileInspector,
  CorpusInstaller,
  DatabaseInspection,
  InstallRequest,
  InstallResult,
} from "../application/ports/archive.ts";
import type { Clock, Hasher } from "../application/ports/system.ts";

export const fixtureHasher: Hasher = {
  hashText: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  hashBytes: (input) => createHash("sha256").update(input).digest("hex"),
};

export const FIXED_CLOCK: Clock = {
  nowIso: () => "2026-09-15T12:00:00.000Z",
  monotonicMs: () => 0,
};

export class JsonArchiveCodec implements ArchiveCodec {
  encode(entries: readonly ArchiveEntry[]): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify(entries.map((entry) => ({ name: entry.name, data: [...entry.data] }))),
    );
  }

  decode(archive: Uint8Array): ArchiveEntry[] {
    try {
      return (JSON.parse(new TextDecoder().decode(archive)) as Array<{ name: string; data: number[] }>).map(
        (entry) => ({ name: entry.name, data: Uint8Array.from(entry.data) }),
      );
    } catch (error) {
      throw new ArchiveError(`fixture archive is not JSON: ${String(error)}`, {});
    }
  }
}

/** Returns a fixed inspection, and records which bytes it was asked about. */
export class StubInspector implements CorpusFileInspector {
  readonly seen: Uint8Array[] = [];
  readonly #result: DatabaseInspection;

  constructor(result: DatabaseInspection) {
    this.#result = result;
  }

  async inspect(database: Uint8Array): Promise<DatabaseInspection> {
    this.seen.push(database);
    return this.#result;
  }
}

/** Records install requests instead of touching a filesystem. */
export class RecordingInstaller implements CorpusInstaller {
  readonly requests: InstallRequest[] = [];

  async install(request: InstallRequest): Promise<InstallResult> {
    this.requests.push(request);
    return { directory: `/workspace/corpora/${request.name}`, scope: "home", replaced: request.replace };
  }
}
