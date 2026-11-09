import assert from "node:assert/strict";
import test from "node:test";

import { createWebFetchTool } from "../src/tools/web.js";

const tool = createWebFetchTool();

test("rejects non-HTTPS and nonstandard-port URLs before network access", async () => {
  for (const url of ["http://example.com", "https://example.com:8443"]) {
    await assert.rejects(tool.execute({ url }, {}), { code: "UNSAFE_URL" });
  }
});

test("rejects credentials and private or local URL targets", async () => {
  for (const url of [
    "https://user:password@example.com",
    "https://localhost",
    "https://service.localhost/path",
    "https://127.0.0.1",
    "https://[::1]/",
  ]) {
    await assert.rejects(tool.execute({ url }, {}), { code: "UNSAFE_URL" });
  }
});
