const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let stepCount = 0;
let toolCount = 0;
let running = false;

function setPulse(text, live) {
  const p = $("#pulse");
  p.querySelector("span").textContent = text;
  p.classList.toggle("live", !!live);
}

function addStep(kind, bodyHtml) {
  stepCount++;
  const el = document.createElement("div");
  el.className = "step " + kind;
  el.innerHTML = `<div class="node"></div><div class="card ${kind}"><div class="kind">${kind === "obs" ? "observation" : kind}</div><div class="body"></div></div>`;
  const body = el.querySelector(".body");
  body.innerHTML = bodyHtml;
  $("#trace").appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return el;
}

function addThought(text, thinking = false) {
  const el = addStep("thought", escapeHtml(text) + (thinking ? `<div class="typing"><i></i><i></i><i></i></div>` : ""));
  return el;
}

function addAction(tool, args) {
  toolCount++;
  const argsStr = args && Object.keys(args).length ? escapeHtml(JSON.stringify(args)) : "";
  addStep("action", `${escapeHtml(tool)}(${argsStr})`);
}

function addObservation(text) {
  const el = addStep("obs", "");
  const body = el.querySelector(".body");
  if (text.length > 260) {
    body.classList.add("clipped");
    body.textContent = text.slice(0, 260) + " …";
    const more = document.createElement("span");
    more.className = "more";
    more.textContent = "show full observation";
    more.addEventListener("click", () => {
      const open = body.classList.toggle("clipped");
      body.textContent = open ? text.slice(0, 260) + " …" : text;
      more.textContent = open ? "show full observation" : "collapse";
    });
    body.after(more);
  } else {
    body.textContent = text;
  }
}

function renderBrief(brief, stats) {
  const el = document.createElement("div");
  el.className = "brief-wrap";
  const srcs = (brief.sources || [])
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.title)}</a>`)
    .join("");
  el.innerHTML = `<div class="brief">
    <div class="tag">Scout's brief</div>
    <div class="body">${escapeHtml(brief.text)}</div>
    ${srcs ? `<div class="srcs"><div class="label">sources — wikipedia</div>${srcs}</div>` : ""}
  </div>`;
  $("#final").appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  const statsEl = document.createElement("div");
  statsEl.className = "panel stats-panel";
  statsEl.style.marginTop = "14px";
  statsEl.innerHTML = `<div class="stats">
    <div class="stat"><div class="v">${stats.steps}</div><div class="l">thoughts</div></div>
    <div class="stat"><div class="v">${stats.toolCalls}</div><div class="l">tool calls</div></div>
    <div class="stat"><div class="v">${(brief.sources || []).length}</div><div class="l">sources</div></div>
    <div class="stat"><div class="v">${stats.secs}s</div><div class="l">duration</div></div>
  </div>`;
  $("#final").appendChild(statsEl);
}

async function run() {
  if (running) return;
  const task = $("#task").value.trim();
  if (!task) { $("#task").focus(); return; }
  running = true;
  stepCount = 0; toolCount = 0;
  $("#runBtn").disabled = true;
  $("#runBtn").textContent = "Scout is working…";
  $("#trace").innerHTML = "";
  $("#final").innerHTML = "";
  setPulse("agent running", true);
  addStep("status", "assembling the context — model loading on the edge");

  const started = Date.now();
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
    let thinkEl = null;

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
          if (thinkEl && lastKind === "thought") {
            // the "step n: thinking…" line updates into the real thought
            thinkEl.querySelector(".body").innerHTML = escapeHtml(ev.text);
            thinkEl = null;
          } else {
            thinkEl = addThought(ev.text);
          }
          stepCount++;
        } else if (ev.type === "action") {
          thinkEl = null;
          addAction(ev.tool, ev.args);
          toolCount++;
          setPulse(`${ev.tool}…`, true);
        } else if (ev.type === "observation") {
          thinkEl = null;
          addObservation(ev.text.slice(0, 1200));
          setPulse("reading the observation", true);
        } else if (ev.type === "status") {
          addStep("status", ev.text);
          setPulse(ev.text.slice(0, 40), true);
        } else if (ev.type === "repair") {
          thinkEl = null;
          addStep("error", ev.text);
        } else if (ev.type === "error") {
          thinkEl = null;
          addStep("error", ev.text);
          done = true;
        } else if (ev.type === "final") {
          thinkEl = null;
          setPulse("writing the brief", true);
          const secs = Math.round((Date.now() - started) / 1000);
          renderBrief(ev, { steps: stepCount, toolCalls, secs });
          done = true;
        }
        lastKind = ev.type;
      }
    }
  } catch (err) {
    addStep("error", `could not reach the agent: ${escapeHtml(err.message)}`);
  }
  running = false;
  setPulse("idle — brief the agent again", false);
  $("#runBtn").disabled = false;
  $("#runBtn").textContent = "Run scout";
}

document.querySelectorAll(".ex").forEach((el) =>
  el.addEventListener("click", () => { $("#task").value = el.textContent; $("#task").focus(); })
);
$("#runBtn").addEventListener("click", run);
$("#task").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });
