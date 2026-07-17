import assert from "node:assert/strict";
import test from "node:test";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { CollaborationRoom } from "../worker/index.js";

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
    const firstText = firstDocument.getText("code");
    assert.match(firstText.toString(), /REPORT zcollaborative_demo\./);

    let update;
    firstDocument.once("update", (nextUpdate) => {
      update = nextUpdate;
    });
    firstText.insert(firstText.length, "\nWRITE / 'Persistent'.\n");
    await room.webSocketMessage(firstSocket, encodeSyncUpdate(update));
    applySyncMessages(secondSocket, secondDocument);
    assert.equal(secondDocument.getText("code").toString(), firstText.toString());

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
      const restoredCode = restoredDocument.getText("code").toString();
      assert.equal(restoredCode.match(/REPORT zcollaborative_demo\./g)?.length, 1);
      assert.match(restoredCode, /WRITE \/ 'Persistent'\./);
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
