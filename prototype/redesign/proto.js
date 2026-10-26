const q = new URLSearchParams(location.search);
const body = document.body;
const $ = (id) => document.getElementById(id);
const labels = { listen: "Listen", resume: "Resume", stop: "Stop", pause: "Pause", play: "Play" };

const states = {
  welcome: { book: "none" },
  book: { primary: "listen", stats: "" },
  generating: { primary: "stop", generating: true, stats: "Generating segment 3..." },
  playing: { primary: "pause", stats: "Playing segment 3 of 12" },
  paused: { primary: "play", stats: "Paused at segment 3 of 12" },
  resume: { primary: "resume", stats: "" },
};

function setState(name) {
  const s = states[name] ?? states.book;
  body.dataset.book = s.book ?? "open";
  body.dataset.state = s.primary ?? "listen";
  body.toggleAttribute("data-generating", !!s.generating);
  const p = $("primary");
  p.dataset.state = s.primary ?? "listen";
  $("primary-label").textContent = labels[s.primary ?? "listen"];
  $("stats").textContent = s.stats ?? "";
}

if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
setState(q.get("state") ?? "book");

const sheets = { book: "sheet-book", voice: "sheet-voice", diagnostics: "diagnostics" };
for (const [k, id] of Object.entries(sheets)) $("open-" + k).addEventListener("click", () => $(id).showModal());
$("forget-book").addEventListener("click", () => { $("sheet-book").close(); setState("welcome"); });
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
$("primary").addEventListener("click", () => {
  const s = body.dataset.state;
  setState({ listen: "generating", resume: "generating", stop: "book", pause: "paused", play: "playing" }[s] ?? "book");
});
$("listen-start").addEventListener("click", () => setState("generating"));
$("file").addEventListener("change", () => setState("book"));

if (q.get("sheet")) $(sheets[q.get("sheet")]).showModal();

if (q.get("clean")) $("debug").remove();
else for (const name of Object.keys(states)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.addEventListener("click", () => setState(name));
  $("debug").append(b);
}
