'use strict';

// ---------------------------------------------------------------------------
// AI game generation + strict validation.
//
// - The game library is FIXED: exactly three reusable templates
//   (airplane, whack_a_mole, flying_fruit) shipped in
//   public/js/game-lib.js. The AI NEVER creates new UI or new templates — it
//   only fills structured content for one of these three templates.
// - The AI obeys a STRICT JSON contract (metadata + games.<template>), see
//   SYSTEM_PROMPT. Validation normalizes the output into a canonical game
//   object stored in games.game_json.
// - Calls OpenRouter (OpenAI-compatible chat completions) when
//   OPENROUTER_API_KEY is present.
// - Otherwise falls back to a deterministic OFFLINE generator so the whole
//   flow can still be demoed without a key (clearly labelled in the UI).
// - NEVER receives a child's real name or any personal data. Only generic
//   per-lesson context (lesson text, level, language, age band, profile type,
//   gender theme).
// ---------------------------------------------------------------------------

const { gradeBand, gradeInfo, MAX_LEVEL, TEMPLATES } = require('../i18n');

const MAX_ATTEMPTS = 3;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Entry/size caps — the AI can never flood a game with content.
const MAX_QUESTIONS = 8;
const MAX_TILES = 12;

const SYSTEM_PROMPT = 'You are an expert game designer of rich, engaging 2D educational mini-games for children aged 5 to 15. '
  + 'Your goal is to weave educational lessons into highly creative, fun storylines so kids love playing them. '
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
// Accepts either the full spec shape `{ metadata, games: { <template> } }`
// (exactly ONE game inside) or a direct per-template object.
// Normalizes every template into a canonical object used by grading,
// rendering and the static version.
// ---------------------------------------------------------------------------
function validateGameJson(raw, targetLang) {
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

  // --- extract the single game payload -------------------------------------
  let core = obj;
  let meta = null;
  if (obj.games && typeof obj.games === 'object' && !Array.isArray(obj.games)) {
    const keys = Object.keys(obj.games).filter((k) => TEMPLATES.includes(k));
    if (keys.length > 1) errors.push(`"games" must contain EXACTLY one template (found: ${keys.join(', ')})`);
    if (keys.length === 0) errors.push(`"games" must contain one of ${TEMPLATES.join(', ')}`);
    core = keys.length === 1 ? obj.games[keys[0]] : obj.games[obj.template] || null;
    meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : null;
  }

  const safety = safetyCheck(obj);
  const hasSafety = !!safety;
  if (hasSafety) errors.push(`age-appropriateness/safety: ${safety}`);

  if (!core || typeof core !== 'object' || Array.isArray(core)) {
    errors.push(`missing game payload for one of ${TEMPLATES.join(', ')}`);
    return { ok: false, game: null, errors };
  }

  const template = str(core.template, obj.games ? Object.keys(obj.games).find((k) => TEMPLATES.includes(k)) : '');
  if (TEMPLATES.indexOf(template) === -1) {
    errors.push(`template must be one of ${TEMPLATES.join(', ')} (new templates are never allowed)`);
  }
  if (typeof obj.theme === 'string' && obj.theme.trim()) core.theme = obj.theme.trim();

  if (typeof core.instructions !== 'string' || !core.instructions.trim()) {
    errors.push('"instructions" is required (one kid-friendly instruction line)');
  }

  if (errors.length) return { ok: false, game: null, errors };

  let game = null;
  try {
    game = normalizeTemplate(template, core, errors, targetLang);
  } catch {
    return { ok: false, game: null, errors };
  }
  if (game === null || errors.length) return { ok: false, game: null, errors };

  if (meta && (str(meta.lesson_title, '') || str(meta.target_level, ''))) {
    game.meta = {};
    if (str(meta.lesson_title, '')) game.meta.lesson_title = str(meta.lesson_title, '');
    if (str(meta.target_level, '')) game.meta.target_level = str(meta.target_level, '');
  }

  if (!hasSafety) {
    const safe2 = safetyCheck(game);
    if (safe2) errors.push(`age-appropriateness/safety: ${safe2}`);
  }

  if (errors.length) return { ok: false, game: null, errors };

  return { ok: true, game, staticVersion: deriveStaticVersion(game), errors };
}

