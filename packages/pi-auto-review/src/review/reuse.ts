import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryRequest, BoundaryReviewerContext } from "../broker/index.ts";
import { canonicalReviewerJson, executionText, type TranscriptResult } from "../policy.ts";
import type { Config, ReviewResult } from "./types.ts";

type InvocationReviewKey = { value: string; target?: { lexical: string; canonical: string } };

/** Reuse a whole invocation review across gates, never a human's narrow grant. */
export class InvocationReviewCache {
  private readonly entries = new Map<string, { expiresAt: number; requestId: string; result: ReviewResult;
    targets: Array<{ lexical: string; canonical: string }> }>();
  constructor(private readonly now = () => Date.now()) {}

  key(ctx: ExtensionContext, config: Config, request: BoundaryRequest, transcript: TranscriptResult,
    reviewerContext?: BoundaryReviewerContext): InvocationReviewKey | undefined {
    if (ctx.signal?.aborted || reviewerContext?.userOverride || transcript.truncated || transcript.failureCode ||
      request.source !== "permission-system" || !request.toolCallId || request.requesterSessionId || request.agentName) return;
    const messages = ctx.sessionManager.buildContextEntries().flatMap(entry => {
      const message = (entry as unknown as { message?: Record<string, unknown> }).message;
      return message ? [message] : [];
    });
    const calls = messages.filter(message => message.role === "assistant").flatMap(message =>
      Array.isArray(message.content) ? message.content : []);
    const call = calls.find(item => item && typeof item === "object" && item.type === "toolCall" && item.id === request.toolCallId);
    if (!call || !["read", "write", "edit", "bash"].includes(call.name) || !call.arguments ||
      typeof call.arguments !== "object" || Array.isArray(call.arguments)) return;
    if (request.toolName && request.toolName !== call.name) return;
    if (call.name === "bash") {
      if (request.toolName !== "bash" || typeof call.arguments.command !== "string" || executionText(request) !== call.arguments.command ||
        request.fullCommandTruncated || request.matchedPattern?.startsWith("<") || request.destination ||
        !["bash", "path", "path_read", "path_write", "external_directory", "external_directory_read", "external_directory_write"].includes(request.surface)) return;
      const cwd = realTarget(ctx.cwd);
      const policies = permissionPolicyFingerprint(ctx.cwd);
      if (!cwd || !policies || (ctx.isProjectTrusted && !ctx.isProjectTrusted())) return;
      const lexical = request.surface !== "bash" ? request.decidingPath?.path ?? request.path ?? request.resolvedPath : undefined;
      // Relative paths may be under an inner `cd`; without the lexical absolute
      // target, do not invent a symlink proof from the outer cwd.
      const canonical = lexical && isAbsolute(lexical) ? realTarget(lexical) : undefined;
      if (request.surface !== "bash" && (!lexical || !canonical)) return;
      return { value: createHash("sha256").update(canonicalReviewerJson({
        session: ctx.sessionManager.getSessionId(), cwd, toolCallId: request.toolCallId,
        name: call.name, arguments: call.arguments, config, policies,
        messages, environment: request.reviewEnvironment,
      })).digest("hex"), ...(lexical && canonical ? { target: { lexical, canonical } } : {}) };
    }
    if (typeof call.arguments.path !== "string") return;
    const direction = call.name === "read" ? "read" : "write";
    const allowedSurfaces = [call.name, "path", `path_${direction}`, "external_directory", `external_directory_${direction}`];
    if (!allowedSurfaces.includes(request.surface) || request.command || request.fullCommand || request.destination) return;
    const lexicalPath = resolve(ctx.cwd, call.arguments.path);
    const canonicalPath = realTarget(lexicalPath);
    if (!canonicalPath) return;
    // A different gate target, symlink resolution, or new effect cannot inherit
    // this result. Every gate still runs its own deterministic deny rules.
    for (const target of [request.path, request.resolvedPath, request.decidingPath?.path]) {
      if (target && realTarget(resolve(ctx.cwd, target)) !== canonicalPath) return;
    }
    return { value: createHash("sha256").update(canonicalReviewerJson({
      session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, toolCallId: request.toolCallId,
      name: call.name, arguments: call.arguments, canonicalPath, config,
      users: messages.filter(message => message.role === "user"),
      environment: request.reviewEnvironment,
    })).digest("hex") };
  }

  get(key: InvocationReviewKey | undefined): { requestId: string; result: ReviewResult } | undefined {
    if (!key) return;
    const entry = this.entries.get(key.value);
    if (entry && entry.expiresAt > this.now()) {
      if (entry.targets.some(target => realTarget(target.lexical) !== target.canonical)) return;
      if (key.target) {
        // A new target needs its own review; a directory-only receipt never
        // expands into an arbitrary path gate.
        if (realTarget(key.target.lexical) !== key.target.canonical ||
          !entry.targets.some(previous => key.target?.lexical === previous.lexical && key.target.canonical === previous.canonical)) return;
      }
      return entry;
    }
    this.entries.delete(key.value);
    return;
  }

  remember(key: InvocationReviewKey | undefined, requestId: string, result: ReviewResult): void {
    if (!key) return;
    const priorTargets = this.entries.get(key.value)?.targets ?? [];
    this.entries.delete(key.value);
    if (result.decision.outcome !== "allow" || result.decision.user_authorization !== "high" ||
      !["low", "medium"].includes(result.decision.risk_level) || result.unavailable || result.summary.reusedReview) return;
    while (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    // Check the pre-review snapshot, not a fresh post-review target. A symlink
    // changed while the model was running must never seed a reusable approval.
    const { lexical, canonical } = key.target ?? {};
    if (lexical && realTarget(lexical) !== canonical) return;
    const targets = priorTargets.filter(target => target.lexical !== lexical);
    if (lexical && canonical) targets.push({ lexical, canonical });
    this.entries.set(key.value, { expiresAt: this.now() + 30_000, requestId, result: structuredClone(result), targets });
  }
}

function permissionPolicyFingerprint(cwd: string): string | undefined {
  const agent = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
  try {
    return createHash("sha256").update(canonicalReviewerJson([
      resolve(agent, "extensions/pi-permission-system/config.json"),
      resolve(cwd, ".pi/extensions/pi-permission-system/config.json"),
    ].map(path => {
      try { return [path, readFileSync(path, "utf8")]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null]; throw error; }
    }))).digest("hex");
  } catch { return; }
}

function realTarget(path: string): string | undefined {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    try { return resolve(realpathSync(dirname(path)), basename(path)); } catch { return; }
  }
}
