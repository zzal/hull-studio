import { packageName as upstream } from "@hull/blueprint";
import { expect, it } from "vitest";
import { packageName } from "./index.js";

it("is the catalog package and can reach @hull/blueprint through the workspace", () => {
  expect(packageName).toBe("@hull/catalog");
  expect(upstream).toBe("@hull/blueprint");
});
