/**
 * tests/helpers/rpc.ts
 *
 * Typed JSON-RPC fetch helpers for integration tests.
 */

import type { JsonRpcResponse } from "../../src/types.js";

// ─── Core fetch helper ────────────────────────────────────────────────────────

export async function sendRpc(
  url:    string,
  method: string,
  params: unknown[] = [],
  id:     number | string = 1
): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res.json() as Promise<JsonRpcResponse>;
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export async function sendRawTx(
  url:    string,
  rawHex: string,
  id:     number | string = 1
): Promise<JsonRpcResponse> {
  return sendRpc(url, "eth_sendRawTransaction", [rawHex], id);
}

export async function sendUserOp(
  url:    string,
  userOp: unknown,
  id:     number | string = 1
): Promise<JsonRpcResponse> {
  return sendRpc(url, "eth_sendUserOperation", [userOp, "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"], id);
}

export async function sendBatch(
  url:      string,
  requests: Array<{ method: string; params: unknown[]; id: number }>
): Promise<JsonRpcResponse[]> {
  const body = requests.map(r => ({ jsonrpc: "2.0", id: r.id, method: r.method, params: r.params }));
  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  return res.json() as Promise<JsonRpcResponse[]>;
}

export async function getHealth(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/health`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function getPolicy(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/policy`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── Response discriminators ──────────────────────────────────────────────────

export function isBlocked(res: JsonRpcResponse): boolean {
  return res.error?.code === -32003;
}

export function isAllowed(res: JsonRpcResponse): boolean {
  return res.result !== undefined && res.error === undefined;
}

export function getDecision(res: JsonRpcResponse): Record<string, unknown> | undefined {
  const data = (res.error?.data as Record<string, unknown> | undefined);
  return data?.["decision"] as Record<string, unknown> | undefined;
}
