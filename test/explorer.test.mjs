import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";
import * as Y from "yjs";

// Keep the real workspace operations and Yjs document; replace browser-only imports.
const dependencies = {
  "@codingame/monaco-vscode-files-service-override": {
    RegisteredFile: class {
      _onDidChange = { fire() {} };
    },
    RegisteredReadOnlyFile: class {
      constructor(uri, read, size) {
        Object.assign(this, { uri, read, size });
      }
    },
  },
  "monaco-editor": {
    Uri: { file: (path) => ({ path }) },
    editor: {
      getModel() {},
      createModel(content, _language, uri) { return { content, uri }; },
    },
  },
  "yjs": Y,
  "./collaborative-monaco-binding": { CollaborativeMonacoBinding: class { destroy() {} } },
};
const { RoomWorkspace } = loadBrowserModule("../src/room-workspace.ts");
const { RoomSearch } = loadBrowserModule("../src/room-search.ts");

test("imports multiple local files without replacing existing names and synchronizes them", async () => {
  const workspace = createWorkspace();
  const remote = new Y.Doc();
  workspace.folders.set("includes", true);
  workspace.files.set("includes/helper.abap", new Y.Text("original"));
  workspace.document.on("update", (update) => Y.applyUpdate(remote, update));
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(workspace.document));

  await workspace.handleDrop(dropEvent("includes", [
    new File(["FORM helper.\r\nENDFORM.\r\n"], "helper.abap"),
    new File(["REPORT zsecond.\n"], "helper.abap"),
    new File([""], "empty.txt"),
  ]));

  assert.equal(workspace.files.get("includes/helper.abap").toString(), "original");
  assert.equal(remote.getMap("files").get("includes/helper copy.abap").toString(), "FORM helper.\r\nENDFORM.\r\n");
  assert.equal(remote.getMap("files").get("includes/helper copy 2.abap").toString(), "REPORT zsecond.\n");
  assert.equal(workspace.files.get("includes/empty.txt").toString(), "");
  assert.equal(workspace.activePath, "includes/helper copy.abap");
  assert.equal(workspace.expandedFolders.has("includes"), true);
  assert.equal(workspace.selectedPaths.size, 3);
  workspace.document.destroy();
  remote.destroy();
});

test("drops local files on a file's parent folder and on the room root", async () => {
  const workspace = createWorkspace();
  workspace.folders.set("includes", true);
  workspace.files.set("includes/existing.abap", new Y.Text());
  await workspace.handleDrop(dropEvent("includes/existing.abap", [new File(["nested"], "nested.txt")], "file"));
  await workspace.handleDrop(dropEvent("", [new File(["root"], "root.txt")]));
  assert.equal(workspace.files.get("includes/nested.txt").toString(), "nested");
  assert.equal(workspace.files.get("root.txt").toString(), "root");
  workspace.document.destroy();
});

test("imports nested local folders and empty folders in one synchronized update", async () => {
  const workspace = createWorkspace();
  const remote = new Y.Doc();
  workspace.folders.set("destination", true);
  workspace.folders.set("destination/package", true);
  workspace.files.set("destination/package/original.txt", new Y.Text("original"));
  workspace.files.set("report.abap", new Y.Text("open report"));
  workspace.activePath = "report.abap";
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(workspace.document));
  let updates = 0;
  workspace.document.on("update", (update) => {
    updates += 1;
    Y.applyUpdate(remote, update);
  });
  const entry = directoryEntry("package", [
    fileEntry(new File(["top level"], "helper.abap")),
    directoryEntry("nested", [
      fileEntry(new File(["nested content"], "helper.abap")),
      directoryEntry("empty", []),
    ]),
  ]);

  await workspace.handleDrop(entryDropEvent("destination", [entry]));

  assert.equal(updates, 1);
  assert.deepEqual([...remote.getMap("folders").keys()].sort(), [
    "destination",
    "destination/package",
    "destination/package copy",
    "destination/package copy/nested",
    "destination/package copy/nested/empty",
  ]);
  assert.equal(remote.getMap("files").get("destination/package copy/helper.abap").toString(), "top level");
  assert.equal(remote.getMap("files").get("destination/package copy/nested/helper.abap").toString(), "nested content");
  assert.equal(workspace.files.get("destination/package/original.txt").toString(), "original");
  assert.equal(workspace.activePath, "report.abap");
  assert.equal(workspace.focusedPath, "destination/package copy");
  assert.equal(workspace.selectedDirectory, "destination/package copy");
  assert.deepEqual([...workspace.selectedPaths], ["destination/package copy"]);
  assert.equal(workspace.expandedFolders.has("destination/package copy"), true);
  workspace.document.destroy();
  remote.destroy();
});

