import { isCollection, isScalar, isSeq, parseDocument, Scalar, stringify, type Document } from "yaml";
import { z } from "zod";

// Edit operations: the studio's patch contract, settled by spike 1 of
// milestone 1. Applied to the blueprint text, never to the model, so the
// file keeps its comments and its formatting (ADR 0001: the file is the
// source of truth).

const pathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: pathSchema, value: z.unknown() }),
  z.object({ op: z.literal("delete"), path: pathSchema }),
]);
export const opsSchema = z.array(opSchema);
export type Op = z.infer<typeof opSchema>;
type Path = Op["path"];

// An operation the blueprint text cannot take: a path through a value, a
// delete of nothing, a sequence index past the end, a text that does not
// parse. Nothing is applied.
export class PatchError extends Error {
  override readonly name = "PatchError";
}

// Apply the operations in order and return the new text. A set of a scalar
// value onto an existing plain scalar is spliced into the source by range, so
// it is byte-exact on any file. Every other operation goes through the
// Document API, which normalizes comment spacing once on a hand-formatted
// file and is idempotent after that.
export function applyOps(text: string, ops: Op[]): string {
  let current = text;
  for (const op of ops) {
    const document = parse(current);
    checkPath(document, op.path);
    if (op.op === "set") {
      current = spliceScalar(current, document, op.path, op.value) ?? setThroughDocument(document, op.path, op.value);
    } else {
      current = deleteThroughDocument(document, op.path);
    }
  }
  return current;
}

function parse(text: string): Document {
  const document = parseDocument(text);
  const [error] = document.errors;
  if (error) throw new PatchError(`cannot patch a blueprint that does not parse: ${error.message}`);
  return document;
}

// Every collection the path goes through must be one, and a sequence index
// may at most append. Checked up front so the messages are Hull's own.
function checkPath(document: Document, path: Path): void {
  for (let depth = 0; depth < path.length; depth++) {
    const prefix = path.slice(0, depth);
    const segment = path[depth]!;
    const node = document.getIn(prefix, true);
    if (node === undefined) {
      // The set creates the rest of the path; a new sequence starts at 0.
      if (typeof segment === "number" && segment > 0) {
        throw new PatchError(`cannot reach ${pathText(path)}: ${pathText(prefix)} does not exist, so index ${segment} has nothing before it`);
      }
      continue;
    }
    if (!isCollection(node)) {
      throw new PatchError(`cannot reach ${pathText(path)}: ${pathText(prefix)} holds a value, not a collection`);
    }
    if (typeof segment === "number" && isSeq(node) && segment > node.items.length) {
      throw new PatchError(`cannot reach ${pathText(path)}: index ${segment} is past the end of a sequence of ${node.items.length}`);
    }
  }
}

const isScalarValue = (value: unknown) =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

// The new value in place of an existing plain scalar, or undefined when the
// edit is not that: a collection or null value, a target that is not a plain
// scalar with source of its own, a target inside a flow collection (where
// the value would need flow quoting), a rendering that needs several lines.
function spliceScalar(text: string, document: Document, path: Path, value: unknown): string | undefined {
  if (!isScalarValue(value) || value === null) return undefined;
  const inFlow = path.some((_, depth) => {
    const node = document.getIn(path.slice(0, depth), true);
    return isCollection(node) && node.flow;
  });
  if (inFlow) return undefined;
  const node = document.getIn(path, true);
  if (!isScalar(node) || node.type !== Scalar.PLAIN || !node.range) return undefined;
  const [start, valueEnd] = node.range;
  if (start === valueEnd) return undefined;
  const rendered = stringify(value).replace(/\n$/, "");
  if (rendered.includes("\n")) return undefined;
  return text.slice(0, start) + rendered + text.slice(valueEnd);
}

function setThroughDocument(document: Document, path: Path, value: unknown): string {
  // Collections along the path the set fills: absent ones it creates, and an
  // empty flow one such as `dev: {}`. Both must come out in block style, or
  // the whole subtree lands on that one line.
  const filled = path.map((_, depth) => path.slice(0, depth)).filter((prefix) => {
    const node = document.getIn(prefix, true);
    return node === undefined || (isCollection(node) && node.items.length === 0);
  });
  document.setIn(path, value);
  for (const prefix of filled) {
    const node = document.getIn(prefix, true);
    if (isCollection(node)) node.flow = false;
  }
  return document.toString();
}

// A delete that empties a mapping also removes it, up to the nearest ancestor
// that is not empty (an `overrides: {}` is noise), except a declaration: a
// section of the blueprint, or an intent or environment by name. `dev: {}` is
// a declared environment and stays.
const declaredByName = ["intents", "environments"];
function isDeclaration(prefix: Path): boolean {
  return prefix.length <= 1 || (prefix.length === 2 && declaredByName.includes(String(prefix[0])));
}

function deleteThroughDocument(document: Document, path: Path): string {
  if (!document.deleteIn(path)) throw new PatchError(`cannot delete ${pathText(path)}: nothing there`);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const prefix = path.slice(0, depth);
    if (isDeclaration(prefix)) break;
    const node = document.getIn(prefix, true);
    if (!isCollection(node) || node.items.length > 0) break;
    document.deleteIn(prefix);
  }
  return document.toString();
}

function pathText(path: Path): string {
  return path.length === 0 ? "the blueprint" : path.join(".");
}
