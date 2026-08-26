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

function addMessage(text, who) {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.textContent = text;
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
  addMessage(reply, isError ? "bot error" : "bot");
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
    input.value = transcript;
    sendMessage(transcript);
  });

  recognizer.addEventListener("end", () => {
    listening = false;
    micBtn.classList.remove("listening");
    micStatus.hidden = true;
  });

  recognizer.addEventListener("error", () => {
    listening = false;
    micBtn.classList.remove("listening");
    micStatus.hidden = true;
  });
} else {
  micBtn.hidden = true;
}

addMessage(
  'Hi! I can help you look up a member or open a new sub-account. Try: "Open a savings account for member 10001 with $100."',
  "bot"
);
