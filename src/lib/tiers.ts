export interface TierInfo {
  tier: string;
  tierNumber: number;
  label: string;
}

const TIER_BOUNDARIES = [
  { max: -2.2, tierNumber: 1, label: 'Tier I - Foundation' },
  { max: -1.0, tierNumber: 2, label: 'Tier II - AMC 8 Proficient' },
  { max: -0.1, tierNumber: 3, label: 'Tier III - AMC 10/12 Developing' },
  { max: 0.7, tierNumber: 4, label: 'Tier IV - AMC 10/12 Competitive' },
  { max: 1.3, tierNumber: 5, label: 'Tier V - AIME Qualifier' },
  { max: 2.1, tierNumber: 6, label: 'Tier VI - AIME Advanced' },
  { max: 3.0, tierNumber: 7, label: 'Tier VII - Olympiad' },
  { max: Infinity, tierNumber: 8, label: 'Tier VIII - Elite Olympiad' },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

export function thetaToTier(theta: number): TierInfo {
  const boundary = TIER_BOUNDARIES.find((entry) => theta < entry.max) ?? TIER_BOUNDARIES.at(-1)!;

  return {
    tier: `Tier ${ROMAN[boundary.tierNumber - 1]}`,
    tierNumber: boundary.tierNumber,
    label: boundary.label,
  };
}
