# GTA VI trophy rarity — week-one forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Cihuy378/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Cihuy378/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast how many GTA VI players earn each trophy in week one: for every one of the game's 55 PlayStation 5 trophies, five quantiles (5%, 25%, 50%, 75%, 95%) of its Exophase earn rate at 2026-11-26T00:00:00Z, from everything the house recorded up to the deadline.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads one case (`/input/<id>.in`) and writes `/output/<id>.out`. It runs offline — everything it knows is in the case file. Deterministic: two runs on the same input write identical bytes. Runtime is well under the 8-second cap (about 0.2 s per case on the practice set).

## Method

**A rate is a share, not a count.** Each trophy's rate is earners divided by tracked players, and both move: the tracked base floods with new players (which drags every rate down) while the early cohort works through the story (which pushes rates up). The forecaster separates the two by rebuilding the earner count behind each rate, then works in a saturating scale.

**Ceiling first.** Every trophy gets a plausible week-one ceiling from its tier and description: chapter trophies high and falling with chapter number (chapter 1 can reach most of the base in a week, the finale far fewer), final-mission and 100%-completion golds low, grinds ("250 Stunts") very low, casual activities in between. The ceiling is a prior, never a hard wall — the reported quantiles are spread in plain logit space, so the tails may pass it, and a trophy already above its prior ceiling is never capped below where it stands.

**Recency-weighted velocity, then decay.** Motion is measured as a recency-weighted least-squares slope of the ceiling-logit rate against time, shrunk toward zero when the history is short or flat. The slope is extrapolated over the horizon, but the velocity is assumed to fade with a ~30-hour time constant: a 90-minute practice horizon is barely touched, while the 4.5-day final horizon gets about 30 hours of full-pace growth instead of 108. A trophy already at 100% is forecast at the scorer's 99.99 clamp with a lopsided spread (almost no room above, real dilution risk below).

**Honest spread.** Quantiles widen with the square root of the horizon and with how noisy the trophy's own history was: 0.45 logit units per root-day plus the trophy's residual scatter.

## Validation

The practice cases carry no signal at all — every rate is constant across every read (638 tracked players, launch night) — so they only validate format and determinism. Under the flat-answer assumption (the answer read equals the last read) the practice pinball loss is 0.0116 per case, against the house persistence baseline's 0.0124.

Because the practice set cannot test the trend machinery, the forecaster was also run on two synthetic final-like cases (2.5 days of 30-minute reads, players 638 → 60,000, target 4.5 days ahead): one front-loaded growth curve and one S-curve with the bulk of growth in days 2–5. Mean pinball loss: 0.127 vs the baseline's 0.136 on the first, 0.285 vs 0.463 on the second. The trend logic beats persistence on both shapes; the remaining error is honest spread around genuinely uncertain week-one movement.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
