'use strict';

// ---------------------------------------------------------------------------
// AI game generation + strict validation.
//
// - The game library is FIXED: exactly three reusable templates
//   (adventure_mission, challenge_quest, build_rescue) shipped in
//   public/js/game-lib.js. The AI NEVER creates new UI or new templates — it
//   only fills structured content for one of these three templates.
// - Calls OpenRouter (OpenAI-compatible chat completions) when
//   OPENROUTER_API_KEY is present.
// - Otherwise falls back to a deterministic OFFLINE generator so the whole
//   flow can still be demoed without a key (clearly labelled in the UI).
// - NEVER receives a child's real name or any personal data. Only generic
//   per-lesson context (lesson text, level, language, age band, profile type,
//   gender theme).
// ---------------------------------------------------------------------------

const { gradeBand, TEMPLATES } = require('../i18n');

const ENTRY_KEYS = { adventure_mission: 'steps', challenge_quest: 'quests', build_rescue: 'parts' };
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
const PHONE_RE = /(?:\+\d[\d\s().-]{5,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\(\d{3}\)\s*\d{3}[-. ]\d{4}\b)/;

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

const str = (v, fb) => (typeof v === 'string' && v.trim() ? v.trim() : fb);

// ---------------------------------------------------------------------------
// Validation of the strict AI JSON contract (one of the 3 fixed templates).
// Normalizes steps/quests/parts into a canonical `entries` array so grading,
// rendering and the static version all use one shared shape.
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

  if (!TEMPLATES.includes(obj.template)) {
    errors.push(`template must be one of ${TEMPLATES.join(', ')} (new templates are never allowed)`);
  }
  if (typeof obj.theme !== 'string' || !obj.theme.trim()) errors.push('theme is required');
  if (typeof obj.instructions !== 'string' || !obj.instructions.trim()) errors.push('instructions is required');

  const safety = safetyCheck(obj);
  const hasSafety = !!safety;
  if (hasSafety) errors.push(`age-appropriateness/safety: ${safety}`);

  if (errors.length) return { ok: false, game: null, errors };

  const template = obj.template;
  const arrayKey = ENTRY_KEYS[template] || 'entries';
  const rawList = Array.isArray(obj[arrayKey]) ? obj[arrayKey]
    : Array.isArray(obj.entries) ? obj.entries
      : null;

  if (!rawList || rawList.length < 1) {
    errors.push(`"${arrayKey}" must be a non-empty array`);
    return { ok: false, game: null, errors };
  }

  const entries = [];
  rawList.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`${arrayKey}[${i}] is not an object`);
      return;
    }
    const label = str(item.name, str(item.label, str(item.quest, str(item.part, str(item.stop, `${i + 1}`)))));
    const detail = str(item.scene, str(item.detail, str(item.prompt, '')));
    const question = str(item.question, '');
    const options = Array.isArray(item.options) ? item.options.map((o) => str(o, '')).filter(Boolean) : [];
    let cIdx = Number.isInteger(item.correctIndex) ? item.correctIndex : null;
    const points = Number.isInteger(item.points) && item.points > 0 ? item.points : 10;
    const feedback = str(item.feedback, '');

    if (!question) errors.push(`${arrayKey}[${i}]: question required`);
    if (options.length < 2) errors.push(`${arrayKey}[${i}]: at least 2 options required`);
    if (cIdx === null || cIdx < 0 || cIdx >= options.length) {
      errors.push(`${arrayKey}[${i}]: correctIndex must point into options`);
    }

    entries.push({ label, detail, question, options, correctIndex: cIdx, feedback, points });
  });

  if (!hasSafety) {
    const safe2 = safetyCheck({ template, entries });
    if (safe2) errors.push(`age-appropriateness/safety: ${safe2}`);
  }

  const dupMsgs = errors.filter((e) => e.startsWith('blocked')).length;
  if (hasSafety && dupMsgs === 0) errors.push(`age-appropriateness/safety: ${safety}`);

  if (errors.length) return { ok: false, game: null, errors };

  const game = {
    template,
    title: str(obj.title, ''),
    theme: obj.theme.trim(),
    instructions: obj.instructions.trim(),
    intro: str(obj.intro, ''),
    entries,
  };
  if (template === 'adventure_mission') game.ending = str(obj.ending, '');
  if (template === 'build_rescue') game.goal = str(obj.goal, '');

  return { ok: true, game, staticVersion: deriveStaticVersion(game), errors };
}

