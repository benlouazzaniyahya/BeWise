'use strict';

// ---------------------------------------------------------------------------
// AI game generation + strict validation.
//
// - The game library is FIXED: exactly three reusable templates
//   (airplane, whack_a_mole, flying_fruit) shipped in
//   public/js/game-lib.js. The AI NEVER creates new UI or new templates â€” it
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

// Entry/size caps â€” the AI can never flood a game with content.
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
  'Ù‚ØªÙ„', 'Ø¯Ù…', 'Ø³Ù„Ø§Ø­', 'Ø¬Ù†Ø³ÙŠ', 'Ø§Ù†ØªØ­Ø§Ø±', 'Ù…Ø®Ø¯Ø±Ø§Øª',
];

// Arabic letters + diacritics, for word-boundary matching of Arabic tokens.
const AR_LETTERS = '\u0621-\u064A\u066E-\u06D3\u06D5\u0750-\u077F';
const AR_DIAC = '\u064B-\u0652\u0653-\u065F\u0670';
const AR_PREFIX = '(?:[Ø¨ÙˆÙÙƒÙ„]?Ø§Ù„)?';

function isArabicToken(tok) {
  return /[\u0621-\u064A\u066E-\u06D3]/.test(tok);
}

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
    // Whole-word matching only: plain substrings would false-positive on
    // innocent words (e.g. english "die" in "diet", arabic "Ø¯Ù…" in "Ù‚Ø¯Ù…"/"Ø¯Ù…Ø§Øº").
    if (isArabicToken(tok)) {
      const re = new RegExp(`(?<![${AR_LETTERS}])${AR_PREFIX}${tok}(?![${AR_LETTERS}${AR_DIAC}])`);
      if (re.test(lower)) return `blocked content: "${tok}"`;
    } else if (new RegExp(`\\b${tok.toLowerCase()}\\b`).test(lower)) {
      return `blocked content: "${tok}"`;
    }
  }
  if (URL_RE.test(joined)) return 'contains a URL';
  if (EMAIL_RE.test(joined)) return 'contains an email address';
  if (PHONE_RE.test(joined)) return 'contains a phone number';
  // nonsense guard: single "word" longer than 60 chars
  for (const s of strings) {
    if (s && s.length > 60 && !s.includes(' ') && !s.includes('ØŒ')) return 'malformed long token';
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
      errors.push(`too many questions (max ${MAX_QUESTIONS}) â€” keep them short and essential`);
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
      sections.push({ title: `${i + 1}. ${q.question}`, body: `â†’ ${q.correct_answer}` });
    });
  } else {
    const list = game.questions ? game.questions : (game.targets || game.items || []);
    const head = game.template === 'flying_fruit' ? game.category_prompt : game.prompt;
    if (head) sections.push({ title: head, body: '' });
    list.forEach((t, i) => {
      sections.push({ title: `${i + 1}. ${t.text}`, body: t.is_correct ? 'âœ” correct' : 'âœ˜ not correct' });
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
const DEFAULT_MODEL = 'nex-agi/nex-n2.5-mini:free';
// Fallback queue: when one model is rate-limited / out of quota (429/402),
// the caller rotates to the next one. `OPENROUTER_MODEL` (if set) stays first.
function getModelQueue() {
  const extra = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'openai/gpt-4o-mini',
    'stealth/space-bunny-alpha',
  ];
  const base = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  return [...new Set([base, ...extra])];
}
function getClientModel() {
  if (!process.env.OPENROUTER_API_KEY) return null;
  return getModelQueue()[0];
}

async function callModel(prompt, options) {
  options = options || {};
  const queue = getModelQueue();
  const model = (options.model || queue[0]);
  if (!model) return null;
  const key = process.env.OPENROUTER_API_KEY;
  const site = process.env.OPENROUTER_SITE_URL || process.env.BASE_URL || 'https://nabta.local';
  const title = process.env.OPENROUTER_APP_TITLE || 'nabta';

  const body = {
    model,
    max_tokens: options.maxTokens || 1200,
    temperature: options.temperature == null ? 0.7 : options.temperature,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  };
  if (options.responseFormat) body.response_format = { type: 'json_object' };

  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': site,
      'X-Title': title,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timer);

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
// Course-grounding: derive the lesson's OWN vocabulary so generated games can
// be REQUIRED to reuse it. Games must mirror the course content â€” not generic
// trivia. The validation loops re-prompt the model when the pack drifts away
// from the lesson keywords.
// ---------------------------------------------------------------------------
const GROUNDING_STOPWORDS = new Set([
  'though', 'during', 'above', 'below', 'between', 'without', 'within', 'because', 'again',
  'the', 'and', 'are', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'you',
  'about', 'they', 'will', 'into', 'some', 'what', 'when', 'them', 'then', 'each', 'than',
  'were', 'been', 'being', 'would', 'could', 'should', 'there', 'their', 'these', 'those',
  'more', 'most', 'other', 'very', 'just', 'over', 'also', 'can', 'may', 'might', 'which',
  'a', 'an', 'to', 'of', 'in', 'is', 'it', 'on', 'be', 'by', 'or', 'as', 'at', 'so', 'we',
  'he', 'she', 'his', 'her', 'not', 'but', 'all', 'has', 'was', 'one', 'two', 'three',
  'le', 'la', 'les', 'un', 'une', 'de', 'du', 'des', 'et', 'ou', 'il', 'elle', 'que', 'qui',
  'est', 'sont', 'pour', 'avec', 'dans', 'sur', 'pas', 'plus', 'mais', 'ses', 'ce', 'cette',
  'ces', 'par', 'aux', 'dau', 'tout', 'tous', 'comme', 'votre', 'nous', 'vous', 'leur',
  'ÙÙŠ', 'Ù…Ù†', 'Ø¹Ù„Ù‰', 'Ø¥Ù„Ù‰', 'Ø§Ù„', 'Ø¹Ù†', 'Ùˆ', 'Ù‡Ùˆ', 'Ù‡ÙŠ', 'Ø£Ù†', 'Ø¥Ù†', 'Ù„Ø§', 'Ù…Ø§', 'Ø¨Ø¹Ø¯',
  'Ù‚Ø¨Ù„', 'Ù…Ø«Ù„', 'Ù‚Ø¯', 'Ø£Ùˆ', 'Ù…Ø¹', 'Ù‡Ø°Ø§', 'Ù‡Ø°Ù‡', 'Ø°Ù„Ùƒ', 'ÙƒØ§Ù†', 'ÙƒØ§Ù†Øª', 'Ø«Ù…', 'Ø­ÙŠØ«', 'Ø£ÙŠ',
]);

function courseKeywords(lesson) {
  const text = String((lesson && (lesson.raw_lesson_text || lesson.title)) || '').toLowerCase();
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (w.length < 3 || /^\d+$/.test(w)) continue;
    if (GROUNDING_STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 14) break;
  }
  return out;
}

function groundingHits(text, keywords) {
  const low = String(text || '').toLowerCase();
  const hits = [];
  for (const k of keywords) if (low.includes(k)) hits.push(k);
  return hits;
}

// Returns a rejection reason string when the AI output drifts away from the
// course vocabulary, or '' when it is sufficiently grounded. Skipped entirely
// for teacher-driven redo/correction requests (they may legitimately alter the
// topic) â€” the `mode === 'fix'` caller decides.
function courseGroundingError(obj, lesson) {
  const kws = courseKeywords(lesson);
  if (kws.length < 3) return '';
  if (!obj || typeof obj !== 'object') return '';
  const games = obj.games && typeof obj.games === 'object' && !Array.isArray(obj.games) ? obj.games : obj;
  const text = JSON.stringify(games);
  const hits = groundingHits(text, kws);
  const need = kws.length >= 6 ? 2 : 1;
  if (hits.length >= need) return '';
  const missing = kws.filter((k) => !hits.includes(k)).slice(0, 12).join(', ');
  return `The generated content is not related to the course. Reuse the lesson's own vocabulary: missing terms from COURSE JSON: ${missing}. Base questions, answers, tiles and categories ONLY on the exact words and facts of the course provided.`;
}

// ---------------------------------------------------------------------------
// Prompt builder (no PII â€” only generic lesson/profile context)
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
      : `GENDER THEME: generic and balanced â€” appealing to everyone.`;

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

Template 1 â€” "airplane": Fly a plane and answer questions. Each question is a multiple choice with one correct answer and two or three distractors:
{
  "instructions": "one kid-friendly instruction line",
  "questions": [
    { "id": "q1", "question": "the question", "correct_answer": "the one correct answer", "distractors": ["wrong option 1", "wrong option 2"] }
  ]
}

Template 2 â€” "whack_a_mole": Moles pop up; the child must whack ONLY the correct ones and leave the wrong ones alone:
{
  "instructions": "one kid-friendly instruction line",
  "prompt": "what the child must look for (e.g. 'Whack the words that begin with the letter b')",
  "targets": [
    { "text": "some word or phrase", "is_correct": true },
    { "text": "another word or phrase", "is_correct": false }
  ]
}

Template 3 â€” "flying_fruit": Fruit/objects fly across the screen; the child must CATCH the ones that belong to a category and avoid the others:
{
  "instructions": "one kid-friendly instruction line",
  "category_prompt": "which category to catch (e.g. 'Catch the fruits')",
  "items": [
    { "text": "some word or phrase", "is_correct": true },
    { "text": "another word or phrase", "is_correct": false }
  ]
}`;

  const courseJson = JSON.stringify({
    lesson_title: lesson.title,
    subject: subjectName,
    grade_band: lesson.school_level,
    level: lesson.level,
    course_content: lesson.raw_lesson_text,
  });

  let prompt = `Create a learning game for children in the ${languageLine} language. ALL content below must be written in ${languageLine}. Age range: ${ageMin}-${ageMax} (lesson level ${baseLevel}). Difficulty requested: ${actualLevel} (scale 1=easiest to 5=hardest).\n\n${variantLine}\n${themeLine}\n${templateChoice}\nAdapt the following LESSON into a fun, vibrant 2D game storyline. The COURSE JSON below is the ONLY source of truth for the content: every question, answer, word, tile and category MUST be taken from it. Do NOT invent facts, words or examples that are not in the course.\nCOURSE JSON (subject: ${subjectName}):\n${courseJson}\n`;

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
    + `- CONTENT MUST BE RELATED TO THE COURSE: every question, answer, word and example must appear in the COURSE JSON. Never use generic or unrelated content.`
    + `- The child never sees JSON keys â€” only the game experience.`;
  return prompt;
}

// ---------------------------------------------------------------------------
// "TRIPLE" mode â€” ask the model to fill ALL THREE fixed templates in one
// response (the spec the user pasted combines airplane + whack_a_mole +
// flying_fruit into a single JSON payload). Sub-validation still happens
// per template via `validateGameJson`, so each entry is graded/rendered by
// the exact same engine as before â€” only the AI call is combined.
// ---------------------------------------------------------------------------
function buildTriplePrompt(context) {
  const lesson = context.lesson;
  const subjectName = context.subjectName;
  const genderTheme = context.genderTheme;
  const lang = context.lang;
  const extraInstructions = context.extraInstructions;
  const difficultyHint = context.difficultyHint;
  const feedback = context.feedback;
  const currentTriple = context.currentTriple;
  const mode = context.mode;

  const [ageMin, ageMax] = gradeBand(lesson.school_level);
  const baseLevel = lesson.level;
  const actualLevel = difficultyHint && difficultyHint > 0 ? difficultyHint : baseLevel;

  // THE TRIPLE PACK IS PURELY COURSE-DRIVEN: the three games always reinforce
  // the SAME lesson for every learner profile. No autism/hearing specialization
  // here â€” content fidelity to the course matters more than profile tweaks.
  const themeLine = genderTheme === 'male'
    ? `GENDER THEME: friendly to boys (e.g. space, cars, animals, robots, sea) but never excluding anyone.`
    : genderTheme === 'female'
      ? `GENDER THEME: friendly to girls (e.g. nature, art, pets, stars, garden) but never excluding anyone.`
      : `GENDER THEME: generic and balanced â€” appealing to everyone.`;

  const languageLine = lang === 'ar'
    ? 'Arabic (keep proper right-to-left text)'
    : lang === 'fr' ? 'French' : 'English';

  const tripleContract = `You must return exactly ONE valid JSON object with this shape:

{
  "metadata": {
    "lesson_title": "the lesson title",
    "target_level": "the target grade/level"
  },
  "games": {
    "airplane":      { ... Template 1 below ... },
    "whack_a_mole":  { ... Template 2 below ... },
    "flying_fruit":  { ... Template 3 below ... }
  }
}

All three keys inside "games" MUST be present and validated. Each is one of the three fixed templates (no other keys allowed):

Template 1 â€” "airplane": Fly a plane and answer questions.
{
  "instructions": "one kid-friendly instruction line",
  "questions": [
    { "id": "q1", "question": "...", "correct_answer": "...", "distractors": ["wrong1", "wrong2"] }
  ]
}

Template 2 â€” "whack_a_mole": Whack only the correct moles.
{
  "instructions": "one kid-friendly instruction line",
  "prompt": "what the child must whack (e.g. 'Whack the words that begin with the letter b')",
  "targets": [
    { "text": "...", "is_correct": true },
    { "text": "...", "is_correct": false }
  ]
}

Template 3 â€” "flying_fruit": Catch only the items that belong to a category.
{
  "instructions": "one kid-friendly instruction line",
  "category_prompt": "which category to catch (e.g. 'Catch the fruits')",
  "items": [
    { "text": "...", "is_correct": true },
    { "text": "...", "is_correct": false }
  ]
}`;

  const courseJson = JSON.stringify({
    lesson_title: lesson.title,
    subject: subjectName,
    grade_band: lesson.school_level,
    level: lesson.level,
    course_content: lesson.raw_lesson_text,
  });

  let prompt = `Generate a TRIPLE PACK of three learning games for children in ${languageLine}. ALL content below must be written in ${languageLine}. Age range: ${ageMin}-${ageMax} (lesson level ${baseLevel}). Difficulty requested: ${actualLevel} (scale 1=easiest to 5=hardest).\n\n${themeLine}\nYou will produce THREE games at once, one of each fixed template below, and all THREE must teach the SAME lesson.\nAdapt the lesson below into a fun, vibrant 2D game storyline. The COURSE JSON is the ONLY source of truth for the content: every question, answer, word, tile and category MUST be taken from it. Do NOT invent facts, words or examples that are not in the course.\nCOURSE JSON (subject: ${subjectName}):\n${courseJson}\n`;

  if (mode === 'fix' && currentTriple && feedback) {
    prompt += `\nThe teacher wants the entire TRIPLE PACK redone. Apply their instructions to ALL THREE templates unless they explicitly ask for a specific one. Keep the content related to the COURSE JSON above. Output the FULL corrected JSON only.\n\nCurrent TRIPLE PACK JSON:\n${JSON.stringify(currentTriple, null, 1)}\n\nTeacher's instructions:\n${feedback}\n`;
  } else if (extraInstructions && extraInstructions.trim()) {
    prompt += `\nEXTRA INSTRUCTIONS FROM THE TEACHER:\n${extraInstructions.trim()}\n`;
  }

  prompt += `\nReturn exactly one JSON object matching this STRICT contract. ${tripleContract}\n`
    + `Requirements:\n`
    + `- "games" contains EXACTLY three keys: "airplane", "whack_a_mole", "flying_fruit".\n`
    + `- airplane: 4 multiple-choice questions that DRILL THE FACTS AND VOCABULARY OF THE COURSE, each with one correct_answer and 2 or 3 distractors that are plausible but clearly wrong.\n`
    + `- whack_a_mole: 6 to 8 tiles total, all words taken from the COURSE JSON, at least 2 correct and at least 2 wrong tiles.\n`
    + `- flying_fruit: 6 to 8 items, all words taken from the COURSE JSON, at least 2 correct and at least 2 wrong.\n`
    + `- The three games reinforce ONE ANOTHER on the same lesson â€” e.g. airplane drills facts, whack surfaces vocabulary words from those facts, flying_fruit sorts examples into a category drawn from the lesson.\n`
    + `- CONTENT MUST BE RELATED TO THE COURSE: every question, answer, word and example must appear in the COURSE JSON. Never use generic or unrelated content.\n`
    + `- Keep every short field to one line. No extra keys, no prose outside the JSON object.\n`
    + `- Age-appropriate, positive, non-violent, respectful. No slang, no profanity, no URLs, no emails, no phone numbers, no real people.\n`
    + `- The child never sees JSON keys â€” only the game experience.`;
  return prompt;
}

