/* global document, window, performance */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Bewize game-lib: exactly 3 reusable HTML5-Canvas templates —
  //   airplane, whack_a_mole, flying_fruit.
  // The AI only ever provides structured CONTENT for one of these templates;
  // it never defines templates, layouts or UI. All text is drawn on the canvas
  // (never innerHTML) so AI content can never inject markup.
  // Submit JSON (answers) is graded server-side — the client score is display
  // only.
  // ---------------------------------------------------------------------------

  const TEMPLATES = ['airplane', 'whack_a_mole', 'flying_fruit'];

  const W = 900;
  const H = 520;

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
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  const DEFAULT_UI = {
    correct: 'Correct!',
    incorrect: 'Not quite.',
    next: 'Next',
    finish: 'Finish',
    start: 'Start',
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

  // Visual "style" is chosen from the player's gender at play time. The game
  // CONTENT never changes — only colours and accents (girl style / boy style /
  // neutral). Teachers and unknown genders get the neutral look.
  const GENDER_STYLES = {
    female: {
      plane: '#ec4899',
      skyTop: '#fbcfe8', skyBottom: '#fdf2f8', ground: '#f472b6', groundEdge: '#f9a8d4',
      mole: ['#f9a8d4', '#be185d'],
      fruit: ['#831843', '#9d174d'],
    },
    male: {
      plane: '#2563eb',
      skyTop: '#7dd3fc', skyBottom: '#e0f2fe', ground: '#3b82f6', groundEdge: '#93c5fd',
      mole: ['#60a5fa', '#1e40af'],
      fruit: ['#172554', '#1e40af'],
    },
    neutral: {
      plane: '#ef4444',
      skyTop: '#7cc6f2', skyBottom: '#cfeeff', ground: '#8bc482', groundEdge: '#a7d09d',
      mole: ['#76c276', '#2e6b3c'],
      fruit: ['#12334f', '#1d4e6b'],
    },
  };

  function genderStyle(ui) {
    const st = (ui && ui.stat) || {};
    return GENDER_STYLES[st.gender] || GENDER_STYLES.neutral;
  }

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
    if (ui.style) {
      const gend = ui.stat && ui.stat.gender;
      meta.appendChild(make('span', 'chip chip-style' + (gend === 'female' || gend === 'male' ? '-' + gend : ''), ui.style));
    }
    h.appendChild(meta);
    if (game.title) h.appendChild(make('h2', 'game-title', game.title));
    if (game.instructions) h.appendChild(make('p', 'game-instructions', game.instructions));
    return h;
  }

  // Intro/gate screen rendered INSIDE the stage so game nodes stay attached.
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
  // Shared canvas plumbing
  // ---------------------------------------------------------------------------
  function buildCanvas(shell) {
    const canvas = make('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.className = 'bewize-game-canvas';
    shell.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const pointer = (e) => {
      const r = canvas.getBoundingClientRect();
      const src = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
      return {
        x: (src.clientX - r.left) * (W / r.width),
        y: (src.clientY - r.top) * (H / r.height),
      };
    };
    return { ctx, pointer, shell };
  }

  // rAF loop with dt (seconds, clamped) + draw callback + cleanup on stop.
  function startLoop(step, draw, cleanup) {
    let raf = 0;
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      step(dt, now);
      draw(dt);
      if (!raf) return; // stopped during step
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return { stop: () => { cancelAnimationFrame(raf); if (cleanup) cleanup(); } };
  }

  function fitText(ctx, text, maxWidth, start) {
    let fs = start || 32;
    while (fs > 12 && ctx.measureText(text).width > maxWidth) fs -= 1;
    ctx.font = 'bold ' + fs + 'px Segoe UI, sans-serif';
    return fs;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3).map((l, i) => (i === 2 && lines.length > 3 ? l + '…' : l));
  }

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawLabelBox(ctx, text, cx, cy, w, h, fill, stroke) {
    roundedRect(ctx, cx - w / 2, cy - h / 2, w, h, 22);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke || 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, text, w - 20, 30);
    const lines = wrapText(ctx, text, w - 20);
    const lh = lines.length * 22;
    let y = cy - lh / 2 + 12;
    for (const l of lines) {
      ctx.fillText(l, cx, y + (lines.length > 1 ? 0 : 4));
      y += 22;
    }
    ctx.textBaseline = 'alphabetic';
  }

  // Simple floating feedback particles.
  function spawnParticles(list, x, y, text, color) {
    list.push({
      x, y, text, color,
      life: 1, vy: -46 - Math.random() * 30, vx: (Math.random() - 0.5) * 40,
    });
    if (list.length > 24) list.shift();
  }
  function drawParticles(ctx, list, dt) {
    ctx.textAlign = 'center';
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt * 0.85;
      if (p.life <= 0) { list.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.font = 'bold 26px Segoe UI, sans-serif';
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Template 1: airplane — side-scrolling; clouds (answer options) drift right
  // to left; fly into the correct one (+10), wrong ones are destroyed (-5).
  // ---------------------------------------------------------------------------
  function renderPlane(pointer, ctx, shell, game, ui, status, onFinish) {
    const answers = [];
    let score = 0;
    let qIndex = 0;
    const plane = { y: 250, targetY: 250 };
    const particles = [];
    let clouds = [];
    const wrongHits = new Set();
    const keys = {};
    let pointerActive = false;
    let pointerY = 250;
    let ended = false;

    const st = ui.stat || {};
    const style = genderStyle(ui);
    const skyline = [];
    for (let i = 0; i < 8; i++) {
      skyline.push({ x: Math.random() * W, y: 60 + Math.random() * 300, r: 18 + Math.random() * 26, vx: 6 + Math.random() * 14 });
    }

    function hdr() {
      status.prompt.textContent = ui.questionTitle + ' ' + (qIndex + 1) + ' / ' + game.questions.length;
      status.score.textContent = ui.score + ': ' + Math.max(0, score);
    }

    function spawnQuestion(qi) {
      const q = game.questions[qi];
      const opts = shuffleArr(
        [{ text: q.correct_answer, correct: true }]
          .concat((q.distractors || []).map((t) => ({ text: String(t), correct: false }))),
      );
      // Correct answer always sits in the easy middle lane; distractors fly
      // above/below it. Position on screen inside the function body below.
      let n = 0;
      clouds = opts.map((o) => {
        const lane = o.correct ? 230 : (n++ % 2 === 0 ? 84 : 388);
        return {
          text: o.text, correct: o.correct,
          x: W + 40 + Math.random() * 160, y: lane + (Math.random() * 10 - 5),
          vx: 2 + Math.random() * 1.4, r: 48, dead: false,
        };
      });
      wrongHits.clear();
      hdr();
    }

    spawnQuestion(0);

    function onKeyDown(e) { keys[e.key] = true; }
    function onKeyUp(e) { keys[e.key] = false; }
    function onPointerMove(e) {
      pointerActive = true;
      pointerY = pointer(e).y;
    }

    function step(dt) {
      const k = keys;
      if (k.ArrowUp || k.w || k.W) plane.targetY -= 260 * dt;
      if (k.ArrowDown || k.s || k.S) plane.targetY += 260 * dt;
      if (pointerActive) plane.targetY = pointerY;
      plane.targetY = clamp(plane.targetY, 42, H - 42);
      plane.y += (plane.targetY - plane.y) * Math.min(1, dt * 9);

      // decor background drift
      skyline.forEach((c) => {
        c.x -= c.vx * dt;
        if (c.x < -80) { c.x = W + 80; c.y = 60 + Math.random() * 300; }
      });

      clouds.forEach((c) => {
        if (c.dead) return;
        c.x -= c.vx * 40 * dt;
        // A cloud that exits the left edge must come back — otherwise the
        // correct answer can be lost forever and the game can never finish.
        if (c.x < -120) {
          c.x = W + 60 + Math.random() * 200;
          c.vx = 2 + Math.random() * 1.4;
        }
        if (Math.hypot(planeX - c.x, plane.y - c.y) < 36 + c.r) {
          if (c.correct) {
            c.dead = true;
            wrongHits.delete(c.text);
            score += 10;
            spawnParticles(particles, c.x, c.y, '+10', '#4ade80');
            answers.push({ itemIndex: qIndex, selected: c.text, wrongHits: Array.from(wrongHits) });
            qIndex += 1;
            if (qIndex >= game.questions.length) end();
            else spawnQuestion(qIndex);
          } else {
            c.dead = true;
            score = Math.max(0, score - 5);
            wrongHits.add(c.text);
            spawnParticles(particles, c.x, c.y, '-5', '#f87171');
          }
          hdr();
        }
      });
    }

    const planeX = 110;
    function draw(dt) {
      // sky + ground
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, style.skyTop);
      g.addColorStop(0.75, style.skyBottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = style.ground;
      ctx.fillRect(0, H - 34, W, 34);
      ctx.fillStyle = style.groundEdge;
      ctx.fillRect(0, H - 34, W, 8);

      // decor clouds
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      skyline.forEach((c) => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.arc(c.x + c.r * 0.9, c.y - c.r * 0.3, c.r * 0.65, 0, Math.PI * 2);
        ctx.arc(c.x - c.r * 0.9, c.y - c.r * 0.25, c.r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      });

      // answer clouds
      clouds.forEach((c) => {
        if (c.dead) return;
        const bob = Math.sin(performance.now() / 600 + c.r) * 4;
        drawLabelBox(ctx, c.text, c.x, c.y + bob, c.r * 2.7, c.r * 1.45, '#ffffff', 'rgba(30,41,59,0.35)');
      });

      // plane
      drawPlane(plane.y, st.color || style.plane);
      drawParticles(ctx, particles, dt);
    }

    function drawPlane(y, color) {
      ctx.save();
      ctx.translate(planeX, y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(46, 0);
      ctx.lineTo(-22, -16);
      ctx.lineTo(-6, 0);
      ctx.lineTo(-22, 16);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(8, -3, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(-20, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function end() {
      if (ended) return;
      ended = true;
      loop.stop();
      finish(shell.parentNode, ui, onFinish, { answers, score });
    }

    const loop = startLoop(step, draw, () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      shell.removeEventListener('pointermove', onPointerMove);
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    shell.addEventListener('pointermove', onPointerMove);
    shell.addEventListener('pointerleave', () => { pointerActive = false; });
  }

  // ---------------------------------------------------------------------------
  // Template 2: whack_a_mole — 6 holes, one mole pops at a time carrying a
  // target. Whack only the correct ones (+10), avoid the wrong ones (-5).
  // ---------------------------------------------------------------------------
  function renderMole(pointer, ctx, shell, game, ui, status, onFinish) {
    const list = game.targets || [];
    const answers = list.map(() => ({ itemIndex: 0, tapped: false }));
    let score = 0;
    const deck = shuffleArr(list.map((_, i) => i));
    let deckIdx = 0;
    let mole = null;
    let moleTimer = 0;
    let pause = 0.55;
    let form = -1;
    const particles = [];
    let ended = false;

    const holes = [
      { x: W * 0.17, y: 150 }, { x: W * 0.5, y: 150 }, { x: W * 0.83, y: 150 },
      { x: W * 0.17, y: 350 }, { x: W * 0.5, y: 350 }, { x: W * 0.83, y: 350 },
    ];

    function hdr() {
      status.prompt.textContent = (game.prompt || ui.board);
      status.score.textContent = ui.score + ': ' + Math.max(0, score) + ' · ' + deckIdx + '/' + deck.length;
    }
    hdr();

    function popNext() {
      if (deckIdx >= deck.length) {
        mole = null;
        if (pause <= 0) end();
        return;
      }
      const idx = deck[deckIdx];
      mole = {
        idx,
        text: list[idx].text,
        correct: Boolean(list[idx].is_correct),
        hole: holes[Math.floor(Math.random() * holes.length)],
        ttl: 1.9,
        state: 'up',
      };
      moleTimer = 0;
      deckIdx += 1;
      hdr();
    }

    function onTap(e) {
      const p = pointer(e);
      if (mole && mole.state === 'up' && Math.hypot(p.x - mole.hole.x, p.y - (mole.hole.y - 34)) < 52) {
        answers[mole.idx].tapped = true;
        if (mole.correct) {
          score += 10;
          spawnParticles(particles, mole.hole.x, mole.hole.y - 40, '+10', '#4ade80');
        } else {
          score = Math.max(0, score - 5);
          spawnParticles(particles, mole.hole.x, mole.hole.y - 40, '-5', '#f87171');
        }
        mole.state = 'down';
        moleTimer = 0;
        pause = 0.5;
        hdr();
      }
    }

    function step(dt) {
      if (pause > 0) {
        pause -= dt;
        if (pause <= 0 && mole && mole.state === 'down') popNext();
        return;
      }
      if (mole) {
        moleTimer += dt;
        if (mole.state === 'up' && moleTimer >= mole.ttl) {
          mole.state = 'down';
          moleTimer = 0;
          pause = 0.5;
        }
        if (mole.state === 'down') {
          const f = moleTimer / 0.25;
          form = 1 - Math.min(1, f);
        } else {
          form = Math.min(1, moleTimer / 0.18);
        }
      } else {
        popNext();
      }
    }

    function draw(dt) {
      const style = genderStyle(ui);
      ctx.fillStyle = style.mole[0];
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, style.mole[0]);
      g.addColorStop(1, style.mole[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      holes.forEach((h) => {
        ctx.fillStyle = '#4a2f13';
        ctx.beginPath();
        ctx.ellipse(h.x, h.y + 16, 64, 24, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1d1006';
        ctx.beginPath();
        ctx.ellipse(h.x, h.y + 8, 46, 14, 0, 0, Math.PI * 2);
        ctx.fill();
      });

      if (mole && mole.state === 'up' && form > 0) {
        const h = mole.hole;
        const rise = form;
        const my = h.y + 8 - rise * 34;
        // mole head + body
        ctx.fillStyle = '#8a5a2b';
        ctx.beginPath();
        ctx.ellipse(h.x, my - 22 * rise, 34 * rise, 26 * rise, 0, 0, Math.PI * 2);
        ctx.fill();
        if (rise > 0.4) {
          ctx.fillStyle = '#f5c88f';
          ctx.beginPath();
          ctx.ellipse(h.x, my - 26 * rise, 16 * rise, 9 * rise, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // label
        if (rise > 0.75) {
          drawLabelBox(ctx, mole.text, h.x, my - 62, 150, 40, 'rgba(255,255,255,0.95)', 'rgba(30,41,59,0.4)');
        }
        // retreat blink in the last moments
        if (moleTimer > mole.ttl - 0.35 && Math.floor(performance.now() / 140) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.beginPath();
          ctx.ellipse(h.x, my - 20 * rise, 30 * rise, 24 * rise, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      drawParticles(ctx, particles, dt);
    }

    function end() {
      if (ended) return;
      ended = true;
      loop.stop();
      shell.removeEventListener('pointerdown', onTap);
      finish(shell.parentNode, ui, onFinish, { answers, score });
    }

    const loop = startLoop(step, draw, () => shell.removeEventListener('pointerdown', onTap));
    shell.addEventListener('pointerdown', onTap);
  }

  // ---------------------------------------------------------------------------
  // Template 3: flying_fruit — items arc up from the bottom with gravity.
  // Tap the right ones (+10), wrong ones cost (-5).
  // ---------------------------------------------------------------------------
  function renderFruit(pointer, ctx, shell, game, ui, status, onFinish) {
    const list = game.items || [];
    const answers = list.map(() => ({ itemIndex: 0, tapped: false }));
    let score = 0;
    const deck = shuffleArr(list.map((_, i) => i));
    let deckIdx = 0;
    const active = [];
    let spawnT = 0;
    const particles = [];
    let ended = false;

    const fruitColors = ['#f59e0b', '#fb923c', '#22c55e', '#a855f7', '#ef4444', '#0ea5e9'];

    function hdr() {
      status.prompt.textContent = (game.category_prompt || ui.board);
      status.score.textContent = ui.score + ': ' + Math.max(0, score) + ' · ' + deckIdx + '/' + deck.length;
    }
    hdr();

    function spawn() {
      if (deckIdx >= deck.length) return;
      const idx = deck[deckIdx];
      active.push({
        idx,
        text: list[idx].text,
        correct: Boolean(list[idx].is_correct),
        x: 120 + Math.random() * (W - 240),
        y: H + 30,
        vx: (Math.random() - 0.5) * 90,
        vy: -(300 + Math.random() * 160),
        r: 44,
        color: fruitColors[Math.floor(Math.random() * fruitColors.length)],
      });
      deckIdx += 1;
      hdr();
    }

    function onTap(e) {
      const p = pointer(e);
      for (let i = active.length - 1; i >= 0; i--) {
        const f = active[i];
        if (Math.hypot(p.x - f.x, p.y - f.y) < f.r + 10) {
          answers[f.idx].tapped = true;
          if (f.correct) {
            score += 10;
            spawnParticles(particles, f.x, f.y, '+10', '#4ade80');
          } else {
            score = Math.max(0, score - 5);
            spawnParticles(particles, f.x, f.y, '-5', '#f87171');
          }
          active.splice(i, 1);
          hdr();
          return;
        }
      }
    }

    function step(dt) {
      spawnT += dt;
      if (spawnT >= 0.85 && deckIdx < deck.length && active.length < 3) {
        spawnT = 0;
        spawn();
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const f = active[i];
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vy += 560 * dt;
        if (f.x < -60) f.x = W + 60;
        if (f.x > W + 60) f.x = -60;
        if (f.y > H + 80) active.splice(i, 1);
      }

      if (deckIdx >= deck.length && active.length === 0) end();
    }

    function draw(dt) {
      const style = genderStyle(ui);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, style.fruit[0]);
      g.addColorStop(1, style.fruit[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 1; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(i * 160, H * 0.6 + Math.sin(i) * 30, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      active.forEach((f) => {
        drawLabelBox(ctx, f.text, f.x, f.y, f.r * 2.4, f.r * 1.35, f.color, 'rgba(255,255,255,0.5)');
      });
      drawParticles(ctx, particles, dt);
    }

    function end() {
      if (ended) return;
      ended = true;
      loop.stop();
      shell.removeEventListener('pointerdown', onTap);
      finish(shell.parentNode, ui, onFinish, { answers, score });
    }

    const loop = startLoop(step, draw, () => shell.removeEventListener('pointerdown', onTap));
    shell.addEventListener('pointerdown', onTap);
  }

  // ---------------------------------------------------------------------------
  // Shared end card + Finish
  // ---------------------------------------------------------------------------
  function finish(stage, ui, onFinish, result) {
    clear(stage);
    const end = make('div', 'result-card result-pass');
    end.appendChild(make('h2', '', ui.score + ': ' + Math.max(0, result.score) + ' / ' + result.answers.length + ' ' + ui.answered));
    end.appendChild(make('p', 'big-score', ui.finish));
    stage.appendChild(end);
    const fin = make('button', 'btn btn-primary btn-lg', ui.finish);
    fin.addEventListener('click', () => onFinish(result));
    stage.appendChild(fin);
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

    const gend = opts.gender || (opts.ui && opts.ui.stat && opts.ui.stat.gender) || '';
    const gameWrapper = make('div', 'game-wrapper theme-' + (game.template || 'default') + (gend === 'female' || gend === 'male' ? ' style-' + gend : ''));
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
        box.appendChild(make('h2', '', ui.score + ': ' + Math.max(0, result.score) + ' / ' + result.answers.length + ' ' + ui.answered));
        gameWrapper.appendChild(box);
      }
    };

    const stage = make('div', 'live');
    gameWrapper.appendChild(stage);

    const statusEl = make('div', 'game-status');
    statusEl.appendChild(make('span', 'status-prompt', ''));
    statusEl.appendChild(make('span', 'status-score', ''));
    stage.appendChild(statusEl);

    function start() {
      clear(stage);
      stage.appendChild(statusEl);
      const shell = make('div', 'canvas-shell');
      stage.appendChild(shell);
      const status = { prompt: statusEl.children[0], score: statusEl.children[1] };
      try {
        const { ctx, pointer } = buildCanvas(shell);
        if (game.template === 'airplane') renderPlane(pointer, ctx, shell, game, ui, status, onFinish);
        else if (game.template === 'whack_a_mole') renderMole(pointer, ctx, shell, game, ui, status, onFinish);
        else renderFruit(pointer, ctx, shell, game, ui, status, onFinish);
      } catch (err) {
        clear(stage);
        gameWrapper.appendChild(make('p', 'bad', ui.notSupported));
        if (window.console) console.error(err);
      }
    }
    introScreen(stage, game, ui, start);
  }

  function previewGame(container, game) {
    playGame(container, game, { ui: DEFAULT_UI });
  }

  global.Bewize = global.Bewize || {};
  global.Bewize.playGame = playGame;
  global.Bewize.previewGame = previewGame;
})(window);