// ---------------------------------------------------------------------------
// Derive a plain read-through (static, non-game) version from game JSON.
// ---------------------------------------------------------------------------
function deriveStaticVersion(game) {
  const sections = [{ title: game.title || game.instructions || 'Game', body: game.intro || '' }];
  (game.entries || []).forEach((e, i) => {
    const ans = e.options && e.options[e.correctIndex] ? e.options[e.correctIndex] : '';
    const label = `${i + 1}. ${e.label ? `${e.label} — ` : ''}${e.question}`;
    sections.push({ title: label, body: `→ ${ans}` + (e.feedback ? ` — ${e.feedback}` : '') });
  });
  if (game.template === 'adventure_mission' && game.ending) {
    sections.push({ title: game.ending, body: '' });
  }
  if (game.template === 'build_rescue' && game.goal) {
    sections.push({ title: game.goal, body: '' });
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
  clientModel = process.env.OPENROUTER_MODEL || 'inclusionai/ling-3.0-flash-vl';
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
      max_tokens: 1200,
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
function buildPrompt({ lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint, mode, currentGame, feedback, template }) {
  const [ageMin, ageMax] = gradeBand(lesson.school_level);
  const baseLevel = lesson.level;
  const actualLevel = difficultyHint && difficultyHint > 0 ? difficultyHint : baseLevel;

  const variantLine = variant === 'autisme'
    ? 'STUDENT PROFILE: autism. Use very short sentences, smaller number of items, extremely simple vocabulary, generous positive tone, and clearer prompts. Reduce cognitive load.'
    : variant === 'deficience_auditive'
      ? 'STUDENT PROFILE: hearing impairment. Keep sentences short and visually clear, rely on written words rather than sound, avoid tasks that depend on hearing, and use plain literal language.'
      : 'STUDENT PROFILE: normal. Age-appropriate but can handle normal sentences.';

  const themeLine = genderTheme === 'male'
    ? `GENDER THEME: friendly to boys (e.g. space, cars, animals, robots, sea) but never excluding anyone.`
    : genderTheme === 'female'
      ? `GENDER THEME: friendly to girls (e.g. nature, art, pets, stars, garden) but never excluding anyone.`
      : `GENDER THEME: neutral — appealing to everyone.`;

  const templateChoice = template
    ? `Use EXACTLY this template: "${template}".\n`
    : `Choose the template that best fits this lesson and the student profile: adventure_mission (a story journey, best for reading/structures), challenge_quest (independent rounds, best for drill/practice), build_rescue (assemble parts to rescue/build, best for vocabulary/steps).\n`;

  const schema =
    'The game library is FIXED. You can only fill structured content for ONE of these 3 templates — you never invent a new template or a new layout:\n'
    + '\n'
    + '1) adventure_mission — a short story journey. Output JSON:\n'
    + '{\n'
    + '  "template": "adventure_mission",\n'
    + '  "title": "short game title",\n'
    + '  "theme": "one short theme word",\n'
    + '  "instructions": "one kid-friendly instruction line",\n'
    + '  "intro": "opening narrative line(s)",\n'
    + '  "ending": "closing narrative line(s)",\n'
    + '  "steps": [\n'
    + '    { "name": "stop name", "scene": "short narrative of this moment", "question": "...", "options": ["a","b","c"], "correctIndex": 0, "feedback": "one-line explainer", "points": 10 }\n'
    + '  ]\n'
    + '}\n'
    + '\n'
    + '2) challenge_quest — independent rounds. Output JSON:\n'
    + '{\n'
    + '  "template": "challenge_quest",\n'
    + '  "title": "short game title",\n'
    + '  "theme": "one short theme word",\n'
    + '  "instructions": "one kid-friendly instruction line",\n'
    + '  "intro": "opening line(s)",\n'
    + '  "quests": [\n'
    + '    { "name": "Round N · skill", "detail": "optional short flavor", "question": "...", "options": ["a","b","c"], "correctIndex": 0, "feedback": "one-line explainer", "points": 10 }\n'
    + '  ]\n'
    + '}\n'
    + '\n'
    + '3) build_rescue — assemble parts to build or rescue something. Output JSON:\n'
    + '{\n'
    + '  "template": "build_rescue",\n'
    + '  "title": "short game title",\n'
    + '  "theme": "one short theme word",\n'
    + '  "instructions": "one kid-friendly instruction line",\n'
    + '  "intro": "opening line(s)",\n'
    + '  "goal": "what is being built or rescued",\n'
    + '  "parts": [\n'
    + '    { "name": "part name", "detail": "what this part does or where it goes", "question": "...", "options": ["a","b","c"], "correctIndex": 0, "feedback": "one-line explainer", "points": 10 }\n'
    + '  ]\n'
    + '}';

  let prompt = `Create a learning game for children in the ${lang === 'ar' ? 'Arabic (keep proper right-to-left text)' : lang === 'fr' ? 'French' : 'English'} language. ALL content below must be written in ${lang === 'ar' ? 'Arabic' : lang === 'fr' ? 'French' : 'English'}. Age range: ${ageMin}-${ageMax} (lesson level ${baseLevel}). Difficulty requested: ${actualLevel} (scale 1=easiest to 5=hardest).\n\n${variantLine}\n${themeLine}\n${templateChoice}\nLESSON (subject: ${subjectName}):\nTitle: ${lesson.title}\nContent:\n${lesson.raw_lesson_text}\n`;

  if (mode === 'fix') {
    prompt += `\nThe teacher wants the game REDONE. Apply their instructions. Keep the SAME template unless the teacher explicitly asks for a different one. Output the FULL corrected JSON object only. Never add text outside the JSON.\n\nCurrent game JSON:\n${JSON.stringify(currentGame, null, 1)}\n\nTeacher\'s instructions for the redo:\n${feedback}\n`;
  } else if (extraInstructions && extraInstructions.trim()) {
    prompt += `\nEXTRA INSTRUCTIONS FROM THE TEACHER:\n${extraInstructions.trim()}\n`;
  }
  prompt += `\nReturn exactly one JSON object matching this STRICT contract. ${schema}\n`
    + `Requirements:\n`
    + `- Keep the template EXACTLY as specified above (or the current game's template on a redo).\n`
    + `- Entry count: 4 for normal profile, 3 for autism, 3 to 4 for hearing impairment. No more than 4 entries.\n`
    + `- Keep EVERY field short (scenes and feedback one line each). No extra keys, no prose outside the JSON object.\n`
    + `- Age-appropriate, positive, non-violent, respectful. No slang, no profanity, no URLs, no emails, no phone numbers, no real people.\n`
    + `- Each entry has exactly one unambiguous correct answer (correctIndex inside options).\n`
    + `- 3 to 4 plausible options per entry, short and clear.\n`
    + `- "feedback" is a one-line explainer shown after answering.\n`
    + `- Use the template fields exactly as shown. The child never sees "steps", "quests" or "parts" JSON keys — only the game experience.`;
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

function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function generateOffline({ lesson, subjectName, variant, genderTheme, lang }) {
  const count = variant === 'autisme' ? 4 : 6;
  const theme = genderTheme === 'male' ? 'Space' : genderTheme === 'female' ? 'Nature' : 'Fun';
  const intro = lesson.title;
  const staticSections = [];

  const wrap = (template, title, instructions, introText, entries) => {
    const game = { template, title, theme, instructions, intro: introText, entries };
    if (template === 'adventure_mission') game.ending = `${intro} — journey complete!`;
    if (template === 'build_rescue') game.goal = `${intro} — build it to finish`;
    return game;
  };

  if (subjectName === 'math') {
    const rnd = (seed) => { const x = Math.sin(seed * 9973) * 10000; return Math.floor((x - Math.floor(x)) * 9) + 1; };
    const entries = Array.from({ length: count }, (_, i) => {
      const a = rnd((lesson.id || 1) * 7 + i * 3 + 1);
      const b = rnd((lesson.id || 1) * 13 + i * 5 + 2);
      const op = i % 2 === 0 ? '+' : '-';
      const x = Math.max(a, b);
      const y = Math.min(a, b);
      const result = op === '+' ? a + b : x - y;
      const distractors = new Set([result, result + 1, result + 2, result - 1].filter((n) => n >= 0));
      const options = [...distractors].map(String);
      while (options.length < 3) options.push(String(options.length + 9));
      const correctIndex = options.indexOf(String(result));
      const question = op === '+' ? `${a} + ${b} = ?` : `${x} - ${y} = ?`;
      staticSections.push({ title: `${i + 1}. ${question}`, body: `→ ${result}` });
      return {
        label: `Round ${i + 1}`, detail: '',
        question, options, correctIndex,
        feedback: `${question.replace(' = ?', '')} = ${result}`, points: 10,
      };
    });
    const game = wrap('challenge_quest', intro, `${intro} — ${variant === 'autisme' ? 'simple math' : 'math practice'}`, 'Answer each round to win the quest!', entries);
    return { game, staticVersion: { sections: staticSections.length ? staticSections : deriveStaticVersion(game).sections } };
  }

  const sents = sentences(lesson.raw_lesson_text);
  const source = sents.length ? sents : [`${intro} is a great lesson to learn. Practice makes progress!`];
  const chosen = source.slice(0, Math.min(count, source.length));

  const keywords = [];
  chosen.forEach((sent) => {
    const words = sent.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
    const kw = words && words.length ? words[Math.max(0, Math.min(1, words.length - 1))] : 'learn';
    keywords.push({ sent, kw });
  });

  const entries = keywords.slice(0, Math.min(count, keywords.length)).map((k, i) => {
    const firstIdx = k.sent.toLowerCase().indexOf(k.kw.toLowerCase());
    const blanked = firstIdx >= 0
      ? k.sent.slice(0, firstIdx) + '__' + k.sent.slice(firstIdx + k.kw.length)
      : k.sent.replace(/_+/g, '__');
    const opts = [k.kw, ...pickDistractors(k.kw, keywords.map((x) => x.kw), lang, 3)].slice(0, 4);
    const correctIndex = opts.indexOf(k.kw);
    staticSections.push({ title: `${i + 1}. ${blanked}`, body: `→ ${k.kw}` });
    return {
      label: `Stop ${i + 1}`, detail: k.sent,
      question: blanked, options: opts, correctIndex,
      feedback: k.sent, points: 10,
    };
  });

  const game = wrap('adventure_mission', intro, `${intro} — read and choose`, 'Follow the story and answer each question to advance!', entries);
  return {
    game,
    staticVersion: { sections: staticSections.length ? staticSections : deriveStaticVersion(game).sections },
  };
}

// ---------------------------------------------------------------------------
// Public: generate one game for a lesson + profile/gender combination
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateOne({ lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint, template }) {
  const context = { lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint, template };

  // Offline demo mode
  if (!getClientModel()) {
    const built = generateOffline(context);
    return { game: built.game, staticVersion: built.staticVersion, source: 'offline', note: 'offline demo generator' };
  }

  const { validation, attempts } = await generateWithRetries(context);
  const model = getClientModel();
  return {
    game: validation.game,
    staticVersion: validation.staticVersion,
    source: 'ai',
    note: `OpenRouter · ${model} · ${attempts} attempt(s)`,
  };
}

// Shared AI loop: builds the prompt, calls the model, validates, and re-prompts
// with the validation errors so the model can repair itself.
async function generateWithRetries(context) {
  const isFix = !!context.mode;
  let prompt = buildPrompt(context);
  let lastErrors = [];
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    let text;
    try {
      text = await callModel(prompt);
    } catch (err) {
      const msg = err.message || 'unknown';
      lastErrors.push(`api error: ${msg}`);
      // Permanent credit/account errors should not be retried.
      if (/insufficient credits|never purchased|purchase more credits/i.test(msg)) break;
      // 402 (credits / in-flight), 429 (rate limit) and 5xx are transient: wait and retry.
      if (!/402|429|5\d\d|in-flight|concurrent|overloaded|temporar/i.test(msg)) break;
      await sleep(1500 * attempt);
      prompt = buildPrompt(context);
      continue;
    }
    const parsed = extractJson(text);
    const validation = validateGameJson(parsed, context.lang);
    if (validation.ok) return { validation, attempts: attempt };
    lastErrors = validation.errors;
    prompt = buildPrompt(context)
      + `\n\nYour previous response was REJECTED by validation. The issues were:\n- ${lastErrors.join('\n- ')}\n`
      + `Please return a corrected JSON object only.`;
  }

  const err = new Error(`${isFix ? 'Redo' : 'Game generation'} failed after the first attempt: ${lastErrors.join('; ')}`);
  if (attemptsUsed > 1) err.message = `${isFix ? 'Redo' : 'Game generation'} failed after ${attemptsUsed} attempts: ${lastErrors.join('; ')}`;
  err.code = 'GENERATION_FAILED';
  throw err;
}

// ---------------------------------------------------------------------------
// Public: redo an existing game from teacher instructions (keeps template
// unless the teacher explicitly asks for a different one)
// ---------------------------------------------------------------------------
async function fixGame({ lesson, game, feedback, lang, variant, genderTheme, subjectName }) {
  if (!getClientModel()) {
    // Offline: honestly cannot "redo" — return the same game unchanged
    const clone = JSON.parse(JSON.stringify(game));
    return { game: clone, staticVersion: deriveStaticVersion(clone), source: 'offline', note: 'offline mode: no AI to redo' };
  }

  const context = { lesson, subjectName, variant, genderTheme, lang, mode: 'fix', currentGame: game, feedback };
  const { validation } = await generateWithRetries(context);
  return { game: validation.game, staticVersion: validation.staticVersion, source: 'ai', note: `OpenRouter redo of ${game.template}` };
}

// ---------------------------------------------------------------------------
// Migration support: convert a legacy quiz/match/fill game (old game_json)
// into one of the 3 fixed templates so existing approved games keep working.
// ---------------------------------------------------------------------------
function convertLegacyGame(json) {
  if (!json || typeof json !== 'object') return null;
  if (TEMPLATES.includes(json.template)) {
    const v = validateGameJson(json);
    return v.ok ? { game: v.game, staticVersion: v.staticVersion } : null;
  }

  const base = (template) => ({ template, title: '', theme: str(json.theme, 'Fun'), instructions: str(json.instructions, 'Play the game!'), intro: '', entries: [] });

  if (json.type === 'quiz') {
    const items = (Array.isArray(json.items) ? json.items : []).filter((it) => it && typeof it === 'object');
    const game = base('challenge_quest');
    game.title = str(json.theme, '').length ? `${str(json.theme, '')}` : '';
    game.intro = str(json.instructions, '');
    items.forEach((it, i) => {
      const opts = (Array.isArray(it.options) ? it.options : []).map((o) => String(o).trim()).filter(Boolean);
      const cIdx = Number.isInteger(it.correctIndex) ? it.correctIndex : 0;
      game.entries.push({
        label: `Round ${i + 1}`,
        detail: '',
        question: str(it.question, ''),
        options: opts,
        correctIndex: cIdx >= 0 && cIdx < opts.length ? cIdx : 0,
        feedback: str(it.feedback, ''),
        points: Number.isInteger(it.points) && it.points > 0 ? it.points : 10,
      });
    });
    return game.entries.length ? { game, staticVersion: deriveStaticVersion(game) } : null;
  }

  if (json.type === 'match') {
    const items = (Array.isArray(json.items) ? json.items : []).filter((it) => it && typeof it === 'object');
    const rights = items.map((it) => str(it.right, '')).filter(Boolean);
    const pool = shuffleArr(rights);
    const game = base('adventure_mission');
    game.title = str(json.theme, '') || '';
    game.intro = str(json.instructions, '');
    items.forEach((it, i) => {
      const left = str(it.left, '');
      const right = str(it.right, '');
      if (!left || !right) return;
      const opts = pool.length >= 2 ? shuffleArr(pool) : [right, `${right}?`, `${right}!!`];
      let cIdx = opts.findIndex((o) => o.toLowerCase() === right.toLowerCase());
      if (cIdx === -1) { opts.push(right); cIdx = opts.length - 1; }
      game.entries.push({
        label: left,
        detail: `Tap the matching word for «${left}»`,
        question: `Match: ${left}`,
        options: opts,
        correctIndex: cIdx,
        feedback: `${left} ↔ ${right}`,
        points: 10,
      });
    });
    if (!game.entries.length) return null;
    game.ending = `${str(json.theme, '')} — match complete!`;
    return { game, staticVersion: deriveStaticVersion(game) };
  }

  if (json.type === 'fill') {
    const items = (Array.isArray(json.items) ? json.items : []).filter((it) => it && typeof it === 'object');
    const game = base('build_rescue');
    game.title = str(json.theme, '') || '';
    game.intro = str(json.instructions, '');
    items.forEach((it, i) => {
      const prompt = str(it.prompt, '');
      const answer = str(it.answer, '');
      if (!prompt || !answer) return;
      const aliases = (Array.isArray(it.aliases) ? it.aliases : []).filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim());
      const opts = shuffleArr([answer, ...aliases.filter((a) => a.toLowerCase() !== answer.toLowerCase()), ...pickDistractors(answer, aliases, 'en', 3)].slice(0, 4));
      let cIdx = opts.findIndex((o) => o.toLowerCase() === answer.toLowerCase());
      if (cIdx === -1) { opts.push(answer); cIdx = opts.length - 1; }
      game.entries.push({
        label: `Part ${i + 1}`,
        detail: prompt,
        question: `Complete: ${prompt.replace(/_+/g, '___')}`,
        options: opts,
        correctIndex: cIdx,
        feedback: `→ ${answer}`,
        points: 10,
      });
    });
    if (!game.entries.length) return null;
    game.goal = `${str(json.theme, '')} — assembled!`;
    return { game, staticVersion: deriveStaticVersion(game) };
  }

  return null;
}

module.exports = {
  TEMPLATES,
  validateGameJson,
  deriveStaticVersion,
  generateOne,
  fixGame,
  convertLegacyGame,
  hasAi: () => Boolean(process.env.OPENROUTER_API_KEY),
};