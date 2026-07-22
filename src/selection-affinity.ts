import * as Y from "yjs";

export interface RelativeSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

export function createRelativeSelection(
  text: Y.Text,
  anchor: number,
  head: number,
): RelativeSelection {
  if (anchor === head) {
    const position = Y.createRelativePositionFromTypeIndex(text, anchor);
    return { anchor: position, head: position };
  }

  const start = Math.min(anchor, head);
  const end = Math.max(anchor, head);
  const relativeStart = Y.createRelativePositionFromTypeIndex(text, start);
  const relativeEnd = Y.createRelativePositionFromTypeIndex(text, end, -1);
  return anchor < head
    ? { anchor: relativeStart, head: relativeEnd }
    : { anchor: relativeEnd, head: relativeStart };
}