// ---------------------------------------------------------------------------
// Offline (no API key) generator â€” deterministic, content-derived, safe.
// ---------------------------------------------------------------------------
const NUMBER_WORDS = {
  en: { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 0: 'zero' },
  fr: { 1: 'un', 2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit', 9: 'neuf', 0: 'zÃ©ro' },
  ar: { 1: 'ÙˆØ§Ø­Ø¯', 2: 'Ø§Ø«Ù†Ø§Ù†', 3: 'Ø«Ù„Ø§Ø«Ø©', 4: 'Ø£Ø±Ø¨Ø¹Ø©', 5: 'Ø®Ù…Ø³Ø©', 6: 'Ø³ØªØ©', 7: 'Ø³Ø¨Ø¹Ø©', 8: 'Ø«Ù…Ø§Ù†ÙŠØ©', 9: 'ØªØ³Ø¹Ø©', 0: 'ØµÙØ±' },
};

function pickDistractors(keyword, pool, lang, n) {
  const out = [];
  const fallback = ['Ø§Ù„', 'de', 'the', 'et', 'Ùˆ', 'a', 'un', 'le', 'la'];
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
    .split(/(?<=[.!ØŸØŸ?Ø›;])\s+/);
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
  const instructions = `${intro} â€” ${variant === 'autisme' ? 'simple practice' : 'practice'}`;

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
      staticSections.push({ title: `${i + 1}. ${question}`, body: `â†’ ${result}` });
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

// Offline TRIPLE generator â€” produces ONE lesson-aligned game for each of the
// three fixed templates so the entire flow can still be demoed without an
// OpenRouter key. Builds all three templates directly from the lesson text
// (does NOT call generateOffline which only ever emits a single template).
function generateTripleOffline(context) {
  const lesson = context.lesson;
  const variant = context.variant;
  const lang = context.lang;
  const subjectName = context.subjectName;
  const genderTheme = context.genderTheme;
  const theme = genderTheme === 'male' ? 'Space' : genderTheme === 'female' ? 'Nature' : 'Fun';
  const count = variant === 'autisme' ? 3 : 4;

  // -------- Mine keyword/source pool from lesson text ----------------------
  // For any non-math subject we treat sentences as cloze + vocabulary sources.
  // For math we use a deterministic arithmetic fact pool (matches the existing
  // single-template offline path).
  let airplaneQ, whackTargets, fruitItems;
  if (subjectName === 'math') {
    const rnd = (seed) => { const x = Math.sin(seed * 9973) * 10000; return Math.floor((x - Math.floor(x)) * 9) + 1; };
    const facts = Array.from({ length: count }, (_, i) => ({
      a: rnd((lesson.id || 1) * 7 + i * 3 + 1),
      b: rnd((lesson.id || 1) * 13 + i * 5 + 2),
      op: i % 2 === 0 ? '+' : '-',
    }));
    facts.forEach((f) => { f.x = Math.max(f.a, f.b); f.y = Math.min(f.a, f.b); f.result = f.op === '+' ? f.a + f.b : f.x - f.y; });

    airplaneQ = {
      title: lesson.title,
      questions: facts.map((f, i) => {
        const question = f.op === '+' ? `${f.a} + ${f.b} = ?` : `${f.x} - ${f.y} = ?`;
        const distractors = [...new Set([f.result + 1, f.result + 2, f.result - 1, f.result + 3].filter((n) => n !== f.result && n >= 0))]
          .slice(0, 3)
          .map(String);
        while (distractors.length < 2) distractors.push(String(f.result + distractors.length + 4));
        return { id: `q${i + 1}`, question, correct_answer: String(f.result), distractors };
      }),
      instructions: 'Answer each question to fly the plane!',
      intro: 'A math flight of arithmetic facts from this lesson.',
    };

    const truePairs = facts.slice(0, 3).map((f) => ({ text: `${f.a} ${f.op} ${f.b} = ${f.result}`, is_correct: true }));
    const wrongNums = [...new Set(facts.map((f) => f.result + 1).filter((n) => !facts.some((q) => q.result === n)))].slice(0, 4);
    if (wrongNums.length < 2) wrongNums.push(99, 42);
    const falsePairs = wrongNums.slice(0, 3).map((n) => ({ text: `${facts[0].a} ${facts[0].op} ${facts[0].b} = ${n}`, is_correct: false }));
    whackTargets = [...truePairs, ...falsePairs];

    fruitItems = [
      ...facts.slice(0, 3).map((f) => ({ text: `${f.result} (${f.a} ${f.op} ${f.b})`, is_correct: true })),
      ...wrongNums.slice(0, 3).map((n) => ({ text: `${n}`, is_correct: false })),
    ];
  } else {
    // Non-math: build airplane cloze questions + whack/fruit from keywords.
    const sents = sentences(lesson.raw_lesson_text);
    const source = sents.length ? sents : [`${lesson.title} is a great lesson to learn. Practice makes progress!`];
    const keywords = [];
    source.slice(0, Math.min(count, source.length)).forEach((sent, idx) => {
      const words = sent.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
      const kw = words && words.length ? words[Math.max(0, Math.min(1, words.length - 1))] : 'learn';
      keywords.push({ sent, kw });
    });

    airplaneQ = {
      title: lesson.title,
      questions: keywords.map((k, i) => {
        const stem = k.sent.replace(new RegExp('\\b' + k.kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '___');
        const candidateDistractors = keywords
          .filter((x) => x.kw && x.kw.toLowerCase() !== k.kw.toLowerCase())
          .map((x) => x.kw);
        const distractors = [];
        for (const c of candidateDistractors) {
          if (c.toLowerCase() === k.kw.toLowerCase()) continue;
          if (distractors.includes(c)) continue;
          distractors.push(c);
          if (distractors.length >= 3) break;
        }
        while (distractors.length < 2) distractors.push(`option ${distractors.length + 1}`);
        return {
          id: `q${i + 1}`,
          question: `Fill the blank: "${stem}"`,
          correct_answer: k.kw,
          distractors,
        };
      }),
      instructions: 'Pilot the plane and pick the right word for each sentence!',
      intro: 'A cloze flight built from this lesson.',
    };

    const trueWords = keywords.map((k) => k.kw);
    const wrongPool = keywords.map((k) => k.sent).join(' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !trueWords.includes(w));
    const falseWords = [...new Set([...pickDistractors('', wrongPool, lang, 4), ...(NUMBER_WORDS[lang] ? Object.values(NUMBER_WORDS[lang]) : [])])]
      .filter((w) => !trueWords.includes(w))
      .slice(0, 4);
    while (falseWords.length < 2) falseWords.push('not-this');

    whackTargets = [
      ...trueWords.map((text) => ({ text, is_correct: true })),
      ...falseWords.map((text) => ({ text, is_correct: false })),
    ];
    fruitItems = whackTargets.slice();
  }

  const airplaneGame = {
    template: 'airplane',
    title: airplaneQ.title,
    theme,
    instructions: airplaneQ.instructions,
    intro: airplaneQ.intro,
    questions: airplaneQ.questions,
  };
  const whackGame = {
    template: 'whack_a_mole',
    title: lesson.title,
    theme,
    instructions: subjectName === 'math' ? 'Whack only the correct sums!' : 'Whack the words you learned in this lesson!',
    intro: subjectName === 'math' ? 'A math whack set built from this lesson.' : 'Whack the words from this lesson.',
    prompt: subjectName === 'math' ? 'Whack the equations that are correct.' : 'Whack the words that belong to this lesson.',
    targets: whackTargets,
  };
  const fruitGame = {
    template: 'flying_fruit',
    title: lesson.title,
    theme,
    instructions: subjectName === 'math' ? 'Catch the answers that match a true fact!' : 'Catch words that belong to the lesson!',
    intro: subjectName === 'math' ? 'A math catch set built from this lesson.' : 'A sorting catch set built from this lesson.',
    category_prompt: subjectName === 'math' ? 'Catch the answers that match the lesson' : 'Catch the words that belong to this lesson',
    items: fruitItems,
  };

  return {
    games: { airplane: airplaneGame, whack_a_mole: whackGame, flying_fruit: fruitGame },
    staticVersions: {
      airplane: deriveStaticVersion(airplaneGame),
      whack_a_mole: deriveStaticVersion(whackGame),
      flying_fruit: deriveStaticVersion(fruitGame),
    },
    source: 'offline',
    note: 'offline demo triple pack (set OPENROUTER_API_KEY for live AI)',
  };
}

// ---------------------------------------------------------------------------
// Triple-shape validation: takes the spec's `{ metadata, games: { 3 templates } }`
// payload and runs validateGameJson on each sub-template, returning a single
// `{ ok, games, staticVersions, errors }` object that the rest of the code can
// store per template (so rendering, grading and storage stay identical to the
// single-template path).
// ---------------------------------------------------------------------------
function validateTripleJson(raw, targetLang) {
  const errors = [];
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, games: null, errors: ['response is not valid JSON'] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, games: null, errors: ['response is not a JSON object'] };
  }
  if (!obj.games || typeof obj.games !== 'object' || Array.isArray(obj.games)) {
    return { ok: false, games: null, errors: ['"games" object is required and must contain airplane, whack_a_mole, flying_fruit'] };
  }
  const keys = Object.keys(obj.games).filter((k) => TEMPLATES.includes(k));
  const missing = TEMPLATES.filter((t) => !keys.includes(t));
  if (missing.length) errors.push(`missing templates in "games": ${missing.join(', ')}`);
  const extras = Object.keys(obj.games).filter((k) => !TEMPLATES.includes(k));
  if (extras.length) errors.push(`unexpected keys in "games": ${extras.join(', ')}`);

  const out = { games: {}, staticVersions: {}, errors };
  if (errors.length) return { ok: false, games: null, errors };

  for (const tpl of TEMPLATES) {
    const sub = { ...obj.games[tpl], template: tpl };
    const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : null;
    const wrapped = { games: { [tpl]: sub } };
    if (meta) wrapped.metadata = meta;
    const v = validateGameJson(wrapped, targetLang);
    if (!v.ok) {
      errors.push(...v.errors.map((e) => `[${tpl}] ${e}`));
      continue;
    }
    out.games[tpl] = v.game;
    out.staticVersions[tpl] = v.staticVersion;
  }
  if (errors.length) return { ok: false, games: null, errors };
  return { ok: true, games: out.games, staticVersions: out.staticVersions, errors: [], metadata: obj.metadata || null };
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

  const { validation, attempts, model } = await generateWithRetries(context);
  return {
    game: validation.game,
    staticVersion: validation.staticVersion,
    source: 'ai',
    note: `OpenRouter Â· ${model || getClientModel()} Â· ${attempts} attempt(s)`,
  };
}

// Shared AI loop: builds the prompt, calls the model, validates, and re-prompts
// with the validation errors so the model can repair itself. When a model is
// rate-limited, out of quota, or unavailable (429/402/404...), it rotates to
// the next model in the fallback queue instead of giving up.
async function generateWithRetries(context) {
  const isFix = !!context.mode;
  const queue = getModelQueue();
  const MAX_CALLS = Math.min(queue.length * MAX_ATTEMPTS, 10);
  let modelIndex = 0;
  let prompt = buildPrompt(context);
  let lastErrors = [];
  let attemptsUsed = 0;

  while (modelIndex < queue.length && attemptsUsed < MAX_CALLS) {
    let text;
    try {
      text = await callModel(prompt, { model: queue[modelIndex] });
    } catch (err) {
      attemptsUsed++;
      const msg = err.message || 'unknown';
      lastErrors.push(`api error: ${msg}`);
      // Bad key / auth: permanent â€” never worth rotating.
      if (/401|403|unauthoriz|invalid api key|missing api key|api key required/i.test(msg)) break;
      // Quota/credits/availability: switch to the next configured model.
      if (modelIndex < queue.length - 1) { modelIndex++; continue; }
      if (attemptsUsed >= MAX_CALLS) break;
      // Whole queue exhausted â€” brief pause, then start over from the top.
      await sleep(1200);
      modelIndex = 0;
      continue;
    }
    attemptsUsed++;
    const parsed = extractJson(text);
    let validation = validateGameJson(parsed, context.lang);
    // Course grounding: content must reuse the lesson's own vocabulary. Skipped
    // for teacher corrective redos (fix mode) which may legitimately refocus.
    if (validation.ok && !context.mode) {
      const grounding = courseGroundingError(parsed, context.lesson);
      if (grounding) validation = { ok: false, game: null, errors: [grounding] };
    }
    if (validation.ok) return { validation, attempts: attemptsUsed, model: queue[modelIndex] };
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
    // Offline: honestly cannot "redo" â€” return the same game unchanged
    const clone = JSON.parse(JSON.stringify(game));
    return { game: clone, staticVersion: deriveStaticVersion(clone), source: 'offline', note: 'offline mode: no AI to redo' };
  }

  const context = { lesson, subjectName, variant, genderTheme, lang, mode: 'fix', currentGame: game, feedback };
  const { validation } = await generateWithRetries(context);
  return { game: validation.game, staticVersion: validation.staticVersion, source: 'ai', note: `OpenRouter redo of ${game.template}` };
}

// Shared AI loop for TRIPLE mode: one model call serves all three templates.
// Retries rebuild the prompt with the per-template validation errors so the
// model can repair itself; uses response_format=json_object when available.
async function generateTripleWithRetries(context) {
  const isFix = !!context.mode;
  const queue = getModelQueue();
  const MAX_CALLS = Math.min(queue.length * MAX_ATTEMPTS, 10);
  let modelIndex = 0;
  let prompt = buildTriplePrompt(context);
  let lastErrors = [];
  let attemptsUsed = 0;

  while (modelIndex < queue.length && attemptsUsed < MAX_CALLS) {
    let text;
    try {
      text = await callModel(prompt, { responseFormat: true, maxTokens: 2400, model: queue[modelIndex] });
    } catch (err) {
      attemptsUsed++;
      const msg = err.message || 'unknown';
      lastErrors.push(`api error: ${msg}`);
      // Bad key / auth: permanent â€” never worth rotating.
      if (/401|403|unauthoriz|invalid api key|missing api key|api key required/i.test(msg)) break;
      // Quota/credits/availability: switch to the next configured model.
      if (modelIndex < queue.length - 1) { modelIndex++; continue; }
      if (attemptsUsed >= MAX_CALLS) break;
      // Whole queue exhausted â€” brief pause, then start over from the top.
      await sleep(1200);
      modelIndex = 0;
      continue;
    }
    attemptsUsed++;
    const parsed = extractJson(text);
    let validation = validateTripleJson(parsed, context.lang);
    if (validation.ok && !context.mode) {
      const grounding = courseGroundingError(parsed.games, context.lesson);
      if (grounding) validation = { ok: false, games: null, errors: [grounding] };
    }
    if (validation.ok) return { validation, attempts: attemptsUsed, model: queue[modelIndex] };
    lastErrors = validation.errors;
    prompt = buildTriplePrompt(context)
      + `\n\nYour previous response was REJECTED by per-template validation. The issues were:\n- ${lastErrors.join('\n- ')}\n`
      + `Please return a corrected triple-pack JSON object only (all three templates inside "games").`;
  }
  const err = new Error(`${isFix ? 'Triple redo' : 'Triple generation'} failed${attemptsUsed > 1 ? ` after ${attemptsUsed} attempts` : ''}: ${lastErrors.join('; ')}`);
  err.code = 'GENERATION_FAILED';
  throw err;
}

// ---------------------------------------------------------------------------
// Public: generate a TRIPLE PACK (all three fixed templates) for a lesson.
// Returns the same shape as packSpec-style single-game but with three games.
// ---------------------------------------------------------------------------
async function generateThree({ lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint }) {
  const context = { lesson, subjectName, variant, genderTheme, lang, extraInstructions, difficultyHint };

  if (!getClientModel()) {
    const built = generateTripleOffline(context);
    return { games: built.games, staticVersions: built.staticVersions, source: built.source, note: built.note };
  }

  const { validation, attempts, model } = await generateTripleWithRetries(context);
  return {
    games: validation.games,
    staticVersions: validation.staticVersions,
    source: 'ai',
    note: `OpenRouter triple Â· ${model || getClientModel()} Â· ${attempts} attempt(s)`,
  };
}

// Redo an existing triple pack from teacher instructions.
async function fixTriple({ lesson, currentTriple, feedback, lang, variant, genderTheme, subjectName }) {
  if (!getClientModel()) {
    const clone = JSON.parse(JSON.stringify(currentTriple));
    const out = { games: {}, staticVersions: {} };
    for (const tpl of TEMPLATES) {
      if (clone.games && clone.games[tpl]) {
        out.games[tpl] = clone.games[tpl];
        out.staticVersions[tpl] = deriveStaticVersion(clone.games[tpl]);
      }
    }
    return { games: out.games, staticVersions: out.staticVersions, source: 'offline', note: 'offline mode: no AI to redo' };
  }

  const context = {
    lesson, subjectName, variant, genderTheme, lang,
    mode: 'fix', currentTriple, feedback,
  };
  const { validation } = await generateTripleWithRetries(context);
  return {
    games: validation.games,
    staticVersions: validation.staticVersions,
    source: 'ai',
    note: `OpenRouter triple redo Â· ${getClientModel()}`,
  };
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

async function generateFromSpec({ lessonText, level, lang = 'en', variant = 'normale', genderTheme = 'male', subjectName = 'english', template, extraInstructions }) {
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
    genderTheme: ctx.genderTheme || 'male',
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
    genderTheme: ctx.genderTheme || 'male',
    subjectName: ctx.subjectName || 'english',
  });
}

// ---------------------------------------------------------------------------
// TRIPLE pack helpers â€” spec-compliant JSON shape:
//   { metadata: {...}, games: { airplane, whack_a_mole, flying_fruit } }
// All three sub-games are returned at once so the teacher can play-test them
// side by side. _ctx is preserved in metadata for a lossless regenerate call.
// ---------------------------------------------------------------------------
function extractTripleGames(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.games || typeof obj.games !== 'object') return null;
  const keys = Object.keys(obj.games).filter((k) => TEMPLATES.includes(k));
  if (keys.length !== TEMPLATES.length) return null;
  return {
    airplane: obj.games.airplane,
    whack_a_mole: obj.games.whack_a_mole,
    flying_fruit: obj.games.flying_fruit,
  };
}

