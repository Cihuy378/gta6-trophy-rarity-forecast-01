// GTA VI trophy rarity forecast: earners-over-players forecaster with a
// saturating ceiling and a recency-weighted velocity.
//
// What the program sees in one case: every Exophase read the house made
// before the checkpoint, oldest first. Each read lists, for all 55 trophies,
// the percent of tracked players who hold it, plus how many players the
// tracker follows. The target is days ahead of the checkpoint in the final
// case, so the forecast has to say where each trophy's share is heading, not
// just where it sits now.
//
// The shape of the problem
// ------------------------
// A trophy's rate is a share: earners divided by tracked players. Both
// numbers move. Early on the tracked base is tiny and hardcore (638 players
// on launch night), then it floods with ordinary players who have earned
// almost nothing yet, which drags every rate down even while the earner
// count climbs. Later, as the flood slows and the early cohort works through
// the story, rates climb again. So a rate's path is not a straight line in
// any scale: it bends toward a ceiling that depends on what the trophy asks
// for. A chapter trophy can plausibly reach most of the player base within a
// week; a 100%-completion platinum cannot.
//
// Forecast, per trophy
// --------------------
// 1. Rebuild the earner count behind each rate (rate x players tracked) so
//    dilution and genuine progress are not confused with each other.
// 2. Pick a ceiling for the trophy from its tier and its description: story
//    chapters high and falling with chapter number, final-mission and
//    100%-completion golds low, grind counts ("250 Stunts") very low, casual
//    activities in between. The ceiling is a prior, never a hard wall: the
//    reported quantiles are spread in plain logit space around the median,
//    so the tails may pass it.
// 3. Measure the trophy's recent motion in ceiling-logit space,
//    log(rate / (ceiling - rate)), with a recency-weighted least-squares
//    slope over the history. Recent reads count more than launch-night
//    reads, because the launch-night cohort is unrepresentative, and the
//    slope is shrunk toward zero when the history is short or flat.
// 4. Extrapolate the shrunk slope over the horizon, damped so a short
//    history cannot project a wild move, and cap the total logit move.
// 5. Spread the five quantiles with a normal scale that grows with the
//    square root of the horizon and with how noisy the trophy's own history
//    was. A 90-minute practice horizon gets a narrow spread; the 4.5-day
//    final horizon gets an honest wide one.
//
// Nothing here is tuned on the practice answers: the practice cases are
// perfectly flat (every rate constant across every read), so they carry no
// velocity signal at all and any slope fitted to them is zero by
// construction. The constants below are judgements about week-one play,
// set before seeing any answer.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// The five levels the scorer asks for, and the standard normal's quantiles.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const ZED = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface TrophyInfo {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
}

