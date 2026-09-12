import { packageName as upstream } from "@hull/studio";
import { expect, it } from "vitest";
import { packageName } from "./index.js";

it("is the cli package and can reach @hull/studio through the workspace", () => {
  expect(packageName).toBe("@hull/cli");
  expect(upstream).toBe("@hull/studio");
});
