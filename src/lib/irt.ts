export interface IRTItem {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface ResponseRecord {
  item: IRTItem;
  isCorrect: boolean;
}

export interface PosteriorResult {
  thetaEAP: number;
  se: number;
  grid: number[];
  posterior: number[];
}

const GRID_MIN = -4;
const GRID_MAX = 4;
const GRID_STEP = 0.05;

export function probCorrect(theta: number, item: IRTItem) {
  const a = finiteOr(item.a, 1);
  const b = finiteOr(item.b, 0);
  const c = clamp(finiteOr(item.c, 0), 0, 0.95);
  const d = clamp(finiteOr(item.d, 1), c + 1e-6, 1);
  const logistic = 1 / (1 + Math.exp(-a * (theta - b)));

  return clamp(c + (d - c) * logistic, 1e-9, 1 - 1e-9);
}

export function fisherInformation(theta: number, item: IRTItem) {
  const a = finiteOr(item.a, 1);
  const c = clamp(finiteOr(item.c, 0), 0, 0.95);
  const d = clamp(finiteOr(item.d, 1), c + 1e-6, 1);
  const p = probCorrect(theta, item);
  const denom = (d - c) ** 2 * p * (1 - p);

  if (denom <= 1e-12) return 0;
  return (a ** 2) * (p - c) ** 2 * (d - p) ** 2 / denom;
}

export function buildGrid() {
  const grid: number[] = [];
  for (let theta = GRID_MIN; theta <= GRID_MAX + 1e-9; theta += GRID_STEP) {
    grid.push(Math.round(theta * 1000) / 1000);
  }
  return grid;
}

export function computePosterior(
  responses: ResponseRecord[],
  priorMean: number,
  priorSd: number
): PosteriorResult {
  const grid = buildGrid();
  const safePriorSd = Math.max(finiteOr(priorSd, 1.5), 0.1);
  const safePriorMean = finiteOr(priorMean, 0);

  const logUnnormalized = grid.map((theta) => {
    let logLikelihood = normalLogPdf(theta, safePriorMean, safePriorSd);

    for (const response of responses) {
      const p = probCorrect(theta, response.item);
      logLikelihood += response.isCorrect ? Math.log(p) : Math.log(1 - p);
    }

    return logLikelihood;
  });

  const maxLog = Math.max(...logUnnormalized);
  const unnormalized = logUnnormalized.map((value) => Math.exp(value - maxLog));
  const totalMass = unnormalized.reduce((sum, value) => sum + value, 0) * GRID_STEP;
  const posterior = unnormalized.map((value) => value / totalMass);

  let mean = 0;
  for (let i = 0; i < grid.length; i += 1) {
    mean += grid[i] * posterior[i] * GRID_STEP;
  }

  let variance = 0;
  for (let i = 0; i < grid.length; i += 1) {
    variance += (grid[i] - mean) ** 2 * posterior[i] * GRID_STEP;
  }

  return {
    thetaEAP: mean,
    se: Math.sqrt(Math.max(variance, 0)),
    grid,
    posterior,
  };
}

export function expectedInformation(item: IRTItem, grid: number[], posterior: number[]) {
  let information = 0;
  for (let i = 0; i < grid.length; i += 1) {
    information += fisherInformation(grid[i], item) * posterior[i] * GRID_STEP;
  }
  return information;
}

function normalLogPdf(value: number, mean: number, sd: number) {
  const z = (value - mean) / sd;
  return -0.5 * Math.log(2 * Math.PI) - Math.log(sd) - 0.5 * z * z;
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
