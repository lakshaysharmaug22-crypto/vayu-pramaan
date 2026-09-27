"""Diagnose the LLM endpoint from inside Actions: status, redirects, body head. No secrets printed."""
import os
import requests

tok = os.environ["GITHUB_TOKEN"]
body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Reply with the word pong."}]}
for url, model in [("https://models.github.ai/inference/chat/completions", "openai/gpt-4o-mini"),
                   ("https://models.inference.ai.azure.com/chat/completions", "gpt-4o-mini")]:
    r = requests.post(url, json=body | {"model": model}, timeout=60, allow_redirects=False,
                      headers={"Authorization": f"Bearer {tok}", "Accept": "application/json"})
    print(url, r.status_code, r.headers.get("content-type"), r.headers.get("location"), repr(r.text[:200]))
