// Client-side chat logic. Deliberately no build step, no framework -- this is a thin demo
// front end for src/chat-ui/server.ts's /chat endpoint, not a product. Voice input/output
// is entirely browser-native (Web Speech API): no audio ever leaves this page except as
// text sent to /chat, and no new backend service exists to support it.

const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic-btn");
const micStatus = document.getElementById("mic-status");
const speakToggle = document.getElementById("speak-toggle");
const catalogListEl = document.getElementById("catalog-list");
const demoScriptsEl = document.getElementById("demo-scripts");
const dashboardLinkEl = document.getElementById("dashboard-link");
const targetSwitcherEl = document.getElementById("target-switcher");
const interventionsEl = document.getElementById("interventions");

function addMessage(text, who, caption) {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.textContent = text;
  if (caption) {
    const captionEl = document.createElement("div");
    captionEl.className = "caption";
    captionEl.textContent = caption;
    el.appendChild(captionEl);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function speak(text) {
  if (!speakToggle.checked || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // don't queue up replies if several arrive quickly
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function sendMessage(text) {
  addMessage(text, "user");
  const thinking = addMessage("...", "bot thinking");

  let data;
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    data = await res.json();
  } catch {
    thinking.remove();
    addMessage("Sorry, I couldn't reach the assistant right now.", "bot error");
    return;
  }

  thinking.remove();
  const reply = data.reply ?? data.error ?? "Something went wrong.";
  const isError = !data.reply;
  // The reply text alone says "it worked" -- this caption is how you actually go verify it:
  // the exact run this produced, so you can check evidence/runs/<runId>/ (the full step log
  // and any screenshots) or open mock-bank itself and look the record up directly, instead
  // of just trusting the chat bubble.
  const runId = data.result?.runId;
  const caption = runId ? `${data.result.status} · run ${runId}` : undefined;
  addMessage(reply, isError ? "bot error" : "bot", caption);
  if (!isError) speak(reply);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendMessage(text);
});

// Voice input via the Web Speech API. Only Chrome/Edge (and a few others) implement
// SpeechRecognition, always behind the webkit-prefixed name -- feature-detected, and the
// mic button is hidden entirely rather than shown and then failing silently on browsers
// that don't support it.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognitionImpl) {
  const recognizer = new SpeechRecognitionImpl();
  recognizer.lang = "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  let listening = false;

  micBtn.addEventListener("click", () => {
    if (listening) return;
    listening = true;
    micBtn.classList.add("listening");
    micStatus.hidden = false;
    try {
      recognizer.start();
    } catch {
      listening = false;
      micBtn.classList.remove("listening");
      micStatus.hidden = true;
    }
  });

  recognizer.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    // Briefly show the transcript in the box (useful feedback that recognition worked)
    // then clear it before sending -- the typed-message path (the form submit handler)
    // already clears the input on send; this path just forgot to.
    input.value = transcript;
    sendMessage(transcript);
    input.value = "";
  });

  recognizer.addEventListener("end", () => {
    listening = false;
    micBtn.classList.remove("listening");
    micStatus.hidden = true;
  });

  // The Web Speech API's own error codes -- previously swallowed entirely, which looked
  // exactly like "the mic button goes active for a second, then just stops" with zero
  // explanation. The single most common real cause is "not-allowed": the browser (or the
  // OS microphone permission underneath it) denied access, which fires almost immediately
  // after start() -- not a bug in the recognizer itself, just invisible without this.
  const MIC_ERROR_MESSAGES = {
    "not-allowed": "Microphone access was denied. Check your browser's site permissions for this page (click the icon in the address bar) and your OS microphone privacy settings, then try again.",
    "audio-capture": "No microphone was found. Check that one is connected and selected as the input device.",
    "no-speech": "Didn't catch any speech that time -- try again and speak right after clicking the mic.",
    network: "The browser's speech recognition service couldn't be reached (it needs network access, even though your message stays local otherwise).",
  };

  recognizer.addEventListener("error", (event) => {
    listening = false;
    micBtn.classList.remove("listening");
    micStatus.hidden = true;
    if (event.error === "aborted") return; // a deliberate stop, not a real failure
    addMessage(MIC_ERROR_MESSAGES[event.error] ?? `Voice input failed (${event.error}).`, "bot error");
  });
} else {
  micBtn.hidden = true;
}

// Sidebar: capability catalog + demo-script buttons + optional dashboard link. Both fetches
// hit this same server (never capability-api directly -- the browser never holds an API
// key), and both fail soft: a demo running the chat panel alone (capability-api down, or
// /config unset) should still work, just with an empty/short sidebar instead of a crash.

function renderCatalog(catalog) {
  catalogListEl.innerHTML = "";
  if (!Array.isArray(catalog) || catalog.length === 0) {
    catalogListEl.innerHTML = '<li class="muted">No capabilities found.</li>';
    return;
  }
  for (const cap of catalog) {
    const li = document.createElement("li");
    li.className = "catalog-item";
    const name = document.createElement("div");
    name.className = "catalog-name";
    name.textContent = cap.name ?? cap.id;
    if (cap.hasRiskyStep) {
      const badge = document.createElement("span");
      badge.className = "badge badge-risky";
      badge.textContent = "risky";
      name.appendChild(badge);
    }
    const meta = document.createElement("div");
    meta.className = "catalog-meta";
    meta.textContent = `${cap.approvalState ?? "unknown"} · v${cap.version ?? "?"}`;
    li.appendChild(name);
    li.appendChild(meta);
    catalogListEl.appendChild(li);
  }
}

