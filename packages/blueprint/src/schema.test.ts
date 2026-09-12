import { expect, it } from "vitest";
import { blueprintJsonSchema } from "./index.js";

// The committed v0 schema is the file the IDEs read. A model change that
// alters it must show up as a diff here; refresh with `vitest -u`.
it("matches the committed schema/v0/hull.json", async () => {
  await expect(JSON.stringify(blueprintJsonSchema(), null, 2) + "\n").toMatchFileSnapshot(
    "../schema/v0/hull.json",
  );
});
