import { expect, it } from "vitest";
import { intent } from "./index.js";

it("is the entry of the api intent", () => {
  expect(intent).toBe("api");
});
