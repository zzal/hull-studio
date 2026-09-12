import { packageName as upstream } from "@hull/catalog";
import { expect, it } from "vitest";
import { packageName } from "./index.js";

it("is the studio package and can reach @hull/catalog through the workspace", () => {
  expect(packageName).toBe("@hull/studio");
  expect(upstream).toBe("@hull/catalog");
});
