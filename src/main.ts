import { whenReady as whenThemesReady } from "@codingame/monaco-vscode-theme-defaults-default-extension";
import "./styles.css";

import { initialize } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getFilesServiceOverride, {
  RegisteredFileSystemProvider,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getSnippetsServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { registerAbapLanguageBasics } from "./abap-extension";
import { ensureRoomUrl } from "./room";
import { ensureWorkspaceDocument, RoomWorkspace } from "./room-workspace";

declare global {
  interface Window {
    MonacoEnvironment: {
      getWorker(moduleId: string, label: string): Worker;
    };
  }
}

const participantColors = [
  "#e06c75", "#e5c07b", "#98c379", "#56b6c2", "#61afef", "#c678dd",
  "#d19a66", "#ff8a80", "#ffd180", "#b9f6ca", "#84ffff", "#80d8ff",
  "#b388ff", "#f8bbd0", "#c62828", "#ad5700", "#2e7d32", "#00796b",
  "#1565c0", "#6a1b9a", "#9c3d10", "#006064", "#283593", "#7b1fa2",
  "#37474f", "#a31515", "#005a9e", "#5b5fc7", "#8e562e", "#006b5f",
];
type ColorTheme = "dark" | "light";

const colorThemes: Record<ColorTheme, {
  editor: string;
  label: string;
  icon: string;
  metaColor: string;
}> = {
  dark: {
    editor: "Dark+",
    label: "Switch to light theme",
    icon: "☀",
    metaColor: "#181818",
  },
  light: {
    editor: "Light+",
    label: "Switch to dark theme",
    icon: "☾",
    metaColor: "#f3f3f3",
  },
};
let colorTheme = readColorTheme();
const roomId = ensureRoomUrl(window.location, window.history);
const storedName = localStorage.getItem("abap-collab.display-name");
const displayName = storedName ?? `Guest ${Math.floor(10 + Math.random() * 90)}`;

window.MonacoEnvironment = {
  getWorker: (_moduleId, label) => label === "TextMateWorker" ? new TextMateWorker() : new EditorWorker(),
};

const workspaceFileSystem = new RegisteredFileSystemProvider(false);
registerFileSystemOverlay(1, workspaceFileSystem);

await initialize({
  ...getConfigurationServiceOverride(),
  ...getFilesServiceOverride(),
  ...getThemeServiceOverride(),
  ...getTextmateServiceOverride(),
  ...getLanguagesServiceOverride(),
  ...getSnippetsServiceOverride(),
}, document.body, {
  workspaceProvider: {
    workspace: { folderUri: monaco.Uri.file("/workspace") },
    trusted: true,
    open: async () => false,
  },
});
await whenThemesReady();
await registerAbapLanguageBasics();

const editorElement = requiredElement("editor");
const editor = monaco.editor.create(editorElement, {
  model: null,
  theme: colorThemes[colorTheme].editor,
  automaticLayout: true,
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  fontSize: 14,
  lineHeight: 22,
  minimap: { enabled: true },
  padding: { top: 28 },
  renderWhitespace: "selection",
  smoothScrolling: true,
  tabSize: 2,
  insertSpaces: true,
  bracketPairColorization: { enabled: true },
});

const ydoc = new Y.Doc();
const websocketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const provider = new WebsocketProvider(
  `${websocketProtocol}//${window.location.host}/collaboration`,
  roomId,
  ydoc,
);
const connectionStatus = requiredElement("connection-status");
provider.on("status", ({ status }: { status: string }) => {
  connectionStatus.textContent = status === "connected" ? "Live" : "Reconnecting…";
  connectionStatus.classList.toggle("connected", status === "connected");
});
let localUser = {
  name: displayName,
  color: randomItem(themeCompatibleColors()),
};

provider.awareness.setLocalStateField("user", localUser);
await waitForInitialSync(provider);
ensureWorkspaceDocument(ydoc);
const roomWorkspace = new RoomWorkspace(ydoc, provider.awareness, editor, workspaceFileSystem);

const nameInput = requiredInput("display-name");
nameInput.value = displayName;
nameInput.addEventListener("change", () => {
  const name = nameInput.value.trim().slice(0, 32) || displayName;
  nameInput.value = name;
  localStorage.setItem("abap-collab.display-name", name);
  localUser = { ...localUser, name };
  provider.awareness.setLocalStateField("user", localUser);
});

requiredElement("room-label").textContent = `⑂ ${roomId}`;
requiredElement("share-room").addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  showToast("Room link copied");
});
requiredElement("new-room").addEventListener("click", () => {
  window.location.assign("/");
});
const themeToggle = requiredButton("theme-toggle");
themeToggle.addEventListener("click", () => {
  applyColorTheme(colorTheme === "dark" ? "light" : "dark");
});
updateThemeToggle();

