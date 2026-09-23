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
const verdictShare = document.getElementById("verdict-share");
const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
const notice = document.getElementById("notice");
const noticeTitle = document.getElementById("notice-title");
const noticeBody = document.getElementById("notice-body");

const ledgerList = document.getElementById("ledger-list");
const ledgerEmpty = document.getElementById("ledger-empty");
const ledgerLive = document.getElementById("ledger-live");
const sortButtons = [...document.querySelectorAll(".ledger__sort-btn")];

/** Optional chaining throughout: analytics must never break an answer. */
function track(event, properties) {
  window.posthog?.capture?.(event, properties);
}

const STAGE_COPY = {
  reading: "reading the question",
  matching: "checking if anyone asked this",
  asking: "asking jev",
};

const SETTLED_COPY = ["taste", "contested", "broadly agreed", "settled"];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let sort = "recent";
let inFlight = false;
let pollTimer = null;
let source = null;
let shown = null;
let shareTimer = null;
// The Worker bakes the current readings into the HTML for crawlers and for
// first paint, so treat a pre-populated list as already loaded rather than
// flashing skeletons over content that is right there.
let loaded = ledgerList.children.length > 0;

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
  notice.hidden = true;
  readout.classList.remove("is-live", "is-noticed");
}

function renderVerdict(question, detail) {
  const colour = readingColor(question.noul);
  readout.classList.add("is-live");
  readout.classList.remove("is-noticed");
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

  shown = question;
  resetShare();
  verdict.hidden = false;
  notice.hidden = true;
}

function resetShare() {
  clearTimeout(shareTimer);
  verdictShare.classList.remove("is-copied");
  verdictShare.textContent = "copy link";
}

/** The Worker resolves ?q= to the stored answer and its social preview. */
function shareUrl(question) {
  return `${location.origin}/?q=${encodeURIComponent(question.text)}`;
}

async function copyShareLink() {
  if (!shown) return;
  const question = shown;
  clearTimeout(shareTimer);
  try {
    await navigator.clipboard.writeText(shareUrl(question));
    verdictShare.classList.add("is-copied");
    verdictShare.textContent = "link copied";
    track("question shared", {
      method: "copy",
      topic: question.topic,
      verdict: question.verdict,
      ask_count: question.askCount,
    });
  } catch {
    verdictShare.textContent = "could not copy. use the address bar";
  }
  shareTimer = setTimeout(resetShare, 2400);
}

/** kind is "refusal", "limit" or "error" — a declined question, a spent
    allowance and a broken request should not look like the same event. */
function showNotice({ kind = "error", title = "Something broke", body = "" }) {
  track("question refused", { kind, reason: title });
  notice.className = `notice notice--${kind}`;
  noticeTitle.textContent = title;
  noticeBody.textContent = body;
  notice.hidden = false;
  verdict.hidden = true;
  readout.classList.remove("is-live");
  readout.classList.add("is-noticed");
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

function ghostNode() {
  const li = document.createElement("li");
  li.className = "reading reading--ghost";
  const long = document.createElement("div");
  long.className = "reading__ghost-line";
  const short = document.createElement("div");
  short.className = "reading__ghost-line reading__ghost-line--short";
  li.append(long, short);
  return li;
}

function showSkeleton() {
  ledgerList.replaceChildren(...Array.from({ length: 6 }, ghostNode));
  ledgerEmpty.hidden = true;
}

function renderLedger(questions) {
  ledgerList.replaceChildren(...questions.map((q) => readingNode(q, false)));
  ledgerEmpty.hidden = questions.length > 0;
  loaded = true;
}

function liftToTop(question) {
  const existing = ledgerList.querySelector(`[data-id="${question.id}"]`);
  if (existing) existing.remove();
  ledgerList.prepend(readingNode(question, true));
  ledgerEmpty.hidden = true;
  trimLedger();
}

/** Someone else's reading. Update in place under "most asked" so their
    scroll position survives; move to the top under "recent", where the
    order is the information. */
function applyRemote(question) {
  if (!loaded) return;
  const existing = ledgerList.querySelector(`[data-id="${question.id}"]`);
  if (sort === "top" && existing) {
    existing.replaceWith(readingNode(question, false));
    return;
  }
  if (sort === "top") return;
  liftToTop(question);
}

function trimLedger() {
  while (ledgerList.children.length > 60) ledgerList.lastElementChild.remove();
}

async function loadLedger() {
  try {
    if (!loaded) showSkeleton();
    const res = await fetch(`/api/feed?sort=${sort}&limit=40`);
    if (!res.ok) return;
    const data = await res.json();
    renderLedger(data.questions ?? []);
  } catch {
    /* the ledger is ambient; a failed poll is not worth reporting */
    if (!loaded) {
      ledgerList.replaceChildren();
      ledgerEmpty.hidden = false;
    }
  }
}

/* Live readings. A Durable Object fans every new answer out to everyone with
   the page open; polling stays on as a slow safety net so a dropped stream or
   a hub at capacity degrades instead of freezing the column. */
function connectLive() {
  if (source) source.close();
  source = new EventSource("/api/stream");

  source.addEventListener("open", () => ledgerLive.classList.add("is-live"));

  source.addEventListener("reading", (event) => {
    try {
      applyRemote(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame */
    }
  });

  source.addEventListener("error", () => {
    ledgerLive.classList.remove("is-live");
    // EventSource retries on its own; the poll covers the gap meanwhile.
  });
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!inFlight && document.visibilityState === "visible") await loadLedger();
    schedulePoll();
  }, source && ledgerLive.classList.contains("is-live") ? 60000 : 8000);
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

