import * as Y from "yjs";

import type { RoomWorkspace, WorkspaceFile } from "./room-workspace";

interface SearchMatch {
  path: string;
  lineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
  before: string;
  match: string;
  after: string;
}

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regularExpression: boolean;
  include: string;
  exclude: string;
}

export class RoomSearch {
  private readonly files: Y.Map<WorkspaceFile>;
  private readonly expandedFiles = new Set<string>();
  private matches: SearchMatch[] = [];
  private refreshTimer: number | undefined;
  private readonly handleFilesChanged = (): void => this.scheduleRefresh();

  constructor(document: Y.Doc, private readonly workspace: RoomWorkspace) {
    this.files = document.getMap<WorkspaceFile>("files");
    this.files.observeDeep(this.handleFilesChanged);

    const searchInput = requiredInput("search-input");
    const replaceInput = requiredInput("replace-input");
    for (const id of ["search-input", "search-include", "search-exclude"]) {
      requiredInput(id).addEventListener("input", () => this.refresh());
    }
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.matches.length > 0) {
        event.preventDefault();
        this.openMatch(this.matches[event.shiftKey ? this.matches.length - 1 : 0]);
      }
    });
    replaceInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.matches.length > 0) {
        event.preventDefault();
        this.replaceMatch(this.matches[0]);
      }
    });
    requiredButton("replace-toggle").addEventListener("click", () => this.toggleReplace());
    requiredButton("replace-all").addEventListener("click", () => this.replaceAll());
    this.bindOption("search-case");
    this.bindOption("search-word");
    this.bindOption("search-regex");
    searchInput.addEventListener("keydown", (event) => {
      if (!event.altKey) return;
      const option = event.key.toLowerCase() === "c" ? "search-case"
        : event.key.toLowerCase() === "w" ? "search-word"
        : event.key.toLowerCase() === "r" ? "search-regex"
        : undefined;
      if (option !== undefined) {
        event.preventDefault();
        requiredButton(option).click();
      }
    });
  }

  focus(): void {
    requiredInput("search-input").focus();
    requiredInput("search-input").select();
  }

  destroy(): void {
    this.files.unobserveDeep(this.handleFilesChanged);
    window.clearTimeout(this.refreshTimer);
  }

  private bindOption(id: string): void {
    const button = requiredButton(id);
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      this.refresh();
    });
  }

  private toggleReplace(): void {
    const button = requiredButton("replace-toggle");
    const row = requiredElement("replace-row");
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "\ueab4" : "\ueab6";
    row.hidden = !expanded;
    this.renderResults();
    if (expanded) requiredInput("replace-input").focus();
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 40);
  }

  private refresh(): void {
    const query = requiredInput("search-input").value;
    const error = requiredElement("search-error");
    error.hidden = true;
    error.textContent = "";
    if (query === "") {
      this.matches = [];
      this.renderResults();
      return;
    }

    try {
      const expression = createSearchExpression(query, this.options());
      this.matches = [];
      for (const [path, text] of [...this.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (!(text instanceof Y.Text)) continue;
        if (!pathMatchesFilters(path, this.options().include, this.options().exclude)) continue;
        this.matches.push(...findMatches(path, text.toString(), expression));
      }
    } catch (caught) {
      this.matches = [];
      error.textContent = caught instanceof Error ? caught.message : "Invalid regular expression";
      error.hidden = false;
    }
    this.renderResults();
  }

  private options(): SearchOptions {
    return {
      caseSensitive: pressed("search-case"),
      wholeWord: pressed("search-word"),
      regularExpression: pressed("search-regex"),
      include: requiredInput("search-include").value,
      exclude: requiredInput("search-exclude").value,
    };
  }

  private renderResults(): void {
    const results = requiredElement("search-results");
    const summary = requiredElement("search-summary");
    results.replaceChildren();
    if (requiredInput("search-input").value === "") {
      summary.textContent = "Enter a search term to search across files.";
      return;
    }
    const grouped = new Map<string, SearchMatch[]>();
    for (const match of this.matches) {
      const fileMatches = grouped.get(match.path) ?? [];
      fileMatches.push(match);
      grouped.set(match.path, fileMatches);
    }
    summary.textContent = this.matches.length === 0
      ? "No results found."
      : `${this.matches.length} ${this.matches.length === 1 ? "result" : "results"} in ${grouped.size} ${grouped.size === 1 ? "file" : "files"}`;

    for (const [path, fileMatches] of grouped) {
      if (!this.expandedFiles.has(path)) this.expandedFiles.add(path);
      const group = document.createElement("section");
      group.className = "search-result-file";
      group.setAttribute("role", "treeitem");
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "search-file-heading";
      heading.setAttribute("aria-expanded", String(this.expandedFiles.has(path)));
      heading.title = path;
      heading.append(
        textSpan("search-chevron codicon", this.expandedFiles.has(path) ? "\ueab4" : "\ueab6"),
        textSpan("search-file-name", baseName(path)),
        textSpan("search-file-path", parentPath(path)),
        textSpan("search-file-count", String(fileMatches.length)),
      );
      const matchList = document.createElement("div");
      matchList.className = "search-match-list";
      matchList.hidden = !this.expandedFiles.has(path);
      heading.addEventListener("click", () => {
        if (this.expandedFiles.delete(path)) {
          matchList.hidden = true;
          heading.setAttribute("aria-expanded", "false");
          heading.querySelector(".search-chevron")!.textContent = "\ueab6";
        } else {
          this.expandedFiles.add(path);
          matchList.hidden = false;
          heading.setAttribute("aria-expanded", "true");
          heading.querySelector(".search-chevron")!.textContent = "\ueab4";
        }
      });
      for (const match of fileMatches) matchList.append(this.renderMatch(match));
      group.append(heading, matchList);
      results.append(group);
    }
  }

  private renderMatch(match: SearchMatch): HTMLElement {
    const row = document.createElement("div");
    row.className = "search-match-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-match";
    button.title = `${match.path}:${match.lineNumber}`;
    const line = textSpan("search-line-number", String(match.lineNumber));
    const preview = document.createElement("span");
    preview.className = "search-preview";
    preview.append(
      document.createTextNode(match.before),
      textSpan("search-highlight", match.match),
      document.createTextNode(match.after),
    );
    button.append(line, preview);
    button.addEventListener("click", () => this.openMatch(match));
    row.append(button);
    if (!requiredElement("replace-row").hidden) {
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "match-replace codicon";
      replace.title = "Replace";
      replace.setAttribute("aria-label", `Replace match on line ${match.lineNumber} in ${match.path}`);
      replace.textContent = "\ueb3d";
      replace.addEventListener("click", () => this.replaceMatch(match));
      row.append(replace);
    }
    return row;
  }

  private openMatch(match: SearchMatch): void {
    this.workspace.openSearchResult(
      match.path,
      match.lineNumber,
      match.startColumn,
      match.endLineNumber,
      match.endColumn,
    );
  }

  private replaceMatch(match: SearchMatch): void {
    const text = this.files.get(match.path);
    if (!(text instanceof Y.Text)) return;
    const content = text.toString();
    if (content.slice(match.startOffset, match.endOffset) !== match.match) {
      this.refresh();
      return;
    }
    const replacement = replacementForMatch(match.match, requiredInput("replace-input").value, this.options());
    text.doc?.transact(() => {
      text.delete(match.startOffset, match.endOffset - match.startOffset);
      text.insert(match.startOffset, replacement);
    });
    this.refresh();
  }

  private replaceAll(): void {
    if (this.matches.length === 0) return;
    const query = requiredInput("search-input").value;
    const options = this.options();
    const replacement = requiredInput("replace-input").value;
    const paths = new Set(this.matches.map((match) => match.path));
    this.files.doc?.transact(() => {
      for (const path of paths) {
        const text = this.files.get(path);
        if (!(text instanceof Y.Text)) continue;
        const content = text.toString();
        const expression = createSearchExpression(query, options);
        const updated = options.regularExpression
          ? content.replace(expression, replacement)
          : content.replace(expression, () => replacement);
        if (updated !== content) {
          text.delete(0, text.length);
          text.insert(0, updated);
        }
      }
    });
    this.refresh();
  }
}

