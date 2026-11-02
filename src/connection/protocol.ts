/**
 * Typed RPC client for the T3 Code WebSocket API, mirroring upstream
 * `packages/client-runtime/src/rpc/protocol.ts`.
 */
import { WsRpcGroup } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, infer _E, infer _R> ? Client : never;

/** Pings go out every 5 seconds (the effect/rpc default, same as upstream). */
export const PING_INTERVAL = "5 seconds";
/**
 * A server busy for a few seconds stops answering pings. Allow 15 seconds
 * without any frame before dropping the socket (same as upstream).
 */
export const PING_TIMEOUT = "15 seconds";
/** How long to wait for the WebSocket handshake (same as upstream). */
export const SOCKET_OPEN_TIMEOUT = "15 seconds";
