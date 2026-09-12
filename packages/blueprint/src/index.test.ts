import { expect, it } from "vitest";
import { packageName } from "./index.js";

it("is the blueprint package", () => {
  expect(packageName).toBe("@hull/blueprint");
});
