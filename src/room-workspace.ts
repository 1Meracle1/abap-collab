import {
  RegisteredFile,
  RegisteredFileSystemProvider,
} from "@codingame/monaco-vscode-files-service-override";
import * as monaco from "monaco-editor";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { CollaborativeMonacoBinding } from "./collaborative-monaco-binding";

const workspaceRoot = "/workspace";

interface TreeEntry {
  kind: "file" | "folder";
  name: string;
  path: string;
  depth: number;
}

interface PendingCreation {
  directory: string;
  kind: "file" | "folder";
  name: string;
}

interface ExplorerClipboard {
  mode: "copy" | "move";
  paths: string[];
}

interface FileLanguage {
  id: string;
  label: string;
  iconClass: string;
  iconText: string;
}

type ExplorerCommand = "new-file" | "new-folder" | "rename" | "cut" | "copy" | "paste" | "delete";

export function ensureWorkspaceDocument(document: Y.Doc): void {
  const files = document.getMap<Y.Text>("files");
  if (files.size !== 0) {
    return;
  }
  files.set("report.abap", new Y.Text(document.getText("code").toString()));
}

export class RoomWorkspace {
  private readonly files: Y.Map<Y.Text>;
  private readonly folders: Y.Map<boolean>;
  private readonly expandedFolders = new Set<string>();
  private readonly registeredFiles = new Map<string, { dispose(): void }>();
  private readonly selectedPaths = new Set<string>();
  private activePath = "";
  private selectedDirectory = "";
  private focusedPath = "";
  private selectionAnchor = "";
  private pendingCreation: PendingCreation | undefined;
  private pendingRename: string | undefined;
  private clipboard: ExplorerClipboard | undefined;
  private binding: CollaborativeMonacoBinding | undefined;
  private mutatingStructure = false;

