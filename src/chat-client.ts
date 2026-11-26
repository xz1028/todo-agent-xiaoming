import type { PendingRequest } from "./session.ts";

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal = AbortSignal.timeout(55_000),
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok)
    throw new Error(typeof value.error === "string" ? value.error : "服务暂时不可用。");
  return value as T;
}
export async function requestReply(request: PendingRequest): Promise<string> {
  const body = await api<{ reply: string }>("/api/chat", "POST", request);
  if (typeof body.reply !== "string") throw new Error("未收到完整回复，请读取本次请求回执。");
  return body.reply;
}
export interface Receipt {
  state: "running" | "done" | "interrupted";
  reply?: string;
}
export async function waitForReceipt(id: string): Promise<string> {
  const deadline = Date.now() + 55_000;
  const signal = AbortSignal.timeout(55_000);
  while (Date.now() < deadline) {
    const value = await api<Receipt>(
      "/api/chat/" + encodeURIComponent(id),
      "GET",
      undefined,
      signal,
    );
    if (value.state !== "running" && value.reply) return value.reply;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("处理尚未结束，请稍后读取回执。");
}