// canonical per-template construction ---------------------------------------
function normalizeTemplate(template, core, errors, targetLang) {
  const lang = (targetLang || 'en').toLowerCase();

  if (template === 'airplane') {
    const rawList = Array.isArray(core.questions) ? core.questions : [];
    if (!rawList.length) errors.push('"questions" must be a non-empty array');
    if (rawList.length > MAX_QUESTIONS) {
      errors.push(`too many questions (max ${MAX_QUESTIONS}) — keep them short and essential`);
    }
    const questions = [];
    rawList.forEach((q, i) => {
      if (!q || typeof q !== 'object') { errors.push(`questions[${i}] is not an object`); return; }
      const question = str(q.question, '');
      const correct = str(q.correct_answer, (Array.isArray(q.options) ? q.options[q.correctIndex] : ''));
      const distractors = (Array.isArray(q.distractors) ? q.distractors : [])
        .map((d) => str(d, ''))
        .filter(Boolean)
        .filter((d) => d.toLowerCase() !== correct.toLowerCase());
      if (!question) errors.push(`questions[${i}]: "question" is required`);
      if (!correct) errors.push(`questions[${i}]: "correct_answer" is required`);
      if (!distractors.length) errors.push(`questions[${i}]: at least 2 "distractors" required`);
      if (distractors.length < 2) {
        const extra = [correct === 'oui' ? 'non' : `[${correct}?]`, `${correct}!`];
        for (const d of extra) {
          if (d.toLowerCase() !== correct.toLowerCase() && !distractors.includes(d) && distractors.length < 3) distractors.push(d);
        }
        if (distractors.length < 2) errors.push(`questions[${i}]: at least 2 "distractors" required`);
      }
      if (!question || !correct) return;
      questions.push({
        id: str(q.id, `q${i + 1}`),
        question,
        correct_answer: correct,
        distractors: distractors.slice(0, 4),
      });
    });
    if (!questions.length && !errors.length) errors.push('"questions" must be a non-empty array');
    return baseGame(template, core, {
      questions,
      _count: questions.length,
      _min: 1, _max: MAX_QUESTIONS, _label: 'questions', errors, lang,
    });
  }

  const isMole = template === 'whack_a_mole';
  const listKey = isMole ? 'targets' : 'items';
  const promptKey = isMole ? 'prompt' : 'category_prompt';
  const rawList = Array.isArray(core[listKey]) ? core[listKey] : [];
  if (!rawList.length) errors.push(`"${listKey}" must be a non-empty array`);
  if (rawList.length > MAX_TILES) errors.push(`too many tiles (max ${MAX_TILES})`);

  const prompt = str(core[promptKey], core.instructions, '');
  if (isMole) {
    if (typeof core.prompt !== 'string' || !core.prompt.trim()) errors.push('"prompt" is required (what the child must look for)');
    if (!errors.length && !prompt) errors.push('"prompt" is required');
  } else if (typeof core.category_prompt !== 'string' || !core.category_prompt.trim()) {
    errors.push('"category_prompt" is required (which category to catch)');
  }

  const items = [];
  rawList.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errors.push(`${listKey}[${i}] is not an object`); return; }
    const text = str(t.text, '');
    if (!text) { errors.push(`${listKey}[${i}]: "text" is required`); return; }
    items.push({ text, is_correct: Boolean(t.is_correct) });
  });
  const corrects = items.filter((t) => t.is_correct).length;
  const wrongs = items.length - corrects;
  if (corrects < 1) errors.push(`at least one ${isMole ? 'target' : 'item'} must be "is_correct": true`);
  if (wrongs < 1) errors.push(`at least one ${isMole ? 'target' : 'item'} must be "is_correct": false`);

  return baseGame(template, core, {
    [promptKey]: prompt,
    [listKey]: items,
    _promptKey: promptKey,
    _count: items.length, _min: 2, _max: MAX_TILES, _label: listKey, errors, lang,
  });
}

