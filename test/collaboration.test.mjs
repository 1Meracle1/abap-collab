import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startServer } from "../server.mjs";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const { WebsocketProvider } = require("y-websocket");
const Y = require("yjs");

test("synchronizes ABAP edits between two clients", async () => {
  const server = await startServer({ port: 0, mode: "test" });
  const firstDocument = new Y.Doc();
  const secondDocument = new Y.Doc();
  const firstProvider = createProvider(server.port, "integration-room", firstDocument);
  const secondProvider = createProvider(server.port, "integration-room", secondDocument);

  try {
    await Promise.all([waitForSync(firstProvider), waitForSync(secondProvider)]);
    const firstText = firstDocument.getText("code");
    const secondText = secondDocument.getText("code");
    assert.match(firstText.toString(), /REPORT zcollaborative_demo\./);

    firstText.insert(firstText.length, "\nWRITE / 'Synced'.\n");
    await waitFor(() => secondText.toString().endsWith("WRITE / 'Synced'.\n"));
    assert.equal(secondText.toString(), firstText.toString());
  } finally {
    firstProvider.destroy();
    secondProvider.destroy();
    firstDocument.destroy();
    secondDocument.destroy();
    await server.close();
  }
});

test("restores a room once after a server restart", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "abap-collab-persistence-"));
  let server;
  let provider;
  let document;
  let mirrorProvider;
  let mirrorDocument;

  try {
    server = await startServer({ port: 0, mode: "test", dataDirectory });
    document = new Y.Doc();
    provider = createProvider(server.port, "persistent-room", document);
    await waitForSync(provider);
    const code = document.getText("code");
    code.insert(code.length, "\nWRITE / 'Persistent'.\n");
    mirrorDocument = new Y.Doc();
    mirrorProvider = createProvider(server.port, "persistent-room", mirrorDocument);
    await waitForSync(mirrorProvider);
    await waitFor(() => mirrorDocument.getText("code").toString().endsWith("WRITE / 'Persistent'.\n"));
    mirrorProvider.destroy();
    mirrorDocument.destroy();
    mirrorProvider = undefined;
    mirrorDocument = undefined;
    provider.destroy();
    document.destroy();
    provider = undefined;
    document = undefined;
    await server.close();
    server = undefined;

    server = await startServer({ port: 0, mode: "test", dataDirectory });
    document = new Y.Doc();
    provider = createProvider(server.port, "persistent-room", document);
    await waitForSync(provider);
    const restoredCode = document.getText("code").toString();
    assert.equal(restoredCode.match(/REPORT zcollaborative_demo\./g)?.length, 1);
    assert.match(restoredCode, /WRITE \/ 'Persistent'\./);
  } finally {
    provider?.destroy();
    document?.destroy();
    mirrorProvider?.destroy();
    mirrorDocument?.destroy();
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

function createProvider(port, room, document) {
  return new WebsocketProvider(`ws://127.0.0.1:${port}/collaboration`, room, document, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
}

function waitForSync(provider) {
  if (provider.synced) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for initial sync")), 3000);
    provider.once("sync", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for collaborative edit");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