function packTripleSpec(games, staticVersions, note, ctx) {
  const titleFrom = (g) => (g && g.meta && g.meta.lesson_title) || (g && g.title) || ctx.title || 'Lesson';
  const levelFrom = (g) => (g && g.meta && g.meta.target_level) || String(ctx.levelNum || ctx.school_level || '');
  const firstMeta = games.airplane;
  return {
    metadata: {
      lesson_title: titleFrom(firstMeta),
      target_level: levelFrom(firstMeta),
      _ctx: ctx,
    },
    games: {
      airplane: games.airplane,
      whack_a_mole: games.whack_a_mole,
      flying_fruit: games.flying_fruit,
    },
    staticVersions,
    source: 'ai',
    note,
  };
}

async function generateTripleFromSpec({ lessonText, level, lang = 'en', variant = 'normale', genderTheme = 'male', subjectName = 'english', extraInstructions }) {
  const lesson = lessonFromSpec({ lessonText, level });
  const result = await generateThree({
    lesson,
    subjectName,
    variant,
    genderTheme,
    lang,
    extraInstructions: String(extraInstructions || '').trim().slice(0, 1200) || undefined,
    difficultyHint: lesson.level,
  });
  const ctx = {
    title: lesson.title,
    lessonText: lesson.raw_lesson_text.slice(0, 4000),
    level: level == null ? String(lesson.level) : String(level),
    levelNum: lesson.level,
    school_level: lesson.school_level,
    lang,
    variant,
    genderTheme,
    subjectName,
  };
  return packTripleSpec(result.games, result.staticVersions, result.note, ctx);
}

