import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "../src/review/complete.ts";
import { DEFAULT_CONFIG, applyProjectConfig, validateConfig } from "../src/review/config.ts";
import { completeTelemetry } from "../src/review/provider.ts";
import type { Config, ReviewerMeta } from "../src/review/types.ts";

const classifierConfig = { model: "magpie-jev/home-m4/typesafe/jev-latest", timeoutMs: 100, minConfidence: 0.98 };
const config = { ...DEFAULT_CONFIG, classifier: classifierConfig, maxUserTranscriptTokens: 8000,
  maxReviewerInputTokens: 16384, timeoutMs: 2000, retries: 0 };
const request = { id: "request-1", source: "permission-system", surface: "bash", operation: "tool",
  cwd: "/repo", toolName: "bash", command: "git status --short" };
function classified(effect = "read_only", confidence = 0.99, authorized = 0.99): ClassifierResult {
  return { api: "typesafe-system-one", provider: "magpie-jev", model: "home-m4/typesafe/jev-latest", timestamp: 0,
    stopReason: "stop", answers: {
      effect: { type: "choice", choice: effect, confidence, probabilities: { [effect]: confidence, unknown: 1 - confidence } },
      authorization: { type: "choice", choice: "authorized", confidence: authorized, probabilities: { authorized, unknown: 1 - authorized } },
      risk: { type: "choice", choice: "low", confidence: 0.99, probabilities: { low: 0.99, elevated: 0.01 } },
    } };
}
function harness(behavior: (signal?: AbortSignal) => Promise<ClassifierResult> = async () => classified()) {
  let lunaCalls = 0;
  const classifierInputs: ClassifierContext[] = [];
  const lunaInputs: unknown[] = [];
  const controller = new AbortController();
  const ctx = {
    cwd: "/repo", signal: controller.signal,
    sessionManager: { getSessionId: () => "test-session", buildContextEntries: () => [
      { message: { role: "user", content: "检查仓库，然后提交 PR" } },
      { message: { role: "user", content: "继续" } },
    ] },
    modelRegistry: {
      findOfType: () => ({ provider: "magpie-jev", id: "home-m4/typesafe/jev-latest", type: "classifier" }),
      classify: async (_model: unknown, context: ClassifierContext, options: { signal?: AbortSignal }) => {
        classifierInputs.push(context); return behavior(options.signal);
      },
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    },
  } as unknown as ExtensionContext;
  const resolve = async (): Promise<ReviewerMeta> => ({
    model: { provider: "reviewer", id: "luna", api: "test", name: "luna" } as ReviewerMeta["model"],
    streamSimple: ((_model: unknown, context: unknown) => {
      lunaCalls++; lunaInputs.push(context);
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
        outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "Luna reviewed the action",
      }) }] }) };
    }) as unknown as ReviewerMeta["streamSimple"],
  });
  return { ctx, controller, resolve, classifierInputs, lunaInputs, get lunaCalls() { return lunaCalls; },
    run: (overrides: Partial<Config> = {}) => complete(ctx, { ...config, ...overrides }, request, undefined, resolve) };
}

test("confident Jev classification completes the review without calling Luna", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.decision.outcome, "allow");
  assert.equal(h.lunaCalls, 0);
  assert.equal(h.classifierInputs.length, 1);
  assert.match(JSON.stringify(h.classifierInputs[0]), /检查仓库，然后提交 PR/);
  assert.equal(result.summary.attempts[0]?.model, classifierConfig.model);
  assert.equal(completeTelemetry(request, config, result.summary, "allow").model, classifierConfig.model);
});

test("uncertain, unauthorized, mutating and malformed classifications fall through to Luna", async () => {
  for (const result of [classified("read_only", 0.7), classified("read_only", 0.99, 0.5),
    classified("remote_mutation"), classified("destructive"), classified("security"),
    { ...classified(), answers: {} }, { ...classified(), stopReason: "error" as const },
    { ...classified(), answers: { ...classified().answers, risk: { type: "choice" as const, choice: "low", confidence: NaN, probabilities: { low: 1 } } } }]) {
    const h = harness(async () => result);
    const review = await h.run();
    assert.equal(h.classifierInputs.length, 1);
    assert.equal(h.lunaCalls, 1);
    assert.equal(review.decision.rationale, "Luna reviewed the action");
    assert.equal(review.summary.attempts.length, 2);
  }
});

