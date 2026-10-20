import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("complete Bash invocation review is reused across its gates and expires", async () => {
  const { InvocationReviewCache } = await import("../src/review/reuse.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-bash-review-"));
  try {
    const file = join(root, "document.txt");
    writeFileSync(file, "example");
    const h = harness();
    let now = 0;
    const cache = new InvocationReviewCache(() => now);
    const command = `cat ${file}`;
    const entries = [{ message: { role: "user", content: "Read the example document" } },
      { message: { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command } }] } }];
    const ctx = { ...h.ctx, cwd: root, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "bash-session", buildContextEntries: () => entries } } as unknown as ExtensionContext;
    const base = { ...request, cwd: root, command, toolCallId: "bash-call", path: file };
    const review = (surface: string, id: string, patch = {}) => complete(ctx, { ...config, classifier: undefined },
      { ...base, surface, id, ...patch }, undefined, h.resolve, undefined, cache);
    await review("external_directory_read", "external");
    assert.equal((await review("path_read", "path")).summary.reusedReview?.requestId, "external");
    assert.equal((await review("bash", "bash", { path: undefined })).summary.reusedReview?.requestId, "external");
    assert.equal(h.lunaCalls, 1);
    now = 30_001;
    await review("bash", "expired", { path: undefined });
    assert.equal(h.lunaCalls, 2);
    // A Bash gate without target evidence does not lend authority to a path gate.
    await review("path_read", "path-again");
    assert.equal(h.lunaCalls, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Bash reuse invalidates on policy, referent, arguments, target identity and cancellation", async () => {
  const { InvocationReviewCache } = await import("../src/review/reuse.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-bash-review-invalidation-"));
  try {
    const first = join(root, "first.txt"), second = join(root, "second.txt"), link = join(root, "link.txt");
    writeFileSync(first, "first"); writeFileSync(second, "second"); symlinkSync(first, link);
    const h = harness();
    const cache = new InvocationReviewCache();
    let command = `cat ${link}`;
    let users = ["Read the document"];
    let proposal = "Read the example?";
    const ctx = { ...h.ctx, cwd: root, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "bash-session", buildContextEntries: () => [
        { message: { role: "assistant", content: [{ type: "text", text: proposal }] } },
        ...users.map(content => ({ message: { role: "user", content } })),
        { message: { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command } }] } },
      ] } } as unknown as ExtensionContext;
    const review = (patch = {}) => complete(ctx, { ...config, classifier: undefined },
      { ...request, cwd: root, command, toolCallId: "bash-call", surface: "path_read", path: link, ...patch },
      undefined, h.resolve, undefined, cache);
    await review(); await review(); assert.equal(h.lunaCalls, 1);
    unlinkSync(link); symlinkSync(second, link);
    await review(); assert.equal(h.lunaCalls, 2);
    const policy = join(root, ".pi/extensions/pi-permission-system");
    mkdirSync(policy, { recursive: true }); writeFileSync(join(policy, "config.json"), '{"permission":{"bash":"ask"}}');
    await review(); assert.equal(h.lunaCalls, 3);
    proposal = "Read a different document?";
    await review(); assert.equal(h.lunaCalls, 4);
    users = [...users, "Do not read any further"];
    await review(); assert.equal(h.lunaCalls, 5);
    command = `cat ${first}`;
    await review(); assert.equal(h.lunaCalls, 6);
    await review({ path: first }); assert.equal(h.lunaCalls, 7);
    await review({ toolCallId: "different-call" }); assert.equal(h.lunaCalls, 8);
    await review({ matchedPattern: "<unparsed-bash-subtree>" }); assert.equal(h.lunaCalls, 9);
    await review({ agentName: "child" }); assert.equal(h.lunaCalls, 10);
    h.controller.abort();
    await assert.rejects(review(), /abort/);
    assert.equal(h.lunaCalls, 10);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Bash cache checks pre-review symlinks and retains every previously reviewed target", async () => {
  const { InvocationReviewCache } = await import("../src/review/reuse.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-bash-review-race-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), third = join(root, "third"), link = join(root, "link");
    for (const file of [first, second, third]) writeFileSync(file, "test");
    symlinkSync(first, link);
    const h = harness();
    const cache = new InvocationReviewCache();
    const command = `cat ${link} ${second}`;
    const ctx = { ...h.ctx, cwd: root, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "race", buildContextEntries: () => [
        { message: { role: "user", content: "Read the two test files" } },
        { message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command } }] } },
      ] } } as unknown as ExtensionContext;
    const review = (path: string | undefined, resolve = h.resolve) => complete(ctx, { ...config, classifier: undefined },
      { ...request, cwd: root, command, toolCallId: "call", surface: path ? "path_read" : "bash", path },
      undefined, resolve, undefined, cache);
    await review(link, async () => { unlinkSync(link); symlinkSync(third, link); return h.resolve(); });
    await review(undefined);
    assert.equal(h.lunaCalls, 2, "a target changed during review cannot seed a cache entry");
    await review(link); await review(second);
    assert.equal(h.lunaCalls, 4, "each distinct path gets reviewed before reuse");
    unlinkSync(link); symlinkSync(first, link);
    await review(undefined);
    assert.equal(h.lunaCalls, 5, "a previous target still invalidates after another target was reviewed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a new lexical alias needs review even when it resolves to a previously reviewed file", async () => {
  const { InvocationReviewCache } = await import("../src/review/reuse.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-bash-review-alias-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias");
    writeFileSync(first, "first"); writeFileSync(second, "second"); symlinkSync(first, alias);
    const h = harness(), cache = new InvocationReviewCache();
    const command = `cat ${first} ${alias}`;
    const ctx = { ...h.ctx, cwd: root, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "alias", buildContextEntries: () => [
        { message: { role: "user", content: "Read the files" } },
        { message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command } }] } },
      ] } } as unknown as ExtensionContext;
    const review = (path: string | undefined) => complete(ctx, { ...config, classifier: undefined },
      { ...request, cwd: root, command, toolCallId: "call", surface: path ? "path_read" : "bash", path },
      undefined, h.resolve, undefined, cache);
    await review(first); await review(alias);
    assert.equal(h.lunaCalls, 2);
    unlinkSync(alias); symlinkSync(second, alias);
    await review(undefined);
    assert.equal(h.lunaCalls, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
