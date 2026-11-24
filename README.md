# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zavonlame/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zavonlame/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Pump.fun Replay Sprint paper bot: buys new bonding-curve coins early, but only when the entry is smooth, and banks the move with a tight trailing exit. A coin first becomes buyable when its real SOL reserve reaches 1 SOL (the harness caps each order at 1% of real reserve, and a round trip only counts at 0.01 SOL or more); on that first buyable batch it buys a small 0.05 SOL starter — but only if the batch-end price sits within 1% of the coin's first trade in the batch and the trigger price sits within 5% of the price three trades earlier, with a 1% buy-slippage limit so the harness refuses spike-top fills in the 2-slot latency. One shot per mint, at most 5 open positions. Fifty slots after entry it triages by velocity (fewer than 20 trades since entry means the coin went quiet — sell); survivors keep a tight 3% trailing exit and a 3000-slot maximum hold. Fully deterministic — no clock, no randomness, no network — every decision comes from the hello / batch / orders / slot stream the harness sends. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
