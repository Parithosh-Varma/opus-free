# opus-free — frontier models for free in OpenCode

Use **Claude Opus 5.5, Sonnet, Haiku, GPT, Gemini, DeepSeek** and 900+ other
models in [OpenCode](https://opencode.ai) for free, via pooled
[Puter](https://puter.com) accounts. No API keys to buy, no card.

How it works: `opus` starts a local proxy (`127.0.0.1:3001`) that speaks the
OpenAI + Anthropic APIs OpenCode expects, and forwards calls to Puter with
your free Puter account token(s) — with tool-call support, request queueing,
prompt-cache breakpoints, and live cost tracking.

## Quick start

```sh
git clone https://github.com/<you>/opus-free.git && cd opus-free
cp bin/opus ~/bin/opus   # or anywhere on your PATH
opus                     # start proxy + open sign-in page
```

Click **Sign in to Puter**, approve the popup. Token is verified and saved
automatically. Then in a project with the example config:

```sh
cp opencode.json.example ./opencode.json
opencode run --model puter/claude-haiku-5-5 "Reply with exactly: HI"
```

More commands: `opus status` · `opus login` (reopen sign-in) ·
`opus add-token <tok>` (manual) · `opus stop` · `opus logs`.

## Why credits vanish (read this)

Every message re-sends the full conversation as input. Real example from the
Puter dashboard: **158,231 input tokens vs 139 output** in one session. The
proxy stamps prompt-cache breakpoints so the static system+tools prefix bills
~5% on repeats (Claude), and the default model is Haiku — but a long session
on Opus still drains a free account. Fresh sessions per task, `/compact`
early, Haiku for small work.

Puter free accounts have a throttled daily allowance, and Puter now asks for
phone verification — so pool realistically 1–3 accounts. `402
insufficient_funds` = dry pool: wait for reset or Switch-account to a second
account (`opus login`).

## Cost cheat-sheet (Puter, usd-cents / 1M tokens in/out)

| Model | In | Out | Use |
|---|---|---|---|
| claude-opus-5-5 | 400 | 2000 | hard problems only |
| claude-sonnet-5-5 | 200 | 1000 | main driver, best value |
| claude-haiku-5-5 | 10 | 50 | default + small tasks |
| deepseek-v4-flash | 44 | 132 | cheap bulk |
| gemini-2.5-flash-lite | 10 | 40 | cheap bulk |
| gpt-4o-mini | 15 | 60 | cheap bulk |

Live spend: the sign-in page shows session requests/tokens/¢, and
`GET :3001/api/usage` returns JSON totals.

## Endpoints

- `POST /v1/chat/completions` — OpenAI shape, tools supported
- `POST /v1/messages` — Anthropic shape, tools supported
- `GET /v1/models` — live Puter model list
- `GET /` — sign-in UI · `GET /api/usage` — spend · `POST /api/save-token`

## Disclaimer

Free-tier pooling lives within Puter's free allowance per account. Respect
Puter's terms; this is a local dev proxy, not a service to share publicly.
