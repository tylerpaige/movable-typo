import type { Node as PMNode } from "prosemirror-model";
import { schema, footnotesPos } from "./schema";

export interface Numbering {
  /** Footnote id → displayed number. */
  num: Map<string, number>;
  /** Footnote ids in number order: referenced notes first (by first ref), then orphans. */
  order: string[];
  /** Footnote id → its node and position. */
  notes: Map<string, { node: PMNode; pos: number }>;
}

/** Numbers notes by the order their refs appear in the text. */
export function numbering(doc: PMNode): Numbering {
  const notes = new Map<string, { node: PMNode; pos: number }>();
  const start = footnotesPos(doc);
  doc.lastChild!.forEach((node, offset) => {
    notes.set(node.attrs.id, { node, pos: start + 1 + offset });
  });
  const order: string[] = [];
  doc.nodesBetween(0, start, (node) => {
    if (node.type === schema.nodes.footnote_ref) {
      const t = node.attrs.target;
      if (t && notes.has(t) && !order.includes(t)) order.push(t);
    }
    return true;
  });
  for (const id of notes.keys()) if (!order.includes(id)) order.push(id);
  return { num: new Map(order.map((id, i) => [id, i + 1])), order, notes };
}

export interface RefInfo {
  pos: number;
  node: PMNode;
}

/** Every ref in the body, in order. */
export function refs(doc: PMNode): RefInfo[] {
  const out: RefInfo[] = [];
  doc.nodesBetween(0, footnotesPos(doc), (node, pos) => {
    if (node.type === schema.nodes.footnote_ref) out.push({ node, pos });
    return true;
  });
  return out;
}

export interface Issue {
  pos: number;
  message: string;
}

/** Broken refs, notes nothing points to, and notes linked more than once. */
export function footnoteIssues(doc: PMNode): Issue[] {
  const { notes, num } = numbering(doc);
  const issues: Issue[] = [];
  const used = new Map<string, number>();
  for (const r of refs(doc)) {
    const t = r.node.attrs.target;
    if (!t || !notes.has(t)) {
      issues.push({ pos: r.pos, message: `Ref “${r.node.attrs.label || "?"}” is not linked to a footnote` });
    } else used.set(t, (used.get(t) ?? 0) + 1);
  }
  for (const [id, { pos }] of notes) {
    if (!used.has(id)) issues.push({ pos: pos + 2, message: `Footnote ${num.get(id)} has no ref in the text` });
    else if (used.get(id)! > 1) issues.push({ pos: pos + 2, message: `Footnote ${num.get(id)} is referenced ${used.get(id)} times` });
  }
  return issues.sort((a, b) => a.pos - b.pos);
}