test("classifier timeout and transport failure use Luna, but session abort cancels the entire review", async () => {
  for (const behavior of [async () => { throw new Error("offline"); }, () => new Promise<ClassifierResult>(() => {})]) {
    const h = harness(behavior);
    assert.equal((await h.run()).decision.outcome, "allow");
    assert.equal(h.lunaCalls, 1);
  }
  const h = harness(async () => { h.controller.abort(); return classified(); });
  await assert.rejects(h.run(), /abort/);
  assert.equal(h.lunaCalls, 0);
});

test("classifier config is trusted-global only and rejects unsafe thresholds", () => {
  assert.deepEqual(validateConfig(config, "test").classifier, classifierConfig);
  assert.throws(() => applyProjectConfig(config, { classifier: classifierConfig }), /cannot set/);
  for (const patch of [{ minConfidence: 0 }, { minConfidence: NaN }, { timeoutMs: 0 }, { model: "current" }, { extra: true }]) {
    assert.throws(() => validateConfig({ ...config, classifier: { ...classifierConfig, ...patch } }, "test"), /classifier/);
  }
});

test("one exact file invocation reuses its review across path and tool gates only", async () => {
  const { InvocationReviewCache } = await import("../src/review/reuse.ts");
  const h = harness();
  const cache = new InvocationReviewCache();
  let users = ["Write the requested document"];
  let content = "document content";
  const ctx = { ...h.ctx, cwd: "/tmp", sessionManager: {
    getSessionId: () => "file-session",
    buildContextEntries: () => [
      ...users.map(text => ({ message: { role: "user", content: text } })),
      { message: { role: "assistant", content: [{ type: "toolCall", name: "write", id: "file-call",
        arguments: { path: "/tmp/pi-review-reuse-probe.md", content } }] } },
    ],
  } } as unknown as ExtensionContext;
  const file = { ...request, command: undefined, cwd: "/tmp", toolName: "write", toolCallId: "file-call",
    path: "/tmp/pi-review-reuse-probe.md" };
  const review = (surface: string, id: string) => complete(ctx, { ...config, classifier: undefined },
    { ...file, surface, id }, undefined, h.resolve, undefined, cache);
  const first = await review("path_write", "first-gate");
  const second = await review("write", "second-gate");
  assert.equal(first.decision.outcome, "allow");
  assert.equal(second.decision.outcome, "allow");
  assert.equal(h.lunaCalls, 1);
  assert.equal(second.attempts, 0);
  assert.equal(second.summary.reusedReview?.requestId, "first-gate");
  content = "changed content";
  await review("write", "changed-arguments");
  assert.equal(h.lunaCalls, 2);
  users = [...users, "Do not write anything further"];
  await review("write", "changed-instructions");
  assert.equal(h.lunaCalls, 3);
  await complete(ctx, { ...config, classifier: undefined }, { ...file, toolCallId: "another-call", surface: "write", id: "new-call" }, undefined, h.resolve, undefined, cache);
  assert.equal(h.lunaCalls, 4);
});

test("incomplete mandatory evidence reaches neither Jev nor Luna", async () => {
  const h = harness();
  const ctx = { ...h.ctx, sessionManager: {
    getSessionId: () => "oversized",
    buildContextEntries: () => [
      { message: { role: "user", content: "Edit the document" } },
      { message: { role: "assistant", content: [{ type: "toolCall", id: "large-edit", name: "edit",
        arguments: { path: "/tmp/document.md", oldText: "old", newText: "x".repeat(100_000) } }] } },
    ],
  } } as unknown as ExtensionContext;
  await assert.rejects(complete(ctx, config, { ...request, surface: "edit", toolName: "edit",
    command: undefined, toolCallId: "large-edit", path: "/tmp/document.md" }, undefined, h.resolve), /evidence_overflow|input_budget/);
  assert.equal(h.classifierInputs.length, 0);
  assert.equal(h.lunaCalls, 0);
});

test("codemode wrapper approval never takes the classifier shortcut", async () => {
  const h = harness();
  await complete(h.ctx, config, { ...request, surface: "codemode", toolName: "codemode" }, undefined, h.resolve);
  assert.equal(h.classifierInputs.length, 1);
  assert.equal(h.lunaCalls, 1);
});
