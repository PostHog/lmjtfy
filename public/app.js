/* lmjtfy — the page is a read-out. Everything here exists to move a needle. */

const form = document.getElementById("ask-form");
const input = document.getElementById("question");
const goButton = document.getElementById("ask-go");
const goLabel = goButton.querySelector(".ask__go-label");

const readout = document.getElementById("readout");
const gauge = document.getElementById("gauge");
const needle = document.getElementById("needle");
const verdict = document.getElementById("verdict");
const verdictAsked = document.getElementById("verdict-asked");
const verdictWord = document.getElementById("verdict-word");
const verdictProb = document.getElementById("verdict-prob");
const verdictCount = document.getElementById("verdict-count");
const verdictTopic = document.getElementById("verdict-topic");
const verdictSettled = document.getElementById("verdict-settled");
const verdictGrouped = document.getElementById("verdict-grouped");
const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
const refusal = document.getElementById("refusal");

const ledgerList = document.getElementById("ledger-list");
const ledgerEmpty = document.getElementById("ledger-empty");
const sortButtons = [...document.querySelectorAll(".ledger__sort-btn")];

const STAGE_COPY = {
  reading: "reading the question",
  matching: "checking if anyone asked this",
  asking: "asking jev",
};

const SETTLED_COPY = ["taste", "contested", "broadly agreed", "settled"];

let sort = "recent";
let inFlight = false;
let pollTimer = null;

/* ------------------------------------------------------------------ view */

function readingColor(p) {
  if (p > 0.58) return "var(--yes)";
  if (p < 0.42) return "var(--no)";
  return "var(--torn)";
}

function showStatus(text) {
  statusText.textContent = text;
  status.hidden = false;
}

function hideStatus() {
  status.hidden = true;
}

function clearReadout() {
  verdict.hidden = true;
  verdictGrouped.hidden = true;
  refusal.hidden = true;
  readout.classList.remove("is-live", "is-refused");
}

function renderVerdict(question, detail) {
  const colour = readingColor(question.noul);
  readout.classList.add("is-live");
  readout.classList.remove("is-refused");
  readout.style.setProperty("--reading", colour);
  needle.style.setProperty("--p", question.noul);

  verdictAsked.textContent = question.text;
  verdictWord.textContent = question.verdict.toLowerCase();
  // Retrigger the rise animation on repeat asks.
  verdictWord.style.animation = "none";
  void verdictWord.offsetWidth;
  verdictWord.style.animation = "";

  verdictProb.textContent = question.noul.toFixed(2);
  verdictCount.textContent = `${question.askCount}×`;
  verdictTopic.textContent = question.topic;
  verdictSettled.textContent = SETTLED_COPY[Math.round(question.settledness)] ?? "—";

  if (detail) {
    verdictGrouped.textContent = detail;
    verdictGrouped.hidden = false;
  } else {
    verdictGrouped.hidden = true;
  }

  verdict.hidden = false;
  refusal.hidden = true;
}

function showRefusal(message) {
  refusal.textContent = message;
  refusal.hidden = false;
  verdict.hidden = true;
  readout.classList.remove("is-live");
  readout.classList.add("is-refused");
}

function setBusy(busy) {
  inFlight = busy;
  goButton.disabled = busy;
  goLabel.textContent = busy ? "…" : "ask";
}

/* ---------------------------------------------------------------- ledger */

function readingNode(question, fresh) {
  const li = document.createElement("li");
  li.className = fresh ? "reading reading--fresh" : "reading";
  li.dataset.id = question.id;
  li.style.setProperty("--reading", readingColor(question.noul));

  const text = document.createElement("p");
  text.className = "reading__text";
  text.textContent = question.text;

  const bar = document.createElement("div");
  bar.className = "reading__bar";
  const dot = document.createElement("span");
  dot.className = "reading__dot";
  dot.style.setProperty("--p", question.noul);
  bar.append(dot);

  const line = document.createElement("div");
  line.className = "reading__line";

  const word = document.createElement("span");
  word.className = "reading__verdict";
  word.textContent = question.verdict.toLowerCase();

  const prob = document.createElement("span");
  prob.className = "reading__prob";
  prob.textContent = question.noul.toFixed(2);

  const count = document.createElement("span");
  count.className = "reading__count";
  count.textContent = `${question.askCount}×`;

  line.append(word, prob, count);
  li.append(text, bar, line);
  return li;
}

function renderLedger(questions) {
  ledgerList.replaceChildren(...questions.map((q) => readingNode(q, false)));
  ledgerEmpty.hidden = questions.length > 0;
}

function liftToTop(question) {
  const existing = ledgerList.querySelector(`[data-id="${question.id}"]`);
  if (existing) existing.remove();
  ledgerList.prepend(readingNode(question, true));
  ledgerEmpty.hidden = true;
}

async function loadLedger() {
  try {
    const res = await fetch(`/api/feed?sort=${sort}&limit=40`);
    if (!res.ok) return;
    const data = await res.json();
    renderLedger(data.questions ?? []);
  } catch {
    /* the ledger is ambient; a failed poll is not worth reporting */
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!inFlight && document.visibilityState === "visible") await loadLedger();
    schedulePoll();
  }, 8000);
}

/* ------------------------------------------------------------------- ask */

/** Reads an SSE body from fetch, since EventSource cannot POST. */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        /* ignore a malformed frame rather than abandoning the stream */
      }
    }
  }
}

async function ask(question) {
  setBusy(true);
  clearReadout();
  showStatus(STAGE_COPY.reading);

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      hideStatus();
      showRefusal(body.error ?? "Jev is unavailable. Try again shortly.");
      return;
    }

    let answered = false;

    for await (const { event, data } of sseEvents(res)) {
      if (event === "stage") {
        showStatus(STAGE_COPY[data.stage] ?? data.stage);
      } else if (event === "answer") {
        answered = true;
        hideStatus();
        const detail =
          data.match === "semantic"
            ? `Grouped with an earlier wording of the same question.`
            : data.match === "exact" || data.match === "alias"
              ? `Already asked. Jev has not changed its mind.`
              : null;
        renderVerdict(data.question, detail);
        liftToTop(data.question);
        input.value = "";
      } else if (event === "blocked") {
        hideStatus();
        showRefusal(data.message);
      } else if (event === "error") {
        hideStatus();
        showRefusal(data.message);
      }
    }

    if (!answered && refusal.hidden && verdict.hidden) {
      hideStatus();
      showRefusal("Jev stopped mid-thought. Try again.");
    }
  } catch {
    hideStatus();
    showRefusal("Lost the connection to Jev. Try again.");
  } finally {
    setBusy(false);
    hideStatus();
  }
}

/* ----------------------------------------------------------------- wiring */

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || inFlight) return;
  ask(question);
});

for (const button of sortButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.sort === sort) return;
    sort = button.dataset.sort;
    for (const other of sortButtons) other.classList.toggle("is-on", other === button);
    loadLedger();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !inFlight) loadLedger();
});

requestAnimationFrame(() => gauge.style.setProperty("--draw", "1"));
loadLedger();
schedulePoll();
input.focus();