function baseGame(template, core, shape) {
  const { errors, lang } = shape;
  const game = {
    template,
    title: str(core.title, ''),
    theme: str(core.theme, ''),
    instructions: str(core.instructions, 'Play and learn!'),
    intro: str(core.intro, ''),
  };
  if (template === 'airplane') game.questions = shape.questions;
  else game[shape._promptKey] = shape[shape._promptKey];
  game[shape._label] = shape[shape._label];
  return game;
}

// ---------------------------------------------------------------------------
// Derive a plain read-through (static, non-game) version from game JSON.
// ---------------------------------------------------------------------------
function deriveStaticVersion(game) {
  if (!game) return { sections: [] };
  const sections = [{ title: game.title || game.instructions || 'Game', body: game.intro || '' }];

  if (game.template === 'airplane') {
    (game.questions || []).forEach((q, i) => {
      sections.push({ title: `${i + 1}. ${q.question}`, body: `→ ${q.correct_answer}` });
    });
  } else {
    const list = game.questions ? game.questions : (game.targets || game.items || []);
    const head = game.template === 'flying_fruit' ? game.category_prompt : game.prompt;
    if (head) sections.push({ title: head, body: '' });
    list.forEach((t, i) => {
      sections.push({ title: `${i + 1}. ${t.text}`, body: t.is_correct ? '✔ correct' : '✘ not correct' });
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
  clientModel = process.env.OPENROUTER_MODEL || 'nex-agi/nex-n2.5-mini:free';
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

  const languageLine = lang === 'ar'
    ? 'Arabic (keep proper right-to-left text)'
    : lang === 'fr' ? 'French' : 'English';

  const templateChoice = template
    ? `Use EXACTLY this template: "${template}". Only include THAT template inside the "games" object.\n`
    : `Choose the template that best fits this lesson and the student profile: airplane (question-answer drilling, best for math and grammar practice), whack_a_mole (pick the right words/actions, best for vocabulary and identification), flying_fruit (catch the items that belong to a category, best for sorting and classification). Only include the chosen template inside the "games" object.\n`;

  // The STRICT output contract (exact spec).
  const contract = `You must return exactly one valid JSON object with this structure:

{
  "metadata": {
    "lesson_title": "the lesson title",
    "target_level": "the target grade/level"
  },
  "games": {
    "<template>": { ... }
  }
}

The "games" object contains EXACTLY ONE key: the template you are filling.

Template 1 — "airplane": Fly a plane and answer questions. Each question is a multiple choice with one correct answer and two or three distractors:
{
  "instructions": "one kid-friendly instruction line",
  "questions": [
    { "id": "q1", "question": "the question", "correct_answer": "the one correct answer", "distractors": ["wrong option 1", "wrong option 2"] }
  ]
}

Template 2 — "whack_a_mole": Moles pop up; the child must whack ONLY the correct ones and leave the wrong ones alone:
{
  "instructions": "one kid-friendly instruction line",
  "prompt": "what the child must look for (e.g. 'Whack the words that begin with the letter b')",
  "targets": [
    { "text": "some word or phrase", "is_correct": true },
    { "text": "another word or phrase", "is_correct": false }
  ]
}

Template 3 — "flying_fruit": Fruit/objects fly across the screen; the child must CATCH the ones that belong to a category and avoid the others:
{
  "instructions": "one kid-friendly instruction line",
  "category_prompt": "which category to catch (e.g. 'Catch the fruits')",
  "items": [
    { "text": "some word or phrase", "is_correct": true },
    { "text": "another word or phrase", "is_correct": false }
  ]
}`;

  let prompt = `Create a learning game for children in the ${languageLine} language. ALL content below must be written in ${languageLine}. Age range: ${ageMin}-${ageMax} (lesson level ${baseLevel}). Difficulty requested: ${actualLevel} (scale 1=easiest to 5=hardest).\n\n${variantLine}\n${themeLine}\n${templateChoice}\nAdapt the following LESSON into a fun, vibrant 2D game storyline. Be highly creative with the questions, words, themes and characters.\nLESSON (subject: ${subjectName}):\nTitle: ${lesson.title}\nContent:\n${lesson.raw_lesson_text}\n`;

  if (mode === 'fix') {
    prompt += `\nThe teacher wants the game REDONE. Apply their instructions. Keep the SAME template unless the teacher explicitly asks for a different one. Output the FULL corrected JSON object only. Never add text outside the JSON.\n\nCurrent game JSON:\n${JSON.stringify(currentGame, null, 1)}\n\nTeacher's instructions for the redo:\n${feedback}\n`;
  } else if (extraInstructions && extraInstructions.trim()) {
    prompt += `\nEXTRA INSTRUCTIONS FROM THE TEACHER:\n${extraInstructions.trim()}\n`;
  }
  prompt += `\nReturn exactly one JSON object matching this STRICT contract. ${contract}\n`
    + `Requirements:\n`
    + `- The "games" object contains EXACTLY one template. When auto, choose the template that fits the lesson best.\n`
    + `- Question count: 4 for a normal profile, 3 for autism, 3 to 4 for hearing impairment. No more than 4 questions.\n`
    + `- For whack_a_mole and flying_fruit: 6-12 tiles (fewer for autism), with at least 2 correct and at least 2 wrong tiles.\n`
    + `- Keep EVERY short field to one line. No extra keys, no prose outside the JSON object.\n`
    + `- Age-appropriate, positive, non-violent, respectful. No slang, no profanity, no URLs, no emails, no phone numbers, no real people.\n`
    + `- Distractors must be plausible but clearly different from the correct answer.`
    + `- The child never sees JSON keys — only the game experience.`;
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
  const count = variant === 'autisme' ? 3 : 4;
  const theme = genderTheme === 'male' ? 'Space' : genderTheme === 'female' ? 'Nature' : 'Fun';
  const intro = lesson.title;
  const staticSections = [];
  const instructions = `${intro} — ${variant === 'autisme' ? 'simple practice' : 'practice'}`;

  if (subjectName === 'math') {
    const rnd = (seed) => { const x = Math.sin(seed * 9973) * 10000; return Math.floor((x - Math.floor(x)) * 9) + 1; };
    const questions = Array.from({ length: count }, (_, i) => {
      const a = rnd((lesson.id || 1) * 7 + i * 3 + 1);
      const b = rnd((lesson.id || 1) * 13 + i * 5 + 2);
      const op = i % 2 === 0 ? '+' : '-';
      const x = Math.max(a, b);
      const y = Math.min(a, b);
      const result = op === '+' ? a + b : x - y;
      const distractors = [...new Set([result + 1, result + 2, result - 1].filter((n) => n >= 0 && n !== result))].map(String);
      while (distractors.length < 2) distractors.push(String(Number(distractors[distractors.length - 1] || result) + 1 + distractors.length));
      const question = op === '+' ? `${a} + ${b} = ?` : `${x} - ${y} = ?`;
      staticSections.push({ title: `${i + 1}. ${question}`, body: `→ ${result}` });
      return { id: `q${i + 1}`, question, correct_answer: String(result), distractors: distractors.slice(0, 3) };
    });
    const game = { template: 'airplane', title: intro, theme, instructions, intro: 'Answer each question to fly the plane!', questions };
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

  const trueWords = keywords.slice(0, Math.min(count, keywords.length)).map((k) => k.kw);
  const wrongPool = keywords.map((k) => k.sent).join(' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !trueWords.includes(w));
  const falseWords = [...new Set([...pickDistractors('', wrongPool, lang, 4), ...(NUMBER_WORDS[lang] ? Object.values(NUMBER_WORDS[lang]) : [])])]
    .filter((w) => !trueWords.includes(w))
    .slice(0, 4);

  const targets = [
    ...trueWords.map((text) => ({ text, is_correct: true })),
    ...falseWords.map((text) => ({ text, is_correct: false })),
  ];

  const game = { template: 'whack_a_mole', title: intro, theme, instructions, intro: 'Find the words that belong to the lesson!', prompt: 'Whack the words you learned in this lesson.', targets };
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
// Stateless API helpers for POST /api/games/generate and
// /api/games/regenerate (spec-compliant `{ metadata, games }` shape).
// The full teacher context lives in metadata._ctx so a regenerate call can
// reproduce it losslessly; validation only reads lesson_title + target_level,
// and the wrapper JSON is never rendered directly by the app.
// ---------------------------------------------------------------------------
function extractSingleGame(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.games && typeof obj.games === 'object') {
    const keys = Object.keys(obj.games).filter((k) => TEMPLATES.includes(k));
    return keys.length === 1 ? obj.games[keys[0]] : null;
  }
  return TEMPLATES.indexOf(obj.template) !== -1 ? obj : null;
}

function lessonFromSpec({ lessonText, level }) {
  const raw = String(lessonText || '');
  const title = (raw.split('\n')[0].trim().slice(0, 80)) || 'Lesson';
  const asNum = /^\d{1,2}$/.test(String(level || '').trim()) ? Number(String(level).trim()) : null;
  const schoolCode = !asNum && gradeInfo(String(level || '').toLowerCase()) ? String(level).toLowerCase() : 'cp';
  return {
    id: 0,
    title,
    school_level: schoolCode,
    level: asNum ? Math.min(MAX_LEVEL, Math.max(1, asNum)) : 1,
    raw_lesson_text: raw,
  };
}

function packSpec(game, staticVersion, note, ctx) {
  return {
    metadata: {
      lesson_title: (game.meta && game.meta.lesson_title) || ctx.title || 'Lesson',
      target_level: (game.meta && game.meta.target_level) || String(ctx.levelNum || ctx.school_level || ''),
      _ctx: ctx,
    },
    games: { [game.template]: game },
    staticVersion,
    source: staticVersion && staticVersion.source ? staticVersion.source : undefined,
    note,
  };
}

async function generateFromSpec({ lessonText, level, lang = 'en', variant = 'normale', genderTheme = 'neutral', subjectName = 'english', template, extraInstructions }) {
  const lesson = lessonFromSpec({ lessonText, level });
  const result = await generateOne({
    lesson,
    subjectName,
    variant,
    genderTheme,
    lang,
    template,
    extraInstructions: String(extraInstructions || '').trim().slice(0, 1200) || undefined,
    difficultyHint: lesson.level,
  });
  return packSpec(result.game, result.staticVersion, result.note, {
    title: lesson.title,
    lessonText: lesson.raw_lesson_text.slice(0, 4000),
    level: level == null ? String(lesson.level) : String(level),
    levelNum: lesson.level,
    school_level: lesson.school_level,
    lang,
    variant,
    genderTheme,
    subjectName,
  });
}

async function regenerateFromFeedback({ previousJson, feedbackInstructions }) {
  const game = extractSingleGame(previousJson || null);
  if (!game) {
    const err = new Error('previousJson must contain exactly one of the fixed templates');
    err.code = 'VALIDATION';
    throw err;
  }
  const meta = previousJson && previousJson.metadata ? previousJson.metadata : {};
  const ctx = (meta._ctx && typeof meta._ctx === 'object' ? meta._ctx : {});
  const lesson = lessonFromSpec({ lessonText: ctx.lessonText || '', level: ctx.level || 1 });
  const result = await fixGame({
    lesson,
    game,
    feedback: String(feedbackInstructions || '').trim().slice(0, 1200),
    lang: ctx.lang || 'en',
    variant: ctx.variant || 'normale',
    genderTheme: ctx.genderTheme || 'neutral',
    subjectName: ctx.subjectName || 'english',
  });
  return packSpec(result.game, result.staticVersion, result.note, {
    title: (game.title || meta.lesson_title || lesson.title),
    lessonText: ctx.lessonText || '',
    level: ctx.level || 1,
    levelNum: lesson.level,
    school_level: lesson.school_level,
    lang: ctx.lang || 'en',
    variant: ctx.variant || 'normale',
    genderTheme: ctx.genderTheme || 'neutral',
    subjectName: ctx.subjectName || 'english',
  });
}

// ---------------------------------------------------------------------------
// Migration support: convert an older game_json into one of the 3 fixed
// templates so already-approved games keep working. Handles the previous
// 3-template canonical shape (entries with options/correctIndex) and the
// legacy quiz/match/fill games, mapping them all onto "airplane".
// ---------------------------------------------------------------------------
const OLD_TEMPLATES = ['adventure_mission', 'challenge_quest', 'build_rescue'];

function toAirplane({ title, theme, instructions, intro, ending, goal, entries, items }) {
  const src = Array.isArray(entries) ? entries : (Array.isArray(items) ? items : []);
  const questions = [];
  src.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    let question = str(e.question, '');
    let correct = '';
    let distractors = [];
    if (Array.isArray(e.options) && Number.isInteger(e.correctIndex)) {
      const opts = e.options.map((o) => String(o).trim()).filter(Boolean);
      const cIdx = e.correctIndex >= 0 && e.correctIndex < opts.length ? e.correctIndex : -1;
      if (cIdx >= 0) {
        correct = opts[cIdx];
        distractors = opts.filter((_, j) => j !== cIdx);
      }
    } else {
      question = str(e.question, e.left ? `Match: ${e.left}` : (e.prompt ? `Complete: ${e.prompt.replace(/_+/g, '___')}` : ''));
      correct = str(e.answer, str(e.right, ''));
      distractors = (Array.isArray(e.aliases) ? e.aliases : []).map((a) => String(a).trim()).filter(Boolean);
      if (!distractors.length) distractors = src.map((x) => str(x.right, '')).filter((r) => r && r.toLowerCase() !== correct.toLowerCase()).slice(0, 3);
    }
    if (!question) question = `Question ${i + 1}`;
    if (!correct) return;
    while (distractors.length < 2) distractors.push(`${correct}?`);
    questions.push({
      id: str(e.id, `q${i + 1}`),
      question,
      correct_answer: correct,
      distractors: distractors.slice(0, 4),
    });
  });
  if (!questions.length) return null;

  const game = {
    template: 'airplane',
    title: str(title, theme, ''),
    theme: str(theme, ''),
    instructions: str(instructions, 'Read each question and pick the right answer!'),
    intro: str(intro, ''),
    questions,
  };
  if (ending) game.meta = { ending };
  if (goal) game.meta = { goal };
  return { game, staticVersion: deriveStaticVersion(game) };
}

function convertLegacyGame(json) {
  if (!json || typeof json !== 'object') return null;

  // Already one of the new templates? Re-validate it.
  if (TEMPLATES.indexOf(json.template) !== -1) {
    const v = validateGameJson(json);
    return v.ok ? { game: v.game, staticVersion: v.staticVersion } : null;
  }

  // The previous fixed-template canonical shape (entries with options).
  if (OLD_TEMPLATES.indexOf(json.template) !== -1) {
    const converted = toAirplane(json);
    if (converted && json.ending) converted.game.meta = { ...(converted.game.meta || {}), ending: json.ending };
    if (converted && json.goal) converted.game.meta = { ...(converted.game.meta || {}), goal: json.goal };
    return converted;
  }

  // Legacy quiz / match / fill games.
  if (json.type === 'quiz' || json.type === 'match' || json.type === 'fill') {
    return toAirplane(json);
  }

  return null;
}

module.exports = {
  TEMPLATES,
  validateGameJson,
  deriveStaticVersion,
  generateOffline,
  generateOne,
  fixGame,
  generateFromSpec,
  regenerateFromFeedback,
  convertLegacyGame,
  hasAi: () => Boolean(process.env.OPENROUTER_API_KEY),
};