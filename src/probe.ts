/**
 * Connectivity probe for a T3 Code server.
 *
 * Usage: bun run src/probe.ts [serverUrl]
 *
 * Fetches the public environment descriptor, validates it against the
 * vendored contracts schema and checks that the server speaks the same
 * orchestration protocol version as the vendored contracts. The same check
 * runs before every connection attempt (see src/connection/environment.ts).
 */
import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_URL, normalizeServerUrl } from "./config.ts";
import { checkProtocol, fetchEnvironment, summarizeEnvironment } from "./connection/environment.ts";

function fail(message: string): never {
  console.error(`probe: ${message}`);
  process.exit(1);
}

let serverUrl: string;
try {
  serverUrl = normalizeServerUrl(process.argv[2] ?? DEFAULT_SERVER_URL);
} catch (cause) {
  fail((cause as Error).message);
}

const result = await Effect.runPromise(Effect.result(fetchEnvironment(serverUrl)));
if (result._tag === "Failure") fail(result.failure.message);
const descriptor = result.success;
const summary = summarizeEnvironment(serverUrl, descriptor);
const machine = descriptor.platform.machine ? ` (${descriptor.platform.machine})` : "";

console.log(`server:        ${summary.server}`);
console.log(`serverVersion: ${summary.serverVersion}`);
console.log(
  `protocol:      ${summary.serverProtocol ?? "(not reported)"} (vendored contracts: ${summary.clientProtocol})`,
);
console.log(`environment:   ${summary.environment.label} (${summary.environment.id})`);
console.log(`platform:      ${summary.platform}${machine}`);

const mismatch = checkProtocol(descriptor);
if (mismatch !== undefined) fail(mismatch.message);

console.log("ok: protocol versions match");
