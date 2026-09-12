import { vocabulary } from "@hull/catalog";
import { expect, it } from "vitest";
import { packageName } from "./index.js";

it("is the compiler package and can reach @hull/catalog through the workspace", () => {
  expect(packageName).toBe("@hull/compiler");
  expect(Object.keys(vocabulary.resolutions)).toContain("rds-postgres");
});
