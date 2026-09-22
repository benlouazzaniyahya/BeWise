'use strict';

// ---------------------------------------------------------------------------
// AI game generation + strict validation.
//
// - Calls OpenRouter (OpenAI-compatible chat completions) when
//   OPENROUTER_API_KEY is present.
// - Otherwise falls back to a deterministic OFFLINE generator so the whole
//   flow can still be demoed without a key (clearly labelled in the UI).
// - NEVER receives a child's real name or any personal data. Only generic
//   per-lesson context (lesson text, level, language, age band, profile type,
//   gender theme).
// ---------------------------------------------------------------------------

const { levelBand } = require('../i18n');

const TYPES = ['quiz', 'match', 'fill'];
const MAX_ATTEMPTS = 3;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = 'You are a careful author of educational mini-games for children aged 5 to 15. '
  + 'You always reply with exactly one valid JSON object and nothing else. '
  + 'No markdown fences, no commentary, no trailing text.';

// ---------------------------------------------------------------------------
// Safety / age-appropriateness check
// ---------------------------------------------------------------------------
const URL_RE = /(https?:\/\/|www\.)[^\s]+/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;

const BLOCKED_TOKENS = [
  // english
  'killing', 'murder', 'kill yourself', 'die', 'death', 'blood', 'weapon',
  'gun', 'bomb', 'sex', 'drug', 'suicide', 'violence', 'violent',
  // french
  'tuer', 'meurtre', 'arme', 'drogue', 'suicide', 'sang', 'violence',
  // arabic (phonetic + common)
  'قتل', 'دم', 'سلاح', 'جنسي', 'انتحار', 'مخدرات',
];