function createSearchExpression(query: string, options: SearchOptions): RegExp {
  const source = options.regularExpression ? query : escapeRegExp(query);
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
  return new RegExp(bounded, `g${options.caseSensitive ? "" : "i"}u`);
}

function findMatches(path: string, content: string, expression: RegExp): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const result of content.matchAll(expression)) {
    if (result.index === undefined) continue;
    const lineStart = content.lastIndexOf("\n", result.index - 1) + 1;
    const lineEndIndex = content.indexOf("\n", result.index + result[0].length);
    const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
    const endOffset = result.index + result[0].length;
    const endLineStart = content.lastIndexOf("\n", Math.max(0, endOffset - 1)) + 1;
    matches.push({
      path,
      lineNumber: countLines(content, result.index),
      startColumn: result.index - lineStart + 1,
      endLineNumber: countLines(content, endOffset),
      endColumn: endOffset - endLineStart + 1,
      startOffset: result.index,
      endOffset,
      before: content.slice(lineStart, result.index),
      match: result[0],
      after: content.slice(result.index + result[0].length, lineEnd),
    });
  }
  return matches;
}

function countLines(content: string, offset: number): number {
  let count = 1;
  for (let index = 0; index < offset; index += 1) if (content.charCodeAt(index) === 10) count += 1;
  return count;
}

function replacementForMatch(match: string, replacement: string, options: SearchOptions): string {
  if (!options.regularExpression) return replacement;
  const expression = createSearchExpression(requiredInput("search-input").value, { ...options, wholeWord: false });
  expression.lastIndex = 0;
  return match.replace(expression, replacement);
}

function pathMatchesFilters(path: string, include: string, exclude: string): boolean {
  const includes = parsePatterns(include);
  const excludes = parsePatterns(exclude);
  return (includes.length === 0 || includes.some((pattern) => pattern.test(path))) &&
    !excludes.some((pattern) => pattern.test(path));
}

function parsePatterns(value: string): RegExp[] {
  return value.split(",").map((pattern) => pattern.trim()).filter(Boolean).map(globExpression);
}

function globExpression(pattern: string): RegExp {
  let normalized = pattern.replaceAll("\\", "/");
  if (!normalized.includes("/") && !normalized.includes("*") && !normalized.includes("?")) {
    normalized = normalized.startsWith(".") ? `*${normalized}` : normalized;
  }
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegExp(character);
  }
  return new RegExp(normalized.includes("/") ? `^${source}$` : `(?:^|/)${source}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pressed(id: string): boolean {
  return requiredButton(id).getAttribute("aria-pressed") === "true";
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function textSpan(className: string, value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = value;
  return span;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
  return element;
}
