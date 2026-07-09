/**
 * Admin runtime map must only reference operation keys that exist on the registry.
 */
import { describe, expect, it } from "vite-plus/test";
import { mikaAdminActionRuntimeDefinitions } from "../src/api/admin-action-runner";
import { mikaOperationDefinitions } from "../src/api/operations";

describe("admin operationKey registry pin", () => {
  it("maps every admin action operationKey to mikaOperationDefinitions", () => {
    const missing: string[] = [];

    for (const [actionId, definition] of Object.entries(mikaAdminActionRuntimeDefinitions)) {
      if (!(definition.operationKey in mikaOperationDefinitions)) {
        missing.push(`${actionId} → ${definition.operationKey}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("covers every MikaAdminActionId with a runtime definition", () => {
    const keys = Object.keys(mikaAdminActionRuntimeDefinitions).sort();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(mikaAdminActionRuntimeDefinitions[key as keyof typeof mikaAdminActionRuntimeDefinitions])
        .toBeDefined();
    }
  });
});
