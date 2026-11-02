/**
 * Connectivity probe for a T3 Code server.
 *
 * Usage: bun run src/probe.ts [serverUrl]
 *
 * Fetches the public environment descriptor, validates it against the
 * vendored contracts schema and checks that the server speaks the same
 * orchestration protocol version as the vendored contracts.
 */
import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DEFAULT_SERVER_URL = "http://localhost:3773";
const DESCRIPTOR_PATH = "/.well-known/t3/environment";

function fail(message: string): never {
  console.error(`probe: ${message}`);
  process.exit(1);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const serverUrl = process.argv[2] ?? DEFAULT_SERVER_URL;

const descriptorUrl =
  URL.parse(DESCRIPTOR_PATH, serverUrl) ?? fail(`invalid server URL: ${serverUrl}`);

const response = await fetch(descriptorUrl, { headers: { accept: "application/json" } }).catch(
  (cause: unknown) => fail(`could not reach ${descriptorUrl.href}: ${errorMessage(cause)}`),
);

if (!response.ok) {
  fail(`${descriptorUrl.href} responded with HTTP ${response.status} ${response.statusText}`);
}

const body: unknown = await response
  .json()
  .catch(() => fail(`${descriptorUrl.href} did not return valid JSON`));

let descriptor: ExecutionEnvironmentDescriptor;
try {
  descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(body);
} catch (cause) {
  fail(`environment descriptor does not match the vendored schema:\n${errorMessage(cause)}`);
}

const serverProtocol = descriptor.orchestrationProtocolVersion;
const machine = descriptor.platform.machine ? ` (${descriptor.platform.machine})` : "";

console.log(`server:        ${descriptorUrl.origin}`);
console.log(`serverVersion: ${descriptor.serverVersion}`);
console.log(
  `protocol:      ${serverProtocol ?? "(not reported)"} (vendored contracts: ${ORCHESTRATION_PROTOCOL_VERSION})`,
);
console.log(`environment:   ${descriptor.label} (${descriptor.environmentId})`);
console.log(`platform:      ${descriptor.platform.os}/${descriptor.platform.arch}${machine}`);

if (serverProtocol !== ORCHESTRATION_PROTOCOL_VERSION) {
  fail(
    `orchestration protocol mismatch: server reports ${serverProtocol ?? "none"}, ` +
      `vendored contracts expect ${ORCHESTRATION_PROTOCOL_VERSION}. ` +
      "Refresh vendor/contracts to match the server (see vendor/contracts/VENDORED.md).",
  );
}

console.log("ok: protocol versions match");