async function regenerateTripleFromFeedback({ previousJson, feedbackInstructions }) {
  const triple = extractTripleGames(previousJson || null);
  if (!triple) {
    const err = new Error('previousJson must contain all three of the fixed templates');
    err.code = 'VALIDATION';
    throw err;
  }
  const meta = previousJson && previousJson.metadata ? previousJson.metadata : {};
  const ctx = (meta._ctx && typeof meta._ctx === 'object' ? meta._ctx : {});
  const lesson = lessonFromSpec({ lessonText: ctx.lessonText || '', level: ctx.level || 1 });
  const currentTriple = { metadata: { _ctx: ctx }, games: triple };
  const result = await fixTriple({
    lesson,
    currentTriple,
    feedback: String(feedbackInstructions || '').trim().slice(0, 1200),
    lang: ctx.lang || 'en',
    variant: ctx.variant || 'normale',
    genderTheme: ctx.genderTheme || 'male',
    subjectName: ctx.subjectName || 'english',
  });
  return packTripleSpec(result.games, result.staticVersions, result.note, {
    title: meta.lesson_title || lesson.title,
    lessonText: ctx.lessonText || '',
    level: ctx.level || 1,
    levelNum: lesson.level,
    school_level: lesson.school_level,
    lang: ctx.lang || 'en',
    variant: ctx.variant || 'normale',
    genderTheme: ctx.genderTheme || 'male',
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

// ---------------------------------------------------------------------------
// WRITTEN EXAM generation (a classic paper-style MCQ quiz).
// One exam per lesson, written entirely in the lesson language, grounded in
// the lesson's OWN text. Strict JSON contract, same safety + grounding rules
// as the games, exported for the teacher's draft â†’ edit â†’ publish flow.
// ---------------------------------------------------------------------------
const EXAM_MAX_QUESTIONS = 6;

function examLangMismatch(questions, lang) {
  const texts = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) texts.push(v.trim()); };
  questions.forEach((q) => {
    if (!q || typeof q !== 'object') return;
    push(q.question);
    (q.options || []).forEach(push);
    push(q.explanation);
  });
  if (!texts.length) return '';
  const joined = texts.join('\n');
  const arabic = (joined.match(/[\u0621-\u064A\u066E-\u06D3\u06D5\u0750-\u077F]/g) || []).length;
  const letters = (joined.match(/\p{L}/gu) || []).length || 1;
  const ratio = arabic / letters;
  if (lang === 'ar' && ratio < 0.5) return 'WRITE THE EXAM QUESTIONS AND OPTIONS IN ARABIC â€” the lesson language is Arabic.';
  if (lang !== 'ar' && ratio > 0.2) return 'WRITE THE EXAM QUESTIONS AND OPTIONS IN THE LESSON LANGUAGE â€” not Arabic.';
  return '';
}

function validateExamJson(raw, targetLang) {
  const errors = [];
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, questions: null, errors: ['response is not valid JSON'] };
  }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') {
    return { ok: false, questions: null, errors: ['response is not a JSON object'] };
  }

  const safety = safetyCheck(obj);
  if (safety) errors.push(`age-appropriateness/safety: ${safety}`);

  const rawList = Array.isArray(obj.questions) ? obj.questions : [];
  if (!rawList.length) errors.push('"questions" must be a non-empty array');
  if (rawList.length > EXAM_MAX_QUESTIONS) errors.push(`too many questions (max ${EXAM_MAX_QUESTIONS})`);

  const questions = [];
  rawList.slice(0, EXAM_MAX_QUESTIONS).forEach((q, i) => {
    if (!q || typeof q !== 'object') { errors.push(`questions[${i}] is not an object`); return; }
    const question = str(q.question, '');
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, '')).filter(Boolean);
    const correctIndex = Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < options.length ? q.correctIndex : -1;
    const explanation = str(q.explanation, '');
    if (!question) errors.push(`questions[${i}]: "question" is required`);
    if (options.length < 3) errors.push(`questions[${i}]: at least 3 options required`);
    if (options.length > 5) errors.push(`questions[${i}]: too many options (max 5)`);
    if (correctIndex === -1) errors.push(`questions[${i}]: "correctIndex" must point to one of the options`);
    if (!question || correctIndex === -1) return;
    questions.push({
      id: str(q.id, `q${i + 1}`),
      question,
      options: options.slice(0, 5),
      correctIndex,
      ...(explanation ? { explanation } : {}),
    });
  });

  if (questions.length < 3) errors.push('a written exam needs at least 3 questions');

  if (!errors.length && (targetLang || 'en')) {
    const mismatch = examLangMismatch(questions, String(targetLang).toLowerCase());
    if (mismatch) errors.push(mismatch);
  }

  if (!errors.length) return { ok: true, questions, errors };
  return { ok: false, questions: null, errors };
}