function safetyCheck(obj) {
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(obj);

  const joined = strings.join('\n');
  const lower = joined.toLowerCase();

  for (const tok of BLOCKED_TOKENS) {
    if (lower.includes(tok.toLowerCase())) return `blocked content: "${tok}"`;
  }
  if (URL_RE.test(joined)) return 'contains a URL';
  if (EMAIL_RE.test(joined)) return 'contains an email address';
  if (PHONE_RE.test(joined)) return 'contains a phone number';
  // nonsense guard: single "word" longer than 60 chars
  for (const s of strings) {
    if (s && s.length > 60 && !s.includes(' ') && !s.includes('،')) return 'malformed long token';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation of the strict AI JSON contract
// ---------------------------------------------------------------------------
function validateGameJson(raw) {
  const errors = [];
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, game: null, errors: ['response is not valid JSON'] };
  }

  if (!obj || Array.isArray(obj) || typeof obj !== 'object') {
    return { ok: false, game: null, errors: ['response is not a JSON object'] };
  }

  if (!TYPES.includes(obj.type)) errors.push(`type must be one of ${TYPES.join(', ')}`);
  if (typeof obj.instructions !== 'string' || !obj.instructions.trim()) errors.push('instructions is required');
  if (typeof obj.theme !== 'string' || !obj.theme.trim()) errors.push('theme is required');
  if (!Array.isArray(obj.items) || obj.items.length < 1) errors.push('items must be a non-empty array');

  const safety = safetyCheck(obj);
  if (safety) errors.push(`age-appropriateness/safety: ${safety}`);

  if (Errors(errors)) return { ok: false, game: null, errors };

  const type = obj.type;
  const items = [];
  const answers = Array.isArray(obj.answers) ? obj.answers : [];

  obj.items.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`item ${i} is not an object`);
      return;
    }
    const base = { points: Number.isInteger(item.points) && item.points > 0 ? item.points : 10 };

    if (type === 'quiz') {
      if (typeof item.question !== 'string' || !item.question.trim()) { errors.push(`quiz item ${i}: question required`); return; }
      if (!Array.isArray(item.options) || item.options.length < 2) { errors.push(`quiz item ${i}: at least 2 options required`); return; }
      for (const opt of item.options) {
        if (typeof opt !== 'string' || !opt.trim()) { errors.push(`quiz item ${i}: options must be non-empty strings`); return; }
      }
      let cIdx = Number.isInteger(item.correctIndex) ? item.correctIndex : null;
      const ans = answers[i];
      if (cIdx === null && ans && typeof ans === 'object' && Number.isInteger(ans.correctIndex)) cIdx = ans.correctIndex;
      if (cIdx === null && ans && typeof ans === 'object' && typeof ans.answer === 'string') {
        const found = item.options.findIndex((o) => o.trim().toLowerCase() === ans.answer.trim().toLowerCase());
        cIdx = found >= 0 ? found : null;
      }
      if (cIdx === null || cIdx < 0 || cIdx >= item.options.length) { errors.push(`quiz item ${i}: correctIndex must point into options`); return; }
      items.push({
        ...base,
        question: item.question.trim(),
        options: item.options.map((o) => String(o).trim()),
        correctIndex: cIdx,
        feedback: typeof item.feedback === 'string' && item.feedback.trim() ? item.feedback.trim() : '',
      });
    } else if (type === 'match') {
      if (typeof item.left !== 'string' || !item.left.trim()) { errors.push(`match item ${i}: left required`); return; }
      if (typeof item.right !== 'string' || !item.right.trim()) { errors.push(`match item ${i}: right required`); return; }
      items.push({ ...base, left: item.left.trim(), right: item.right.trim() });
    } else if (type === 'fill') {
      if (typeof item.prompt !== 'string' || !item.prompt.trim()) { errors.push(`fill item ${i}: prompt required`); return; }
      let answer = typeof item.answer === 'string' && item.answer.trim() ? item.answer.trim() : null;
      if (!answer && ans && typeof ans === 'object' && typeof ans.answer === 'string') answer = ans.answer.trim();
      if (!answer) { errors.push(`fill item ${i}: an answer is required`); return; }
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim())
        : [];
      if (answer && !aliases.includes(answer)) aliases.unshift(answer);
      items.push({ ...base, prompt: item.prompt.trim(), answer, aliases });
    }
  });

  const dupMsgs = errors.filter((e) => e.startsWith('blocked')).length;
  if (safety && dupMsgs === 0) errors.push(`age-appropriateness/safety: ${safety}`);

  if (errors.length) return { ok: false, game: null, errors };

  const game = { type, instructions: obj.instructions.trim(), items, theme: obj.theme.trim() };

  // optional staticVersion (read-through) from the AI; validated loosely
  let staticVersion = null;
  if (obj.staticVersion && typeof obj.staticVersion === 'object' && Array.isArray(obj.staticVersion.sections)) {
    const sections = obj.staticVersion.sections
      .filter((s) => s && typeof s.title === 'string' && typeof s.body === 'string' && s.title.trim() && s.body.trim())
      .map((s) => ({ title: s.title.trim(), body: s.body.trim() }));
    if (sections.length) staticVersion = { sections };
  }
  if (!staticVersion) staticVersion = deriveStaticVersion(game);

  const safe = safetyCheck(game);
  if (safe) return { ok: false, game: null, errors: [`age-appropriateness/safety: ${safe}`] };

  return { ok: true, game, staticVersion, errors };
}

function Errors(errors) {
  return errors.length > 0;
}

// ---------------------------------------------------------------------------
// Derive a plain read-through (static, non-game) version from game JSON.
// This guarantees the static version always exists, even if the AI omits it.
// ---------------------------------------------------------------------------
function deriveStaticVersion(game) {
  const sections = [{ title: game.instructions, body: '' }];
  if (game.type === 'quiz') {
    game.items.forEach((it, i) => {
      const ans = it.options[it.correctIndex] || '';
      sections.push({
        title: `${i + 1}. ${it.question}`,
        body: `→ ${ans}` + (it.feedback ? ` — ${it.feedback}` : ''),
      });
    });
  } else if (game.type === 'match') {
    game.items.forEach((it, i) => {
      sections.push({ title: `${i + 1}. ${it.left}`, body: `→ ${it.right}` });
    });
  } else if (game.type === 'fill') {
    game.items.forEach((it, i) => {
      sections.push({ title: `${i + 1}. ${it.prompt.replace(/_{2,}/g, '…')}`, body: `→ ${it.answer}` });
    });
  }
  return { sections };
}

