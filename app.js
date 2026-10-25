/* Квиз в узких кругах — ведущий открывает страницу и шерит экран. */
(() => {
  "use strict";

  const QUIZZES = {};
  window.registerQuiz = (quiz) => { QUIZZES[quiz.id] = quiz; };

  const STORE_KEY = "kvuk-game-v1";
  const TEAM_COLORS = ["#d7ff3a", "#ff4fa3", "#38e1ff", "#ffb03a", "#b78cff", "#5dffb0", "#ff7a59", "#7aa2ff"];
  const STANDINGS_EVERY = 3; // турнирная таблица после 3-го, 6-го… тура
  const app = document.getElementById("app");

  let S = defaultState();
  let timer = null; // { kind, total, left, running, last, id }
  let pixelator = null;
  let audio = null;
  let muted = false;

  function defaultState() {
    return { phase: "setup", quizId: null, teams: [{ name: "", scores: {} }], qTime: 60, thinkTime: 60, r: 0, q: 0, revealed: false };
  }

  // ---------- хранение ----------
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* приватный режим */ }
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const st = raw && JSON.parse(raw);
      return st && st.phase && st.phase !== "setup" && QUIZZES[st.quizId] ? st : null;
    } catch (e) { return null; }
  }
  function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }

  // ---------- утилиты ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const quiz = () => QUIZZES[S.quizId];
  const round = () => quiz().rounds[S.r];
  const question = () => round().questions[S.q];
  const CACHE_BUST = Date.now(); // свежие картинки после правок, без кэша браузера
  const imgSrc = (src) => `quizzes/${S.quizId}/${typeof src === "string" ? src : src.src}?v=${CACHE_BUST}`;
  const teamName = (t, i) => (t.name || "").trim() || `Команда ${i + 1}`;
  const total = (t) => Object.values(t.scores).reduce((a, b) => a + (Number(b) || 0), 0);
  const fmt = (n) => (Math.round(n * 100) / 100).toString().replace(".", ",");
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
  const letter = (i) => "ABCD"[i] || String(i + 1);

  // ---------- звук ----------
  function beep(freq, dur, vol = 0.15, type = "sine", delay = 0) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audio.currentTime + delay;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(audio.destination);
      o.start(t0); o.stop(t0 + dur);
    } catch (e) {}
  }
  const tick = () => beep(880, 0.08, 0.08, "square");
  const gong = () => { beep(523, 0.6, 0.2, "triangle"); beep(392, 0.9, 0.2, "triangle", 0.18); };

  // ---------- таймер ----------
  function startTimer(kind, seconds) {
    stopTimer();
    timer = { kind, total: seconds, left: seconds, running: true, last: performance.now(), lastWhole: seconds };
    timer.id = setInterval(stepTimer, 200);
    paintTimer();
  }
  function stopTimer() { if (timer) clearInterval(timer.id); timer = null; }
  function stepTimer() {
    if (!timer || !timer.running) return;
    const now = performance.now();
    timer.left = Math.max(0, timer.left - (now - timer.last) / 1000);
    timer.last = now;
    const whole = Math.ceil(timer.left);
    if (whole !== timer.lastWhole) {
      timer.lastWhole = whole;
      if (whole > 0 && whole <= 5) tick();
    }
    if (timer.left <= 0) {
      timer.running = false;
      clearInterval(timer.id);
      gong();
      if (timer.kind === "question" && pixelator && !S.uncovered) pixelator.cover(true);
    }
    paintTimer();
  }
  function togglePause() {
    if (!timer || timer.left <= 0) return;
    timer.running = !timer.running;
    timer.last = performance.now();
    paintTimer();
  }
  function restartTimer() {
    if (!timer) return;
    const kind = timer.kind, total = timer.total;
    if (kind === "question" && pixelator) { pixelator.uncover(false); S.uncovered = false; }
    startTimer(kind, total);
  }
  function paintTimer() {
    const el = document.querySelector(".timer");
    if (!el || !timer) return;
    const bar = el.querySelector(".bar");
    const len = 2 * Math.PI * 54;
    bar.style.strokeDasharray = len;
    bar.style.strokeDashoffset = len * (1 - timer.left / timer.total);
    el.querySelector(".val").textContent = Math.ceil(timer.left);
    el.classList.toggle("low", timer.left <= 10 && timer.left > 0);
    el.classList.toggle("out", timer.left <= 0);
    el.classList.toggle("paused", !timer.running && timer.left > 0);
    const pb = document.querySelector("[data-act=pause]");
    if (pb) pb.textContent = timer.running || timer.left <= 0 ? "❚❚" : "▶";
  }
  const timerHTML = (big) => `
    <div class="timer ${big ? "big-timer" : ""}">
      <svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="54"/><circle class="bar" cx="60" cy="60" r="54"/></svg>
      <div class="val"></div>
    </div>`;

  // ---------- пиксели ----------
  function Pixelator(host, onReveal) {
    const cv = document.createElement("canvas");
    cv.className = "pix";
    const hint = document.createElement("div");
    hint.className = "pix-hint";
    hint.textContent = "Время вышло · нажмите, чтобы открыть";
    const ctx = cv.getContext("2d");
    const PAL = ["#20246a", "#272c86", "#1a1d5c", "#2f35a0", "#232776", "#3a40b8", "#161950"];
    const ACC = ["#ff4fa3", "#38e1ff", "#d7ff3a"];
    let cells = [], size = 26, anim = null, covered = false;

    function layout() {
      const r = host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cells = [];
      for (let y = 0; y < r.height; y += size)
        for (let x = 0; x < r.width; x += size)
          cells.push({ x, y, c: Math.random() < 0.04 ? ACC[(Math.random() * ACC.length) | 0] : PAL[(Math.random() * PAL.length) | 0] });
      for (let i = cells.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [cells[i], cells[j]] = [cells[j], cells[i]]; }
    }
    function run(draw, done, ms = 750) {
      cancelAnimationFrame(anim);
      const t0 = performance.now();
      let n = 0;
      const frame = (now) => {
        const target = Math.min(cells.length, Math.ceil(((now - t0) / ms) * cells.length));
        for (; n < target; n++) draw(cells[n]);
        if (n < cells.length) anim = requestAnimationFrame(frame); else done && done();
      };
      anim = requestAnimationFrame(frame);
    }
    const paint = (c) => {
      ctx.fillStyle = c.c; ctx.fillRect(c.x, c.y, size, size);
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(c.x + size - 2, c.y, 2, size); ctx.fillRect(c.x, c.y + size - 2, size, 2);
    };

    this.cover = (animate) => {
      if (covered) return;
      covered = true;
      host.append(cv, hint);
      layout();
      if (animate) run(paint); else cells.forEach(paint);
    };
    this.uncover = (animate) => {
      if (!covered) return;
      covered = false;
      hint.remove();
      const done = () => cv.remove();
      if (animate) run((c) => ctx.clearRect(c.x - 1, c.y - 1, size + 1, size + 1), done, 650); else { cancelAnimationFrame(anim); done(); }
    };
    cv.addEventListener("click", () => { this.uncover(true); onReveal && onReveal(); });
    window.addEventListener("resize", () => { if (covered) { layout(); cells.forEach(paint); } });
  }

  // ---------- рендер ----------
  function render() {
    stopTimer();
    pixelator = null;
    window.scrollTo(0, 0);
    const view = {
      setup: renderSetup, intro: renderIntro, question: renderQuestion, think: renderThink,
      answersIntro: renderAnswersIntro, answer: renderAnswer, scores: renderScores,
      standings: renderStandings, final: renderFinal,
    }[S.phase];
    view();
    if (S.phase !== "setup") save();
  }

  function topbar(mode) {
    const qs = round().questions;
    const dots = mode ? `<div class="dots">${qs.map((_, i) => `<i class="${i < S.q ? "done" : i === S.q ? "cur" : ""}"></i>`).join("")}</div>` : "";
    return `
      <header class="topbar">
        <div class="logo"><div class="logo-rings"><span></span><span></span><span></span></div>
          <div class="logo-text">Квиз в узких кругах<small>${esc(quiz().title)}</small></div></div>
        <span class="round-chip">${esc(round().title)}</span>
        ${mode ? `<span class="mode-chip">${mode}</span>` : ""}
        ${dots}
        <div class="spacer"></div>
        <button class="icon-btn" data-act="mute" title="Звук (M)">${muted ? "🔇" : "🔊"}</button>
        <button class="icon-btn" data-act="fullscreen" title="Полный экран (F)">⛶</button>
        <button class="icon-btn" data-act="menu" title="В меню">☰</button>
      </header>`;
  }
  const footer = (primary, opts = {}) => `
    <footer class="footer">
      <button class="btn btn-ghost btn-small" data-act="back" ${opts.noBack ? "disabled" : ""}>← Назад</button>
      <span class="hint">→ / пробел — дальше · ← — назад · F — полный экран</span>
      ${primary}
    </footer>`;

  // --- старт ---
  function renderSetup() {
    const saved = loadSaved();
    const ids = (window.QUIZ_LIST || []).map((q) => q.id).filter((id) => QUIZZES[id]);
    if (!S.quizId || !QUIZZES[S.quizId]) S.quizId = ids[0] || null;
    const qz = QUIZZES[S.quizId];
    const todos = qz ? qz.rounds.flatMap((r, ri) => r.questions.map((q, qi) => (q.todo ? `${ri + 1}.${qi + 1}` : null))).filter(Boolean) : [];
    app.innerHTML = `
      <div class="setup">
        <div class="hero">
          <div class="big-rings"><span></span><span></span><span></span></div>
          <h1>Квиз <em>в узких</em> кругах</h1>
          <p>Выберите квиз, впишите команды — и поехали</p>
        </div>
        ${saved ? `<div class="panel" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <div style="flex:1;min-width:220px"><b>Есть незаконченная игра</b><div style="color:var(--muted);margin-top:4px">${esc(QUIZZES[saved.quizId].title)} · ${esc(QUIZZES[saved.quizId].rounds[saved.r].title)} · ${saved.teams.map(teamName).map(esc).join(", ")}</div></div>
            <button class="btn btn-pink" data-act="resume">Продолжить</button></div>` : ""}
        <div class="panel">
          <h2><span class="num">1</span>Квиз</h2>
          <div class="quiz-grid">
            ${ids.map((id) => { const z = QUIZZES[id]; const n = z.rounds.reduce((a, r) => a + r.questions.length, 0);
              return `<button class="quiz-card ${id === S.quizId ? "sel" : ""}" data-act="pick" data-id="${esc(id)}"><b>${esc(z.title)}</b><span>${z.rounds.length} ${plural(z.rounds.length, "тур", "тура", "туров")} · ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}</span></button>`; }).join("")}
          </div>
          ${!ids.length ? `<div class="warn-box">Квизы не найдены. Проверьте quizzes/index.js.</div>` : ""}
          ${todos.length ? `<div class="warn-box">Неполные вопросы (нет текста или ответа): ${todos.join(", ")}. Их можно дописать в quizzes/${esc(S.quizId)}/quiz.js — помечены <code>todo: true</code>.</div>` : ""}
        </div>
        <div class="panel">
          <h2><span class="num">2</span>Команды</h2>
          <div class="team-list">
            ${S.teams.map((t, i) => `
              <div class="team-row">
                <span class="badge" style="background:${TEAM_COLORS[i % TEAM_COLORS.length]}">${i + 1}</span>
                <input class="text-input" data-team="${i}" placeholder="Команда ${i + 1}" value="${esc(t.name)}" maxlength="40">
                <button class="icon-btn" data-act="del-team" data-i="${i}" title="Удалить" ${S.teams.length < 2 ? "disabled" : ""}>✕</button>
              </div>`).join("")}
          </div>
          <div style="margin-top:14px"><button class="btn btn-ghost btn-small" data-act="add-team">+ Добавить команду</button></div>
        </div>
        <div class="panel">
          <h2><span class="num">3</span>Время</h2>
          <div class="settings">
            <label>На вопрос, сек<input class="text-input" type="number" min="5" max="600" data-set="qTime" value="${S.qTime}"></label>
            <label>Подумать в конце тура, сек<input class="text-input" type="number" min="5" max="600" data-set="thinkTime" value="${S.thinkTime}"></label>
          </div>
        </div>
        <div class="start-row"><button class="btn btn-primary" data-act="start" ${qz ? "" : "disabled"}>Начать игру →</button></div>
      </div>`;
    app.querySelectorAll("[data-team]").forEach((inp) => inp.addEventListener("input", () => { S.teams[+inp.dataset.team].name = inp.value; }));
    app.querySelectorAll("[data-set]").forEach((inp) => inp.addEventListener("change", () => {
      S[inp.dataset.set] = Math.min(600, Math.max(5, parseInt(inp.value, 10) || 60));
      inp.value = S[inp.dataset.set];
    }));
  }

  // --- интро тура ---
  function renderIntro() {
    const r = round();
    const n = r.questions.length;
    app.innerHTML = `${topbar()}
      <main class="stage"><div class="intro">
        <div class="kicker">Тур ${S.r + 1} из ${quiz().rounds.length}</div>
        <h1>${esc(r.title.replace(/^Тур \d+\.?\s*/, "") || r.title)}</h1>
        <p>${esc(r.description || "")} ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}, по ${S.qTime} сек на каждый.</p>
        <button class="btn btn-primary" data-act="next">Поехали →</button>
      </div></main>${footer("<span></span>", { noBack: S.r === 0 })}`;
  }

  // --- вопрос (и ответ) ---
  function questionBody(q, withAnswer) {
    const imgs = withAnswer && S.revealed && q.answerImages ? q.answerImages : q.images || [];
    const short = !imgs.length ? false : (q.text || "").length < 40;
    const right = withAnswer && S.revealed ? (q.answer || "").trim().charAt(0) : null;
    return `
      ${q.todo ? `<span class="todo-flag">⚠ вопрос неполный — допишите в quiz.js</span>` : ""}
      ${q.text ? `<p class="qtext ${short ? "short" : ""}">${esc(q.text)}</p>` : ""}
      ${q.options ? `<div class="options">${q.options.map((o, i) => `<div class="${right === letter(i) ? "right" : ""}"><b>${letter(i)}</b>${esc(o)}</div>`).join("")}</div>` : ""}
      ${q.hints ? `<div class="options hints">${q.hints.map((h) => `<div>${esc(h)}</div>`).join("")}</div>` : ""}
      ${imgs.length ? `<div class="qimgs ${imgs.length === 2 ? "two" : ""}">${imgs.map((im) => `
        <figure>${im.emoji ? `<div class="emoji">${esc(im.emoji)}</div>` : `<img src="${esc(imgSrc(im))}" alt="" data-zoom>`}${im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ""}</figure>`).join("")}</div>` : ""}`;
  }

  function renderQuestion() {
    const q = question();
    const last = S.q === round().questions.length - 1;
    S.uncovered = false;
    app.innerHTML = `${topbar("Вопросы")}
      <main class="stage"><div class="qwrap">
        <div>
          <div class="qnum"><small>Вопрос</small>${S.q + 1}</div>
          <div class="qcard" style="margin-top:18px"><div class="qbody">${questionBody(q, false)}</div></div>
        </div>
        <div class="timer-col">${timerHTML()}
          <div class="timer-ctrls"><button class="icon-btn" data-act="pause" title="Пауза (P)">❚❚</button><button class="icon-btn" data-act="restart" title="Заново">↺</button></div>
        </div>
      </div></main>
      ${footer(`<button class="btn btn-primary" data-act="next">${last ? "Завершить тур" : "Далее"} →</button>`)}`;
    pixelator = new Pixelator(app.querySelector(".qcard"), () => { S.uncovered = true; });
    startTimer("question", S.qTime);
  }

  function renderThink() {
    app.innerHTML = `${topbar()}
      <main class="stage"><div class="think">
        <h1>Минута на подумать</h1>
        <p>Допишите ответы на бланке — дальше разбор</p>
        ${timerHTML(true)}
        <div class="timer-ctrls" style="justify-content:center;margin-bottom:24px"><button class="icon-btn" data-act="pause" title="Пауза (P)">❚❚</button><button class="icon-btn" data-act="restart" title="Заново">↺</button></div>
        <button class="btn btn-primary" data-act="next">К ответам →</button>
      </div></main>${footer("<span></span>")}`;
    startTimer("think", S.thinkTime);
  }

  function renderAnswersIntro() {
    app.innerHTML = `${topbar()}
      <main class="stage"><div class="intro">
        <div class="kicker">${esc(round().title)}</div>
        <h1>Ответы</h1>
        <p>Сдайте бланки и проверяем.</p>
        <button class="btn btn-primary" data-act="next">Смотреть ответы →</button>
      </div></main>${footer("<span></span>")}`;
  }

  function renderAnswer() {
    const q = question();
    const last = S.q === round().questions.length - 1;
    app.innerHTML = `${topbar("Ответы")}
      <main class="stage"><div class="qwrap" style="grid-template-columns:1fr">
        <div>
          <div class="qnum"><small>Вопрос</small>${S.q + 1}</div>
          <div class="qcard" style="margin-top:18px"><div class="qbody">
            ${questionBody(q, true)}
            ${S.revealed ? `<div class="answer"><div class="lbl">Правильный ответ</div><div class="txt">${esc(q.answer)}</div>${q.comment ? `<div class="cmt">${esc(q.comment)}</div>` : ""}</div>` : ""}
          </div></div>
        </div>
      </div></main>
      ${footer(S.revealed
        ? `<button class="btn btn-primary" data-act="next">${last ? "К баллам" : "Далее"} →</button>`
        : `<button class="btn btn-pink" data-act="reveal">Показать правильный ответ</button>`)}`;
  }

  // --- баллы ---
  function renderScores() {
    const key = String(S.r);
    app.innerHTML = `${topbar()}
      <main class="stage"><div class="score-card">
        <h1>Баллы за ${esc(round().title.split(".")[0].toLowerCase())}</h1>
        <p class="sub">Впишите, сколько набрала каждая команда</p>
        ${S.teams.map((t, i) => `
          <div class="score-row">
            <span class="badge" style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-family:var(--head);font-weight:700;color:#0a0b24;background:${TEAM_COLORS[i % TEAM_COLORS.length]}">${i + 1}</span>
            <span class="name">${esc(teamName(t, i))}</span>
            <div class="stepper">
              <button class="icon-btn" data-act="dec" data-i="${i}">−</button>
              <input class="text-input" inputmode="decimal" data-score="${i}" value="${t.scores[key] ?? ""}" placeholder="0">
              <button class="icon-btn" data-act="inc" data-i="${i}">+</button>
            </div>
          </div>`).join("")}
        <div class="start-row"><button class="btn btn-primary" data-act="next">Сохранить →</button></div>
      </div></main>${footer("<span></span>")}`;
    app.querySelectorAll("[data-score]").forEach((inp) => inp.addEventListener("input", () => setScore(+inp.dataset.score, inp.value)));
    const first = app.querySelector("[data-score]");
    if (first) first.focus();
  }
  function setScore(i, raw) {
    const v = String(raw).replace(",", ".").trim();
    if (v === "") delete S.teams[i].scores[S.r];
    else if (!isNaN(Number(v))) S.teams[i].scores[S.r] = Number(v);
    save();
  }

  function standingsTable(upto) {
    const rows = S.teams.map((t, i) => ({ t, i, sum: total(t) })).sort((a, b) => b.sum - a.sum);
    let place = 0, prev = null;
    rows.forEach((row, k) => { if (row.sum !== prev) place = k + 1; row.place = place; prev = row.sum; });
    const rs = quiz().rounds.slice(0, upto + 1);
    return `<div class="table-wrap"><table class="st">
      <thead><tr><th>Место</th><th style="text-align:left">Команда</th>${rs.map((_, i) => `<th>Тур ${i + 1}</th>`).join("")}<th>Итого</th></tr></thead>
      <tbody>${rows.map((row, k) => `
        <tr class="${row.place === 1 && S.teams.length > 1 ? "lead" : ""}" style="animation-delay:${k * 0.08}s">
          <td class="place">${row.place === 1 ? "🥇" : row.place === 2 ? "🥈" : row.place === 3 ? "🥉" : row.place}</td>
          <td class="team"><span style="display:inline-block;width:12px;height:12px;border-radius:4px;margin-right:10px;background:${TEAM_COLORS[row.i % TEAM_COLORS.length]}"></span>${esc(teamName(row.t, row.i))}</td>
          ${rs.map((_, ri) => `<td>${row.t.scores[ri] != null ? fmt(row.t.scores[ri]) : "—"}</td>`).join("")}
          <td class="total">${fmt(row.sum)}</td>
        </tr>`).join("")}</tbody></table></div>`;
  }

  function renderStandings() {
    app.innerHTML = `${topbar()}
      <main class="stage"><div class="standings">
        <h1>Турнирная таблица</h1>
        <p class="sub">После ${S.r + 1} ${plural(S.r + 1, "тура", "туров", "туров")}</p>
        ${standingsTable(S.r)}
        <div class="start-row"><button class="btn btn-primary" data-act="next">Следующий тур →</button></div>
      </div></main>${footer("<span></span>")}`;
  }

  function renderFinal() {
    const multi = S.teams.length > 1;
    const best = Math.max(...S.teams.map(total));
    const winners = S.teams.map((t, i) => ({ t, i })).filter((x) => total(x.t) === best);
    app.innerHTML = `${topbar()}
      <main class="stage">
        <div class="winner">
          <div class="cup">🏆</div>
          <div class="kicker">${multi ? (winners.length > 1 ? "Победители" : "Победитель") : "Игра окончена"}</div>
          <h1>${multi ? winners.map((w) => esc(teamName(w.t, w.i))).join(" и ") : esc(teamName(S.teams[0], 0))}</h1>
          <div class="pts">${fmt(best)} ${plural(Math.round(best), "балл", "балла", "баллов")}</div>
        </div>
        <div class="standings" style="margin-top:20px">${standingsTable(quiz().rounds.length - 1)}</div>
        <div class="start-row"><button class="btn btn-ghost" data-act="new-game">Новая игра</button></div>
      </main>${footer("<span></span>")}`;
    confetti();
  }

  function confetti() {
    const cv = document.createElement("canvas");
    cv.id = "confetti";
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize();
    const parts = Array.from({ length: 220 }, () => ({
      x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.6, s: 6 + Math.random() * 8,
      vx: -1.5 + Math.random() * 3, vy: 2 + Math.random() * 4, r: Math.random() * 6, vr: -0.2 + Math.random() * 0.4,
      c: TEAM_COLORS[(Math.random() * 5) | 0],
    }));
    const t0 = performance.now();
    beep(523, 0.2, 0.15); beep(659, 0.2, 0.15, "sine", 0.15); beep(784, 0.5, 0.15, "sine", 0.3);
    (function frame(now) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      });
      if (now - t0 < 6000 && document.body.contains(cv)) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  }

  // ---------- навигация ----------
  const lastQ = () => round().questions.length - 1;
  const showStandingsAfter = (r) => (r + 1) % STANDINGS_EVERY === 0 && r < quiz().rounds.length - 1;

  function next() {
    switch (S.phase) {
      case "intro": S.phase = "question"; S.q = 0; break;
      case "question": if (S.q < lastQ()) S.q++; else S.phase = "think"; break;
      case "think": S.phase = "answersIntro"; break;
      case "answersIntro": S.phase = "answer"; S.q = 0; S.revealed = false; break;
      case "answer":
        if (!S.revealed) { S.revealed = true; break; }
        if (S.q < lastQ()) { S.q++; S.revealed = false; } else S.phase = "scores";
        break;
      case "scores":
        if (S.r === quiz().rounds.length - 1) S.phase = "final";
        else if (showStandingsAfter(S.r)) S.phase = "standings";
        else { S.r++; S.phase = "intro"; }
        break;
      case "standings": S.r++; S.phase = "intro"; break;
      default: return;
    }
    render();
  }

  function back() {
    switch (S.phase) {
      case "intro": if (S.r === 0) return; S.r--; S.phase = "scores"; break;
      case "question": if (S.q > 0) S.q--; else S.phase = "intro"; break;
      case "think": S.phase = "question"; S.q = lastQ(); break;
      case "answersIntro": S.phase = "think"; break;
      case "answer":
        if (S.revealed) S.revealed = false;
        else if (S.q > 0) { S.q--; S.revealed = true; } else S.phase = "answersIntro";
        break;
      case "scores": S.phase = "answer"; S.q = lastQ(); S.revealed = true; break;
      case "standings": S.phase = "scores"; break;
      case "final": S.phase = "scores"; break;
      default: return;
    }
    render();
  }

  function primary() {
    if (S.phase === "setup") return;
    const btn = app.querySelector("[data-act=reveal]") || app.querySelector("[data-act=next]");
    if (btn) btn.click();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  // ---------- события ----------
  app.addEventListener("click", (e) => {
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) { const lb = document.getElementById("lightbox"); lb.querySelector("img").src = zoom.src; lb.hidden = false; return; }
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    switch (act) {
      case "pick": S.quizId = el.dataset.id; render(); break;
      case "add-team": S.teams.push({ name: "", scores: {} }); render(); app.querySelector(`[data-team="${S.teams.length - 1}"]`).focus(); break;
      case "del-team": S.teams.splice(+el.dataset.i, 1); render(); break;
      case "start":
        S.teams = S.teams.map((t, i) => ({ name: teamName(t, i), scores: {} }));
        Object.assign(S, { phase: "intro", r: 0, q: 0, revealed: false });
        render(); break;
      case "resume": S = loadSaved(); render(); break;
      case "next": next(); break;
      case "back": back(); break;
      case "reveal": S.revealed = true; render(); break;
      case "pause": togglePause(); break;
      case "restart": restartTimer(); break;
      case "mute": muted = !muted; el.textContent = muted ? "🔇" : "🔊"; break;
      case "fullscreen": toggleFullscreen(); break;
      case "inc": case "dec": {
        const i = +el.dataset.i, cur = Number(S.teams[i].scores[S.r]) || 0;
        const v = Math.max(0, cur + (act === "inc" ? 1 : -1));
        setScore(i, v);
        app.querySelector(`[data-score="${i}"]`).value = v;
        break;
      }
      case "menu":
        if (confirm("Выйти в меню? Игру можно будет продолжить.")) { save(); stopTimer(); const keep = S; S = defaultState(); S.quizId = keep.quizId; render(); }
        break;
      case "new-game": clearSaved(); S = defaultState(); render(); break;
    }
  });

  document.getElementById("lightbox").addEventListener("click", (e) => { e.currentTarget.hidden = true; });

  document.addEventListener("keydown", (e) => {
    const lb = document.getElementById("lightbox");
    if (!lb.hidden) { if (e.key === "Escape" || e.key === " ") { lb.hidden = true; e.preventDefault(); } return; }
    const typing = e.target.matches && e.target.matches("input, textarea");
    if (typing) { if (e.key === "Enter") { e.preventDefault(); primary(); } return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); primary(); }
    else if (e.key === "ArrowLeft") { if (S.phase !== "setup") back(); }
    else if (e.key === "f" || e.key === "F" || e.key === "а" || e.key === "А") toggleFullscreen();
    else if (e.key === "p" || e.key === "P" || e.key === "з" || e.key === "З") togglePause();
    else if (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь") { muted = !muted; const b = app.querySelector("[data-act=mute]"); if (b) b.textContent = muted ? "🔇" : "🔊"; }
  });

  // ---------- загрузка квизов ----------
  const list = window.QUIZ_LIST || [];
  let pending = list.length;
  const ready = () => { if (--pending <= 0) render(); };
  if (!pending) render();
  list.forEach((q) => {
    const s = document.createElement("script");
    s.src = `quizzes/${q.id}/quiz.js?v=${Date.now()}`;
    s.onload = ready;
    s.onerror = () => { console.warn("Не удалось загрузить квиз", q.id); ready(); };
    document.head.appendChild(s);
  });
})();
