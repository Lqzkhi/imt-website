export interface ScratchSection {
  status: string;
  expires_at: string;
  working_ended_at?: string | null;
  submitted_at?: string | null;
  scratch_file_count?: number;
  disqualified_at?: string | null;
}

// This reports the scratch-paper requirement only; organizers still review work and final-round selection.
export function scratchEligibility(sections: { computational?: ScratchSection; proof?: ScratchSection }, now = Date.now()) {
  const missing: string[] = [];
  let pending = false;
  for (const name of ['computational', 'proof'] as const) {
    const section = sections[name];
    if (section?.disqualified_at) return { status: 'ineligible' as const, label: 'Ineligible — disqualified attempt' };
    if ((section?.scratch_file_count ?? 0) > 0) continue;
    const ended = section?.working_ended_at ? Date.parse(section.working_ended_at)
      : section?.status !== 'in_progress' && section?.submitted_at ? Math.min(Date.parse(section.submitted_at), Date.parse(section.expires_at))
      : section && Date.parse(section.expires_at) <= now ? Date.parse(section.expires_at) : NaN;
    if (Number.isFinite(ended) && ended + 30 * 60_000 <= now) missing.push(name);
    else pending = true;
  }
  if (missing.length) return { status: 'ineligible' as const, label: 'Ineligible — missing ' + missing.join(' and ') + ' scratch paper' };
  if (pending) return { status: 'pending' as const, label: 'Pending — scratch uploads required for both sections' };
  return { status: 'complete' as const, label: 'Scratch requirement met — review work before awarding or qualifying' };
}
