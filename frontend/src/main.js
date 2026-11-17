const $ = (sel) => document.querySelector(sel);

function card(kind, text) {
  const el = document.createElement("div");
  el.className = "card " + kind;
  const labels = { thought: "thought", action: "action", obs: "observation", status: "status", repair: "protocol repair", error: "error", final: "final brief" };
  el.innerHTML = `<div class="kind">${labels[kind] || kind}</div><div class="body">${escapeHtml(text)}</div>`;
  $("#trace").appendChild(el);
  $("#trace").scrollTop = $("#trace").scrollHeight;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBrief(brief) {
  const el = document.createElement("div");
  el.className = "panel brief";
  const srcs = (brief.sources || [])
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">▸ ${escapeHtml(s.title)}</a>`)
    .join("");
  el.innerHTML = `<h4>the brief</h4><div class="body">${escapeHtml(brief.text)}</div>
    ${srcs ? `<div class="srcs"><div class="kind" style="font:700 10.5px 'JetBrains Mono';color:var(--faint);margin-bottom:6px">SOURCES</div>${srcs}</div>` : ""}`;
  $("#final").appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

let running = false;

async function run() {
  if (running) return;
  const task = $("#task").value.trim();
  if (!task) { $("#task").focus(); return; }
  running = true;
  $("#runBtn").disabled = true;
  $("#runBtn").textContent = "scout is working…";
  $("#trace").innerHTML = "";
  $("#final").innerHTML = "";

  const started = Date.now();
  let steps = 0;
  let toolCalls = 0;
  let lastKind = "";

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;

    while (!done) {
      const { value, done: rd } = await reader.read();
      if (rd) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith("data: ")) continue;
        let ev;
        try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }

        if (ev.type === "thought") {
          if (lastKind === "status") { /* keep the thinking line compact */ }
          card("thought", ev.text);
          steps++;
        } else if (ev.type === "action") {
          card("action", `${ev.tool}(${JSON.stringify(ev.args || {})})`);
          toolCalls++;
        } else if (ev.type === "observation") {
          card("obs", ev.text.slice(0, 600));
        } else if (ev.type === "status") {
          card("status", ev.text);
        } else if (ev.type === "repair") {
          card("repair", ev.text);
        } else if (ev.type === "error") {
          card("error", ev.text);
          done = true;
        } else if (ev.type === "final") {
          card("final", "done — writing the brief");
          renderBrief(ev);
          done = true;
        }
        lastKind = ev.type;
      }
    }

    const secs = Math.round((Date.now() - started) / 1000);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${steps} thoughts · ${toolCalls} tool calls · ${secs}s · inference on cloudflare's free edge`;
    $("#final").appendChild(meta);
  } catch (err) {
    card("error", `could not reach the agent: ${err.message}`);
  }
  running = false;
  $("#runBtn").disabled = false;
  $("#runBtn").textContent = "⌕ send scout";
}

document.querySelectorAll(".ex").forEach((el) =>
  el.addEventListener("click", () => { $("#task").value = el.textContent; $("#task").focus(); })
);
$("#runBtn").addEventListener("click", run);
$("#task").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });
