import assert from "node:assert/strict";

import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const baseUrl = process.argv[2];
if (baseUrl === undefined) {
  throw new Error("Usage: node test/smoke.mjs <http-or-https-url>");
}

const room = `smoke-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const endpoint = new URL("/collaboration", baseUrl);
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
const firstDocument = new Y.Doc();
const secondDocument = new Y.Doc();
const firstProvider = createProvider(firstDocument);
const secondProvider = createProvider(secondDocument);

try {
  await Promise.all([waitForSync(firstProvider), waitForSync(secondProvider)]);
  const firstText = firstDocument.getText("code");
  const secondText = secondDocument.getText("code");
  assert.match(firstText.toString(), /REPORT zcollaborative_demo\./);
  const marker = `\nWRITE / 'Smoke ${room}'.\n`;
  firstText.insert(firstText.length, marker);
  await waitFor(() => secondText.toString().endsWith(marker));
  assert.equal(secondText.toString(), firstText.toString());
  console.log(`Collaboration smoke test passed for ${new URL(baseUrl).origin}/room/${room}`);
} finally {
  firstProvider.destroy();
  secondProvider.destroy();
  firstDocument.destroy();
  secondDocument.destroy();
}

function createProvider(document) {
  return new WebsocketProvider(endpoint.toString(), room, document, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
}

function waitForSync(provider) {
  if (provider.synced) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for initial sync")), 10000);
    provider.once("sync", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for collaborative edit");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
