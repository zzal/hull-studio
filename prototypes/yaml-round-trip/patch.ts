// PROTOTYPE, throwaway. Pure module: apply blueprint edits to YAML source text
// without touching anything else in the file. This is the part that could be
// lifted into @hull/blueprint if the answer is yes.
//
// Finding of the spike: the Document API alone normalizes the whole file on
// first write (comment spacing, comment-after-key placement), so a hybrid is
// used here:
//   - set on an existing scalar  -> splice the new value into the source by
//     byte range (byte-exact, works on hand-formatted files)
//   - anything structural        -> Document API (minimal diff once the file
//     is in the library's canonical form; idempotent after one pass)
import { parseDocument, isScalar, isMap, isSeq, type Document } from "yaml";

export type Op =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "delete"; path: (string | number)[] };

const scalarLike = (v: unknown) =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function applyOps(source: string, ops: Op[]): string {
  let text = source;
  for (const o of ops) {
    if (o.op === "set" && scalarLike(o.value)) {
      const spliced = trySpliceScalar(text, o.path, o.value);
      if (spliced !== null) { text = spliced; continue; }
    }
    const doc: Document = parseDocument(text);
    if (o.op === "set") {
      doc.setIn(o.path, o.value);
      unflowAlong(doc, o.path);
    } else {
      doc.deleteIn(o.path);
    }
    text = doc.toString();
  }
  return text;
}

// Replace the value of an existing plain scalar in place. Returns null when the
// target is not an existing plain scalar (caller falls back to the Document API).
function trySpliceScalar(text: string, path: (string | number)[], value: unknown): string | null {
  const doc = parseDocument(text);
  const node = doc.getIn(path, true);
  if (!isScalar(node) || !node.range || node.type !== "PLAIN") return null;
  const rendered = doc.createNode(value).toString();
  if (rendered.includes("\n")) return null;
  const [start, valueEnd] = node.range;
  return text.slice(0, start) + rendered + text.slice(valueEnd);
}

// After setIn creates nodes inside a flow mapping like `dev: {}`, force block
// style on every mapping along the path so the output stays multi-line.
function unflowAlong(doc: Document, path: (string | number)[]) {
  for (let i = 0; i <= path.length; i++) {
    const n = doc.getIn(path.slice(0, i), true);
    if ((isMap(n) || isSeq(n)) && n.flow && n.items.length > 0) n.flow = false;
  }
}

export function readPath(source: string, path: (string | number)[]): unknown {
  return parseDocument(source).getIn(path);
}
