/**
 * Programmatic entry point for the CLI.
 *
 * Exported so the command router can be driven from tests and from other
 * tooling without spawning a process.
 */

export { main } from "./main.ts";
export { VERSION } from "./version.ts";
