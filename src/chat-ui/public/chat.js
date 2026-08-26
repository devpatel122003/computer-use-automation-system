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

addMessage(
  'Hi! I can help you look up a member or open a new sub-account. Try: "Open a savings account for member 10001 with $100."',
  "bot"
);
