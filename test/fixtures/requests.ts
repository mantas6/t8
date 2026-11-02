/**
 * Builds decoded thread stream events for runtime requests (approvals and
 * user-input questions), modelled on the recorded fixture's turn items.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type Json = Record<string, unknown>;

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

const rawLines: ReadonlyArray<Json> = readFileSync(
  join(import.meta.dir, "thread-lifecycle.ndjson"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Json);

const template = rawLines.find((line) => {
  const event = line.event as Json | undefined;
  return (
    event?.type === "turn-item.updated" && (event.payload as Json).type === "assistant_message"
  );
})?.event as Json | undefined;
if (template === undefined) throw new Error("fixture has no assistant turn item");
const common = template.payload as Json;

export type Capability = "live" | "message";

/** Event builders with increasing sequences, above anything in the fixture. */
export function requestEvents(startSequence = 900_000) {
  let sequence = startSequence;
  let ordinal = 2_000_000;
  const event = (type: string, payload: Json) =>
    decode({
      kind: "event",
      sequence: ++sequence,
      event: { ...template, id: `event:test:${sequence}`, type, payload },
    });
  const turnItem = (requestId: string, fields: Json) =>
    event("turn-item.updated", {
      ...common,
      id: `turn-item:test:${requestId}`,
      text: undefined,
      messageId: undefined,
      streaming: undefined,
      ordinal: ++ordinal,
      status: "waiting",
      requestId,
      ...fields,
    });
  return {
    /** The runtime request itself. */
    request: (
      requestId: string,
      kind: "command" | "user_input",
      status: "pending" | "resolved" = "pending",
      capability: Capability = "live",
    ) =>
      event("runtime-request.updated", {
        id: requestId,
        nodeId: common.nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status,
        responseCapability:
          capability === "live"
            ? { type: "live", providerSessionId: "provider-session:test" }
            : { type: "message" },
        createdAt: "2026-11-02T06:44:09.400Z",
        resolvedAt: status === "pending" ? null : "2026-11-02T06:44:10.000Z",
      }),
    /** The turn item describing an approval; `options` replaces the default set. */
    approvalItem: (requestId: string, options?: ReadonlyArray<Json>) =>
      turnItem(requestId, {
        type: "approval_request",
        title: "Run command",
        requestKind: "command",
        prompt: "List the files in the repo root",
        ...(options === undefined ? {} : { options }),
      }),
    /** The turn item carrying user-input questions. */
    userInputItem: (requestId: string, questions: ReadonlyArray<Json>, extra: Json = {}) =>
      turnItem(requestId, { type: "user_input_request", title: "Question", questions, ...extra }),
  };
}

export function question(id: string, options: ReadonlyArray<string>, extra: Json = {}): Json {
  return {
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: options.map((label) => ({ label, description: `about ${label}` })),
    ...extra,
  };
}