async function loadCatalog() {
  try {
    const res = await fetch("/catalog");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    renderCatalog(data);
  } catch (err) {
    catalogListEl.innerHTML = `<li class="muted">Catalog unavailable (${err.message ?? err}).</li>`;
  }
}

function renderDemoScripts(scripts) {
  demoScriptsEl.innerHTML = "";
  if (!Array.isArray(scripts) || scripts.length === 0) return;
  for (const script of scripts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "demo-script-btn";
    btn.textContent = script.label;
    btn.title = script.message;
    // Fills the real composer input and submits through the exact same path a typed message
    // would take -- no separate invocation logic for buttons vs. free text.
    btn.addEventListener("click", () => sendMessage(script.message));
    demoScriptsEl.appendChild(btn);
  }
}

function renderTargetSwitcher(targets, activeTarget) {
  targetSwitcherEl.innerHTML = "";
  for (const t of targets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "target-btn" + (t.id === activeTarget.id ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => switchTarget(t.id, t.label));
    targetSwitcherEl.appendChild(btn);
  }
}

// Switching targets means a different backend AND a different signed-on identity
// underneath -- the server clears any pending confirmation/chain/history for this session
// (see server.ts's POST /target), so the chat panel here does the client-side equivalent:
// drop the old dashboard link and demo scripts, refresh the catalog against the NEW target,
// and leave a visible note in the transcript rather than silently wiping it (a person should
// be able to see exactly when and to what they switched).
async function switchTarget(targetId, targetLabel) {
  try {
    const res = await fetch("/target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      addMessage(`Couldn't switch target: ${data.error ?? `HTTP ${res.status}`}`, "bot error");
      return;
    }
    addMessage(`Switched to ${targetLabel}. Catalog and demo scripts below now reflect it.`, "bot");
    await Promise.all([loadCatalog(), loadConsoleConfig()]);
  } catch (err) {
    addMessage(`Couldn't switch target (${err.message ?? err}).`, "bot error");
  }
}

async function loadConsoleConfig() {
  try {
    const res = await fetch("/config");
    const data = await res.json();
    renderDemoScripts(data.demoScripts);
    if (Array.isArray(data.targets) && data.activeTarget) {
      renderTargetSwitcher(data.targets, data.activeTarget);
    }
    if (data.dashboardUrl) {
      dashboardLinkEl.href = data.dashboardUrl;
      dashboardLinkEl.hidden = false;
    } else {
      dashboardLinkEl.hidden = true;
    }
    if (Array.isArray(data.registerTargetExamples)) {
      populateRegisterTargetExamples(data.registerTargetExamples);
    }
  } catch {
    // No config, no demo-script buttons, no dashboard link, no switcher -- the chat panel
    // itself still works, so this stays a soft failure with nothing shown to the user.
  }
}

// Human escalation: a genuine mid-replay hard failure pauses the real (headed) browser
// session server-side and waits for a person -- see src/api/http-escalation.ts. This tab has
// no way to be pushed to, so it polls; the real handoff is the live browser window itself
// (visible on the same machine running the demo), this card is just the "resume/abort"
// signal a terminal prompt would otherwise be. Tracks which ids it's already narrated in the
// chat log so a repeated poll doesn't spam the same announcement every 2.5s.
const announcedInterventionIds = new Set();

function renderInterventions(list) {
  if (!Array.isArray(list) || list.length === 0) {
    interventionsEl.hidden = true;
    interventionsEl.innerHTML = "";
    return;
  }
  interventionsEl.hidden = false;
  interventionsEl.innerHTML = "";
  for (const item of list) {
    if (!announcedInterventionIds.has(item.id)) {
      announcedInterventionIds.add(item.id);
      addMessage(
        `Human needed: "${item.reason}" (${item.capability}). The live browser window is paused on ${item.url} — fix it there if it needs fixing, then Resume or Abort below.`,
        "bot error"
      );
    }

    const card = document.createElement("div");
    card.className = "intervention-card";

    const img = document.createElement("img");
    img.className = "intervention-screenshot";
    img.src = `/interventions/${item.id}/screenshot`;
    img.alt = "Live session screenshot at the moment of escalation";
    card.appendChild(img);

    const reason = document.createElement("div");
    reason.className = "intervention-reason";
    reason.textContent = item.reason;
    card.appendChild(reason);

    const meta = document.createElement("div");
    meta.className = "intervention-meta";
    meta.textContent = `${item.capability} · step ${item.step} · ${item.url}`;
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "intervention-actions";

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "intervention-btn resume";
    resumeBtn.textContent = "Resume (I fixed it)";
    resumeBtn.addEventListener("click", () => resolveIntervention(item.id, "resume"));

    const abortBtn = document.createElement("button");
    abortBtn.type = "button";
    abortBtn.className = "intervention-btn abort";
    abortBtn.textContent = "Abort";
    abortBtn.addEventListener("click", () => resolveIntervention(item.id, "abort"));

    actions.appendChild(resumeBtn);
    actions.appendChild(abortBtn);
    card.appendChild(actions);
    interventionsEl.appendChild(card);
  }
}

