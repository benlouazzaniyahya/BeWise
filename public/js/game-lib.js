/* global document, window */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tiny DOM helpers — ALL dynamic text is set with textContent (never
  // innerHTML) so AI-generated content can never inject markup.
  // ---------------------------------------------------------------------------
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  const eq = (x, y) => String(x).trim().toLowerCase() === String(y).trim().toLowerCase();

  const DEFAULT_UI = {
    correct: 'Correct!',
    incorrect: 'Not quite.',
    next: 'Next',
    finish: 'Finish',
    question: 'Question',
    of: 'of',
    matchLeft: 'Tap a card on the left',
    matchRight: 'Now tap its match on the right',
    matched: 'Matched!',
    matchLeftCount: 'left to match',
    fillHint: 'Type the missing word, then tap Check.',
    check: 'Check',
    fillGood: 'Yes!',
    fillAgain: 'Try again.',
    notSupported: 'This game type is not supported yet.',
    score: 'Score',
    answered: 'answered',
  };

  function header(game, ui) {
    const h = make('div', 'game-header');
    if (game.theme) h.appendChild(make('span', 'chip chip-theme', game.theme));
    if (game.instructions) h.appendChild(make('p', 'game-instructions', game.instructions));
    return h;
  }

  // ---------------------------------------------------------------------------
  // Quiz / MCQ template
  // ---------------------------------------------------------------------------
  function renderQuiz(box, game, ui, onFinish) {
    let index = 0;
    let score = 0;
    const answers = [];

    const stage = make('div', 'live');
    const progressEl = make('p', 'game-progress', '');
    const qEl = make('div', 'game-question');
    const optsEl = make('div', 'game-options');
    const feedbackEl = make('div', 'game-feedback');
    const footerEl = make('div', 'game-footer');
    stage.appendChild(progressEl);
    stage.appendChild(qEl);
    stage.appendChild(optsEl);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);
    box.appendChild(stage);

    function renderQuestion() {
      clear(qEl); clear(optsEl); clear(feedbackEl); clear(footerEl);
      if (index >= game.items.length) { return finish(); }
      const item = game.items[index];
      progressEl.textContent = ui.question + ' ' + (index + 1) + ' ' + ui.of + ' ' + game.items.length;
      qEl.textContent = item.question || '';
      (item.options || []).forEach((opt, i) => {
        const b = make('button', 'quiz-option');
        b.textContent = String(opt);
        b.addEventListener('click', () => answer(item, i, b));
        optsEl.appendChild(b);
      });
      const btn = make('button', 'btn btn-primary', index === game.items.length - 1 ? ui.finish : ui.next);
      btn.addEventListener('click', () => { index++; renderQuestion(); });
      footerEl.appendChild(btn);
    }

    function answer(item, pickedIdx, chosenBtn) {
      const buttons = Array.prototype.slice.call(optsEl.children);
      if (item.__answered) return;
      item.__answered = true;
      answers.push({ itemIndex: index, selectedIndex: pickedIdx });
      const isCorrect = pickedIdx === item.correctIndex;
      if (isCorrect) score += item.points || 10;
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === item.correctIndex) b.classList.add('quiz-option-ok');
        else if (i === pickedIdx) b.classList.add('quiz-option-bad');
      });
      feedbackEl.className = 'game-feedback ' + (isCorrect ? 'ok' : 'bad');
      feedbackEl.textContent = isCorrect
        ? (item.feedback ? item.feedback : ui.correct)
        : (item.feedback ? item.feedback : ui.incorrect);
    }

    function finish() {
      onFinish({ answers: answers, score: score });
    }

    renderQuestion();
  }

  // ---------------------------------------------------------------------------
  // Match / sort template
  // ---------------------------------------------------------------------------
  function renderMatch(box, game, ui, onFinish) {
    const items = game.items;
    const shLeft = shuffle(items.map((it, i) => ({ id: i, text: it.left })));
    const shRight = shuffle(items.map((it, i) => ({ id: i, text: it.right })));

    let selected = null;          // { btn, id }
    let matched = 0;
    const answers = [];
    const matchedIds = {};

    const colLeft = make('div', 'match-col');
    const colRight = make('div', 'match-col');
    const hint = make('p', 'match-hint', ui.matchLeft);
    const progress = make('p', 'game-progress', '');
    const stage = make('div', 'live');
    const grid = make('div', 'match-grid');
    grid.appendChild(colLeft);
    grid.appendChild(colRight);
    const footer = make('div', 'game-footer');
    stage.appendChild(progress);
    stage.appendChild(hint);
    stage.appendChild(grid);
    stage.appendChild(footer);
    box.appendChild(stage);

    const finishBtn = make('button', 'btn btn-primary', ui.finish);
    finishBtn.disabled = true;
    finishBtn.addEventListener('click', () => {
      const score = answers.reduce((s, a) => s + (items[a.itemIndex] ? (items[a.itemIndex].points || 10) : 0), 0);
      onFinish({ answers: answers, score: score });
    });
    footer.appendChild(finishBtn);

    function updateProgress() {
      progress.textContent = (items.length - matched) + ' ' + ui.matchLeftCount;
    }

    shLeft.forEach((item) => {
      const b = make('button', 'match-card');
      b.textContent = item.text;
      b.addEventListener('click', () => {
        if (selected) selected.btn.classList.remove('selected');
        selected = { btn: b, id: item.id };
        b.classList.add('selected');
        hint.textContent = ui.matchRight;
      });
      colLeft.appendChild(b);
    });

    shRight.forEach((item) => {
      const b = make('button', 'match-card');
      b.textContent = item.text;
      b.addEventListener('click', () => {
        if (!selected || selected.id === undefined) {
          if (!selected) hint.textContent = ui.matchLeft;
          return;
        }
        if (matchedIds[item.id] === true) return;
        if (selected.id === item.id) {
          matchedIds[item.id] = true;
          matched++;
          selected.btn.classList.add('matched');
          b.classList.add('matched');
          answers.push({ itemIndex: selected.id, matchedRight: item.text });
          selected = null;
          hint.textContent = ui.matched + ' · ' + (items.length - matched) + ' ' + ui.matchLeftCount;
          updateProgress();
          if (matched === items.length) {
            hint.textContent = ui.matched;
            finishBtn.disabled = false;
          }
        } else {
          b.classList.add('shake');
          setTimeout(() => b.classList.remove('shake'), 400);
          hint.textContent = ui.incorrect + ' ' + ui.matchRight;
        }
      });
      colRight.appendChild(b);
    });

    updateProgress();
  }

  // ---------------------------------------------------------------------------
  // Fill-in-the-blank template
  // ---------------------------------------------------------------------------
  function renderFill(box, game, ui, onFinish) {
    const answers = [];
    let score = 0;
    const stage = make('div', 'live');
    box.appendChild(stage);

    game.items.forEach((item, index) => {
      const row = make('div', 'fill-row');
      const p = make('div', 'game-question');
      p.textContent = (item.prompt || '').replace(/_+/g, '___');
      const input = make('input', 'fill-input');
      input.setAttribute('type', 'text');
      input.autocomplete = 'off';
      const checkBtn = make('button', 'btn btn-primary btn-sm', ui.check);
      const feedback = make('p', 'game-feedback small', '');
      const bottom = make('div', 'fill-controls');
      bottom.appendChild(input);
      bottom.appendChild(checkBtn);
      row.appendChild(p);
      row.appendChild(bottom);
      row.appendChild(feedback);
      stage.appendChild(row);

      const accepted = (Array.isArray(item.aliases) && item.aliases.length)
        ? item.aliases : (item.answer ? [item.answer] : []);

      let locked = false;
      let submittedText = '';
      checkBtn.addEventListener('click', () => {
        const value = input.value || '';
        if (locked) return;
        submittedText = value;
        const isCorrect = accepted.some((a) => eq(a, value));
        if (isCorrect) {
          locked = true;
          score += item.points || 10;
          input.disabled = true;
          input.classList.add('fill-ok');
          feedback.className = 'game-feedback ok';
          feedback.textContent = (item.feedback ? item.feedback : ui.fillGood);
          answers.push({ itemIndex: index, text: value });
        } else {
          feedback.className = 'game-feedback bad';
          feedback.textContent = ui.fillAgain;
          input.classList.add('shake');
          setTimeout(() => input.classList.remove('shake'), 400);
          answers.push({ itemIndex: index, text: value || null });
        }
      });
    });

    const footer = make('div', 'game-footer');
    const finishBtn = make('button', 'btn btn-primary', ui.finish);
    finishBtn.addEventListener('click', () => onFinish({ answers: answers, score: score }));
    footer.appendChild(finishBtn);
    stage.appendChild(footer);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function playGame(container, game, opts) {
    if (!container) return;
    opts = opts || {};
    const ui = Object.assign({}, DEFAULT_UI, opts.ui || {});
    clear(container);

    if (!game || typeof game !== 'object') {
      container.appendChild(make('p', 'muted', ui.notSupported));
      return;
    }
    container.appendChild(header(game, ui));

    if (!Array.isArray(game.items) || game.items.length === 0) {
      container.appendChild(make('p', 'muted', ui.notSupported));
      return;
    }

    const onFinish = function (result) {
      if (typeof opts.onFinish === 'function') {
        opts.onFinish(result);
      } else {
        // preview / fallback: show the score
        clear(container);
        container.appendChild(header(game, ui));
        const box = make('div', 'result-card result-pass');
        box.appendChild(make('h2', '', ui.score + ': ' + result.score + ' / ' + result.answers.length + ' ' + ui.answered));
        container.appendChild(box);
      }
    };

    try {
      if (game.type === 'quiz') renderQuiz(container, game, ui, onFinish);
      else if (game.type === 'match') renderMatch(container, game, ui, onFinish);
      else if (game.type === 'fill') renderFill(container, game, ui, onFinish);
      else container.appendChild(make('p', 'muted', ui.notSupported));
    } catch (err) {
      clear(container);
      container.appendChild(header(game, ui));
      container.appendChild(make('p', 'bad', ui.notSupported));
      if (window.console) console.error(err);
    }
  }

  function previewGame(container, game) {
    playGame(container, game, { ui: DEFAULT_UI });
  }

  global.Bewize = global.Bewize || {};
  global.Bewize.playGame = playGame;
  global.Bewize.previewGame = previewGame;
})(window);