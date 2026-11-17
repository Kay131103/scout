# Scout — a research agent that reads Wikipedia for you

Give Scout a question and it plans, searches, reads and writes a sourced brief — a real
agentic loop (think → act → observe → repeat) streaming live to the browser.

- **Agent loop**: Cloudflare Workers AI (llama-3.1-8b-instruct-fast) on the free tier,
  speaking a strict JSON tool protocol; automatic repair prompts if the model breaks it.
- **Tools**: Wikipedia search + page extracts (public APIs, no keys).
- **Host**: Cloudflare Pages with a Pages Function for the agent endpoint — same origin,
  no CORS, no workers.dev, free.
- **Zero secrets in the browser** — inference happens server-side on the edge.

Live: scout.krithiuk.space · Part of the [krithiuk.space](https://portfolio.krithiuk.space) lab fleet.