const workbench = document.querySelector<HTMLElement>(".workbench")!;
const explorerToggle = requiredButton("explorer-toggle");
explorerToggle.addEventListener("click", toggleExplorer);
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === "b") {
    event.preventDefault();
    if (!event.repeat) {
      toggleExplorer();
    }
  }
}, true);

const cursorPosition = requiredElement("cursor-position");
editor.onDidChangeCursorPosition(({ position }) => {
  cursorPosition.textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
});

provider.awareness.on("change", updatePresence);
requiredElement("color-picker").addEventListener("click", ({ target }) => {
  if (!(target instanceof HTMLButtonElement) || target.dataset.color === undefined) {
    return;
  }
  const availableColors = availableParticipantColors();
  if (!availableColors.includes(target.dataset.color)) {
    renderParticipants();
    return;
  }
  localUser = { ...localUser, color: target.dataset.color };
  provider.awareness.setLocalStateField("user", localUser);
});
renderParticipants();

window.addEventListener("beforeunload", () => {
  roomWorkspace.destroy();
  provider.destroy();
  ydoc.destroy();
});

function renderParticipants(): void {
  const participants = requiredElement("participants");
  const presenceStyles = requiredElement("presence-styles");
  const colorPicker = requiredElement("color-picker");
  participants.replaceChildren();
  colorPicker.replaceChildren();
  const styles: string[] = [];
  const compatibleColors = themeCompatibleColors();
  const unavailableColors = colorsUsedByOthers();

  for (const color of compatibleColors) {
    const swatch = document.createElement("button");
    const selected = color === localUser.color;
    const unavailable = unavailableColors.has(color) && !selected;
    swatch.type = "button";
    swatch.className = "color-swatch";
    swatch.dataset.color = color;
    swatch.style.backgroundColor = color;
    swatch.disabled = unavailable;
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", String(selected));
    swatch.setAttribute(
      "aria-label",
      unavailable ? `${color}, used by another participant` : `${color}${selected ? ", selected" : ""}`,
    );
    swatch.title = unavailable ? "Used by another participant" : "Use this color";
    colorPicker.append(swatch);
  }

  for (const [clientId, state] of provider.awareness.getStates()) {
    const user = readAwarenessUser(state);
    if (user === undefined) {
      continue;
    }

    const participant = document.createElement("div");
    participant.className = "participant";
    const dot = document.createElement("span");
    dot.className = "participant-dot";
    dot.style.backgroundColor = user.color;
    const name = document.createElement("span");
    name.textContent = clientId === ydoc.clientID ? `${user.name} (you)` : user.name;
    participant.append(dot, name);
    participants.append(participant);

    styles.push(
      `.yRemoteSelection-${clientId} { background-color: ${user.color}40 !important; }`,
      `.yRemoteSelectionHead-${clientId} { border-left-color: ${user.color} !important; }`,
      `.yRemoteSelectionHead-${clientId}::after { content: ${cssString(user.name)}; background-color: ${user.color}; color: ${labelTextColor(user.color)}; }`,
    );
  }

  presenceStyles.textContent = styles.join("\n");
}

function applyColorTheme(theme: ColorTheme): void {
  colorTheme = theme;
  localStorage.setItem("abap-collab.theme", theme);
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content =
    colorThemes[theme].metaColor;
  monaco.editor.setTheme(colorThemes[theme].editor);
  updateThemeToggle();
  updatePresence();
}