test("reads every directory batch when a folder contains more than 100 files", async () => {
  const workspace = createWorkspace();
  const children = Array.from({ length: 205 }, (_, index) =>
    fileEntry(new File([`content ${index}`], `file-${index}.txt`))
  );
  await workspace.handleDrop(entryDropEvent("", [directoryEntry("many-files", children)]));
  assert.equal(workspace.files.size, 205);
  assert.equal(workspace.files.get("many-files/file-204.txt").toString(), "content 204");
  workspace.document.destroy();
});

test("imports mixed files and folders with duplicate top-level names", async () => {
  const workspace = createWorkspace();
  workspace.files.set("package", new Y.Text("existing file"));
  await workspace.handleDrop(entryDropEvent("", [
    directoryEntry("package", [fileEntry(new File(["first"], "helper.abap"))]),
    directoryEntry("package", [fileEntry(new File(["second"], "helper.abap"))]),
    directoryEntry("empty", []),
    fileEntry(new File(["root file"], "root.txt")),
  ]));
  assert.equal(workspace.files.get("package").toString(), "existing file");
  assert.equal(workspace.files.get("package copy/helper.abap").toString(), "first");
  assert.equal(workspace.files.get("package copy 2/helper.abap").toString(), "second");
  assert.equal(workspace.files.get("root.txt").toString(), "root file");
  assert.equal(workspace.folders.has("empty"), true);
  assert.equal(workspace.selectedPaths.size, 4);
  workspace.document.destroy();
});

test("does not create a partial tree when a nested file or directory cannot be read", async (t) => {
  const alerts = [];
  globalThis.window = { alert: (message) => alerts.push(message) };
  t.after(() => delete globalThis.window);
  const workspace = createWorkspace();
  const unreadableFile = fileEntry(new File([], "unreadable.txt"));
  unreadableFile.file = (_resolve, reject) => {
    queueMicrotask(() => reject(new Error("File access denied")));
  };
  await workspace.handleDrop(entryDropEvent("", [directoryEntry("package", [
    fileEntry(new File(["valid"], "valid.txt")),
    directoryEntry("nested", [unreadableFile]),
  ])]));
  const unreadable = directoryEntry("unreadable", []);
  unreadable.createReader = () => ({
    readEntries(_resolve, reject) {
      queueMicrotask(() => reject(new Error("Directory access denied")));
    },
  });
  await workspace.handleDrop(entryDropEvent("", [unreadable]));
  assert.equal(workspace.files.size, 0);
  assert.equal(workspace.folders.size, 0);
  assert.match(alerts[0], /Could not read “unreadable.txt”/);
  assert.match(alerts[1], /access denied/);
  workspace.document.destroy();
});

test("captures all dropped entries before asynchronous folder reads and rejects a removed destination", async (t) => {
  const alerts = [];
  globalThis.window = { alert: (message) => alerts.push(message) };
  t.after(() => delete globalThis.window);
  const workspace = createWorkspace();
  workspace.folders.set("destination", true);
  const event = entryDropEvent("destination", [
    directoryEntry("folder", []),
    fileEntry(new File(["text"], "file.txt")),
  ]);
  const importing = workspace.handleDrop(event);
  for (const item of event.dataTransfer.items) {
    item.webkitGetAsEntry = () => { throw new Error("Drag data is no longer available"); };
  }
  workspace.folders.delete("destination");
  await importing;
  assert.equal(workspace.files.size, 0);
  assert.equal(workspace.folders.size, 0);
  assert.match(alerts[0], /no longer exists/);
  workspace.document.destroy();
});

