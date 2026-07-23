import CDP from "chrome-remote-interface";
import type { Browser, BrowserTargetScope } from "./types.js";
import { connectToTarget } from "./browser.js";
import { withLocalCdpHost } from "./local-cdp.js";

export interface ScopedTargetInfo {
  targetId: string;
  url: string;
  title: string;
  openerId?: string;
}

export interface TargetScopeBackend {
  listTargets(): Promise<ScopedTargetInfo[]>;
  createTarget(url: string): Promise<string>;
  closeTarget(targetId: string): Promise<void>;
}

export interface WorkflowScopeDiagnosticState {
  exists: boolean;
  targetCount: number;
}

export class TargetScopeViolationError extends Error {
  readonly scopeId: string;
  readonly targetId: string;

  constructor(scopeId: string, targetId: string) {
    super(`Workflow scope ${scopeId} does not own browser target ${targetId}.`);
    this.name = "TargetScopeViolationError";
    this.scopeId = scopeId;
    this.targetId = targetId;
  }
}

export class WorkflowScopeNotFoundError extends Error {
  readonly scopeId: string;

  constructor(scopeId: string) {
    super(`Unknown workflow browser scope: ${scopeId}`);
    this.name = "WorkflowScopeNotFoundError";
    this.scopeId = scopeId;
  }
}

export class WorkflowScopeNotEmptyError extends Error {
  readonly scopeId: string;
  readonly targetCount: number;

  constructor(scopeId: string, targetCount: number) {
    super(`Workflow browser scope ${scopeId} is not empty.`);
    this.name = "WorkflowScopeNotEmptyError";
    this.scopeId = scopeId;
    this.targetCount = targetCount;
  }
}

function assertScopeId(scopeId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scopeId)) {
    throw new Error(`Invalid workflow browser scope id: ${scopeId}`);
  }
}

function createDefaultBackend(browser: Browser): TargetScopeBackend {
  return {
    listTargets: async () => {
      const targets = await CDP.List(withLocalCdpHost({ port: browser.port }));
      return targets
        .filter((target: any) => target.type === "page")
        .map((target: any) => ({
          targetId: target.id,
          url: target.url || "about:blank",
          title: target.title || "",
          ...(typeof target.openerId === "string"
            ? { openerId: target.openerId }
            : {}),
        }));
    },
    createTarget: async (url) => {
      const { targetId } = await browser.Target.createTarget({
        url,
        background: true,
      });
      return targetId;
    },
    closeTarget: async (targetId) => {
      await browser.Target.closeTarget({ targetId });
    },
  };
}

/**
 * Owns target-to-node attribution for one shared Chrome/CDP instance.
 * Unattributable page targets are quarantined and never become visible to a
 * scoped browser unless explicitly claimed.
 */
export class TargetScopeCoordinator {
  private readonly scopes = new Map<string, Set<string>>();
  private readonly owners = new Map<string, string>();
  private readonly quarantined = new Set<string>();
  private readonly backend: TargetScopeBackend;

  constructor(
    private readonly rootBrowser: Browser,
    backend?: TargetScopeBackend,
  ) {
    this.backend = backend ?? createDefaultBackend(rootBrowser);
  }

  createScope(
    scopeId: string,
    initialTargetIds: Iterable<string> = [],
  ): BrowserTargetScope {
    assertScopeId(scopeId);
    if (this.scopes.has(scopeId)) {
      throw new Error(`Workflow browser scope already exists: ${scopeId}`);
    }
    this.scopes.set(scopeId, new Set());
    for (const targetId of initialTargetIds) {
      this.claim(scopeId, targetId);
    }
    return this.access(scopeId);
  }

  async createPreparationScope(scopeId: string): Promise<BrowserTargetScope> {
    const targets = await this.backend.listTargets();
    const scope = this.createScope(
      scopeId,
      targets.map((target) => target.targetId),
    );
    await this.refresh();
    return scope;
  }

  access(scopeId: string): BrowserTargetScope {
    this.getScope(scopeId);
    return {
      scopeId,
      refresh: async () => await this.refresh(),
      listTargetIds: () => new Set(this.getScope(scopeId)),
      assertOwned: (targetId) => this.assertOwned(scopeId, targetId),
      claimCreatedTarget: async (targetId) => {
        this.claim(scopeId, targetId);
        await this.refresh();
      },
      releaseTarget: (targetId) => this.releaseTarget(scopeId, targetId),
    };
  }

  claim(scopeId: string, targetId: string): void {
    const scope = this.getScope(scopeId);
    const owner = this.owners.get(targetId);
    if (owner && owner !== scopeId) {
      throw new TargetScopeViolationError(scopeId, targetId);
    }
    scope.add(targetId);
    this.owners.set(targetId, scopeId);
    this.quarantined.delete(targetId);
  }

  assertOwned(scopeId: string, targetId: string): void {
    if (this.owners.get(targetId) !== scopeId) {
      throw new TargetScopeViolationError(scopeId, targetId);
    }
  }