function updateThemeToggle(): void {
  const theme = colorThemes[colorTheme];
  themeToggle.textContent = `${theme.icon} ${colorTheme === "dark" ? "Light" : "Dark"}`;
  themeToggle.setAttribute("aria-label", theme.label);
  themeToggle.title = theme.label;
}

function toggleExplorer(): void {
  const visible = workbench.classList.toggle("explorer-hidden") === false;
  explorerToggle.classList.toggle("active", visible);
  explorerToggle.setAttribute("aria-expanded", String(visible));
  explorerToggle.setAttribute("aria-label", `${visible ? "Hide" : "Show"} Explorer`);
  explorerToggle.title = `${visible ? "Hide" : "Show"} Explorer (Ctrl+B)`;
}

function readColorTheme(): ColorTheme {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" ? "light" : "dark";
}

function updatePresence(): void {
  const compatibleColors = themeCompatibleColors();
  const sameColorOwner = [...provider.awareness.getStates()]
    .filter(([clientId, state]) => clientId !== ydoc.clientID && readAwarenessUser(state)?.color === localUser.color)
    .map(([clientId]) => clientId)
    .sort((left, right) => left - right)[0];

  if (!compatibleColors.includes(localUser.color) ||
      (sameColorOwner !== undefined && sameColorOwner < ydoc.clientID)) {
    const availableColors = availableParticipantColors();
    if (availableColors.length > 0) {
      localUser = { ...localUser, color: randomItem(availableColors) };
      provider.awareness.setLocalStateField("user", localUser);
      return;
    }
  }
  renderParticipants();
}

function availableParticipantColors(): string[] {
  const unavailableColors = colorsUsedByOthers();
  return themeCompatibleColors().filter((color) => !unavailableColors.has(color));
}

function colorsUsedByOthers(): Set<string> {
  const colors = new Set<string>();
  for (const [clientId, state] of provider.awareness.getStates()) {
    const user = readAwarenessUser(state);
    if (user !== undefined && clientId !== ydoc.clientID) {
      colors.add(user.color);
    }
  }
  return colors;
}

function themeCompatibleColors(): string[] {
  const computedBackground = getComputedStyle(document.documentElement)
    .getPropertyValue("--vscode-editor-background")
    .trim() || getComputedStyle(editor.getDomNode() ?? editorElement).backgroundColor || "#1f1f1f";
  const editorBackground = computedBackground === "rgba(0, 0, 0, 0)"
    ? "#1f1f1f"
    : computedBackground;
  return participantColors.filter((color) => contrastRatio(color, editorBackground) >= 3);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function relativeLuminance(color: string): number {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) {
    throw new Error("Canvas color parsing is unavailable");
  }
  context.fillStyle = color;
  const normalized = context.fillStyle;
  const hexMatch = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(normalized);
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(normalized);
  if (hexMatch === null && (rgbMatch === null || rgbMatch[4] === "0")) {
    throw new Error(`Unsupported color ${color}`);
  }
  const channels = hexMatch !== null
    ? hexMatch.slice(1).map((channel) => Number.parseInt(channel, 16) / 255)
    : rgbMatch!.slice(1, 4).map((channel) => Number.parseInt(channel, 10) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function labelTextColor(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff")
    ? "#000000"
    : "#ffffff";
}

function randomItem<T>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("No collaboration colors are compatible with the current theme");
  }
  return items[Math.floor(Math.random() * items.length)];
}

function cssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")}"`;
}

function readAwarenessUser(state: Record<string, unknown>): { name: string; color: string } | undefined {
  if (typeof state.user !== "object" || state.user === null) {
    return undefined;
  }
  const user = state.user as Record<string, unknown>;
  if (typeof user.name !== "string" || typeof user.color !== "string") {
    return undefined;
  }
  const color = /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : "#4fc1ff";
  return { name: user.name.slice(0, 32), color };
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return element;
}

function waitForInitialSync(websocketProvider: WebsocketProvider): Promise<void> {
  if (websocketProvider.synced) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const handleSync = (synced: boolean): void => {
      if (synced) {
        websocketProvider.off("sync", handleSync);
        resolve();
      }
    };
    websocketProvider.on("sync", handleSync);
  });
}

let toastTimer: number | undefined;
function showToast(message: string): void {
  const toast = requiredElement("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
}