test("moves a selection and its nested folder through the shared relocation path", async () => {
  const workspace = createWorkspace();
  workspace.folders.set("source", true);
  workspace.folders.set("source/nested", true);
  workspace.folders.set("destination", true);
  workspace.files.set("source/nested/helper.abap", new Y.Text("FORM helper. ENDFORM."));
  workspace.files.set("report.abap", new Y.Text("REPORT zmove."));
  workspace.files.set("destination/report.abap", new Y.Text("existing"));
  workspace.selectedPaths = new Set(["source", "source/nested/helper.abap", "report.abap"]);
  workspace.draggedPaths = workspace.topLevelSelection();
  workspace.activePath = "source/nested/helper.abap";
  await workspace.handleDrop(dropEvent("destination"));
  assert.equal(workspace.files.has("report.abap"), false);
  assert.equal(workspace.files.has("source/nested/helper.abap"), false);
  assert.equal(workspace.folders.has("source"), false);
  assert.equal(workspace.folders.has("destination/source/nested"), true);
  assert.equal(workspace.files.get("destination/source/nested/helper.abap").toString(), "FORM helper. ENDFORM.");
  assert.equal(workspace.files.get("destination/report.abap").toString(), "existing");
  assert.equal(workspace.files.get("destination/report copy.abap").toString(), "REPORT zmove.");
  assert.equal(workspace.activePath, "destination/source/nested/helper.abap");
  assert.equal(workspace.expandedFolders.has("destination"), true);
  assert.deepEqual(workspace.draggedPaths, []);
  workspace.document.destroy();
});

test("blocks folder cycles, same-parent drops, stale sources, and foreign explorer drags", async () => {
  const workspace = createWorkspace();
  workspace.folders.set("source", true);
  workspace.folders.set("source/nested", true);
  workspace.files.set("source/helper.abap", new Y.Text("unchanged"));
  workspace.draggedPaths = ["source"];
  await workspace.handleDrop(dropEvent("source/nested"));
  assert.equal(workspace.folders.has("source/nested/source"), false);
  workspace.draggedPaths = ["source/helper.abap"];
  assert.equal(workspace.canDropPaths("source"), false);
  workspace.files.delete("source/helper.abap");
  assert.equal(workspace.canDropPaths(""), false);
  workspace.draggedPaths = [];
  assert.equal(workspace.canDropPaths("source"), false);
  workspace.document.destroy();
});

test("moves a nested file back to the root", async () => {
  const workspace = createWorkspace();
  workspace.folders.set("source", true);
  workspace.files.set("source/helper.abap", new Y.Text("root move"));
  workspace.draggedPaths = ["source/helper.abap"];
  await workspace.handleDrop(dropEvent(""));
  assert.equal(workspace.files.get("helper.abap").toString(), "root move");
  assert.equal(workspace.files.has("source/helper.abap"), false);
  workspace.document.destroy();
});

test("rejects invalid local imports without partially changing the workspace", async (t) => {
  const alerts = [];
  globalThis.window = { alert: (message) => alerts.push(message) };
  t.after(() => delete globalThis.window);
  const workspace = createWorkspace();
  await workspace.importLocalEntries([
    new File(["valid"], "valid.txt"),
    new File(["invalid name"], ".."),
  ], "");
  await workspace.importLocalEntries([new File(["text"], "missing.txt")], "deleted-folder");
  assert.equal(workspace.files.size, 0);
  assert.match(alerts[0], /Invalid file or folder name/);
  assert.match(alerts[1], /no longer exists/);
  workspace.document.destroy();
});

test("imports mixed text and binary folders without changing binary bytes", async () => {
  const workspace = createWorkspace();
  const remote = new Y.Doc();
  workspace.document.on("update", (update) => Y.applyUpdate(remote, update));
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  await workspace.handleDrop(entryDropEvent("", [directoryEntry("package", [
    fileEntry(new File(["REPORT zmixed.\n"], "report.abap")),
    directoryEntry("assets", [
      fileEntry(new File([bytes], "image.png", { type: "image/png" })),
      fileEntry(new File(["\0binary"], "data.bin")),
      fileEntry(new File([new Uint8Array([1, 2, 3])], "control.bin")),
    ]),
  ])]));
  assert.ok(workspace.files.get("package/report.abap") instanceof Y.Text);
  assert.deepEqual(remote.getMap("files").get("package/assets/image.png"), bytes);
  assert.deepEqual(workspace.files.get("package/assets/data.bin"), new TextEncoder().encode("\0binary"));
  assert.deepEqual(workspace.files.get("package/assets/control.bin"), new Uint8Array([1, 2, 3]));
  workspace.document.destroy();
  remote.destroy();
});

test("imports standalone binary files and keeps a UTF-8 text byte-order mark", async () => {
  const workspace = createWorkspace();
  await workspace.handleDrop(dropEvent("", [new File([new Uint8Array([0xff, 0xfe])], "data.bin")]));
  await workspace.importLocalEntries([new File([new Uint8Array([0xef, 0xbb, 0xbf, 65])], "bom.txt")], "");
  assert.deepEqual(workspace.files.get("data.bin"), new Uint8Array([0xff, 0xfe]));
  assert.equal(workspace.files.get("bom.txt").toString(), "\ufeffA");
  workspace.document.destroy();
});