async function resolveIntervention(id, decision) {
  try {
    const res = await fetch(`/interventions/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      addMessage(`Couldn't resolve the intervention: ${data.error ?? `HTTP ${res.status}`}`, "bot error");
      return;
    }
    addMessage(`Told the paused run to ${decision === "resume" ? "resume" : "abort"}.`, "bot");
    announcedInterventionIds.delete(id);
    pollInterventions(); // refresh immediately rather than waiting for the next tick
  } catch (err) {
    addMessage(`Couldn't resolve the intervention (${err.message ?? err}).`, "bot error");
  }
}

async function pollInterventions() {
  try {
    const res = await fetch("/interventions");
    if (!res.ok) return; // a transient miss just means the card doesn't update this tick
    renderInterventions(await res.json());
  } catch {
    // Same soft-fail as above -- this is a polling loop, not a user-initiated action.
  }
}

setInterval(pollInterventions, 2500);
pollInterventions();

// "Register a new target": adds a URL + its routes to the allowlist for real, then runs one
// real discovery attempt against it -- see server.ts's POST /register-target for exactly
// what this does and doesn't do (it does not produce a finished capability).
const registerTargetForm = document.getElementById("register-target-form");
const registerTargetResultEl = document.getElementById("register-target-result");
const registerTargetExamplePicker = document.getElementById("rt-example-picker");

// Config-driven, same as the target switcher and demo scripts above -- the picker's options
// come from config/register-target-examples.json (server-side), not a hardcoded list here.
// Selecting one only fills the same four fields a person would otherwise type by hand;
// POST /register-target itself is completely unaware this picker exists.
let registerTargetExamples = [];

function populateRegisterTargetExamples(examples) {
  registerTargetExamples = examples;
  registerTargetExamplePicker.innerHTML = '<option value="">Type your own…</option>';
  examples.forEach((example, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = example.label;
    registerTargetExamplePicker.appendChild(option);
  });
}

registerTargetExamplePicker.addEventListener("change", () => {
  const index = registerTargetExamplePicker.value;
  if (index === "") return; // "Type your own…" -- leave whatever's already in the fields
  const example = registerTargetExamples[Number(index)];
  if (!example) return;
  document.getElementById("rt-base-url").value = example.baseUrl ?? "";
  document.getElementById("rt-start-url").value = example.startUrl ?? "";
  document.getElementById("rt-routes").value = example.routesText ?? "";
  document.getElementById("rt-goal").value = example.goal ?? "";
});

function renderRegisterTargetResult(data, isError) {
  registerTargetResultEl.hidden = false;
  registerTargetResultEl.className = "register-target-result" + (isError ? " error" : "");
  if (isError) {
    registerTargetResultEl.textContent = data.error ?? "Something went wrong.";
    return;
  }
  const lines = [
    `Status: ${data.status}`,
    `Steps taken: ${data.stepCount}`,
    `Routes newly added to the allowlist: ${data.routesAddedToAllowlist}`,
  ];
  if (data.finalSummary) lines.push(`Summary: ${data.finalSummary}`);
  if (data.escalationReason) lines.push(`Stopped because: ${data.escalationReason}`);
  if (data.outputs && Object.keys(data.outputs).length > 0) {
    lines.push(`Extracted: ${Object.entries(data.outputs).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  }
  lines.push(`Evidence: ${data.evidenceDir}`);
  if (data.status === "finished") {
    lines.push('Discovery succeeded. To turn this into a reusable capability, author a config JSON (see config/capability-configs/*.example.json) and run "npm run record-capability" against this same target -- that authoring step stays manual on purpose.');
  }
  registerTargetResultEl.textContent = lines.join("\n");
}

if (registerTargetForm) {
  registerTargetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const baseUrl = document.getElementById("rt-base-url").value.trim();
    const startUrl = document.getElementById("rt-start-url").value.trim();
    const routesText = document.getElementById("rt-routes").value;
    const goal = document.getElementById("rt-goal").value.trim();

    const submitBtn = registerTargetForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Running discovery… (this drives a real browser and can take a minute or two)";
    registerTargetResultEl.hidden = true;

    try {
      const res = await fetch("/register-target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, startUrl, routesText, goal }),
      });
      const data = await res.json();
      renderRegisterTargetResult(data, !res.ok);
    } catch (err) {
      renderRegisterTargetResult({ error: `Couldn't reach the server (${err.message ?? err}).` }, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Run discovery";
    }
  });
}

loadCatalog();
loadConsoleConfig();

addMessage(
  'Hi! I can help you look up a member or open a new sub-account. Try: "Open a savings account for member 10001 with $100."',
  "bot"
);
