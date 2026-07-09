/**
 * Admin runtime map must only reference operation keys that exist on the registry,
 * and must cover every declared admin action id.
 */
import { describe, expect, it } from "vite-plus/test";
import { mikaAdminActionRuntimeDefinitions } from "../src/api/admin-action-runner";
import { mikaOperationDefinitions } from "../src/api/operations";
import { mikaAdminActionDefinitions } from "../src/admin";

describe("admin operationKey registry pin", () => {
  it("maps every admin action operationKey to mikaOperationDefinitions", () => {
    const missing: string[] = [];

    for (const [actionId, definition] of Object.entries(mikaAdminActionRuntimeDefinitions)) {
      if (!Object.hasOwn(mikaOperationDefinitions, definition.operationKey)) {
        missing.push(`${actionId} → ${definition.operationKey}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("covers every MikaAdminActionId with a runtime definition (set equality)", () => {
    const definitionIds = Object.keys(mikaAdminActionDefinitions).sort();
    const runtimeIds = Object.keys(mikaAdminActionRuntimeDefinitions).sort();
    expect(runtimeIds).toEqual(definitionIds);
  });
});