test("preserves bytes when copying, moving, and renaming binary files and their folders", () => {
  const workspace = createWorkspace();
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  workspace.folders.set("assets", true);
  workspace.folders.set("destination", true);
  workspace.files.set("assets/image.png", bytes);
  workspace.transferPaths(["assets"], "destination", true);
  assert.deepEqual(workspace.files.get("destination/assets/image.png"), bytes);
  assert.notEqual(workspace.files.get("destination/assets/image.png"), bytes);
  workspace.transferPaths(["assets/image.png"], "destination", false);
  assert.equal(workspace.files.has("assets/image.png"), false);
  assert.deepEqual(workspace.files.get("destination/image.png"), bytes);
  workspace.relocatePaths([{ source: "destination/image.png", destination: "destination/renamed.bin" }], false);
  assert.deepEqual(workspace.files.get("destination/renamed.bin"), bytes);
  workspace.document.destroy();
});

test("opens binary files as downloads and releases the URL when returning to text", async (t) => {
  const elements = browserElements(t, [
    "editor", "binary-file-view", "cursor-position", "indent-status", "encoding-status",
    "download-binary-file", "binary-file-size",
  ]);
  const workspace = createWorkspace();
  const bytes = new Uint8Array([0xff, 0, 128, 1]);
  workspace.files.set("image.png", bytes);
  workspace.files.set("report.abap", new Y.Text("REPORT ztext."));
  RoomWorkspace.prototype.openFile.call(workspace, "image.png", false);
  assert.equal(workspace.activePath, "image.png");
  assert.equal(workspace.editor.model, null);
  assert.equal(elements.get("editor").hidden, true);
  assert.equal(elements.get("binary-file-view").hidden, false);
  assert.equal(elements.get("encoding-status").hidden, true);
  assert.equal(elements.get("download-binary-file").download, "image.png");
  const downloadUrl = elements.get("download-binary-file").href;
  assert.deepEqual(new Uint8Array(await (await fetch(downloadUrl)).arrayBuffer()), bytes);
  RoomWorkspace.prototype.openFile.call(workspace, "report.abap", false);
  assert.equal(elements.get("editor").hidden, false);
  assert.equal(elements.get("binary-file-view").hidden, true);
  assert.equal(workspace.editor.model.content, "REPORT ztext.");
  assert.equal(workspace.binaryUrl, undefined);
  await assert.rejects(fetch(downloadUrl));
  workspace.document.destroy();
});

test("registers binary bytes with the file system and refreshes replaced content", async () => {
  const workspace = createWorkspace();
  const registrations = [];
  workspace.registeredFiles = new Map();
  workspace.fileSystem = {
    registerFile(file) {
      const registration = { disposed: false, dispose() { this.disposed = true; } };
      registrations.push({ file, registration });
      return registration;
    },
  };
  workspace.files.set("asset.bin", new Uint8Array([0, 255]));
  RoomWorkspace.prototype.syncRegisteredFiles.call(workspace);
  assert.deepEqual(await registrations[0].file.read(), new Uint8Array([0, 255]));
  assert.equal(registrations[0].file.size, 2);
  workspace.files.set("asset.bin", new Uint8Array([128, 0, 1]));
  RoomWorkspace.prototype.syncRegisteredFiles.call(workspace);
  assert.equal(registrations[0].registration.disposed, true);
  assert.deepEqual(await registrations[1].file.read(), new Uint8Array([128, 0, 1]));
  workspace.document.destroy();
});

