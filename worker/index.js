import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;
const roomPathPattern = /^\/collaboration\/([a-z0-9-]{8,64})$/;
const defaultAbapSource = `REPORT zcollaborative_demo.

TYPES: BEGIN OF ty_message,
         text TYPE string,
       END OF ty_message.

DATA(messages) = VALUE string_table(
  ( \`Welcome to collaborative ABAP.\` )
  ( \`Share the room URL and start typing together.\` )
).

LOOP AT messages INTO DATA(message).
  WRITE: / message.
ENDLOOP.
`;

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    const roomMatch = roomPathPattern.exec(url.pathname);
    if (roomMatch !== null) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const room = environment.COLLABORATION_ROOMS.getByName(roomMatch[1]);
      return room.fetch(request);
    }
    return environment.ASSETS.fetch(request);
  },
};

export class CollaborationRoom {
  constructor(context) {
    this.context = context;
    this.document = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.document);
    // WebSocket close events remove presence, so the library's periodic stale
    // client scan is unnecessary and would prevent Durable Object hibernation.
    clearInterval(this.awareness._checkInterval);
    this.ready = context.blockConcurrencyWhile(async () => {
      const persistedUpdate = await context.storage.get("document");
      if (persistedUpdate !== undefined) {
        Y.applyUpdate(this.document, new Uint8Array(persistedUpdate), "storage");
      }
      const code = this.document.getText("code");
      if (code.length === 0) {
        code.insert(0, defaultAbapSource);
        await this.persistDocument();
      }
      this.document.on("update", (update, origin) => {
        this.broadcast(encodeSyncUpdate(update), origin);
      });
      this.awareness.on("update", ({ added, updated, removed }, origin) => {
        const changedClients = added.concat(updated, removed);
        if (changedClients.length !== 0) {
          this.broadcast(encodeAwarenessUpdate(this.awareness, changedClients), origin);
        }
      });
      for (const socket of context.getWebSockets()) {
        const attachment = readAttachment(socket);
        if (attachment.awarenessUpdate !== undefined) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            new Uint8Array(attachment.awarenessUpdate),
            socket,
          );
        }
      }
    });
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.context.acceptWebSocket(server);
    server.serializeAttachment({ clientIds: [] });
    server.send(encodeSyncStepOne(this.document));
    const awarenessClients = [...this.awareness.getStates().keys()];
    if (awarenessClients.length !== 0) {
      server.send(encodeAwarenessUpdate(this.awareness, awarenessClients));
    }
    server.send(encodeMessage(messageQueryAwareness));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    if (typeof message === "string") {
      socket.close(1003, "Binary messages required");
      return;
    }

    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const messageType = decoding.readVarUint(decoder);
      if (messageType === messageSync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, this.document, socket);
        if (encoding.length(encoder) > 1) {
          socket.send(encoding.toUint8Array(encoder));
        }
        await this.persistDocument();
      } else if (messageType === messageAwareness) {
        const update = decoding.readVarUint8Array(decoder);
        const clientIds = awarenessClientIds(update);
        socket.serializeAttachment({
          awarenessUpdate: update,
          clientIds,
        });
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, socket);
      } else if (messageType === messageQueryAwareness) {
        const clients = [...this.awareness.getStates().keys()];
        if (clients.length !== 0) {
          socket.send(encodeAwarenessUpdate(this.awareness, clients));
        }
      }
    } catch (error) {
      console.error("Invalid collaboration message", error);
      socket.close(1003, "Invalid collaboration message");
    }
  }

  async webSocketClose(socket) {
    await this.ready;
    const { clientIds } = readAttachment(socket);
    awarenessProtocol.removeAwarenessStates(this.awareness, clientIds, socket);
  }

  async webSocketError(socket) {
    await this.ready;
    const { clientIds } = readAttachment(socket);
    awarenessProtocol.removeAwarenessStates(this.awareness, clientIds, socket);
  }

  async persistDocument() {
    await this.context.storage.put("document", Y.encodeStateAsUpdate(this.document));
  }

  broadcast(message, origin) {
    for (const socket of this.context.getWebSockets()) {
      if (socket !== origin && socket.readyState === 1) {
        socket.send(message);
      }
    }
  }
}

function encodeSyncStepOne(document) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, document);
  return encoding.toUint8Array(encoder);
}

function encodeSyncUpdate(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function encodeAwarenessUpdate(awareness, clients) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

function encodeMessage(messageType) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  return encoding.toUint8Array(encoder);
}

function awarenessClientIds(update) {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const clients = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    if (state !== null) {
      clients.push(clientId);
    }
  }
  return clients;
}

function readAttachment(socket) {
  return socket.deserializeAttachment() ?? { clientIds: [] };
}
