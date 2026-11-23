# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kingsmandrx/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kingsmandrx/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks pre-token protocols by implied value — what a protocol's token would be worth if its record stayed as it is — and gives every protocol a concrete farm plan with costs and time. Built from the sealed 2026-11-14 DefiLlama snapshot: 200 ranked protocols (40 on the watchlist, 160 early), with 24 already-issued tokens set aside on their own page. The value model derives its base multiple (0.082) from the snapshot's own tokenized protocols — the median market-cap-to-TVL ratio — then adjusts for 7-day growth and age. No token launch is predicted; implied value is a model estimate, not a price.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Requires Node.js 22.18 or later. The program reads the sealed snapshot, scores every pre-token protocol, writes the ranked board to `out/board.json`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json`. Open `out/dashboard/index.html` to browse the radar: search, filter by category, chain, age and scope, sort by any column, and open any row for its model inputs and farm plan.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
