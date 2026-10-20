import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionRpcAutoConfirmer } from "../src/rpc-auto-confirm.ts";

const capability = Symbol.for("pi-permissions:rpc-reviewed-approval/v1");
const payload = { kind: "path", request: { surface: "path" }, evidence: { path: "/tmp/reviewed.md" } };
function fixture() {
  let now = 0;
  let sessionId = "owner";
  const controller = new AbortController();
  const ui = {} as Record<symbol, { consume: (id: string, payload: typeof globalThis.Object) => boolean }>;
  const ctx = { ui, hasUI: true, mode: "rpc", signal: controller.signal,
    sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  const receipts = new PermissionRpcAutoConfirmer(() => ["path"], 10_000, () => now);
  receipts.attach(ctx);
  const consume = (value = payload) => (ui[capability] as unknown as { consume: (id: string, value: unknown) => boolean }).consume("request", value);
  return { receipts, consume, controller, stage: () => receipts.stage("request", "path", payload),
    expire: () => { now = 10_000; }, changeOwner: () => { sessionId = "other"; } };
}

test("RPC approval receipts are exact and single-use", () => {
  const h = fixture();
  assert.equal(h.stage(), true);
  assert.equal(h.consume(), true);
  assert.equal(h.consume(), false);
  assert.equal(h.stage(), true);
  assert.equal(h.consume({ ...payload, evidence: { path: "/tmp/another.md" } }), false);
  assert.equal(h.consume(), false);
});

test("expired, cancelled, revoked and cross-session RPC receipts cannot approve", () => {
  for (const invalidate of [
    (h: ReturnType<typeof fixture>) => h.expire(),
    (h: ReturnType<typeof fixture>) => h.controller.abort(),
    (h: ReturnType<typeof fixture>) => h.changeOwner(),
    (h: ReturnType<typeof fixture>) => h.receipts.revoke(),
  ]) {
    const h = fixture();
    assert.equal(h.stage(), true);
    invalidate(h);
    assert.equal(h.consume(), false);
  }
});
