import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import sirv from "sirv";
import { WebSocketServer } from "ws";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require("y-leveldb");
const { docs, getYDoc, setupWSConnection } = require("y-websocket/bin/utils");
const Y = require("yjs");
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

export async function startServer({
  port = Number(process.env.PORT ?? 4173),
  mode = process.env.NODE_ENV ?? "development",
  dataDirectory = process.env.DATA_DIRECTORY,
  host = process.env.HOST ?? (mode === "production" ? "0.0.0.0" : "127.0.0.1"),
} = {}) {
  const temporaryDataDirectory = mode === "test" && dataDirectory === undefined;
  const persistenceDirectory = dataDirectory
    ?? (temporaryDataDirectory ? await mkdtemp(join(tmpdir(), "abap-collab-")) : join(root, ".data"));
  const persistence = new LeveldbPersistence(persistenceDirectory);
  const initializedDocuments = new Map();
  const pendingPersistenceWrites = new Set();
  let requestHandler = (_request, response) => {
    response.statusCode = 404;
    response.end("Not found");
  };
  const server = createHttpServer((request, response) => requestHandler(request, response));
  let vite;

  if (mode === "development") {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      root,
      appType: "spa",
      server: { middlewareMode: true, hmr: { server } },
    });
    requestHandler = vite.middlewares;
  } else if (mode === "production") {
    requestHandler = sirv(join(root, "dist"), { single: true });
  }

  const webSocketServer = new WebSocketServer({ noServer: true });
  webSocketServer.on("connection", (socket, request) => {
    const docName = (request.url ?? "").slice(1).split("?")[0];
    setupWSConnection(socket, request, { docName, gc: true });
  });
  server.on("upgrade", async (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!/^\/collaboration\/[a-z0-9-]{8,64}$/.test(pathname)) {
      socket.destroy();
      return;
    }
    const docName = pathname.slice(1);
    try {
      let initialization = initializedDocuments.get(docName);
      if (initialization === undefined) {
        initialization = initializeDocument(docName, persistence, pendingPersistenceWrites);
        initializedDocuments.set(docName, initialization);
      }
      await initialization;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    } catch (error) {
      console.error(`Unable to initialize room ${docName}`, error);
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Collaboration server did not bind a TCP port");
  }

  return {
    port: address.port,
    async close() {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
      await vite?.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      await Promise.all(pendingPersistenceWrites);
      for (const docName of initializedDocuments.keys()) {
        docs.get(docName)?.destroy();
        docs.delete(docName);
      }
      await persistence.destroy();
      if (temporaryDataDirectory) {
        await rm(persistenceDirectory, { recursive: true, force: true });
      }
    },
  };
}

async function initializeDocument(docName, persistence, pendingPersistenceWrites) {
  const document = getYDoc(docName, true);
  const persistedDocument = await persistence.getYDoc(docName);
  Y.applyUpdate(document, Y.encodeStateAsUpdate(persistedDocument));
  persistedDocument.destroy();

  const code = document.getText("code");
  if (code.length === 0) {
    code.insert(0, defaultAbapSource);
  }

  await persistence.storeUpdate(docName, Y.encodeStateAsUpdate(document));
  document.on("update", (update) => {
    const write = persistence.storeUpdate(docName, update);
    pendingPersistenceWrites.add(write);
    void write.then(
      () => pendingPersistenceWrites.delete(write),
      () => pendingPersistenceWrites.delete(write),
    );
  });
  docs.set(docName, document);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runningServer = await startServer();
  console.log(`ABAP Collaborate is running on port ${runningServer.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await runningServer.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
