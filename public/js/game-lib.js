/* global document, window */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Bewize game-lib: the library is FIXED to exactly 3 reusable templates —
  //   airplane, whack_a_mole, flying_fruit.
  // The AI only ever provides structured CONTENT for one of these templates;
  // it never defines new templates, layouts or UI. All content is rendered
  // with textContent (never innerHTML) so AI text can never inject markup.
  // ---------------------------------------------------------------------------

  const TEMPLATES = ['airplane', 'whack_a_mole', 'flying_fruit'];

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }
  function shuffleArr(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  const DEFAULT_UI = {
    correct: 'Correct!',
    incorrect: 'Not quite.',
    next: 'Next',
    finish: 'Finish',
    start: 'Start',
    skip: 'Skip',
    score: 'Score',
    answered: 'answered',
    notSupported: 'This game type is not supported yet.',
    questionTitle: 'Question',
    done: 'Done',
    hit: 'Whacked!',
    caught: 'Caught!',
    board: 'Catch the right ones!',
    ouch: 'Uh oh — not that one!',
    takeOff: 'Vroom! The plane is flying…',
  };

  function header(game, ui) {
    const h = make('div', 'game-header');
    const meta = make('div', 'game-header-meta');
    if (game.theme) meta.appendChild(make('span', 'chip chip-theme', game.theme));
    const idx = TEMPLATES.indexOf(game.template);
    if (idx >= 0) {
      let label = TEMPLATES[idx];
      if (ui.templates && Array.isArray(ui.templates)) {
        const found = ui.templates.filter((x) => x && x.id === game.template)[0];
        if (found && found.label) label = found.label;
      }
      meta.appendChild(make('span', 'chip chip-template', label));
    }
    h.appendChild(meta);
    if (game.title) h.appendChild(make('h2', 'game-title', game.title));
    if (game.instructions) h.appendChild(make('p', 'game-instructions', game.instructions));
    return h;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------
  function buildOptions(opts, onPick) {
    const box = make('div', 'game-options');
    (opts || []).forEach((opt, i) => {
      const b = make('button', 'quiz-option');
      b.textContent = String(opt);
      b.addEventListener('click', () => {
        if (b.disabled) return;
        onPick(i, b, String(opt));
      });
      box.appendChild(b);
    });
    return { box, buttons: Array.prototype.slice.call(box.children) };
  }

  function finishBar(finishLabel) {
    return make('button', 'btn btn-primary', finishLabel);
  }

  function skipBtn(label, onSkip) {
    const s = make('button', 'btn btn-ghost btn-sm', label);
    s.addEventListener('click', onSkip);
    return s;
  }

  // Intro/gate screen rendered INSIDE the stage so the game content nodes stay
  // attached to the document. On start it removes only itself, then renders.
  function introScreen(stage, game, ui, onStart) {
    const box = make('div', 'live intro-box');
    if (game.intro) box.appendChild(make('p', 'game-intro', game.intro));
    if (game.template === 'airplane' && ui.takeOff) box.appendChild(make('p', 'plane-takeoff', ui.takeOff));
    const start = make('button', 'btn btn-primary btn-lg', ui.start);
    start.addEventListener('click', () => {
      if (box.parentNode) box.parentNode.removeChild(box);
      onStart();
    });
    box.appendChild(start);
    stage.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // Template 1: airplane — fly a plane by answering each multiple-choice
  // question once. Immediate feedback, then Next. Skipping moves on.
  // ---------------------------------------------------------------------------
  function renderPlane(box, game, ui, onFinish) {
    const answers = [];
    let index = 0;
    let clientScore = 0;

    const stage = make('div', 'live');
    box.appendChild(stage);

    const skyline = make('div', 'plane-sky');
    const progressEl = make('p', 'game-progress', '');
    const qEl = make('div', 'game-question');
    const optsBox = make('div', 'game-options');
    const feedbackEl = make('div', 'game-feedback');
    const footerEl = make('div', 'game-footer');

    stage.appendChild(skyline);
    stage.appendChild(progressEl);
    stage.appendChild(qEl);
    stage.appendChild(optsBox);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);

    function renderQuestion(i) {
      if (i >= game.questions.length) return renderEnd();
      clear(skyline); clear(qEl); clear(optsBox); clear(feedbackEl); clear(footerEl);
      const q = game.questions[i];
      progressEl.textContent = ui.questionTitle + ' ' + (i + 1) + ' / ' + game.questions.length;

      const meteor = make('span', 'plane-icon', '✈');
      skyline.appendChild(meteor);
      skyline.appendChild(make('span', 'plane-trail', '•'.repeat(Math.min(12, 3 + i * 2))));

      qEl.textContent = q.question || '';

      const widget = buildOptions(shuffleArr([q.correct_answer].concat(q.distractors || [])), (pickedIdx, btn, text) => {
        const isCorrect = eq(text, q.correct_answer);
        widget.buttons.forEach((b, j) => {
          b.disabled = true;
          if (eq(b.textContent, q.correct_answer)) b.classList.add('quiz-option-ok');
          else if (j === pickedIdx) b.classList.add('quiz-option-bad');
        });
        answers.push({ itemIndex: i, selected: text });
        if (isCorrect) clientScore += 10;
        feedbackEl.className = 'game-feedback ' + (isCorrect ? 'ok' : 'bad');
        feedbackEl.textContent = isCorrect ? ui.correct : ui.incorrect;
        const nextBtn = finishBar(i === game.questions.length - 1 ? ui.finish : ui.next);
        nextBtn.addEventListener('click', () => { index = i + 1; renderQuestion(index); });
        footerEl.appendChild(nextBtn);
      });
      optsBox.appendChild(widget.box);

      const skipLbl = skipBtn(ui.skip, () => {
        answers.push({ itemIndex: i, selected: null });
        index = i + 1;
        renderQuestion(index);
      });
      footerEl.appendChild(skipLbl);
    }

    function renderEnd() {
      clear(stage);
      const end = make('div', 'result-card result-pass');
      end.appendChild(make('h2', '', ui.score + ': ' + clientScore + ' / ' + game.questions.length + ' ' + ui.answered));
      end.appendChild(make('p', 'big-score', game.questions.length + ' ' + ui.questionTitle.toLowerCase()));
      stage.appendChild(end);
      const fin = finishBar(ui.finish);
      fin.addEventListener('click', () => onFinish({ answers: answers, score: clientScore }));
      stage.appendChild(fin);
    }

    introScreen(stage, game, ui, () => renderQuestion(0));
  }

  // ---------------------------------------------------------------------------
  // Templates 2 & 3: whack_a_mole / flying_fruit — a grid of tiles the child
  // taps. Tap the right ones, leave the wrong ones alone. Tapping toggles.
  // ---------------------------------------------------------------------------
  function renderTiles(box, game, ui, onFinish) {
    const isMole = game.template === 'whack_a_mole';
    const list = game.targets || game.items || [];
    const prompt = game.prompt || game.category_prompt || '';
    const verb = { hit: ui.hit, caught: ui.caught }[isMole ? 'hit' : 'caught'];

    const tapped = {};
    let score = 0;

    const stage = make('div', 'live');
    box.appendChild(stage);

    const board = make('p', 'game-instructions tile-prompt', prompt || (isMole ? ui.board : ui.board));
    const grid = make('div', 'tile-grid');
    const feedbackEl = make('div', 'game-feedback');
    const footerEl = make('div', 'game-footer');

    stage.appendChild(board);
    stage.appendChild(grid);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);

    function countIllustrated() {
      const trueCount = list.filter((t) => t.is_correct).length;
      const tick = make('span', 'tile-score', ui.score + ': ' + score + ' / ' + trueCount + ' ' + ui.answered);
      clear(footerEl);
      footerEl.appendChild(tick);
    }

    list.forEach((tile, i) => {
      const tileEl = make('button', 'tile tile-' + (isMole ? 'mole' : 'fruit'));
      tileEl.textContent = tile.text;
      tileEl.addEventListener('click', () => {
        const now = !tapped[i];
        tapped[i] = now;
        tileEl.classList.toggle('tapped', now);
        tileEl.classList.toggle('tile-ok', now && tile.is_correct);
        tileEl.classList.toggle('tile-bad', now && !tile.is_correct);
        if (now) score += tile.is_correct ? 10 : -10;
        else if (tile.is_correct) score -= 10;
        else score += 10;
        if (score < 0) score = 0;
        feedbackEl.className = 'game-feedback ' + (tile.is_correct ? 'ok' : 'bad');
        feedbackEl.textContent = now
          ? (tile.is_correct ? verb : ui.ouch)
          : '';
        countIllustrated();
      });
      grid.appendChild(tileEl);
    });

    // A "Done" bar appears when every tile has been touched.
    const doneBar = make('button', 'btn btn-primary btn-lg tile-done', ui.done);
    stage.appendChild(doneBar);
    doneBar.addEventListener('click', () => {
      const answers = list.map((tile, i) => ({ itemIndex: i, tapped: Boolean(tapped[i]) }));
      clear(stage);
      const end = make('div', 'result-card result-pass');
      end.appendChild(make('h2', '', ui.score + ': ' + score + ' / ' + list.filter((t) => t.is_correct).length + ' ' + ui.answered));
      stage.appendChild(end);
      const fin = finishBar(ui.finish);
      fin.addEventListener('click', () => onFinish({ answers: answers, score: score }));
      stage.appendChild(fin);
    });
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

    const gameWrapper = make('div', 'game-wrapper theme-' + (game.template || 'default'));
    container.appendChild(gameWrapper);

    gameWrapper.appendChild(header(game, ui));

    const hasContent = game.template === 'airplane'
      ? Array.isArray(game.questions) && game.questions.length > 0
      : Array.isArray(game.targets) && game.targets.length > 0
        || Array.isArray(game.items) && game.items.length > 0;

    if (TEMPLATES.indexOf(game.template) === -1 || !hasContent) {
      gameWrapper.appendChild(make('p', 'muted', ui.notSupported));
      return;
    }

    const onFinish = function (result) {
      if (typeof opts.onFinish === 'function') {
        opts.onFinish(result);
      } else {
        clear(gameWrapper);
        gameWrapper.appendChild(header(game, ui));
        const box = make('div', 'result-card result-pass');
        box.appendChild(make('h2', '', ui.score + ': ' + result.score + ' / ' + result.answers.length + ' ' + ui.answered));
        gameWrapper.appendChild(box);
      }
    };

    try {
      if (game.template === 'airplane') renderPlane(gameWrapper, game, ui, onFinish);
      else if (game.template === 'whack_a_mole') renderTiles(gameWrapper, game, ui, onFinish);
      else if (game.template === 'flying_fruit') renderTiles(gameWrapper, game, ui, onFinish);
      else gameWrapper.appendChild(make('p', 'muted', ui.notSupported));
    } catch (err) {
      clear(gameWrapper);
      gameWrapper.appendChild(header(game, ui));
      gameWrapper.appendChild(make('p', 'bad', ui.notSupported));
      if (window.console) console.error(err);
    }
  }

  function eq(a, b) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

  function previewGame(container, game) {
    playGame(container, game, { ui: DEFAULT_UI });
  }

  global.Bewize = global.Bewize || {};
  global.Bewize.playGame = playGame;
  global.Bewize.previewGame = previewGame;
})(window);