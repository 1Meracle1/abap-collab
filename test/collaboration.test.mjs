import assert from "node:assert/strict";
import test from "node:test";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { CollaborationRoom } from "../worker/index.js";
import { createRelativeSelection } from "../src/selection-affinity.ts";

test("synchronizes and restores ABAP edits through a durable room", async () => {
  const storage = new MemoryStorage();
  const context = new FakeContext(storage);
  const room = new CollaborationRoom(context);
  await room.ready;
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  context.sockets.push(firstSocket, secondSocket);
  const firstDocument = new Y.Doc();
  const secondDocument = new Y.Doc();

  try {
    await synchronize(room, firstSocket, firstDocument);
    await synchronize(room, secondSocket, secondDocument);
    const firstFiles = firstDocument.getMap("files");
    const secondFiles = secondDocument.getMap("files");
    const firstText = firstFiles.get("report.abap");
    assert.ok(firstText instanceof Y.Text);
    assert.match(firstText.toString(), /REPORT zcollaborative_demo\./);

    let update;
    firstDocument.once("update", (nextUpdate) => {
      update = nextUpdate;
    });
    firstText.insert(firstText.length, "\nWRITE / 'Persistent'.\n");
    await room.webSocketMessage(firstSocket, encodeSyncUpdate(update));
    applySyncMessages(secondSocket, secondDocument);
    const secondText = secondFiles.get("report.abap");
    assert.ok(secondText instanceof Y.Text);
    assert.equal(secondText.toString(), firstText.toString());

    let structureUpdate;
    firstDocument.once("update", (nextUpdate) => {
      structureUpdate = nextUpdate;
    });
    firstDocument.transact(() => {
      firstDocument.getMap("folders").set("includes", true);
      firstFiles.set("includes/helper.abap", new Y.Text("FORM helper.\nENDFORM.\n"));
    });
    await room.webSocketMessage(firstSocket, encodeSyncUpdate(structureUpdate));
    applySyncMessages(secondSocket, secondDocument);
    assert.equal(secondDocument.getMap("folders").get("includes"), true);
    assert.equal(secondFiles.get("includes/helper.abap")?.toString(), "FORM helper.\nENDFORM.\n");

    room.awareness.destroy();
    room.document.destroy();
    const restoredContext = new FakeContext(storage);
    const restoredRoom = new CollaborationRoom(restoredContext);
    await restoredRoom.ready;
    const restoredSocket = new FakeSocket();
    const restoredDocument = new Y.Doc();
    restoredContext.sockets.push(restoredSocket);
    try {
      await synchronize(restoredRoom, restoredSocket, restoredDocument);
      const restoredFiles = restoredDocument.getMap("files");
      const restoredCode = restoredFiles.get("report.abap")?.toString();
      assert.equal(restoredCode.match(/REPORT zcollaborative_demo\./g)?.length, 1);
      assert.match(restoredCode, /WRITE \/ 'Persistent'\./);
      assert.equal(restoredDocument.getMap("folders").get("includes"), true);
      assert.equal(restoredFiles.get("includes/helper.abap")?.toString(), "FORM helper.\nENDFORM.\n");
    } finally {
      restoredRoom.awareness.destroy();
      restoredRoom.document.destroy();
      restoredDocument.destroy();
    }
  } finally {
    room.awareness.destroy();
    room.document.destroy();
    firstDocument.destroy();
    secondDocument.destroy();
  }
});

test("migrates the single-file room document into the shared workspace", async () => {
  const legacyDocument = new Y.Doc();
  legacyDocument.getText("code").insert(0, "REPORT zlegacy_room.\n");
  const storage = new MemoryStorage();
  await storage.put("document", Y.encodeStateAsUpdate(legacyDocument));
  legacyDocument.destroy();

  const context = new FakeContext(storage);
  const room = new CollaborationRoom(context);
  await room.ready;
  try {
    const report = room.document.getMap("files").get("report.abap");
    assert.ok(report instanceof Y.Text);
    assert.equal(report.toString(), "REPORT zlegacy_room.\n");
  } finally {
    room.awareness.destroy();
    room.document.destroy();
  }
});

test("keeps a full-file selection stable when another user appends text", () => {
  const firstDocument = new Y.Doc();
  const secondDocument = new Y.Doc();
  const firstText = firstDocument.getText("code");
  const secondText = secondDocument.getText("code");
  firstText.insert(0, "REPORT zselection.\n");
  Y.applyUpdate(secondDocument, Y.encodeStateAsUpdate(firstDocument));
  const originalLength = secondText.length;
  const selection = createRelativeSelection(secondText, 0, originalLength);
  const reverseSelection = createRelativeSelection(secondText, originalLength, 0);

  let update;
  firstDocument.once("update", (nextUpdate) => {
    update = nextUpdate;
  });
  firstText.insert(firstText.length, "WRITE / 'Appended'.\n");
  Y.applyUpdate(secondDocument, update);

  const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, secondDocument);
  const head = Y.createAbsolutePositionFromRelativePosition(selection.head, secondDocument);
  const reverseAnchor = Y.createAbsolutePositionFromRelativePosition(
    reverseSelection.anchor,
    secondDocument,
  );
  const reverseHead = Y.createAbsolutePositionFromRelativePosition(
    reverseSelection.head,
    secondDocument,
  );
  assert.equal(anchor?.index, 0);
  assert.equal(head?.index, originalLength);
  assert.equal(reverseAnchor?.index, originalLength);
  assert.equal(reverseHead?.index, 0);
  firstDocument.destroy();
  secondDocument.destroy();
});

test("keeps a collapsed end-of-file cursor attached to the end", () => {
  const document = new Y.Doc();
  const text = document.getText("code");
  text.insert(0, "REPORT zcursor.\n");
  const selection = createRelativeSelection(text, text.length, text.length);

  text.insert(text.length, "WRITE / 'Appended'.\n");

  const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, document);
  const head = Y.createAbsolutePositionFromRelativePosition(selection.head, document);
  assert.equal(anchor?.index, text.length);
  assert.equal(head?.index, text.length);
  document.destroy();
});

async function synchronize(room, socket, document) {
  await room.webSocketMessage(socket, encodeSyncStepOne(document));
  applySyncMessages(socket, document);
}

function applySyncMessages(socket, document) {
  for (const message of socket.sent.splice(0)) {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== 0) {
      continue;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, document, null);
    assert.equal(encoding.length(encoder), 1);
  }
}

function encodeSyncStepOne(document) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, document);
  return encoding.toUint8Array(encoder);
}

function encodeSyncUpdate(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

class MemoryStorage {
  values = new Map();

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : new Uint8Array(value);
  }

  async put(key, value) {
    this.values.set(key, new Uint8Array(value));
  }
}

class FakeContext {
  sockets = [];

  constructor(storage) {
    this.storage = storage;
  }

  blockConcurrencyWhile(callback) {
    return callback();
  }

  getWebSockets() {
    return this.sockets;
  }
}

class FakeSocket {
  readyState = 1;
  sent = [];
  attachment;

  send(message) {
    this.sent.push(new Uint8Array(message));
  }

  close() {
    this.readyState = 3;
  }

  serializeAttachment(attachment) {
    this.attachment = structuredClone(attachment);
  }

  deserializeAttachment() {
    return this.attachment === undefined ? undefined : structuredClone(this.attachment);
  }
}
