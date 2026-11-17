/* Scout — advanced-mode Pages Worker.
   POST /api/run runs the agent loop (Cloudflare Workers AI, free tier).
   Every other request is served from the static assets (the frontend). */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_STEPS = 7;

const SYS = `You are Scout, a careful research agent. Complete the user's TASK using tools.

Respond ONLY with one JSON object and nothing else:
{"thought": "<one sentence: what you know and what you still need>",
 "action": {"tool": "<search|read|finish>", "args": {...}}}

Tools:
- search: {"query": "<wikipedia search query>"} — find relevant pages
- read: {"title": "<exact wikipedia page title>"} — read a page's summary
- finish: {"answer": "<a clear, structured brief answering the task>", "sources": ["<wikipedia page titles used>"]}

Rules: exactly one action per response. search first, then read the best page.
finish ONLY when the answer fully covers the task. Thoughts under 30 words.`;

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/run" && request.method === "POST") {
      const { task } = await request.json().catch(() => ({ task: "" }));
      if (!task || typeof task !== "string" || task.length > 500)
        return jsonResp({ error: "provide a task (max 500 chars)" }, 400);
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (type, data) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
          try {
            await runAgent(env, task.slice(0, 500), send);
          } catch (err) {
            send("error", { text: `agent error: ${String(err).slice(0, 200)}` });
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- the agent loop ---------------- */

async function runAgent(env, task, send) {
  const messages = [
    { role: "system", content: SYS },
    { role: "user", content: `TASK: ${task}` },
  ];
  const sources = new Map();
  send("status", { text: "agent starting — assembling the context" });

  for (let step = 1; step <= MAX_STEPS; step++) {
    send("thought", { text: `step ${step}: thinking…` });
    const res = await env.AI.run(MODEL, { messages, max_tokens: 320, temperature: 0.2 });
    const raw = typeof res.response === "string" ? res.response : JSON.stringify(res);
    const parsed = extractJson(raw);

    if (!parsed || !parsed.action) {
      messages.push({ role: "assistant", content: raw.slice(0, 400) });
      messages.push({
        role: "user",
        content: `invalid format. reply with ONLY: {"thought":"...","action":{"tool":"search","args":{"query":"..."}}}`,
      });
      send("repair", { text: "the model broke the JSON protocol — sending a repair prompt" });
      continue;
    }

    messages.push({ role: "assistant", content: raw.slice(0, 500) });
    send("thought", { text: (parsed.thought || "").slice(0, 300) });

    const { tool, args } = parsed.action;

    if (tool === "search") {
      const q = String(args?.query || "").slice(0, 120);
      send("action", { tool: "search", args: { query: q } });
      const r = await wikiSearch(q);
      send("observation", { text: r.text, items: r.items });
      for (const it of r.items)
        sources.set(it.title, `https://en.wikipedia.org/wiki/${it.title.replaceAll(" ", "_")}`);
      messages.push({ role: "user", content: `OBSERVATION (search "${q}"):\n${r.text}` });
    } else if (tool === "read") {
      const title = String(args?.title || "").slice(0, 150);
      send("action", { tool: "read", args: { title } });
      const r = await wikiRead(title);
      send("observation", { text: r.text });
      if (r.ok) sources.set(r.title, `https://en.wikipedia.org/wiki/${r.title.replaceAll(" ", "_")}`);
      messages.push({ role: "user", content: `OBSERVATION (read "${title}"):\n${r.text}` });
    } else if (tool === "finish") {
      send("action", { tool: "finish", args: {} });
      send("final", {
        text: String(args?.answer || "").slice(0, 4000),
        sources: [...sources.entries()].map(([title, url]) => ({ title, url })),
      });
      return;
    } else {
      send("observation", { text: `unknown tool "${tool}" — use search, read or finish` });
      messages.push({ role: "user", content: `OBSERVATION: unknown tool "${tool}". use search, read or finish.` });
    }
  }
  send("final", {
    text: "the agent hit its step limit before finishing. try a narrower task.",
    sources: [...sources.entries()].map(([title, url]) => ({ title, url })),
  });
}

/* ---------------- robust JSON extraction ---------------- */

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < c.length; i++) {
      if (c[i] === "{") depth++;
      else if (c[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/* ---------------- wikipedia tools (public APIs, no keys) ---------------- */

async function wikiSearch(q) {
  const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=3`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "scout-agent-lab" } });
    const j = await r.json();
    const items = (j.pages || []).map((p) => ({
      title: p.title,
      snippet: (p.excerpt || "").replace(/<[^>]+>/g, "").slice(0, 180),
    }));
    return {
      items,
      text: items.length
        ? items.map((it, i) => `${i + 1}. ${it.title} — ${it.snippet}…`).join("\n")
        : "no pages found — try a different query",
    };
  } catch (e) {
    return { items: [], text: `search failed: ${String(e).slice(0, 100)}` };
  }
}

async function wikiRead(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsentences=6&format=json&redirects=1&titles=${encodeURIComponent(title)}&origin=*`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "scout-agent-lab" } });
    const j = await r.json();
    const pages = j.query?.pages || {};
    const first = Object.values(pages)[0];
    if (!first || first.missing)
      return { ok: false, title, text: `no wikipedia page titled "${title}" — try search first` };
    const extract = (first.extract || "").replace(/\n+/g, " ").slice(0, 900);
    return { ok: true, title: first.title, text: extract || "(empty extract)" };
  } catch (e) {
    return { ok: false, title, text: `read failed: ${String(e).slice(0, 100)}` };
  }
}