function buildExamPrompt({ lesson, subjectName, lang, extraInstructions }) {
  const [ageMin, ageMax] = gradeBand(lesson.school_level || 'cp');
  const langName = { en: 'English', fr: 'French', ar: 'Arabic' }[lang] || 'English';
  const rules = [];
  if (extraInstructions) rules.push(extraInstructions);
  return [
    'You are a school teacher writing a WRITTEN EXAM (a classic paper-style multiple-choice quiz) for a lesson.',
    '',
    'STRICT RULES:',
    '- Base EVERY question and EVERY option ONLY on the exact facts, words and vocabulary of the COURSE TEXT below.',
    `- Write the whole exam in ${langName} (the language of the lesson).`,
    '- 4 to 6 questions. Each question has exactly 4 options and exactly one correct option.',
    '- one question per fact/concept; do not repeat the same idea twice.',
    '- Use simple, short, age-appropriate sentences for children aged ' + ageMin + ' to ' + ageMax + '.',
    '- For each question, add a one-line "explanation" in the same language telling the child why the correct option is right.',
    '- No violence, no religion, no politics. Never mention a real name of a child or a teacher.',
    ...(rules.length ? ['', 'TEACHER EXTRA INSTRUCTIONS: ' + rules.join(' ')] : []),
    '',
    'Answer with EXACTLY one JSON object like this and nothing else (no markdown fences):',
    '{ "questions": [ { "question": "...", "options": ["A","B","C","D"], "correctIndex": 0, "explanation": "..." } ] }',
    '',
    'COURSE TEXT:',
    lesson.raw_lesson_text || lesson.title,
  ].join('\n');
}

