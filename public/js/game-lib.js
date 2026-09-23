/* global document, window */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Bewize game-lib: the library is FIXED to exactly 3 reusable templates —
  //   adventure_mission, challenge_quest, build_rescue.
  // The AI only ever provides structured CONTENT for one of these templates;
  // it never defines new templates, layouts or UI. All content is rendered
  // with textContent (never innerHTML) so AI text can never inject markup.
  // ---------------------------------------------------------------------------

  const TEMPLATES = ['adventure_mission', 'challenge_quest', 'build_rescue'];

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
    journey: 'Journey',
    stop: 'Stop',
    scene: 'Scene',
    advance: 'Solved! Moving on…',
    retry: 'Not quite — try again!',
    missionComplete: 'Mission complete!',
    questBoard: 'Quest board',
    questRound: 'Round',
    trophy: 'Trophy',
    goal: 'Goal',
    parts: 'parts',
    assembled: 'Assembled — rescue complete!',
    built: 'Built',
  };

  function header(game, ui) {
    const h = make('div', 'game-header');
    const meta = make('div', 'game-header-meta');
    if (game.theme) meta.appendChild(make('span', 'chip chip-theme', game.theme));
    const tpl = TEMPLATES.indexOf(game.template);
    if (tpl >= 0) {
      let label = ['adventure_mission', 'challenge_quest', 'build_rescue'][tpl];
      if (ui.templates && Array.isArray(ui.templates)) {
        const found = ui.templates.filter((x) => x && x.id === label)[0];
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
        onPick(i, b);
      });
      box.appendChild(b);
    });
    return { box, buttons: Array.prototype.slice.call(box.children) };
  }

  function detailLabel(entry, ui) {
    const wrap = make('div', 'entry-meta');
    if (entry.label) wrap.appendChild(make('p', 'game-progress entry-label', entry.label));
    if (entry.detail) wrap.appendChild(make('p', 'entry-detail', entry.detail));
    return wrap;
  }

  function finishBar(finishLabel) {
    return make('button', 'btn btn-primary', finishLabel);
  }

  // Partial "skip" resets a step without submitting.
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
    if (game.template === 'build_rescue' && game.goal) {
      box.appendChild(make('p', 'build-goal', ui.goal + ': ' + game.goal));
    }
    const start = make('button', 'btn btn-primary btn-lg', ui.start);
    start.addEventListener('click', () => {
      if (box.parentNode) box.parentNode.removeChild(box);
      onStart();
    });
    box.appendChild(start);
    stage.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // Template 1: adventure_mission — a gated story journey.
  // Each "stop" must be answered correctly to advance. Retries allowed.
  // ---------------------------------------------------------------------------
  function renderAdventure(box, game, ui, onFinish) {
    const answers = [];
    let index = 0;
    let clientScore = 0;

    const stage = make('div', 'live');
    box.appendChild(stage);

    const journey = make('div', 'journey-track');
    const progressEl = make('p', 'game-progress', '');
    const labelP = make('p', 'game-progress entry-label', '');
    const sceneP = make('p', 'entry-detail', '');
    const qEl = make('div', 'game-question');
    const optsBox = make('div', 'game-options');
    const feedbackEl = make('div', 'game-feedback');
    const stepMeta = make('div', '');
    const footerEl = make('div', 'game-footer');

    stage.appendChild(journey);
    stage.appendChild(progressEl);
    stage.appendChild(stepMeta);
    stage.appendChild(qEl);
    stage.appendChild(optsBox);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);

    function buildTrack() {
      clear(journey);
      const t = make('span', 'journey-title', ui.journey);
      journey.appendChild(t);
      game.entries.forEach((e, i) => {
        const n = make('span', 'journey-node' + (i < index ? ' done' : i === index ? ' current' : ''));
        n.textContent = String(i + 1);
        n.title = e.label || '';
        journey.appendChild(n);
      });
    }

    function renderStep() {
      if (index >= game.entries.length) return renderEnd();
      clear(stepMeta); clear(qEl); clear(optsBox); clear(feedbackEl); clear(footerEl);
      buildTrack();
      const entry = game.entries[index];
      progressEl.textContent = ui.stop + ' ' + (index + 1) + ' / ' + game.entries.length;
      labelP.textContent = entry.label || '';
      sceneP.textContent = entry.detail || '';
      stepMeta.appendChild(labelP);
      stepMeta.appendChild(sceneP);
      qEl.textContent = entry.question || '';

      const widget = buildOptions(entry.options, (pickedIdx, btn) => {
        const isCorrect = pickedIdx === entry.correctIndex;
        if (isCorrect) {
          widget.buttons.forEach((b, i) => { b.disabled = true; if (i === entry.correctIndex) b.classList.add('quiz-option-ok'); });
          answers.push({ itemIndex: index, selectedIndex: pickedIdx });
          clientScore += entry.points || 10;
          feedbackEl.className = 'game-feedback ok';
          feedbackEl.textContent = entry.feedback ? entry.feedback : ui.correct;
          const nextBtn = finishBar(ui.advance);
          nextBtn.addEventListener('click', () => { index++; renderStep(); });
          footerEl.appendChild(nextBtn);
        } else {
          btn.classList.add('shake');
          setTimeout(() => btn.classList.remove('shake'), 400);
          feedbackEl.className = 'game-feedback bad';
          feedbackEl.textContent = ui.retry;
        }
      });
      optsBox.appendChild(widget.box);
      const skipLbl = make('button', 'btn btn-ghost btn-sm', ui.skip);
      skipLbl.addEventListener('click', () => {
        answers.push({ itemIndex: index, selectedIndex: null });
        index++;
        renderStep();
      });
      footerEl.appendChild(skipLbl);
    }

    function renderEnd() {
      clear(stage);
      const end = make('div', 'result-card result-pass');
      end.appendChild(make('h2', '', game.ending || ui.missionComplete));
      end.appendChild(make('p', 'big-score', ui.score + ': ' + clientScore + ' / ' + game.entries.length + ' ' + ui.answered));
      stage.appendChild(end);
      const fin = finishBar(ui.finish);
      fin.addEventListener('click', () => onFinish({ answers: answers, score: clientScore }));
      stage.appendChild(fin);
    }

    introScreen(stage, game, ui, renderStep);
  }

  // ---------------------------------------------------------------------------
  // Template 2: challenge_quest — independent rounds, one attempt each,
  // a trophy board tracks how many you mastered.
  // ---------------------------------------------------------------------------
  function renderQuest(box, game, ui, onFinish) {
    const answers = [];
    let index = 0;
    let clientScore = 0;
    let trophies = 0;

    const stage = make('div', 'live');
    box.appendChild(stage);

    const board = make('div', 'quest-board');
    const progressEl = make('p', 'game-progress', '');
    const flavorP = make('p', 'entry-detail', '');
    const qEl = make('div', 'game-question');
    const optsBox = make('div', 'game-options');
    const feedbackEl = make('div', 'game-feedback');
    const footerEl = make('div', 'game-footer');

    stage.appendChild(board);
    stage.appendChild(progressEl);
    stage.appendChild(flavorP);
    stage.appendChild(qEl);
    stage.appendChild(optsBox);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);

    function renderBoard() {
      clear(board);
      const t = make('span', 'board-title', ui.questBoard);
      board.appendChild(t);
      game.entries.forEach((e, i) => {
        const slot = make('span', 'quest-slot' + (i === index ? ' current' : ''));
        const label = make('span', 'quest-slot-label', e.label || String(i + 1));
        const cup = make('span', 'quest-cup' + (i < index ? ' earned' : ''));
        cup.textContent = '★';
        cup.title = ui.trophy;
        slot.appendChild(label);
        slot.appendChild(cup);
        board.appendChild(slot);
      });
    }

    function renderQuestAt(i) {
      if (i >= game.entries.length) return renderEnd();
      clear(flavorP); clear(qEl); clear(optsBox); clear(feedbackEl); clear(footerEl);
      renderBoard();
      const entry = game.entries[i];
      progressEl.textContent = ui.questRound + ' ' + (i + 1) + ' / ' + game.entries.length;
      if (entry.label) progressEl.textContent = (entry.label ? entry.label + ' · ' : '') + progressEl.textContent;
      if (entry.detail) flavorP.textContent = entry.detail;
      qEl.textContent = entry.question || '';

      const widget = buildOptions(entry.options, (pickedIdx, btn) => {
        const isCorrect = pickedIdx === entry.correctIndex;
        widget.buttons.forEach((b, j) => {
          b.disabled = true;
          if (j === entry.correctIndex) b.classList.add('quiz-option-ok');
          else if (j === pickedIdx) b.classList.add('quiz-option-bad');
        });
        answers.push({ itemIndex: i, selectedIndex: pickedIdx });
        if (isCorrect) { clientScore += entry.points || 10; trophies++; }
        feedbackEl.className = 'game-feedback ' + (isCorrect ? 'ok' : 'bad');
        feedbackEl.textContent = entry.feedback ? entry.feedback : (isCorrect ? ui.correct : ui.incorrect);
        const nextBtn = finishBar(i === game.entries.length - 1 ? ui.finish : ui.next);
        nextBtn.addEventListener('click', () => { index = i + 1; renderQuestAt(index); });
        footerEl.appendChild(nextBtn);
      });
      optsBox.appendChild(widget.box);
      // after a skip the board just moves on, no trophy
      const skipLbl = make('button', 'btn btn-ghost btn-sm', ui.skip);
      skipLbl.addEventListener('click', () => {
        answers.push({ itemIndex: i, selectedIndex: null });
        index = i + 1;
        renderQuestAt(index);
      });
      footerEl.appendChild(skipLbl);
    }

    function renderEnd() {
      clear(stage);
      const end = make('div', 'result-card result-pass');
      end.appendChild(make('h2', '', ui.questBoard + ' — ' + trophies + ' ' + ui.trophy));
      end.appendChild(make('p', 'big-score', ui.score + ': ' + clientScore + ' / ' + game.entries.length + ' ' + ui.answered));
      stage.appendChild(end);
      const fin = finishBar(ui.finish);
      fin.addEventListener('click', () => onFinish({ answers: answers, score: clientScore }));
      stage.appendChild(fin);
    }

    introScreen(stage, game, ui, () => renderQuestAt(0));
  }

  // ---------------------------------------------------------------------------
  // Template 3: build_rescue — assemble parts to build / rescue a goal.
  // Parts build up a progress bar; retries allowed until each part is placed.
  // ---------------------------------------------------------------------------
  function renderBuild(box, game, ui, onFinish) {
    const answers = [];
    let index = 0;
    let clientScore = 0;
    const skipped = {};

    const stage = make('div', 'live');
    box.appendChild(stage);

    const goalBar = make('p', 'build-goal', (game.goal ? ui.goal + ': ' + game.goal : ''));
    const buildTrack = make('div', 'build-track');
    const progressEl = make('p', 'game-progress', '');
    const partNameP = make('p', 'game-progress entry-label', '');
    const partDetailP = make('p', 'entry-detail', '');
    const qEl = make('div', 'game-question');
    const optsBox = make('div', 'game-options');
    const feedbackEl = make('div', 'game-feedback');
    const footerEl = make('div', 'game-footer');

    stage.appendChild(goalBar);
    stage.appendChild(buildTrack);
    stage.appendChild(progressEl);
    stage.appendChild(partNameP);
    stage.appendChild(partDetailP);
    stage.appendChild(qEl);
    stage.appendChild(optsBox);
    stage.appendChild(feedbackEl);
    stage.appendChild(footerEl);

    function renderTrack() {
      clear(buildTrack);
      game.entries.forEach((e, i) => {
        const seg = make('span', 'build-seg' + (i < index ? ' built' : i === index ? ' current' : ''));
        seg.textContent = String(i + 1);
        seg.title = e.label || '';
        buildTrack.appendChild(seg);
      });
      buildTrack.appendChild(make('span', 'build-count', (index - Object.keys(skipped).length) + '/' + game.entries.length + ' ' + ui.parts));
    }

    function renderPart(i) {
      if (i >= game.entries.length) return renderEnd();
      clear(partNameP); clear(partDetailP); clear(qEl); clear(optsBox); clear(feedbackEl); clear(footerEl);
      renderTrack();
      const entry = game.entries[i];
      progressEl.textContent = i + 1 + ' / ' + game.entries.length;
      partNameP.textContent = entry.label || '';
      partDetailP.textContent = entry.detail || '';
      qEl.textContent = entry.question || '';

      const widget = buildOptions(entry.options, (pickedIdx) => {
        const isCorrect = pickedIdx === entry.correctIndex;
        if (isCorrect) {
          widget.buttons.forEach((b, j) => { b.disabled = true; if (j === entry.correctIndex) b.classList.add('quiz-option-ok'); });
          answers.push({ itemIndex: i, selectedIndex: pickedIdx });
          clientScore += entry.points || 10;
          delete skipped[i];
          feedbackEl.className = 'game-feedback ok';
          feedbackEl.textContent = entry.feedback ? entry.feedback : ui.built;
          const nextBtn = finishBar(i === game.entries.length - 1 ? ui.finish : ui.next);
          nextBtn.addEventListener('click', () => { index = i + 1; renderPart(index); });
          footerEl.appendChild(nextBtn);
        } else {
          widget.buttons.forEach((b, j) => {
            if (j === pickedIdx) b.classList.add('shake');
            setTimeout(() => b.classList.remove('shake'), 400);
          });
          feedbackEl.className = 'game-feedback bad';
          feedbackEl.textContent = ui.retry;
        }
      });
      optsBox.appendChild(widget.box);
      const skipLbl = make('button', 'btn btn-ghost btn-sm', ui.skip);
      skipLbl.addEventListener('click', () => {
        answers.push({ itemIndex: i, selectedIndex: null });
        skipped[i] = true;
        index = i + 1;
        renderPart(index);
      });
      footerEl.appendChild(skipLbl);
    }

    function renderEnd() {
      clear(stage);
      const end = make('div', 'result-card result-pass');
      end.appendChild(make('h2', '', ui.assembled));
      end.appendChild(make('p', 'big-score', ui.score + ': ' + clientScore + ' / ' + game.entries.length + ' ' + ui.answered));
      stage.appendChild(end);
      const fin = finishBar(ui.finish);
      fin.addEventListener('click', () => onFinish({ answers: answers, score: clientScore }));
      stage.appendChild(fin);
    }

    introScreen(stage, game, ui, () => renderPart(0));
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

    if (TEMPLATES.indexOf(game.template) === -1 || !Array.isArray(game.entries) || game.entries.length === 0) {
      container.appendChild(make('p', 'muted', ui.notSupported));
      return;
    }

    const onFinish = function (result) {
      if (typeof opts.onFinish === 'function') {
        opts.onFinish(result);
      } else {
        clear(container);
        container.appendChild(header(game, ui));
        const box = make('div', 'result-card result-pass');
        box.appendChild(make('h2', '', ui.score + ': ' + result.score + ' / ' + result.answers.length + ' ' + ui.answered));
        container.appendChild(box);
      }
    };

    try {
      if (game.template === 'adventure_mission') renderAdventure(container, game, ui, onFinish);
      else if (game.template === 'challenge_quest') renderQuest(container, game, ui, onFinish);
      else if (game.template === 'build_rescue') renderBuild(container, game, ui, onFinish);
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