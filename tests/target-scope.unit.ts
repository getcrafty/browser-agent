import { assert } from "chai";
import { describe, it } from "mocha";
import type { Browser } from "../src/browser/types.js";
import {
  TargetScopeCoordinator,
  TargetScopeViolationError,
  WorkflowScopeNotEmptyError,
  WorkflowScopeNotFoundError,
  type ScopedTargetInfo,
  type TargetScopeBackend,
} from "../src/browser/target-scope.js";
import { resolveCurrentTabIndex } from "../src/agents/executor-utils/step-context.js";

function createFixture(initialTargets: ScopedTargetInfo[]) {
  let nextId = 1;
  const targets = new Map(
    initialTargets.map((target) => [target.targetId, target]),
  );
  const backend: TargetScopeBackend = {
    listTargets: async () => [...targets.values()],
    createTarget: async (url) => {
      const targetId = `created-${nextId++}`;
      targets.set(targetId, { targetId, url, title: "" });
      return targetId;
    },
    closeTarget: async (targetId) => {
      targets.delete(targetId);
    },
  };
  const root = { port: 9222, Target: {} } as Browser;
  return {
    coordinator: new TargetScopeCoordinator(root, backend),
    targets,
  };
}

describe("TargetScopeCoordinator", () => {
  it("resolves the scoped browser's active tab before global attached targets", async () => {
    let queriedGlobalTargets = false;
    const browser = {
      currentTargetId: "owned-b",
      Target: {
        getTargets: async () => {
          queriedGlobalTargets = true;
          return {
            targetInfos: [
              { type: "page", targetId: "foreign", attached: true },
            ],
          };
        },
      },
    } as unknown as Browser;

    const index = await resolveCurrentTabIndex({
      b: browser,
      openTabs: [
        { targetId: "owned-a", url: "https://a.test", title: "A" },
        { targetId: "owned-b", url: "https://b.test", title: "B" },
      ],
      currentUrl: "https://a.test",
    });

    assert.equal(index, 1);
    assert.isFalse(queriedGlobalTargets);
  });

  it("keeps sibling scopes disjoint and rejects foreign target access", () => {
    const { coordinator } = createFixture([]);
    coordinator.createScope("left", ["a"]);
    coordinator.createScope("right", ["b"]);

    assert.deepEqual(coordinator.ownedTargetIds("left"), ["a"]);
    assert.deepEqual(coordinator.ownedTargetIds("right"), ["b"]);
    assert.throws(
      () => coordinator.access("left").assertOwned("b"),
      TargetScopeViolationError,
    );
  });

  it("attributes popup chains to the opener scope and quarantines unknown tabs", async () => {
    const { coordinator, targets } = createFixture([
      { targetId: "root", url: "https://example.test", title: "root" },
    ]);
    coordinator.createScope("node", ["root"]);
    targets.set("popup", {
      targetId: "popup",
      url: "https://example.test/popup",
      title: "popup",
      openerId: "root",
    });
    targets.set("nested", {
      targetId: "nested",
      url: "https://example.test/nested",
      title: "nested",
      openerId: "popup",
    });
    targets.set("foreign", {
      targetId: "foreign",
      url: "https://other.test",
      title: "foreign",
    });

    await coordinator.refresh();

    assert.sameMembers(coordinator.ownedTargetIds("node"), [
      "root",
      "popup",
      "nested",
    ]);
    assert.deepEqual(coordinator.quarantinedTargetIds(), ["foreign"]);
  });

  it("hands off sequential targets, clones fan-out URLs, and unions joins", async () => {
    const { coordinator } = createFixture([
      { targetId: "source", url: "https://example.test/a", title: "a" },
    ]);
    coordinator.createScope("preparation", ["source"]);
    coordinator.handoff("preparation", "serial");
    assert.deepEqual(coordinator.ownedTargetIds("preparation"), []);
    assert.deepEqual(coordinator.ownedTargetIds("serial"), ["source"]);

    await coordinator.fanOut("serial", ["left", "right"]);
    assert.lengthOf(coordinator.ownedTargetIds("left"), 1);
    assert.lengthOf(coordinator.ownedTargetIds("right"), 1);
    assert.notEqual(
      coordinator.ownedTargetIds("left")[0],
      coordinator.ownedTargetIds("right")[0],
    );

    coordinator.join(["left", "right"], "synthesis");
    assert.lengthOf(coordinator.ownedTargetIds("synthesis"), 2);
    assert.deepEqual(coordinator.ownedTargetIds("left"), []);
    assert.deepEqual(coordinator.ownedTargetIds("right"), []);
  });

  it("reports typed, security-safe scope state failures", () => {
    const { coordinator } = createFixture([]);
    coordinator.createScope("source", ["owned-a"]);
    coordinator.createScope("occupied", ["owned-b"]);

    assert.deepEqual(coordinator.diagnosticState("source"), {
      exists: true,
      targetCount: 1,
    });
    assert.deepEqual(coordinator.diagnosticState("missing"), {
      exists: false,
      targetCount: 0,
    });
    assert.throws(
      () => coordinator.handoff("missing", "destination"),
      WorkflowScopeNotFoundError,
    );
    const occupied = assert.throws(
      () => coordinator.handoff("source", "occupied"),
      WorkflowScopeNotEmptyError,
    ) as WorkflowScopeNotEmptyError;
    assert.equal(occupied.scopeId, "occupied");
    assert.equal(occupied.targetCount, 1);
  });
});
