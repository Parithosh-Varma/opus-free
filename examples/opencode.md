# OpenCode usage

```sh
cp opencode.json.example ./opencode.json
opencode run --model puter/claude-haiku-5-5 "Explain this repo"
opencode run --model puter/claude-sonnet-5-5 "Refactor auth.ts"
```

Set defaults in `opencode.json`:

```json
{
  "model": "puter/claude-sonnet-5-5",
  "small_model": "puter/claude-haiku-5-5"
}
```
