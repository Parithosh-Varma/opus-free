# opus-free 🆓

> **Frontier models, free, in your terminal.** Use Claude Opus 5.5, Sonnet,
> Haiku, GPT, Gemini, DeepSeek and 900+ other models in
> [OpenCode](https://opencode.ai) — routed through your free
> [Puter](https://puter.com) account. No API keys to buy. No card. Ever.

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![No deps](https://img.shields.io/badge/deps-zero-orange)

---

## How it works

```text
OpenCode ──OpenAI/Anthropic API──▶ opus proxy :3001 ──▶ api.puter.com ──▶ Claude Opus 5.5 …
                                    ▲  ▲  ▲
                          tool calls │ cache │ cost meter
```

`opus` starts a zero-dependency local proxy that speaks the exact APIs
OpenCode expects (`/v1/chat/completions`, `/v1/messages`) and forwards calls
to Puter using free Puter account tokens — with **function calling**,
**request queueing with 429 backoff**, **prompt-cache breakpoints**, and
**live spend tracking** built in.

## ✨ Features

| | |
|---|---|
| 🔑 **One-click sign-in** | Proxy serves a page with a **Sign in to Puter** button — popup auth, token verified + saved automatically |
| 🛠️ **Full tool support** | OpenAI `tool_calls` and Anthropic `tool_use` blocks translated end-to-end, so OpenCode agents actually work |
| 💸 **Credit survival kit** | Prompt-cache breakpoints make repeat context ~5% price on Claude; Haiku default; per-call ¢ logging |
| 📊 **Live cost meter** | Sign-in page shows session requests/tokens/¢; `GET /api/usage` returns JSON totals per model |
| 🔁 **Pool + failover** | Round-robin across multiple Puter tokens, auto-failover on 402/429, serialized queue (Puter hates parallel calls) |

## 🚀 Quick start

```sh
git clone https://github.com/Parithosh-Varma/opus-free.git && cd opus-free
cp bin/opus ~/bin/opus          # or anywhere on your PATH
opus                            # start proxy + open sign-in page
```

Click **Sign in to Puter** → approve the popup → done. Then:

```sh
cp opencode.json.example ./opencode.json
opencode run --model puter/claude-haiku-5-5 "Reply with exactly: HI"
```

## 📖 `opus` CLI

| Command | Does |
|---|---|
| `opus` | Start proxy on `:3001`, open sign-in UI |
| `opus login` | Reopen the sign-in page anytime |
| `opus status` | Health, model count, saved tokens |
| `opus add-token <tok>` | Save a token manually (puter.com → DevTools → localStorage → `auth_token`) |
| `opus tokens` | List saved accounts (redacted) |
| `opus logs` / `opus stop` | Tail logs / stop proxy |

## 💰 Cost cheat-sheet

Puter prices (usd-cents / 1M tokens, in / out):

| Model | In | Out | Role |
|---|---|---|---|
| `claude-opus-5-5` | 400 | 2000 | hard problems only |
| `claude-sonnet-5-5` | 200 | 1000 | main driver — best value |
| `claude-haiku-5-5` | 10 | 50 | **default** + small tasks |
| `deepseek-v4-flash-0731` | 44 | 132 | cheap bulk |
| `gemini-2.5-flash-lite` | 10 | 40 | cheap bulk |
| `gpt-4o-mini` | 15 | 60 | cheap bulk |

> ⚠️ **Read this before your credits vanish:** every message re-sends the
> full conversation as input. A real session billed **158,231 input vs 139
> output tokens**. Mitigate with fresh sessions per task, `/compact` early,
> Haiku for small work — and cache breakpoints (already on) for the rest.

Free Puter accounts get a throttled daily allowance, and Puter now requires
phone verification, so realistically pool 1–3 accounts. `402
insufficient_funds` = dry pool → wait for reset or Switch-account to a second
account via `opus login`.

## 🔌 Endpoints

| Endpoint | Shape |
|---|---|
| `POST /v1/chat/completions` | OpenAI, tools supported |
| `POST /v1/messages` (+ `/anthropic/…`) | Anthropic, tools supported |
| `GET /v1/models` | live Puter model list (~995) |
| `GET /` | sign-in UI + spend meter |
| `GET /api/usage` | spend JSON · `POST /api/save-token` · `GET /healthz` |

Tokens load from `$PUTER_TOKEN` / `$PUTER_TOKENS` and pooled account storage;
the proxy never hardcodes credentials.

## 🛠️ Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `stream ended without finish_reason` (old versions) | empty stream on upstream error — fixed; update the proxy |
| `402 insufficient_funds` | dry pool → reset wait or second account |
| `429 Usage is reserved` | parallel calls on one account → proxy serializes + retries; add accounts |
| Sign-in popup blocked | call it from the button click (user gesture required) |

## ⚖️ Disclaimer

This pools **your own** Puter free allowance per account — respect Puter's
terms. It's a local dev proxy, not a service to share publicly.

## 📄 License

MIT — see [LICENSE](LICENSE).
