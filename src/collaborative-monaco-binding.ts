import * as monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createRelativeSelection, type RelativeSelection } from "./selection-affinity";

type SavedSelection = RelativeSelection;

interface AwarenessSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

export class CollaborativeMonacoBinding {
  private readonly binding: MonacoBinding;
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly cursorListener: monaco.IDisposable;
  private savedSelection: SavedSelection | undefined;
  private transactionActive = false;
  private selectionChangedDuringTransaction = false;
  private destroyed = false;

  constructor(
    private readonly text: Y.Text,
    private readonly model: monaco.editor.ITextModel,
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly awareness: Awareness,
  ) {
    this.binding = new MonacoBinding(text, model);
    this.decorations = editor.createDecorationsCollection();
    text.doc!.on("beforeAllTransactions", this.saveSelection);
    text.doc!.on("afterAllTransactions", this.finishTransaction);
    text.observe(this.restoreSelection);
    this.cursorListener = editor.onDidChangeCursorSelection(this.handleSelectionChange);
    awareness.on("change", this.renderRemoteSelections);
    this.publishSelection();
    this.renderRemoteSelections();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.binding.destroy();
    this.cursorListener.dispose();
    this.text.unobserve(this.restoreSelection);
    this.text.doc!.off("beforeAllTransactions", this.saveSelection);
    this.text.doc!.off("afterAllTransactions", this.finishTransaction);
    this.awareness.off("change", this.renderRemoteSelections);
    this.decorations.clear();
  }

  private readonly saveSelection = (): void => {
    this.transactionActive = true;
    this.selectionChangedDuringTransaction = false;
    if (this.editor.getModel() !== this.model) {
      this.savedSelection = undefined;
      return;
    }
    const selection = this.editor.getSelection();
    if (selection === null) {
      this.savedSelection = undefined;
      return;
    }
    const anchor = this.model.getOffsetAt(selection.getSelectionStart());
    const head = this.model.getOffsetAt(selection.getPosition());
    this.savedSelection = createRelativeSelection(this.text, anchor, head);
  };

  private readonly finishTransaction = (): void => {
    this.transactionActive = false;
    if (this.selectionChangedDuringTransaction) {
      this.publishSelection();
    }
  };

  private readonly restoreSelection = (event: Y.YTextEvent): void => {
    if (event.transaction.origin === this.binding || this.savedSelection === undefined ||
        this.editor.getModel() !== this.model) {
      return;
    }
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      this.savedSelection.anchor,
      this.text.doc!,
    );
    const head = Y.createAbsolutePositionFromRelativePosition(
      this.savedSelection.head,
      this.text.doc!,
    );
    if (anchor?.type !== this.text || head?.type !== this.text) {
      return;
    }
    const anchorPosition = this.model.getPositionAt(anchor.index);
    const headPosition = this.model.getPositionAt(head.index);
    this.editor.setSelection(new monaco.Selection(
      anchorPosition.lineNumber,
      anchorPosition.column,
      headPosition.lineNumber,
      headPosition.column,
    ));
  };

  private readonly handleSelectionChange = (): void => {
    if (this.transactionActive) {
      this.selectionChangedDuringTransaction = true;
      return;
    }
    this.publishSelection();
  };

  private readonly publishSelection = (): void => {
    if (this.editor.getModel() !== this.model) {
      return;
    }
    const selection = this.editor.getSelection();
    if (selection === null) {
      return;
    }
    const anchor = this.model.getOffsetAt(selection.getSelectionStart());
    const head = this.model.getOffsetAt(selection.getPosition());
    this.awareness.setLocalStateField(
      "selection",
      createRelativeSelection(this.text, anchor, head),
    );
  };

  private readonly renderRemoteSelections = (): void => {
    if (this.editor.getModel() !== this.model) {
      this.decorations.clear();
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.text.doc!.clientID) {
        continue;
      }
      const selection = state.selection as AwarenessSelection | undefined;
      if (selection?.anchor === undefined || selection.head === undefined) {
        continue;
      }
      const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, this.text.doc!);
      const head = Y.createAbsolutePositionFromRelativePosition(selection.head, this.text.doc!);
      if (anchor?.type !== this.text || head?.type !== this.text) {
        continue;
      }
      const anchorPosition = this.model.getPositionAt(anchor.index);
      const headPosition = this.model.getPositionAt(head.index);
      const forward = anchor.index < head.index;
      const start = forward ? anchorPosition : headPosition;
      const end = forward ? headPosition : anchorPosition;
      decorations.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          className: `yRemoteSelection yRemoteSelection-${clientId}`,
          afterContentClassName: forward
            ? `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
            : undefined,
          beforeContentClassName: forward
            ? undefined
            : `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`,
        },
      });
    }
    this.decorations.set(decorations);
  };
}