  private releaseTarget(scopeId: string, targetId: string): void {
    this.assertOwned(scopeId, targetId);
    this.getScope(scopeId).delete(targetId);
    this.owners.delete(targetId);
    this.quarantined.add(targetId);
  }

  async refresh(): Promise<void> {
    const targets = await this.backend.listTargets();
    const liveIds = new Set(targets.map((target) => target.targetId));
    for (const [targetId, owner] of this.owners) {
      if (!liveIds.has(targetId)) {
        this.owners.delete(targetId);
        this.scopes.get(owner)?.delete(targetId);
      }
    }
    for (const targetId of this.quarantined) {
      if (!liveIds.has(targetId)) this.quarantined.delete(targetId);
    }

    // Repeat to attribute popup chains whose parent appears in the same poll.
    let changed = true;
    while (changed) {
      changed = false;
      for (const target of targets) {
        if (this.owners.has(target.targetId)) {
          continue;
        }
        const owner = target.openerId
          ? this.owners.get(target.openerId)
          : undefined;
        if (owner) {
          this.claim(owner, target.targetId);
          changed = true;
        }
      }
    }
    for (const target of targets) {
      if (!this.owners.has(target.targetId)) {
        this.quarantined.add(target.targetId);
      }
    }
  }

  handoff(fromScopeId: string, toScopeId: string): void {
    const from = this.getScope(fromScopeId);
    const to = this.ensureEmptyScope(toScopeId);
    for (const targetId of from) {
      to.add(targetId);
      this.owners.set(targetId, toScopeId);
    }
    from.clear();
  }

  async fanOut(fromScopeId: string, toScopeIds: string[]): Promise<void> {
    if (toScopeIds.length === 0) return;
    await this.refresh();
    const sourceIds = [...this.getScope(fromScopeId)];
    const targetById = new Map(
      (await this.backend.listTargets()).map((target) => [
        target.targetId,
        target,
      ]),
    );
    const urls =
      sourceIds.length > 0
        ? sourceIds.map(
            (targetId) => targetById.get(targetId)?.url || "about:blank",
          )
        : ["about:blank"];
    for (const scopeId of toScopeIds) {
      this.ensureEmptyScope(scopeId);
      for (const url of urls) {
        const targetId = await this.backend.createTarget(url);
        this.claim(scopeId, targetId);
      }
    }
  }

  join(fromScopeIds: string[], toScopeId: string): void {
    const to = this.ensureEmptyScope(toScopeId);
    for (const fromScopeId of fromScopeIds) {
      const from = this.getScope(fromScopeId);
      for (const targetId of from) {
        to.add(targetId);
        this.owners.set(targetId, toScopeId);
      }
      from.clear();
    }
  }

  async releaseScope(
    scopeId: string,
    options: { closeTargets?: boolean } = {},
  ): Promise<void> {
    const scope = this.getScope(scopeId);
    const targets = [...scope];
    for (const targetId of targets) {
      scope.delete(targetId);
      this.owners.delete(targetId);
      if (options.closeTargets) {
        await this.backend.closeTarget(targetId).catch(() => undefined);
      } else {
        this.quarantined.add(targetId);
      }
    }
    this.scopes.delete(scopeId);
  }

  ownedTargetIds(scopeId: string): string[] {
    return [...this.getScope(scopeId)];
  }

  /** Returns only security-safe scope metadata for workflow diagnostics. */
  diagnosticState(scopeId: string): WorkflowScopeDiagnosticState {
    const scope = this.scopes.get(scopeId);
    return { exists: !!scope, targetCount: scope?.size ?? 0 };
  }

  quarantinedTargetIds(): string[] {
    return [...this.quarantined];
  }

  async createScopedBrowser(
    scopeId: string,
    preferredTargetId?: string,
  ): Promise<Browser> {
    await this.refresh();
    const scope = this.getScope(scopeId);
    const targetId = preferredTargetId ?? scope.values().next().value;
    if (!targetId) {
      throw new Error(`Workflow browser scope ${scopeId} has no targets.`);
    }
    this.assertOwned(scopeId, targetId);
    return await connectToTarget({
      port: this.rootBrowser.port,
      targetId,
      downloadDir: this.rootBrowser.downloadDir,
      userDataDir: this.rootBrowser.userDataDir,
      targetScope: this.access(scopeId),
      onActivateTarget: async (nextTargetId) =>
        this.assertOwned(scopeId, nextTargetId),
    });
  }

  private getScope(scopeId: string): Set<string> {
    const scope = this.scopes.get(scopeId);
    if (!scope) throw new WorkflowScopeNotFoundError(scopeId);
    return scope;
  }

  private ensureEmptyScope(scopeId: string): Set<string> {
    if (!this.scopes.has(scopeId)) this.createScope(scopeId);
    const scope = this.getScope(scopeId);
    if (scope.size > 0) {
      throw new WorkflowScopeNotEmptyError(scopeId, scope.size);
    }
    return scope;
  }
}