async function generateExamWithRetries(context) {
  const queue = getModelQueue();
  const MAX_CALLS = Math.min(queue.length * MAX_ATTEMPTS, 8);
  let modelIndex = 0;
  let prompt = buildExamPrompt(context);
  let lastErrors = [];
  let attemptsUsed = 0;

  while (modelIndex < queue.length && attemptsUsed < MAX_CALLS) {
    let text;
    try {
      text = await callModel(prompt, { responseFormat: true, maxTokens: 1600, model: queue[modelIndex] });
    } catch (err) {
      attemptsUsed++;
      lastErrors.push(`api error: ${err.message || 'unknown'}`);
      const msg = err.message || 'unknown';
      if (/401|403|unauthoriz|invalid api key|missing api key|api key required/i.test(msg)) break;
      if (modelIndex < queue.length - 1) { modelIndex++; continue; }
      if (attemptsUsed >= MAX_CALLS) break;
      await sleep(1200);
      modelIndex = 0;
      continue;
    }
    attemptsUsed++;
    const parsed = extractJson(text);
    let validation = validateExamJson(parsed, context.lang);
    if (validation.ok) {
      const grounding = courseGroundingError(parsed, context.lesson);
      if (grounding) validation = { ok: false, questions: null, errors: [grounding] };
    }
    if (validation.ok) return { validation, attempts: attemptsUsed, model: queue[modelIndex] };
    lastErrors = validation.errors;
    prompt = buildExamPrompt(context)
      + `\n\nYour previous response was REJECTED by validation. The issues were:\n- ${lastErrors.join('\n- ')}\n`
      + 'Please return a corrected JSON object only.';
  }
  const err = new Error(`Exam generation failed after ${Math.max(1, attemptsUsed)} attempt(s): ${lastErrors.join('; ')}`);
  err.code = 'GENERATION_FAILED';
  throw err;
}