  constructor(
    private readonly document: Y.Doc,
    private readonly awareness: Awareness,
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly fileSystem: RegisteredFileSystemProvider,
  ) {
    this.files = document.getMap<Y.Text>("files");
    this.folders = document.getMap<boolean>("folders");
    this.files.observe(() => this.handleStructureChange());
    this.folders.observe(() => this.handleStructureChange());
    requiredButton("new-file").addEventListener("click", () => this.beginCreate("file"));
    requiredButton("new-folder").addEventListener("click", () => this.beginCreate("folder"));
    requiredButton("explorer-menu-button").addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleExplorerMenu();
    });

    const tree = requiredElement("explorer-tree");
    tree.addEventListener("keydown", (event) => this.handleTreeKeyDown(event));
    tree.addEventListener("contextmenu", (event) => this.handleContextMenu(event));
    requiredElement("explorer-menu").addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-command]");
      if (button === null || button.disabled) {
        return;
      }
      this.closeExplorerMenu();
      this.runCommand(button.dataset.command as ExplorerCommand);
    });
    globalThis.document.addEventListener("click", () => this.closeExplorerMenu());

    for (const path of this.folders.keys()) {
      this.expandedFolders.add(path);
    }
    this.syncRegisteredFiles();

    const initialPath = [...this.files.keys()].sort(comparePaths)[0];
    if (initialPath === undefined) {
      this.clearEditor();
      this.renderTree();
      return;
    }
    this.selectedPaths.add(initialPath);
    this.focusedPath = initialPath;
    this.selectionAnchor = initialPath;
    this.openFile(initialPath);
  }

  destroy(): void {
    this.binding?.destroy();
    for (const model of monaco.editor.getModels()) {
      if (model.uri.path.startsWith(`${workspaceRoot}/`)) {
        model.dispose();
      }
    }
    for (const registration of this.registeredFiles.values()) {
      registration.dispose();
    }
  }

  openSearchResult(
    path: string,
    lineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ): void {
    if (!this.files.has(path)) {
      return;
    }
    this.openFile(path, false);
    const selection = new monaco.Selection(lineNumber, startColumn, endLineNumber, endColumn);
    this.editor.setSelection(selection);
    this.editor.revealRangeInCenterIfOutsideViewport(selection);
    this.editor.focus();
  }

  private handleStructureChange(): void {
    if (this.mutatingStructure) {
      return;
    }
    if (this.activePath !== "" && !this.files.has(this.activePath)) {
      this.binding?.destroy();
      this.binding = undefined;
      this.editor.setModel(null);
      this.activePath = "";
    }
    this.syncRegisteredFiles();
    this.pruneExplorerState();
    if (this.activePath === "") {
      const nextPath = [...this.files.keys()].sort(comparePaths)[0];
      if (nextPath === undefined) {
        this.clearEditor();
      } else {
        this.openFile(nextPath, false);
        return;
      }
    }
    this.renderTree();
  }

  private syncRegisteredFiles(): void {
    for (const [path, registration] of this.registeredFiles) {
      if (this.files.has(path)) {
        continue;
      }
      registration.dispose();
      this.registeredFiles.delete(path);
      monaco.editor.getModel(fileUri(path))?.dispose();
    }
    for (const [path, text] of this.files) {
      if (this.registeredFiles.has(path)) {
        continue;
      }
      const file = new CollaborativeFile(fileUri(path), text);
      this.registeredFiles.set(path, this.fileSystem.registerFile(file));
    }
  }

  private pruneExplorerState(): void {
    for (const path of this.selectedPaths) {
      if (!this.pathExists(path)) {
        this.selectedPaths.delete(path);
      }
    }
    for (const path of this.expandedFolders) {
      if (!this.folders.has(path)) {
        this.expandedFolders.delete(path);
      }
    }
    if (!this.pathExists(this.focusedPath)) {
      this.focusedPath = "";
    }
    if (!this.pathExists(this.selectionAnchor)) {
      this.selectionAnchor = "";
    }
    if (!this.folders.has(this.selectedDirectory)) {
      this.selectedDirectory = "";
    }
  }

  private renderTree(focusPath?: string): void {
    const tree = requiredElement("explorer-tree");
    tree.replaceChildren();
    for (const entry of this.visibleEntries()) {
      tree.append(this.renderEntry(entry));
    }
    if (this.pendingCreation !== undefined) {
      this.renderCreateRow(tree, this.pendingCreation);
    }
    if (focusPath !== undefined) {
      tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    }
    this.updateMenuState();
  }

  private renderEntry(entry: TreeEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "file-row";
    row.style.paddingLeft = `${8 + entry.depth * 14}px`;
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(this.selectedPaths.has(entry.path)));
    row.tabIndex = this.focusedPath === entry.path ? 0 : -1;
    row.classList.toggle("selected", this.selectedPaths.has(entry.path));
    row.classList.toggle("active", this.activePath === entry.path);
    row.classList.toggle("cut", this.clipboard?.mode === "move" && this.clipboard.paths.includes(entry.path));

    if (entry.kind === "folder") {
      const expanded = this.expandedFolders.has(entry.path);
      row.setAttribute("aria-expanded", String(expanded));
      row.append(
        icon("folder-chevron codicon", expanded ? "\ueab4" : "\ueab6"),
        icon("folder-icon codicon", "\uea83"),
        label(entry.name),
      );
    } else {
      row.append(icon("folder-chevron", ""), fileIcon(entry.path), label(entry.name));
    }

    if (this.pendingRename === entry.path) {
      this.renderRenameInput(row, entry);
    } else {
      row.addEventListener("click", (event) => this.handleEntryClick(entry, event));
      row.addEventListener("dblclick", () => {
        if (entry.kind === "folder") {
          this.toggleFolder(entry.path);
        }
      });
    }
    return row;
  }

  private visibleEntries(): TreeEntry[] {
    const entries: TreeEntry[] = [];
    const appendDirectory = (directory: string, depth: number): void => {
      for (const entry of this.directoryEntries(directory)) {
        const visibleEntry = { ...entry, depth };
        entries.push(visibleEntry);
        if (entry.kind === "folder" && this.expandedFolders.has(entry.path)) {
          appendDirectory(entry.path, depth + 1);
        }
      }
    };
    appendDirectory("", 0);
    return entries;
  }

  private directoryEntries(directory: string): Omit<TreeEntry, "depth">[] {
    const prefix = directory === "" ? "" : `${directory}/`;
    const entries: Omit<TreeEntry, "depth">[] = [];
    for (const path of this.folders.keys()) {
      if (parentPath(path) === directory) {
        entries.push({ kind: "folder", name: path.slice(prefix.length), path });
      }
    }
    for (const path of this.files.keys()) {
      if (parentPath(path) === directory) {
        entries.push({ kind: "file", name: path.slice(prefix.length), path });
      }
    }
    return entries.sort((left, right) =>
      left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1
    );
  }

  private handleEntryClick(entry: TreeEntry, event: MouseEvent): void {
    this.selectPath(entry.path, event.shiftKey, event.ctrlKey || event.metaKey);
    if (entry.kind === "file" && !event.shiftKey && !(event.ctrlKey || event.metaKey)) {
      this.openFile(entry.path, false);
      requiredElement("explorer-tree")
        .querySelector<HTMLElement>(`[data-path="${CSS.escape(entry.path)}"]`)
        ?.focus();
    } else {
      this.renderTree(entry.path);
    }
  }

  private selectPath(path: string, extend: boolean, toggle: boolean): void {
    const visiblePaths = this.visibleEntries().map((entry) => entry.path);
    if (extend && this.selectionAnchor !== "" && visiblePaths.includes(this.selectionAnchor)) {
      const anchorIndex = visiblePaths.indexOf(this.selectionAnchor);
      const targetIndex = visiblePaths.indexOf(path);
      this.selectedPaths.clear();
      for (const selectedPath of visiblePaths.slice(
        Math.min(anchorIndex, targetIndex),
        Math.max(anchorIndex, targetIndex) + 1,
      )) {
        this.selectedPaths.add(selectedPath);
      }
    } else if (toggle) {
      if (this.selectedPaths.has(path)) {
        this.selectedPaths.delete(path);
      } else {
        this.selectedPaths.add(path);
      }
      this.selectionAnchor = path;
    } else {
      this.selectedPaths.clear();
      this.selectedPaths.add(path);
      this.selectionAnchor = path;
    }
    this.focusedPath = path;
    this.selectedDirectory = this.folders.has(path) ? path : parentPath(path);
  }

  private openFile(path: string, focusEditor = true): void {
    const text = this.files.get(path);
    if (!(text instanceof Y.Text)) {
      return;
    }
    if (path !== this.activePath) {
      this.binding?.destroy();
      this.activePath = path;
      const uri = fileUri(path);
      const language = languageForPath(path);
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(
        text.toString(),
        language.id,
        uri,
      );
      this.editor.setModel(model);
      this.binding = new CollaborativeMonacoBinding(text, model, this.editor, this.awareness);
      this.updateFileLabels(path);
    }
    if (!this.selectedPaths.has(path)) {
      this.selectedPaths.clear();
      this.selectedPaths.add(path);
      this.selectionAnchor = path;
    }
    this.focusedPath = path;
    this.selectedDirectory = parentPath(path);
    this.renderTree();
    if (focusEditor) {
      this.editor.focus();
    }
  }

  private updateFileLabels(path: string): void {
    const name = baseName(path);
    requiredElement("titlebar-label").textContent = `${name} — ABAP Collaborate`;
    const tabFileName = requiredElement("tab-file-name");
    tabFileName.textContent = name;
    tabFileName.title = name;
    requiredElement("tab-file-icon").replaceWith(fileIcon(path, "tab-file-icon"));
    requiredElement("language-status").textContent = languageForPath(path).label;

    const breadcrumbs = requiredElement("breadcrumbs");
    breadcrumbs.replaceChildren();
    for (const part of ["ABAP ROOM", ...path.split("/")]) {
      if (breadcrumbs.childElementCount > 0) {
        const separator = document.createElement("span");
        separator.textContent = "›";
        breadcrumbs.append(separator);
      }
      const segment = document.createElement("span");
      segment.textContent = part;
      breadcrumbs.append(segment);
    }
  }

  private clearEditor(): void {
    this.binding?.destroy();
    this.binding = undefined;
    this.editor.setModel(null);
    this.activePath = "";
    requiredElement("titlebar-label").textContent = "ABAP Collaborate";
    const tabFileName = requiredElement("tab-file-name");
    tabFileName.textContent = "No file open";
    tabFileName.title = "No file open";
    requiredElement("tab-file-icon").replaceWith(fileIcon("", "tab-file-icon"));
    requiredElement("language-status").textContent = "Plain Text";
    requiredElement("breadcrumbs").replaceChildren(label("ABAP ROOM"));
  }

  private beginCreate(kind: "file" | "folder"): void {
    this.closeExplorerMenu();
    if (this.selectedDirectory !== "") {
      this.expandedFolders.add(this.selectedDirectory);
    }
    this.pendingRename = undefined;
    this.pendingCreation = { directory: this.selectedDirectory, kind, name: "" };
    this.renderTree();
  }

  private renderCreateRow(tree: HTMLElement, pending: PendingCreation): void {
    const row = document.createElement("div");
    row.className = "create-row";
    row.style.paddingLeft = `${8 + pathDepth(pending.directory) * 14}px`;
    row.append(
      icon("folder-chevron", ""),
      icon(
        pending.kind === "file" ? "file-type-icon generic-file-icon codicon" : "folder-icon codicon",
        pending.kind === "file" ? "\uea7b" : "\uea83",
      ),
    );
    const input = document.createElement("input");
    input.className = "create-input";
    input.setAttribute("aria-label", pending.kind === "file" ? "New file name" : "New folder name");
    input.placeholder = pending.kind === "file" ? "name.abap" : "folder name";
    input.value = pending.name;
    row.append(input);
    const entries = [...tree.querySelectorAll<HTMLElement>("[data-path]")];
    const selectedIndex = entries.findIndex((entry) => entry.dataset.path === pending.directory);
    const followingRootEntry = selectedIndex === -1
      ? null
      : entries.slice(selectedIndex + 1).find((entry) =>
          !entry.dataset.path?.startsWith(`${pending.directory}/`)
        ) ?? null;
    tree.insertBefore(row, followingRootEntry);
    input.focus();

    const finish = (): void => {
      const name = input.value.trim();
      const path = joinPath(pending.directory, name);
      if (!validName(name) || this.pathExists(path)) {
        markInvalidName(input, name, this.pathExists(path));
        return;
      }
      this.pendingCreation = undefined;
      this.document.transact(() => {
        if (pending.kind === "file") {
          this.files.set(path, new Y.Text());
        } else {
          this.folders.set(path, true);
        }
      });
      this.selectedPaths.clear();
      this.selectedPaths.add(path);
      this.focusedPath = path;
      this.selectionAnchor = path;
      if (pending.kind === "file") {
        this.openFile(path);
      } else {
        this.selectedDirectory = path;
        this.expandedFolders.add(path);
        this.renderTree(path);
      }
    };
    input.addEventListener("input", () => {
      pending.name = input.value;
      input.classList.remove("invalid");
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        finish();
      } else if (event.key === "Escape") {
        this.pendingCreation = undefined;
        this.renderTree(pending.directory || undefined);
      }
    });
    input.addEventListener("blur", () => {
      queueMicrotask(() => {
        if (this.pendingCreation === pending && !input.classList.contains("invalid")) {
          this.pendingCreation = undefined;
          this.renderTree();
        }
      });
    });
  }

  private beginRename(): void {
    if (this.selectedPaths.size !== 1) {
      return;
    }
    this.pendingCreation = undefined;
    this.pendingRename = [...this.selectedPaths][0];
    this.renderTree();
  }

  private renderRenameInput(row: HTMLElement, entry: TreeEntry): void {
    row.querySelector(".file-row-label")?.remove();
    const input = document.createElement("input");
    input.className = "create-input rename-input";
    input.setAttribute("aria-label", `Rename ${entry.name}`);
    input.value = entry.name;
    row.append(input);
    queueMicrotask(() => {
      input.focus();
      const extensionIndex = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1;
      input.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : entry.name.length);
    });

    const finish = (): void => {
      const name = input.value.trim();
      const destination = joinPath(parentPath(entry.path), name);
      if (destination === entry.path) {
        this.pendingRename = undefined;
        this.renderTree(entry.path);
        return;
      }
      if (!validName(name) || this.pathExists(destination)) {
        markInvalidName(input, name, this.pathExists(destination));
        return;
      }
      this.pendingRename = undefined;
      this.relocatePaths([{ source: entry.path, destination }], false);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        finish();
      } else if (event.key === "Escape") {
        this.pendingRename = undefined;
        this.renderTree(entry.path);
      }
    });
    input.addEventListener("blur", () => {
      if (this.pendingRename === entry.path && !input.classList.contains("invalid")) {
        this.pendingRename = undefined;
        this.renderTree();
      }
    });
  }

  private handleTreeKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      this.beginCreate(event.shiftKey ? "folder" : "file");
      return;
    }
    if (commandKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectedPaths.clear();
      for (const entry of this.visibleEntries()) {
        this.selectedPaths.add(entry.path);
      }
      this.renderTree(this.focusedPath || undefined);
      return;
    }
    if (commandKey && ["c", "x", "v"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      this.runCommand(event.key.toLowerCase() === "c" ? "copy" : event.key.toLowerCase() === "x" ? "cut" : "paste");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace" && event.metaKey) {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      this.beginRename();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (this.files.has(this.focusedPath)) {
        this.openFile(this.focusedPath);
      } else if (this.folders.has(this.focusedPath)) {
        this.toggleFolder(this.focusedPath, true);
      }
      return;
    }
    if (event.key === "ArrowRight" && this.folders.has(this.focusedPath)) {
      event.preventDefault();
      if (!this.expandedFolders.has(this.focusedPath)) {
        this.expandedFolders.add(this.focusedPath);
        this.renderTree(this.focusedPath);
      } else {
        this.moveFocus(1, event.shiftKey);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (this.folders.has(this.focusedPath) && this.expandedFolders.has(this.focusedPath)) {
        this.expandedFolders.delete(this.focusedPath);
        this.renderTree(this.focusedPath);
      } else {
        const parent = parentPath(this.focusedPath);
        if (parent !== "" && this.folders.has(parent)) {
          this.selectPath(parent, event.shiftKey, false);
          this.renderTree(parent);
        }
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const entries = this.visibleEntries();
      const currentIndex = entries.findIndex((entry) => entry.path === this.focusedPath);
      const targetIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : Math.max(0, Math.min(entries.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const target = entries[targetIndex];
      if (target !== undefined) {
        this.selectPath(target.path, event.shiftKey, false);
        this.renderTree(target.path);
      }
    }
  }

  private moveFocus(offset: number, extend: boolean): void {
    const entries = this.visibleEntries();
    const index = entries.findIndex((entry) => entry.path === this.focusedPath);
    const target = entries[Math.max(0, Math.min(entries.length - 1, index + offset))];
    if (target !== undefined) {
      this.selectPath(target.path, extend, false);
      this.renderTree(target.path);
    }
  }

  private toggleFolder(path: string, focus = false): void {
    if (this.expandedFolders.has(path)) {
      this.expandedFolders.delete(path);
    } else {
      this.expandedFolders.add(path);
    }
    this.renderTree(focus ? path : undefined);
  }

  private runCommand(command: ExplorerCommand): void {
    switch (command) {
      case "new-file": this.beginCreate("file"); break;
      case "new-folder": this.beginCreate("folder"); break;
      case "rename": this.beginRename(); break;
      case "copy": this.setClipboard("copy"); break;
      case "cut": this.setClipboard("move"); break;
      case "paste": this.pasteClipboard(); break;
      case "delete": this.deleteSelection(); break;
    }
  }

  private setClipboard(mode: "copy" | "move"): void {
    const paths = this.topLevelSelection();
    if (paths.length === 0) {
      return;
    }
    this.clipboard = { mode, paths };
    this.renderTree(this.focusedPath || undefined);
  }

  private pasteClipboard(): void {
    if (this.clipboard === undefined) {
      return;
    }
    const sources = this.clipboard.paths.filter((path) => this.pathExists(path));
    if (sources.length === 0) {
      this.clipboard = undefined;
      this.renderTree();
      return;
    }
    const destinationDirectory = this.pasteDirectory();
    const occupied = new Set([...this.files.keys(), ...this.folders.keys()]);
    const moves: { source: string; destination: string }[] = [];
    for (const source of sources) {
      if (this.folders.has(source) && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
        continue;
      }
      if (this.clipboard.mode === "move" && parentPath(source) === destinationDirectory) {
        continue;
      }
      const destination = uniqueCopyPath(destinationDirectory, baseName(source), occupied);
      occupied.add(destination);
      moves.push({ source, destination });
    }
    if (moves.length === 0) {
      return;
    }
    const moving = this.clipboard.mode === "move";
    this.relocatePaths(moves, !moving);
    if (moving) {
      this.clipboard = undefined;
    }
  }

  private relocatePaths(moves: { source: string; destination: string }[], copy: boolean): void {
    const activeDestination = moves.find(({ source }) => isPathWithin(this.activePath, source));
    const nextActivePath = activeDestination === undefined
      ? this.activePath
      : replacePathPrefix(this.activePath, activeDestination.source, activeDestination.destination);
    if (!copy && activeDestination !== undefined) {
      this.binding?.destroy();
      this.binding = undefined;
      this.editor.setModel(null);
      this.activePath = "";
    }

    this.mutateStructure(() => {
      for (const { source, destination } of moves) {
        if (this.files.has(source)) {
          this.files.set(destination, new Y.Text(this.files.get(source)!.toString()));
          if (!copy) {
            this.files.delete(source);
          }
          continue;
        }
        const nestedFolders = [...this.folders.keys()].filter((path) => isPathWithin(path, source));
        const nestedFiles = [...this.files.keys()].filter((path) => isPathWithin(path, source));
        for (const path of nestedFolders) {
          this.folders.set(replacePathPrefix(path, source, destination), true);
        }
        for (const path of nestedFiles) {
          this.files.set(
            replacePathPrefix(path, source, destination),
            new Y.Text(this.files.get(path)!.toString()),
          );
        }
        if (!copy) {
          for (const path of nestedFiles) this.files.delete(path);
          for (const path of nestedFolders) this.folders.delete(path);
        }
      }
    });

    this.selectedPaths.clear();
    for (const { destination } of moves) this.selectedPaths.add(destination);
    this.focusedPath = moves[0].destination;
    this.selectionAnchor = this.focusedPath;
    this.selectedDirectory = this.folders.has(this.focusedPath) ? this.focusedPath : parentPath(this.focusedPath);
    this.syncRegisteredFiles();
    this.pruneExplorerState();
    for (const { destination } of moves) {
      if (this.folders.has(destination)) this.expandedFolders.add(destination);
    }
    if (nextActivePath !== "" && this.files.has(nextActivePath) && nextActivePath !== this.activePath) {
      this.openFile(nextActivePath, false);
    } else {
      this.renderTree(this.focusedPath);
    }
  }

  private deleteSelection(): void {
    const paths = this.topLevelSelection();
    if (paths.length === 0) {
      return;
    }
    const description = paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} selected items`;
    if (!window.confirm(`Delete ${description}? This cannot be undone.`)) {
      return;
    }
    const activeDeleted = paths.some((path) => isPathWithin(this.activePath, path));
    if (activeDeleted) {
      this.binding?.destroy();
      this.binding = undefined;
      this.editor.setModel(null);
      this.activePath = "";
    }
    this.mutateStructure(() => {
      for (const selectedPath of paths) {
        for (const path of [...this.files.keys()]) {
          if (isPathWithin(path, selectedPath)) this.files.delete(path);
        }
        for (const path of [...this.folders.keys()]) {
          if (isPathWithin(path, selectedPath)) this.folders.delete(path);
        }
      }
    });
    this.selectedPaths.clear();
    this.focusedPath = "";
    this.selectionAnchor = "";
    this.syncRegisteredFiles();
    this.pruneExplorerState();
    const nextPath = [...this.files.keys()].sort(comparePaths)[0];
    if (nextPath === undefined) {
      this.clearEditor();
      this.renderTree();
    } else if (activeDeleted) {
      this.selectedPaths.add(nextPath);
      this.openFile(nextPath, false);
    } else {
      this.renderTree();
    }
  }

  private mutateStructure(change: () => void): void {
    this.mutatingStructure = true;
    try {
      this.document.transact(change);
    } finally {
      this.mutatingStructure = false;
    }
  }

  private topLevelSelection(): string[] {
    return [...this.selectedPaths]
      .filter((path) => this.pathExists(path))
      .filter((path, _index, paths) => !paths.some((parent) => parent !== path && isPathWithin(path, parent)))
      .sort(comparePaths);
  }

  private pasteDirectory(): string {
    if (this.selectedPaths.size === 1) {
      const path = [...this.selectedPaths][0];
      if (this.folders.has(path)) {
        return path;
      }
    }
    return this.folders.has(this.selectedDirectory) ? this.selectedDirectory : "";
  }

  private pathExists(path: string): boolean {
    return this.files.has(path) || this.folders.has(path);
  }

  private handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const row = (event.target as Element).closest<HTMLElement>("[data-path]");
    if (row?.dataset.path !== undefined && !this.selectedPaths.has(row.dataset.path)) {
      this.selectPath(row.dataset.path, false, false);
      this.renderTree(row.dataset.path);
    }
    this.openExplorerMenu(event.clientX, event.clientY);
  }

  private toggleExplorerMenu(): void {
    const menu = requiredElement("explorer-menu");
    if (!menu.hidden) {
      this.closeExplorerMenu();
      return;
    }
    const button = requiredButton("explorer-menu-button");
    const bounds = button.getBoundingClientRect();
    this.openExplorerMenu(bounds.right - 190, bounds.bottom + 2);
  }

  private openExplorerMenu(left: number, top: number): void {
    const menu = requiredElement("explorer-menu");
    this.updateMenuState();
    menu.hidden = false;
    menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - 204))}px`;
    menu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - menu.offsetHeight - 4))}px`;
  }

  private closeExplorerMenu(): void {
    requiredElement("explorer-menu").hidden = true;
  }

  private updateMenuState(): void {
    const menu = requiredElement("explorer-menu");
    for (const button of menu.querySelectorAll<HTMLButtonElement>("[data-command]")) {
      const command = button.dataset.command as ExplorerCommand;
      button.disabled = command === "paste"
        ? this.clipboard === undefined
        : ["rename", "cut", "copy", "delete"].includes(command)
          ? this.selectedPaths.size === 0 || command === "rename" && this.selectedPaths.size !== 1
          : false;
    }
  }
}

class CollaborativeFile extends RegisteredFile {
  private readonly encoder = new TextEncoder();

  constructor(uri: monaco.Uri, private readonly text: Y.Text) {
    super(uri, false);
    text.observe(() => this._onDidChange.fire());
  }

  async getSize(): Promise<number> {
    return this.encoder.encode(this.text.toString()).byteLength;
  }

  async read(): Promise<Uint8Array> {
    return this.encoder.encode(this.text.toString());
  }

  async write(content: Uint8Array): Promise<void> {
    const value = new TextDecoder().decode(content);
    this.text.doc?.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, value);
    });
  }
}

function fileUri(path: string): monaco.Uri {
  return monaco.Uri.file(`${workspaceRoot}/${path}`);
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function pathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function replacePathPrefix(path: string, source: string, destination: string): string {
  return `${destination}${path.slice(source.length)}`;
}

function uniqueCopyPath(directory: string, name: string, occupied: Set<string>): string {
  const original = joinPath(directory, name);
  if (!occupied.has(original)) {
    return original;
  }
  const extensionIndex = name.lastIndexOf(".");
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : "";
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    const candidate = joinPath(directory, `${stem}${suffix}${extension}`);
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
}

function validName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function markInvalidName(input: HTMLInputElement, name: string, exists: boolean): void {
  input.classList.add("invalid");
  input.title = !validName(name) ? "Use a name without /, \\, . or .." : exists ? "That name already exists" : "Invalid name";
  input.focus();
}

function comparePaths(left: string, right: string): number {
  if (left === "report.abap") return -1;
  if (right === "report.abap") return 1;
  return left.localeCompare(right);
}

function icon(className: string, content: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.setAttribute("aria-hidden", "true");
  element.textContent = content;
  return element;
}

function fileIcon(path: string, id?: string): HTMLSpanElement {
  const language = languageForPath(path);
  const element = icon(language.iconClass, language.iconText);
  if (id !== undefined) element.id = id;
  return element;
}

function languageForPath(path: string): FileLanguage {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".abap")) {
    return { id: "abap", label: "ABAP", iconClass: "file-type-icon abap-file-icon", iconText: "A" };
  }
  if (lowerPath.endsWith(".ddls")) {
    return {
      id: "abap-cds",
      label: "ABAP CDS",
      iconClass: "file-type-icon cds-file-icon codicon",
      iconText: "\ueace",
    };
  }
  return {
    id: "plaintext",
    label: "Plain Text",
    iconClass: "file-type-icon generic-file-icon codicon",
    iconText: "\uea7b",
  };
}

function label(value: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "file-row-label";
  element.textContent = value;
  return element;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
  return element;
}
