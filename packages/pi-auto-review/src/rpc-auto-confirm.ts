import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathSurfaceInfo } from "./path-surfaces.ts";

// Process-local capability. No receipt or consume method is sent over RPC.
const CAPABILITY = Symbol.for("pi-permissions:rpc-reviewed-approval/v1");
type Payload = { kind: unknown; request: { surface: string }; evidence: unknown };
type Receipt = { surface: string; fingerprint: string; expiresAt: number };

function fingerprint(payload: Payload): string {
  return createHash("sha256").update(JSON.stringify([
    payload.kind, payload.request, payload.evidence,
  ])).digest("hex");
}

/** A reviewed allow, consumable once by the exact local permission terminal. */
export class PermissionRpcAutoConfirmer {
  private readonly pending = new Map<string, Receipt>();
  private detach: (() => void) | undefined;
  private context: ExtensionContext | undefined;
  private owner: string | undefined;

  constructor(
    private readonly enabledSurfaces: () => readonly string[],
    private readonly ttlMs = 10_000,
    private readonly now = () => Date.now(),
  ) {}

  attach(ctx: ExtensionContext): void {
    this.clear();
    if (!ctx.hasUI || ctx.mode !== "rpc") return;
    const ui = ctx.ui as unknown as Record<symbol, unknown>;
    // Another owner is never replaced. The ordinary human prompt remains.
    if (ui[CAPABILITY] !== undefined) return;
    this.owner = ctx.sessionManager.getSessionId();
    this.context = ctx;
    const capability = {
      version: 1,
      consume: (requestId: string, payload: Payload): boolean => this.consume(requestId, payload),
    };
    ui[CAPABILITY] = capability;
    this.detach = () => { if (ui[CAPABILITY] === capability) delete ui[CAPABILITY]; };
  }

  stage(requestId: string, surface: string, payload: Payload): boolean {
    this.prune();
    const family = pathSurfaceInfo(surface)?.family;
    if (!this.context || !family || !this.enabledSurfaces().includes(family)
      || payload.request.surface !== surface) return false;
    this.pending.set(requestId, { surface, fingerprint: fingerprint(payload), expiresAt: this.now() + this.ttlMs });
    return true;
  }

  private consume(requestId: string, payload: Payload): boolean {
    const receipt = this.pending.get(requestId);
    // Even a mismatched attempt consumes the receipt; it cannot be retried.
    this.pending.delete(requestId);
    if (!receipt || receipt.expiresAt <= this.now()) return false;
    try {
      const ctx = this.context;
      const family = pathSurfaceInfo(receipt.surface)?.family;
      return Boolean(ctx && ctx.hasUI && ctx.mode === "rpc" && !ctx.signal?.aborted
        && ctx.sessionManager.getSessionId() === this.owner
        && family && this.enabledSurfaces().includes(family)
        && payload.request.surface === receipt.surface
        && fingerprint(payload) === receipt.fingerprint);
    } catch { return false; }
  }

  revoke(): void { this.pending.clear(); }

  clear(): void {
    this.revoke();
    this.detach?.();
    this.detach = undefined;
    this.context = undefined;
    this.owner = undefined;
  }

  private prune(): void {
    for (const [id, receipt] of this.pending) if (receipt.expiresAt <= this.now()) this.pending.delete(id);
  }
}