async function ask(question, source = "typed") {
  track("question submitted", { source });
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
      showNotice(body);
      return;
    }

    let answered = false;

    for await (const { event, data } of sseEvents(res)) {
      if (event === "stage") {
        showStatus(STAGE_COPY[data.stage] ?? data.stage);
      } else if (event === "answer") {
        answered = true;
        hideStatus();
        const detail = data.question.inverted
          ? "You asked the reverse of a question Jev has already answered, so this is that answer flipped."
          : data.match === "semantic"
            ? "Grouped with an earlier wording of the same question."
            : data.match === "exact" || data.match === "alias"
              ? "Already asked. Jev has not changed its mind."
              : null;
        renderVerdict(data.question, detail);
        liftToTop(data.reading ?? data.question);
        track("question answered", {
          match: data.match,
          inverted: Boolean(data.question.inverted),
          topic: data.question.topic,
          verdict: data.question.verdict,
          probability: data.question.noul,
          ask_count: data.question.askCount,
          settledness: data.question.settledness,
        });
        input.value = "";
        history.replaceState(null, "", shareUrl(data.question));
      } else if (event === "notice") {
        hideStatus();
        showNotice(data);
      }
    }

    if (!answered && notice.hidden && verdict.hidden) {
      hideStatus();
      showNotice({
        kind: "error",
        title: "Jev stopped mid-thought",
        body: "The connection dropped before an answer arrived. Try again.",
      });
    }
  } catch {
    hideStatus();
    showNotice({
      kind: "error",
      title: "Lost the connection",
      body: "Check your network and ask again.",
    });
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

verdictShare.addEventListener("click", copyShareLink);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function typeInto(text) {
  if (reducedMotion) {
    input.value = text;
    return;
  }
  input.value = "";
  for (const character of text) {
    input.value += character;
    await sleep(character === " " ? 46 : 26 + Math.random() * 26);
  }
}

async function askFromUrl() {
  const q = new URLSearchParams(location.search).get("q");
  if (!q) return false;
  const question = q.replace(/\s+/g, " ").trim().slice(0, 280);
  if (question.length < 3) return false;

  await sleep(reducedMotion ? 0 : 450);
  await typeInto(question);
  await sleep(reducedMotion ? 0 : 280);
  await ask(question, "link");
  return true;
}

requestAnimationFrame(() => gauge.style.setProperty("--draw", "1"));
if (!loaded) showSkeleton();
ledgerEmpty.hidden = loaded;
loadLedger();
connectLive();
schedulePoll();

askFromUrl().then((asked) => {
  if (!asked) input.focus();
});
