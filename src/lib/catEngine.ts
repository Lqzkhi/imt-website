import {
  computePosterior,
  expectedInformation,
  fisherInformation,
  type IRTItem,
  type ResponseRecord,
} from './irt';
import { thetaToTier } from './tiers';

export const DOMAINS = ['Algebra', 'Combinatorics', 'Geometry', 'Number Theory'] as const;
export type Domain = (typeof DOMAINS)[number];

const MIN_ITEMS = 15;
const MAX_ITEMS = 25;
const SE_STOP_THRESHOLD = 0.28;
const COLD_START_ITEMS = 5;

const MIN_DOMAIN_COUNTS: Record<Domain, number> = {
  Algebra: 4,
  Geometry: 3,
  Combinatorics: 3,
  'Number Theory': 3,
};

const MAX_DOMAIN_COUNTS: Record<Domain, number> = {
  Algebra: 10,
  Geometry: 8,
  Combinatorics: 7,
  'Number Theory': 7,
};

export interface SelectionResult {
  stop: boolean;
  stopReason?: string;
  nextItem?: any;
  itemsAdministered: number;
  theta: number;
  se: number;
}

export interface ReportResult {
  session: any;
  overall: ReturnType<typeof computePosterior>;
  domainReports: Record<Domain, { theta: number; se: number; n: number; correct: number }>;
  skillCounts: Record<string, { correct: number; total: number }>;
  responses: any[];
}

export async function getOwnedDiagnosticSession(supabase: any, sessionId: string, userId: string) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('session_type', 'diagnostic')
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function selectNextItem(supabase: any, sessionId: string): Promise<SelectionResult> {
  const { session, responses } = await getSessionAndResponses(supabase, sessionId);
  if (!session) throw new Error('Session not found');

  const posterior = computePosterior(toResponseRecords(responses), session.prior_mean, session.prior_sd);
  const itemsAdministered = responses.length;
  const domainCounts = countDomains(responses);
  const domainCoverageMet = DOMAINS.every((domain) => domainCounts[domain] >= MIN_DOMAIN_COUNTS[domain]);

  if (itemsAdministered >= MAX_ITEMS) {
    return selectionStop('max_items', itemsAdministered, posterior.thetaEAP, posterior.se);
  }

  if (itemsAdministered >= MIN_ITEMS && posterior.se < SE_STOP_THRESHOLD && domainCoverageMet) {
    return selectionStop('se_threshold', itemsAdministered, posterior.thetaEAP, posterior.se);
  }

  const candidates = await loadCandidateItems(supabase, responses.map((response: any) => response.item_id));
  if (candidates.length === 0) {
    return selectionStop('item_pool_exhausted', itemsAdministered, posterior.thetaEAP, posterior.se);
  }

  const eligible = filterByContentBalance(candidates, responses, domainCounts);
  const useColdStart = itemsAdministered < COLD_START_ITEMS;
  let bestItem = eligible[0];
  let bestScore = -Infinity;

  for (const item of eligible) {
    const irtItem = toIRTItem(item);
    const score = useColdStart
      ? expectedInformation(irtItem, posterior.grid, posterior.posterior)
      : fisherInformation(posterior.thetaEAP, irtItem);

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return {
    stop: false,
    nextItem: bestItem,
    itemsAdministered,
    theta: posterior.thetaEAP,
    se: posterior.se,
  };
}

export function gradeResponse(item: { answer: string; item_format: string }, submittedValue: string) {
  const normalized = normalizeAnswer(submittedValue);
  const expected = normalizeAnswer(String(item.answer ?? ''));

  if (!normalized || !expected) return false;

  if (item.item_format === 'mcq_5') {
    return normalized.toUpperCase() === expected.toUpperCase();
  }

  const submittedNumber = Number(normalized);
  const expectedNumber = Number(expected);
  if (!Number.isNaN(submittedNumber) && !Number.isNaN(expectedNumber)) {
    return submittedNumber === expectedNumber;
  }

  return normalized.toLowerCase() === expected.toLowerCase();
}

export async function computeReport(supabase: any, sessionId: string): Promise<ReportResult> {
  const { session, responses } = await getSessionAndResponses(supabase, sessionId);
  if (!session) throw new Error('Session not found');

  const overall = computePosterior(toResponseRecords(responses), session.prior_mean, session.prior_sd);
  const domainReports = {} as ReportResult['domainReports'];

  for (const domain of DOMAINS) {
    const domainResponses = responses.filter((response: any) => response.domain === domain);
    const posterior = computePosterior(toResponseRecords(domainResponses), session.prior_mean, session.prior_sd);
    const correct = domainResponses.filter((response: any) => response.is_correct === true).length;

    domainReports[domain] = {
      theta: posterior.thetaEAP,
      se: posterior.se,
      n: domainResponses.length,
      correct,
    };
  }

  return {
    session,
    overall,
    domainReports,
    skillCounts: countSkills(responses),
    responses,
  };
}

export async function finalizeSession(supabase: any, sessionId: string, stopReason: string) {
  const report = await computeReport(supabase, sessionId);
  const tier = thetaToTier(report.overall.thetaEAP);

  await supabase
    .from('sessions')
    .update({
      completed_at: new Date().toISOString(),
      theta_end: report.overall.thetaEAP,
      theta_se_end: report.overall.se,
      items_administered: report.responses.length,
      stop_reason: stopReason,
      current_item_id: null,
      current_item_started_at: null,
    })
    .eq('id', sessionId);

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('total_sessions')
    .eq('id', report.session.user_id)
    .single();

  await supabase
    .from('user_profiles')
    .update({
      theta_global: report.overall.thetaEAP,
      theta_global_se: report.overall.se,
      theta_algebra: report.domainReports.Algebra.theta,
      theta_combinatorics: report.domainReports.Combinatorics.theta,
      theta_geometry: report.domainReports.Geometry.theta,
      theta_number_theory: report.domainReports['Number Theory'].theta,
      overall_tier: tier.tierNumber,
      total_sessions: (profile?.total_sessions ?? 0) + 1,
      last_active_at: new Date().toISOString(),
    })
    .eq('id', report.session.user_id);

  return report;
}

async function getSessionAndResponses(supabase: any, sessionId: string) {
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionError) throw sessionError;

  const { data: responses, error: responsesError } = await supabase
    .from('item_responses')
    .select('is_correct, domain, item_id, item_bank(a_param,b_param,c_param,d_param,q_matrix_tags)')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (responsesError) throw responsesError;
  return { session, responses: responses ?? [] };
}