// Deterministic offline exam so the whole flow works without an OpenRouter key.
function generateExamOffline({ lesson, subjectName, lang, extraInstructions }) {
  const count = 5;
  const questions = [];
  if (subjectName === 'math') {
    const rnd = (seed) => { const x = Math.sin(seed * 9973) * 10000; return Math.floor((x - Math.floor(x)) * 9) + 1; };
    for (let i = 0; i < count; i++) {
      const a = rnd((lesson.id || 1) * 7 + i * 3 + 1);
      const b = rnd((lesson.id || 1) * 13 + i * 5 + 2);
      const isPlus = i % 2 === 0;
      const x = Math.max(a, b);
      const y = Math.min(a, b);
      const result = isPlus ? a + b : x - y;
      const options = [...new Set([result - 1, result + 1, result + 2, result].map((n) => String(Math.max(0, n))))];
      while (options.length < 3) options.push(String(result));
      const shuffled = shuffleArr(options);
      questions.push({
        id: `q${i + 1}`,
        question: isPlus ? `${a} + ${b} = ?` : `${x} - ${y} = ?`,
        options: shuffled,
        correctIndex: shuffled.indexOf(String(result)),
        explanation: 'This is the correct result of the operation.',
      });
    }
  } else {
    const sents = sentences(lesson.raw_lesson_text);
    const source = sents.length ? sents : [`${lesson.title} is a great lesson to learn. Practice makes progress!`];
    const seen = new Set();
    source.slice(0, count).forEach((sent, idx) => {
      const words = sent.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
      if (!words.length) return;
      const correct = words[Math.min(1, words.length - 1)];
      if (seen.has(correct.toLowerCase())) return;
      seen.add(correct.toLowerCase());
      const pool = source.map((s) => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3)).flat();
      const distractors = [...new Set(pool.filter((w) => w.toLowerCase() !== correct.toLowerCase()))];
      const options = [...new Set([correct, ...distractors.slice(0, 3)])].slice(0, 4);
      while (options.length < 4) options.push(options[options.length - 1] + '?');
      const shuffled = shuffleArr(options);
      questions.push({
        id: `q${idx + 1}`,
        question: `Which word belongs to the lesson Â« ${lesson.title} Â»?`,
        options: shuffled,
        correctIndex: shuffled.indexOf(correct),
        explanation: `The word Â« ${correct} Â» is used in this lesson.`,
      });
    });
    while (questions.length < 3) questions.push(questions[0] || null);
  }
  return { questions: questions.filter(Boolean).slice(0, EXAM_MAX_QUESTIONS), note: 'offline demo generator' };
}

async function generateExam({ lesson, subjectName, lang = 'en', extraInstructions }) {
  const context = { lesson, subjectName, lang, extraInstructions };
  if (!getClientModel()) {
    return { ...generateExamOffline(context), source: 'offline' };
  }
  const { validation, attempts, model } = await generateExamWithRetries(context);
  return { questions: validation.questions, source: 'ai', note: `OpenRouter exam Â· ${model || getClientModel()} Â· ${attempts} attempt(s)` };
}

module.exports = {
  TEMPLATES,
  validateGameJson,
  validateTripleJson,
  courseKeywords,
  courseGroundingError,
  deriveStaticVersion,
  generateOffline,
  generateTripleOffline,
  generateOne,
  generateThree,
  fixGame,
  fixTriple,
  safetyCheck,
  generateFromSpec,
  regenerateFromFeedback,
  generateTripleFromSpec,
  regenerateTripleFromFeedback,
  extractTripleGames,
  convertLegacyGame,
  validateExamJson,
  generateExam,
  generateExamOffline,
  hasAi: () => Boolean(process.env.OPENROUTER_API_KEY),
};