#!/bin/sh
# Plain chat (OpenAI shape)
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"Say HI"}],"max_tokens":50}'

# Streaming
curl -N http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"Count to 3"}],"stream":true,"max_tokens":100}'

# Tool calling
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"Weather in Paris?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}],"max_tokens":300}'

# Anthropic shape
curl http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-5-5","max_tokens":50,"messages":[{"role":"user","content":"Say HI"}]}'