async function loadCandidateItems(supabase: any, answeredIds: string[]) {
  let query = supabase
    .from('item_bank')
    .select('id, domain, a_param, b_param, c_param, d_param')
    .in('calibration_status', ['Warming', 'Calibrated', 'Anchored'])
    .eq('flagged_for_review', false)
    .not('b_param', 'is', null)
    .or('requires_diagram.eq.false,diagram_status.eq.complete');

  if (answeredIds.length > 0) {
    query = query.not('id', 'in', `(${answeredIds.join(',')})`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

function filterByContentBalance(candidates: any[], responses: any[], domainCounts: Record<Domain, number>) {
  const lastTwoDomains = responses.slice(-2).map((response: any) => response.domain);
  const avoidDomain = lastTwoDomains.length === 2 && lastTwoDomains[0] === lastTwoDomains[1]
    ? lastTwoDomains[0]
    : null;

  const underrepresented = DOMAINS.filter((domain) => domainCounts[domain] < MIN_DOMAIN_COUNTS[domain]);
  const belowMaximum = (item: any) => domainCounts[item.domain as Domain] < MAX_DOMAIN_COUNTS[item.domain as Domain];
  const notRepeated = (item: any) => !avoidDomain || item.domain !== avoidDomain;

  let eligible = candidates;

  if (underrepresented.length > 0) {
    eligible = candidates.filter((item) => underrepresented.includes(item.domain) && notRepeated(item));
    if (eligible.length > 0) return eligible;

    eligible = candidates.filter((item) => underrepresented.includes(item.domain));
    if (eligible.length > 0) return eligible;
  }

  eligible = candidates.filter((item) => belowMaximum(item) && notRepeated(item));
  if (eligible.length > 0) return eligible;

  eligible = candidates.filter(notRepeated);
  if (eligible.length > 0) return eligible;

  return candidates;
}

function toResponseRecords(rows: any[]): ResponseRecord[] {
  return rows.map((row) => ({
    item: toIRTItem(joinedItem(row)),
    isCorrect: row.is_correct === true,
  }));
}

function toIRTItem(item: any): IRTItem {
  return {
    a: Number(item?.a_param ?? 1),
    b: Number(item?.b_param ?? 0),
    c: Number(item?.c_param ?? 0),
    d: Number(item?.d_param ?? 1),
  };
}

function joinedItem(row: any) {
  return Array.isArray(row.item_bank) ? row.item_bank[0] : row.item_bank;
}

function countDomains(responses: any[]) {
  const counts = {
    Algebra: 0,
    Geometry: 0,
    Combinatorics: 0,
    'Number Theory': 0,
  } as Record<Domain, number>;

  for (const response of responses) {
    if (DOMAINS.includes(response.domain)) {
      counts[response.domain as Domain] += 1;
    }
  }

  return counts;
}

function countSkills(responses: any[]) {
  const counts: Record<string, { correct: number; total: number }> = {};

  for (const response of responses) {
    const item = joinedItem(response);
    const tags = Array.isArray(item?.q_matrix_tags) ? item.q_matrix_tags : [];

    for (const tag of tags) {
      if (!counts[tag]) counts[tag] = { correct: 0, total: 0 };
      counts[tag].total += 1;
      if (response.is_correct === true) counts[tag].correct += 1;
    }
  }

  return counts;
}

function selectionStop(stopReason: string, itemsAdministered: number, theta: number, se: number): SelectionResult {
  return {
    stop: true,
    stopReason,
    itemsAdministered,
    theta,
    se,
  };
}

function normalizeAnswer(value: string) {
  return value
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
