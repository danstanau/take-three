const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDisplayMediaHandler } = require("./screen-capture.cjs");

const request = { securityOrigin: "http://localhost:5173", frame: {}, videoRequested: true };
const isAppUrl = (url) => url === "http://localhost:5173";

test("returns only the source selected by the user", async () => {
  const sources = [{ name: "Screen 1", id: "screen:1" }, { name: "Window", id: "window:1" }];
  const handler = createDisplayMediaHandler({
    isAppUrl,
    desktopCapturer: { getSources: async () => sources },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
  });
  let result;
  await handler(request, (value) => { result = value; });
  assert.deepEqual(result, { video: sources[1] });
});

test("rejects untrusted requests without opening a picker", async () => {
  let opened = false;
  const handler = createDisplayMediaHandler({
    isAppUrl,
    desktopCapturer: { getSources: async () => { opened = true; return []; } },
    dialog: {},
  });
  let result;
  await handler({ ...request, securityOrigin: "https://example.com" }, (value) => { result = value; });
  assert.equal(result, null);
  assert.equal(opened, false);
});

test("rejects a cancelled selection", async () => {
  const handler = createDisplayMediaHandler({
    isAppUrl,
    desktopCapturer: { getSources: async () => [{ name: "Screen 1" }] },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
  });
  let result;
  await handler(request, (value) => { result = value; });
  assert.equal(result, null);
});
