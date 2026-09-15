import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArchiveCodec, ArchiveEntry } from "./archive.ts";

/**
 * An interface, so what is worth testing is that its contract is satisfiable
 * by something other than the real codec -- which is what lets the export and
 * import use cases be tested without gzip or a filesystem. The gzip codec has
 * its own spec.
 */
describe("application/ports/archive", () => {
  const codec: ArchiveCodec = {
    encode: (entries) =>
      new TextEncoder().encode(JSON.stringify(entries.map((entry) => ({ name: entry.name, data: [...entry.data] })))),
    decode: (archive) =>
      (JSON.parse(new TextDecoder().decode(archive)) as Array<{ name: string; data: number[] }>).map(
        (entry): ArchiveEntry => ({ name: entry.name, data: Uint8Array.from(entry.data) }),
      ),
  };

  const entries: ArchiveEntry[] = [
    { name: "b", data: Uint8Array.from([0x00, 0xff, 0x7f]) },
    { name: "a", data: new Uint8Array(0) },
  ];

  it("round-trips entries in the order they were given", () => {
    assert.deepEqual(
      codec.decode(codec.encode(entries)).map((entry) => entry.name),
      ["b", "a"],
    );
  });

  it("keeps binary content byte-exact", () => {
    assert.deepEqual(codec.decode(codec.encode(entries)), entries);
  });

  it("represents an archive as one byte array, so it can be written as one file", () => {
    assert.ok(codec.encode(entries) instanceof Uint8Array);
  });
});
