from openai import OpenAI  # pip install openai

client = OpenAI(base_url="http://127.0.0.1:3001/v1", api_key="dummy")
r = client.chat.completions.create(
    model="claude-haiku-5-5",
    messages=[{"role": "user", "content": "Say HI"}],
    max_tokens=50,
)
print(r.choices[0].message.content)