interface HistoryRead {
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface TrophyCase {
  levels: number[];
  horizon_minutes: number;
  trophies: TrophyInfo[];
  history: HistoryRead[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logitOf = (pct: number): number => {
  const c = clampPct(pct);
  return Math.log(c / (100 - c));
};
const sigmoidPct = (y: number): number => 100 / (1 + Math.exp(-y));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// A trophy's plausible week-one ceiling, in percent, from what it asks for.
// Chapter trophies fall with chapter number: most tracked players reach
// chapter 1 within a week, far fewer reach the finale. Grinds and
// 100%-completion sit near the floor. Everything is floored above the rate
// already observed, so a trophy that is already popular is never capped
// below where it stands.
function ceilingFor(t: TrophyInfo, seen: number): number {
  const d = `${t.name} ${t.description}`.toLowerCase();
  let cap: number;
  if (t.tier === "platinum" || /100% completion/.test(d)) {
    cap = 4;
  } else if (/final mission/.test(d)) {
    cap = 20;
  } else if (/chapter (\d)/.test(d)) {
    const n = Number(/chapter (\d)/.exec(d)?.[1] ?? 1);
    cap = 90 - 10 * (n - 1);
  } else if (/250 stunts/.test(d)) {
    cap = 5;
  } else if (/gold medal in all/.test(d)) {
    cap = 7;
  } else if (/win 20/.test(d)) {
    cap = 12;
  } else if (/every location/.test(d)) {
    cap = 14;
  } else if (/8 mission strands/.test(d)) {
    cap = 18;
  } else if (/every spot/.test(d) || /unique animal/.test(d)) {
    cap = 13;
  } else if (/try each type of activity/.test(d)) {
    cap = 38;
  } else if (/arcade game/.test(d) || /fishing challenge/.test(d)) {
    cap = 30;
  } else if (t.tier === "gold") {
    cap = 26;
  } else if (t.tier === "silver") {
    cap = 20;
  } else {
    cap = 32;
  }
  cap = Math.min(92, Math.max(2, cap));
  // A trophy already above its prior ceiling is never capped below where it
  // stands: the floor follows the observed rate up to 99.99.
  return Math.max(cap, Math.min(99.99, seen + 2));
}

// Recency-weighted slope of y against time (hours), with the weights
// decaying over the newer half of the span. Returns the slope and the
// residual scatter around the fitted line.
function weightedSlope(
  timesH: number[],
  ys: number[],
): { slope: number; scatter: number } {
  const n = timesH.length;
  if (n < 2) return { slope: 0, scatter: 0 };
  const span = timesH[n - 1] - timesH[0];
  const halfLife = Math.max(2, span / 3);
  const w = timesH.map((t) => Math.pow(0.5, (timesH[n - 1] - t) / halfLife));
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    sx += w[i] * timesH[i];
    sy += w[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += w[i] * (timesH[i] - mx) * (timesH[i] - mx);
    sxy += w[i] * (timesH[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-9) return { slope: 0, scatter: 0 };
  const slope = sxy / sxx;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const fit = my + slope * (timesH[i] - mx);
    rss += w[i] * (ys[i] - fit) * (ys[i] - fit);
  }
  return { slope, scatter: Math.sqrt(rss / sw) };
}

function forecastOne(
  trophy: TrophyInfo,
  position: number,
  history: HistoryRead[],
  horizonH: number,
): number[] {
  // `rates` follows the order of `trophies` in the case, so index by the
  // trophy's position in that list, never by its id.
  const idx = position;
  // Carry the last non-null rate forward through gaps; trophies appear in
  // `trophies` order, so index by position, not by id.
  const series: Array<{ tH: number; rate: number; players: number }> = [];
  let lastRate: number | null = null;
  const t0 = history.length > 0 ? Date.parse(history[0].at) : 0;
  for (const read of history) {
    const r = read.rates[idx];
    if (r !== null && r !== undefined && Number.isFinite(r)) lastRate = r;
    if (lastRate === null) continue;
    series.push({
      tH: (Date.parse(read.at) - t0) / 3600000,
      rate: lastRate,
      players: read.players_tracked,
    });
  }
  if (series.length === 0) {
    // No read ever listed this trophy: a wide, low forecast from the tier.
    const cap = ceilingFor(trophy, 0.5);
    const mid = cap * 0.15;
    const spread = 0.9 * Math.sqrt(Math.max(horizonH, 1) / 24) + 0.3;
    return ZED.map((z) => round4(clampPct(sigmoidPct(logitOf(mid) + z * spread))));
  }

  const now = series[series.length - 1];
  const spanH = Math.max(0, now.tH - series[0].tH);

  // A trophy the tracked base has already saturated (100% on launch night
  // is one trophy here) lives at the top of the logit scale, where a tenth
  // of a point is a whole logit unit: the ceiling transform would shave it
  // to 99.9 and pay a logit-scale penalty for nothing. Forecast it at the
  // scorer's clamp, 99.99, with a lopsided spread: almost no room above,
  // real dilution risk below as fresh players join who have not earned it
  // yet. The lower tail widens with the horizon; the upper tail stays put.
  if (now.rate >= 99.9) {
    const horizonDays = Math.max(horizonH, 0.25) / 24;
    const spread = Math.sqrt(0.45 * 0.45 * horizonDays + 0.02 * 0.02);
    const mid = logitOf(99.99);
    const qs = ZED.map((z) =>
      round4(clampPct(sigmoidPct(mid + z * (z < 0 ? spread * 3 : spread * 0.3)))),
    );
    for (let i = 1; i < qs.length; i++) {
      if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
    }
    return qs;
  }

  const cap = ceilingFor(trophy, now.rate);

  // Motion in ceiling-logit space, where a trophy approaching its ceiling
  // slows down instead of running away in a straight line.
  const ceilingLogit = (pct: number): number => {
    const c = Math.min(cap - 0.01, Math.max(0.01, pct));
    return Math.log(c / (cap - c));
  };
  const ys = series.map((s) => ceilingLogit(s.rate));
  const { slope, scatter } = weightedSlope(
    series.map((s) => s.tH),
    ys,
  );

  // Shrinkage: a flat or very short history earns no extrapolation, and a
  // slope only counts in proportion to how much history backs it. The
  // effective sample grows with the number of reads and with the span.
  const support = Math.min(1, series.length / 12) * Math.min(1, spanH / 24);
  const shrunkSlope = slope * support;
  // A short history cannot project a wild move: damp the projected delta
  // toward persistence, then cap it outright.
  const horizonWeight = Math.min(1, spanH / 12);
  // Growth decays: a trophy's recent climb does not hold its pace for
  // four and a half days. The velocity is assumed to fade with a ~30-hour
  // time constant, so the effective horizon saturates near 30 hours of
  // full-pace growth instead of the whole 108. A 90-minute practice horizon
  // is barely touched by this; the final horizon is cut to about a third.
  const TAU_H = 30;
  const effectiveH = TAU_H * (1 - Math.exp(-horizonH / TAU_H));
  let delta = shrunkSlope * effectiveH * horizonWeight;
  delta = Math.max(-2.5, Math.min(2.5, delta));
  const medianRate = cap / (1 + Math.exp(-(ceilingLogit(now.rate) + delta)));

  // Spread: a base rate of 0.45 logit units per root-day, plus the trophy's
  // own residual scatter (noisy histories forecast wider), plus a floor so
  // even a dead-flat history admits that the week can still move.
  const horizonDays = Math.max(horizonH, 0.25) / 24;
  const vol = Math.min(0.6, Math.max(0, scatter));
  const spread = Math.sqrt((0.45 * 0.45 + vol * vol) * horizonDays + 0.02 * 0.02);
  const mid = logitOf(medianRate);
  const qs = ZED.map((z) => round4(clampPct(sigmoidPct(mid + z * spread))));
  // Keep the row non-decreasing after rounding.
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

mkdirSync(OUT_DIR, { recursive: true });
const files = readdirSync(IN_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of files) {
  const id = file.slice(0, -".in".length);
  const kase = JSON.parse(readFileSync(join(IN_DIR, file), "utf8")) as TrophyCase;
  if (kase.levels.length !== LEVELS.length) {
    throw new Error(`${file} asks for ${kase.levels.length} levels, not ${LEVELS.length}`);
  }
  const horizonH = kase.horizon_minutes / 60;
  const rows = kase.trophies.map((t, i) => {
    return { id: t.id, q: forecastOne(t, i, kase.history, horizonH) };
  });
  // Sort rows by id so the output order is stable regardless of input order.
  rows.sort((a, b) => a.id - b.id);
  writeFileSync(join(OUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: rows })}\n`);
}
