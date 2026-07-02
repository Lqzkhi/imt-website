import type { Domain } from './catEngine';

export type SkillStatus = 'not_assessed' | 'touched' | 'strong_evidence' | 'developing' | 'needs_review';

export interface SkillNodeRow {
  id: string;
  domain: Domain;
  name: string;
  description: string | null;
  prerequisite_ids: string[] | string | null;
  display_order: number;
}

export interface SkillTreeNode {
  id: string;
  domain: Domain;
  name: string;
  description: string;
  prerequisites: string[];
  displayOrder: number;
  depth: number;
  correct: number;
  total: number;
  accuracy: number | null;
  status: SkillStatus;
}

export interface RecommendedFocus {
  node: SkillTreeNode | null;
  reason: string;
}

const STATUS_LABELS: Record<SkillStatus, string> = {
  not_assessed: 'Not assessed',
  touched: 'Touched',
  strong_evidence: 'Strong',
  developing: 'Developing',
  needs_review: 'Needs review',
};

export function buildSkillTree(
  rows: SkillNodeRow[],
  evidence: Record<string, { correct: number; total: number }>
) {
  const nodes = rows.map((row) => {
    const counts = evidence[row.id] ?? { correct: 0, total: 0 };
    const accuracy = counts.total > 0 ? counts.correct / counts.total : null;

    return {
      id: row.id,
      domain: row.domain,
      name: row.name,
      description: row.description ?? '',
      prerequisites: normalizePrerequisites(row.prerequisite_ids),
      displayOrder: row.display_order ?? 0,
      depth: 0,
      correct: counts.correct,
      total: counts.total,
      accuracy,
      status: statusFor(counts.correct, counts.total),
    } satisfies SkillTreeNode;
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    node.depth = computeDepth(node, byId, new Set());
  }

  return nodes.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.displayOrder - b.displayOrder;
  });
}

export function groupSkillTreeByDomain(nodes: SkillTreeNode[]) {
  return nodes.reduce((groups, node) => {
    if (!groups[node.domain]) groups[node.domain] = [];
    groups[node.domain].push(node);
    return groups;
  }, {} as Record<Domain, SkillTreeNode[]>);
}

export function statusLabel(status: SkillStatus) {
  return STATUS_LABELS[status];
}

export function pickRecommendedFocus(nodes: SkillTreeNode[]): RecommendedFocus {
  const assessed = nodes.filter((node) => node.total > 0);

  const needsReview = assessed
    .filter((node) => node.status === 'needs_review')
    .sort(byMostEvidenceThenOrder)[0];
  if (needsReview) {
    return { node: needsReview, reason: 'Lowest current evidence among assessed skills.' };
  }

  const developing = assessed
    .filter((node) => node.status === 'developing')
    .sort(byMostEvidenceThenOrder)[0];
  if (developing) {
    return { node: developing, reason: 'Promising next skill to stabilize.' };
  }

  const touched = assessed
    .filter((node) => node.status === 'touched')
    .sort(byMostEvidenceThenOrder)[0];
  if (touched) {
    return { node: touched, reason: 'Needs another problem before the signal is reliable.' };
  }

  const firstUnassessed = nodes
    .filter((node) => node.status === 'not_assessed')
    .sort((a, b) => a.depth - b.depth || a.displayOrder - b.displayOrder)[0];

  if (firstUnassessed) {
    return { node: firstUnassessed, reason: 'Good candidate for the next diagnostic or practice pass.' };
  }

  return { node: null, reason: 'No focus area identified yet.' };
}

function statusFor(correct: number, total: number): SkillStatus {
  if (total === 0) return 'not_assessed';
  if (total === 1) return 'touched';

  const accuracy = correct / total;
  if (accuracy >= 0.75) return 'strong_evidence';
  if (accuracy >= 0.4) return 'developing';
  return 'needs_review';
}

function computeDepth(node: SkillTreeNode, byId: Map<string, SkillTreeNode>, visiting: Set<string>): number {
  if (node.prerequisites.length === 0) return 0;
  if (visiting.has(node.id)) return 0;

  visiting.add(node.id);
  const parentDepths = node.prerequisites
    .map((id) => byId.get(id))
    .filter((parent): parent is SkillTreeNode => Boolean(parent))
    .map((parent) => computeDepth(parent, byId, visiting));
  visiting.delete(node.id);

  return parentDepths.length === 0 ? 0 : Math.max(...parentDepths) + 1;
}

function normalizePrerequisites(value: SkillNodeRow['prerequisite_ids']) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);

  return value
    .replace(/[{}]/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function byMostEvidenceThenOrder(a: SkillTreeNode, b: SkillTreeNode) {
  return b.total - a.total || a.depth - b.depth || a.displayOrder - b.displayOrder;
}
