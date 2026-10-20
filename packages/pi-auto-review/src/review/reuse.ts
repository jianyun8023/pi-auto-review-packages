import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryRequest, BoundaryReviewerContext } from "../broker/index.ts";
import { canonicalReviewerJson, type TranscriptResult } from "../policy.ts";
import type { Config, ReviewResult } from "./types.ts";

/** Reuse a whole file-call review across its path/tool gates, never across calls. */
export class InvocationReviewCache {
  private readonly entries = new Map<string, { expiresAt: number; requestId: string; result: ReviewResult }>();
  constructor(private readonly now = () => Date.now()) {}

  key(ctx: ExtensionContext, config: Config, request: BoundaryRequest, transcript: TranscriptResult,
    reviewerContext?: BoundaryReviewerContext): string | undefined {
    if (ctx.signal?.aborted || reviewerContext?.userOverride || transcript.truncated || transcript.failureCode ||
      request.source !== "permission-system" || !request.toolCallId || request.requesterSessionId || request.agentName) return;
    const messages = ctx.sessionManager.buildContextEntries().flatMap(entry => {
      const message = (entry as unknown as { message?: Record<string, unknown> }).message;
      return message ? [message] : [];
    });
    const calls = messages.filter(message => message.role === "assistant").flatMap(message =>
      Array.isArray(message.content) ? message.content : []);
    const call = calls.find(item => item && typeof item === "object" && item.type === "toolCall" && item.id === request.toolCallId);
    if (!call || !["read", "write", "edit"].includes(call.name) || !call.arguments ||
      typeof call.arguments !== "object" || Array.isArray(call.arguments) || typeof call.arguments.path !== "string") return;
    if (request.toolName && request.toolName !== call.name) return;
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
    return createHash("sha256").update(canonicalReviewerJson({
      session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, toolCallId: request.toolCallId,
      name: call.name, arguments: call.arguments, canonicalPath, config,
      users: messages.filter(message => message.role === "user"),
      environment: request.reviewEnvironment,
    })).digest("hex");
  }

  get(key: string | undefined): { requestId: string; result: ReviewResult } | undefined {
    if (!key) return;
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry;
    this.entries.delete(key);
    return;
  }

  remember(key: string | undefined, requestId: string, result: ReviewResult): void {
    if (!key || result.decision.outcome !== "allow" || result.decision.user_authorization !== "high" ||
      !["low", "medium"].includes(result.decision.risk_level) || result.unavailable || result.summary.reusedReview) return;
    while (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expiresAt: this.now() + 30_000, requestId, result: structuredClone(result) });
  }
}

function realTarget(path: string): string | undefined {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    try { return resolve(realpathSync(dirname(path)), basename(path)); } catch { return; }
  }
}