// ---------------------------------------------------------------------------
// JSON extraction from a model reply
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (!text) return null;
  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1];
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenRouter call
// ---------------------------------------------------------------------------
let clientModel = null;
function getClientModel() {
  if (clientModel) return clientModel;
  if (!process.env.OPENROUTER_API_KEY) return null;
  clientModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
  return clientModel;
}

async function callModel(prompt) {
  const model = getClientModel();
  if (!model) return null;
  const key = process.env.OPENROUTER_API_KEY;
  const site = process.env.OPENROUTER_SITE_URL || process.env.BASE_URL || 'https://bewize.local';
  const title = process.env.OPENROUTER_APP_TITLE || 'Bewize';

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': site,
      'X-Title': title,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body && body.error ? `: ${body.error.message || JSON.stringify(body.error)}` : '';
    } catch { /* ignore body parse */ }
    throw new Error(`OpenRouter ${resp.status}${detail}`);
  }

  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return msg && typeof msg.content === 'string' ? msg.content : '';
}

// ---------------------------------------------------------------------------
// Prompt builder (no PII — only generic lesson/profile context)
// ---------------------------------------------------------------------------
function buildPrompt({ lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint, mode, currentGame, feedback }) {
  const [ageMin, ageMax] = levelBand(lesson.level);
  const baseLevel = lesson.level;
  const actualLevel = difficultyHint && difficultyHint > 0 ? difficultyHint : baseLevel;

  const variantLine = variant === 'special_needs'
    ? 'STUDENT PROFILE: special needs. Use very short sentences, smaller number of items, extremely simple vocabulary, generous positive tone, and clearer prompts. Reduce cognitive load.'
    : 'STUDENT PROFILE: standard. Age-appropriate but can handle normal sentences.';

  const themeLine = genderTheme === 'male'
    ? `GENDER THEME: friendly to boys (e.g. space, cars, animals, robots, sea) but never excluding anyone.`
    : genderTheme === 'female'
      ? `GENDER THEME: friendly to girls (e.g. nature, art, pets, stars, garden) but never excluding anyone.`
      : `GENDER THEME: neutral — appealing to everyone.`;

  const schema =
    '{\n'
    + '  "type": "quiz" | "match" | "fill",\n'
    + '  "instructions": "short kid-friendly instruction",\n'
    + '  "items": [...see below...],\n'
    + '  "answers": [...parallel array, same length as items...],\n'
    + '  "theme": "short theme word (e.g. Space)",\n'
    + '  "staticVersion": { "sections": [ { "title": "...", "body": "plain read-through text" } ] }\n'
    + '}\n'
    + 'Item schemas by type:\n'
    + '- quiz: items=[{ "question": "...", "options": ["a","b","c","d"], "correctIndex": <0..n>, "points": 10, "feedback": "short explainer"}]; answers=[{ "correctIndex": <0..n> }]\n'
    + '- match: items=[{ "left": "word/phrase/number", "right": "matching value" }]; answers=[{ "match": "<the right value>" }]\n'
    + '- fill:  items=[{ "prompt": "sentence with a blank marked ___", "answer": "missing word", "aliases": ["other acceptable answers"] }]; answers=[{ "answer": "<missing word>" }]';

  let prompt = `Create learning games for children in the ${lang === 'ar' ? 'Arabic (keep proper right-to-left text)' : lang === 'fr' ? 'French' : 'English'} language. ALL content below must be written in ${lang === 'ar' ? 'Arabic' : lang === 'fr' ? 'French' : 'English'}. Age range: ${ageMin}-${ageMax} (lesson level ${baseLevel}). Difficulty requested: ${actualLevel} (scale 1=easiest to 5=hardest).\n\n${variantLine}\n${themeLine}\n\nLESSON (subject: ${subjectName}):\nTitle: ${lesson.title}\nContent:\n${lesson.raw_lesson_text}\n`;

  if (mode === 'fix') {
    prompt += `\nThe current game JSON has issues. Fix the specific problems from the teacher's feedback, keep the same type and structure, and output the FULL corrected JSON:\n\nCurrent game JSON:\n${JSON.stringify(currentGame, null, 1)}\n\nTeacher feedback to fix:\n${feedback}\n`;
  } else {
    if (extraInstructions && extraInstructions.trim()) {
      prompt += `\nEXTRA INSTRUCTIONS FROM THE TEACHER:\n${extraInstructions.trim()}\n`;
    }
    prompt += `\nReturn exactly one JSON object matching this STRICT contract: ${schema}\n`
      + `Requirements:\n`
      + `- For standard profile: 5 to 8 items. For special needs: 3 to 5 items.\n`
      + `- Age-appropriate, positive, non-violent, respectful. No slang, no profanity, no URLs, no emails, no phone numbers, no real people.\n`
      + `- Each item has exactly one unambiguous correct answer.\n`
      + `- Quiz: 3 to 4 plausible options, correctIndex inside the options array.\n`
      + `- Match: each pair unique.\n`
      + `- Fill: one clear blank per prompt, answer is a single common word or short phrase.\n`
      + `- "staticVersion" is optional but recommended; if you omit it I will derive one.`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Offline (no API key) generator — deterministic, content-derived, safe.
// ---------------------------------------------------------------------------
const NUMBER_WORDS = {
  en: { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 0: 'zero' },
  fr: { 1: 'un', 2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit', 9: 'neuf', 0: 'zéro' },
  ar: { 1: 'واحد', 2: 'اثنان', 3: 'ثلاثة', 4: 'أربعة', 5: 'خمسة', 6: 'ستة', 7: 'سبعة', 8: 'ثمانية', 9: 'تسعة', 0: 'صفر' },
};

function pickDistractors(keyword, pool, lang, n) {
  const out = [];
  const fallback = ['ال', 'de', 'the', 'et', 'و', 'a', 'un', 'le', 'la'];
  const src = [...pool, ...(NUMBER_WORDS[lang] ? Object.values(NUMBER_WORDS[lang]) : []), ...fallback];
  for (const w of src) {
    if (w && w.toLowerCase() !== keyword.toLowerCase() && !out.includes(w) && out.length < n) out.push(w);
  }
  while (out.length < n) out.push(`${keyword}?`);
  return out;
}

function sentences(text) {
  const parts = String(text || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!؟؟?؛;])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 4);
}

function generateOffline({ lesson, subjectName, variant, genderTheme, lang }) {
  const count = variant === 'special_needs' ? 4 : 6;
  const theme = genderTheme === 'male' ? 'Space' : genderTheme === 'female' ? 'Nature' : 'Fun';
  const intro = lesson.title;
  let items;
  const staticSections = [];

  if (subjectName === 'math') {
    const rnd = (seed) => { const x = Math.sin(seed * 9973) * 10000; return Math.floor((x - Math.floor(x)) * 9) + 1; };
    items = Array.from({ length: count }, (_, i) => {
      const a = rnd((lesson.id || 1) * 7 + i * 3 + 1);
      const b = rnd((lesson.id || 1) * 13 + i * 5 + 2);
      const op = i % 2 === 0 ? '+' : '-';
      const x = Math.max(a, b);
      const y = Math.min(a, b);
      const result = op === '+' ? a + b : x - y;
      const distractors = new Set([result, result + 1, result + 2, result - 1].filter((n) => n >= 0));
      const options = [...distractors].map(String);
      while (options.length < 3) options.push(String(options.length + 9));
      const correct = options.indexOf(String(result));
      const question = op === '+' ? `${a} + ${b} = ?` : `${x} - ${y} = ?`;
      staticSections.push({ title: `${i + 1}. ${question}`, body: `→ ${result}` });
      return { points: 10, question, options, correctIndex: correct, feedback: `${question.replace(' = ?', '')} = ${result}` };
    });
    return { game: { type: 'quiz', instructions: `${intro} — ${variant === 'special_needs' ? 'simple math' : 'math practice'}`, items, theme }, staticVersion: { sections: staticSections } };
  }

  const sents = sentences(lesson.raw_lesson_text);
  const source = sents.length ? sents : [`${intro} is a great lesson to learn. Practice makes progress!`];
  const chosen = source.slice(0, Math.min(count, source.length));
  while (chosen.length < Math.min(count, source.length)) chosen.push(`${intro} is fun and easy to learn.`);

  const keywords = [];
  chosen.forEach((sent) => {
    const words = sent.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
    const kw = words && words.length ? words[Math.max(0, Math.min(1, words.length - 1))] : 'learn';
    keywords.push({ sent, kw });
  });

  if (keywords.length >= 3) {
    items = keywords.slice(0, Math.min(count, keywords.length)).map((k, i) => {
      const firstIdx = k.sent.toLowerCase().indexOf(k.kw.toLowerCase());
      const blanked = firstIdx >= 0
        ? k.sent.slice(0, firstIdx) + '__' + k.sent.slice(firstIdx + k.kw.length)
        : k.sent.replace(/_+/g, '__');
      const opts = [k.kw, ...pickDistractors(k.kw, keywords.map((x) => x.kw), lang, 3)].slice(0, 4);
      const correct = opts.indexOf(k.kw);
      staticSections.push({ title: `${i + 1}. ${blanked}`, body: `→ ${k.kw}` });
      return { points: 10, question: blanked, options: opts, correctIndex: correct, feedback: k.sent };
    });
  } else {
    items = keywords.map((k, i) => ({ points: 10, question: k.sent, options: [k.kw, 'no', 'yes', k.kw + '!'], correctIndex: 0, feedback: '' }));
  }

  return {
    game: { type: 'quiz', instructions: `${intro} — ${variant === 'special_needs' ? 'read and choose' : 'read and choose'}`, items, theme },
    staticVersion: { sections: staticSections.length ? staticSections : [{ title: intro, body: lesson.raw_lesson_text }] },
  };
}

// ---------------------------------------------------------------------------
// Public: generate one game for a lesson + profile/gender combination
// ---------------------------------------------------------------------------
async function generateOne({ lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint }) {
  const context = { lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint };

  // Offline demo mode
  if (!getClientModel()) {
    const built = generateOffline(context);
    return { game: built.game, staticVersion: built.staticVersion, source: 'offline', note: 'offline demo generator' };
  }

  let lastErrors = [];
  let prompt = buildPrompt(context);
  const model = getClientModel();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text;
    try {
      text = await callModel(prompt);
    } catch (err) {
      lastErrors.push(`api error: ${err.message || 'unknown'}`);
      break;
    }
    const parsed = extractJson(text);
    const validation = validateGameJson(parsed, lang);
    if (validation.ok) {
      return {
        game: validation.game,
        staticVersion: validation.staticVersion,
        source: 'ai',
        note: `OpenRouter · ${model} · ${attempt} attempt(s)`,
      };
    }
    lastErrors = validation.errors;
    // re-prompt with the validation errors so the model can repair itself
    prompt = buildPrompt(context)
      + `\n\nYour previous response was REJECTED by validation. The issues were:\n- ${lastErrors.join('\n- ')}\n`
      + `Please return a corrected JSON object only.`;
  }

  const err = new Error(`Game generation failed after ${MAX_ATTEMPTS} attempts: ${lastErrors.join('; ')}`);
  err.code = 'GENERATION_FAILED';
  throw err;
}

// ---------------------------------------------------------------------------
// Public: fix an existing game from teacher feedback
// ---------------------------------------------------------------------------
async function fixGame({ lesson, game, feedback, lang, variant, genderTheme, subjectName }) {
  if (!getClientModel()) {
    // Offline: honestly cannot "fix" — return a slightly altered same game
    const clone = JSON.parse(JSON.stringify(game));
    return { game: clone, source: 'offline', note: 'offline mode: no AI to revise' };
  }

  let prompt = buildPrompt({ lesson, subjectName, variant, genderTheme, lang, mode: 'fix', currentGame: game, feedback });
  const text = await callModel(prompt);
  const parsed = extractJson(text);
  const validation = validateGameJson(parsed, lang);
  if (!validation.ok) {
    const err = new Error(`Revise failed: ${validation.errors.join('; ')}`);
    err.code = 'GENERATION_FAILED';
    throw err;
  }
  return { game: validation.game, staticVersion: validation.staticVersion, source: 'ai', note: `OpenRouter revision of ${game.type}` };
}

module.exports = {
  TYPES,
  validateGameJson,
  deriveStaticVersion,
  generateOne,
  fixGame,
  hasAi: () => Boolean(process.env.OPENROUTER_API_KEY),
};