test("refreshes the active view when another client replaces text with binary content or back", async (t) => {
  const elements = browserElements(t, [
    "editor", "binary-file-view", "cursor-position", "indent-status", "encoding-status",
    "download-binary-file", "binary-file-size",
  ]);
  const workspace = createWorkspace();
  workspace.registeredFiles = new Map();
  workspace.fileSystem = { registerFile: () => ({ dispose() {} }) };
  workspace.syncRegisteredFiles = RoomWorkspace.prototype.syncRegisteredFiles;
  workspace.openFile = RoomWorkspace.prototype.openFile;
  workspace.files.set("aaa.txt", new Y.Text("another file"));
  workspace.files.set("asset.bin", new Uint8Array([0xff]));
  workspace.syncRegisteredFiles();
  workspace.openFile("asset.bin", false);
  const originalUrl = elements.get("download-binary-file").href;
  workspace.files.set("asset.bin", new Y.Text("now text"));
  workspace.handleStructureChange();
  assert.equal(workspace.activePath, "asset.bin");
  assert.equal(workspace.editor.model.content, "now text");
  assert.equal(elements.get("binary-file-view").hidden, true);
  await assert.rejects(fetch(originalUrl));
  workspace.files.set("asset.bin", new Uint8Array([0, 128]));
  workspace.handleStructureChange();
  assert.equal(workspace.activePath, "asset.bin");
  assert.equal(workspace.editor.model, null);
  assert.equal(elements.get("binary-file-view").hidden, false);
  const downloaded = await fetch(elements.get("download-binary-file").href);
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), new Uint8Array([0, 128]));
  workspace.setBinaryView();
  workspace.document.destroy();
});

test("search and replace exclude binary files", (t) => {
  const elements = browserElements(t, ["search-input", "replace-input", "search-error"]);
  elements.get("search-input").value = "255";
  elements.get("replace-input").value = "updated";
  const document = new Y.Doc();
  const files = document.getMap("files");
  files.set("report.abap", new Y.Text("255 text"));
  files.set("image.png", new Uint8Array([255]));
  const search = Object.create(RoomSearch.prototype);
  Object.assign(search, {
    files,
    renderResults() {},
    options: () => ({ caseSensitive: false, wholeWord: false, regularExpression: false, include: "", exclude: "" }),
  });
  search.refresh();
  assert.deepEqual(search.matches.map((match) => match.path), ["report.abap"]);
  search.matches.push({ path: "image.png" });
  search.replaceAll();
  assert.equal(files.get("report.abap").toString(), "updated text");
  assert.deepEqual(files.get("image.png"), new Uint8Array([255]));
  document.destroy();
});

test("keeps a cut selection when pasting into the same folder", () => {
  const workspace = createWorkspace();
  workspace.files.set("report.abap", new Y.Text("report"));
  workspace.clipboard = { mode: "move", paths: ["report.abap"] };
  workspace.pasteClipboard();
  assert.equal(workspace.clipboard.mode, "move");
  assert.equal(workspace.files.get("report.abap").toString(), "report");
  workspace.document.destroy();
});

function createWorkspace() {
  const document = new Y.Doc();
  const workspace = Object.create(RoomWorkspace.prototype);
  Object.assign(workspace, {
    document,
    files: document.getMap("files"),
    folders: document.getMap("folders"),
    selectedPaths: new Set(),
    expandedFolders: new Set(),
    draggedPaths: [],
    activePath: "",
    selectedDirectory: "",
    focusedPath: "",
    selectionAnchor: "",
    editor: { setModel(model) { this.model = model; } },
    syncRegisteredFiles() {},
    renderTree() {},
    closeExplorerMenu() {},
    updateFileLabels() {},
    openFile(path) {
      this.activePath = path;
      this.focusedPath = path;
    },
  });
  return workspace;
}

function dropEvent(path, files, kind = "folder") {
  return {
    target: { closest: () => path === "" ? null : { dataset: { path, kind } } },
    dataTransfer: {
      types: [files === undefined ? "application/x-abap-collab-paths" : "Files"],
      files,
      items: [],
    },
    preventDefault() {},
  };
}

function entryDropEvent(path, entries) {
  const event = dropEvent(path, []);
  event.dataTransfer.items = entries.map((entry) => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
  }));
  return event;
}

function fileEntry(file) {
  return {
    name: file.name,
    isDirectory: false,
    file(resolve) {
      queueMicrotask(() => resolve(file));
    },
  };
}

function directoryEntry(name, children) {
  return {
    name,
    isDirectory: true,
    createReader() {
      let offset = 0;
      return {
        readEntries(resolve) {
          const batch = children.slice(offset, offset + 100);
          offset += 100;
          queueMicrotask(() => resolve(batch));
        },
      };
    },
  };
}

function loadBrowserModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    assert.ok(name in dependencies, `Unexpected browser dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function browserElements(t, ids) {
  class Input {
    hidden = false;
    removeAttribute(name) { delete this[name]; }
  }
  const elements = new Map(ids.map((id) => [id, new Input()]));
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };
  globalThis.HTMLInputElement = Input;
  t.after(() => {
    delete globalThis.document;
    delete globalThis.HTMLInputElement;
  });
  return elements;
}
