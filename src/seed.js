'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, run, get, transaction } = require('./db');
const { deriveStaticVersion } = require('./services/ai');

const hash = (p) => bcrypt.hashSync(p, 10);
const now = () => new Date().toISOString();

function ensureSubject(name) {
  const existing = get('SELECT * FROM subjects WHERE name = ?', name);
  if (existing) return existing.id;
  return run('INSERT INTO subjects (name) VALUES (?)', name).lastInsertRowid;
}

function ensureUser(role, email, password, language) {
  let u = get('SELECT * FROM users WHERE email = ?', email);
  if (!u) {
    const info = run('INSERT INTO users (role, email, password_hash, language, created_at) VALUES (?, ?, ?, ?, ?)', role, email, hash(password), language, now());
    u = get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid);
  }
  return u;
}

function ensureChild(parentId, loginId, password, displayName, age, gender, profileType, language) {
  let c = get('SELECT * FROM children WHERE child_login_id = ?', loginId);
  if (!c) {
    const info = run(
      'INSERT INTO children (parent_id, child_login_id, password_hash, display_name, age, gender, profile_type, language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      parentId, loginId, hash(password), displayName, age, gender, profileType, language, now(),
    );
    c = get('SELECT * FROM children WHERE id = ?', info.lastInsertRowid);
  }
  return c;
}

function getOrCreateLesson(teacherId, subjectId, title, content, level, target, orderIndex) {
  let l = get('SELECT * FROM lessons WHERE teacher_id = ? AND subject_id = ? AND title = ?', teacherId, subjectId, title);
  if (!l) {
    const info = run(
      'INSERT INTO lessons (subject_id, teacher_id, title, raw_lesson_text, level, target_score, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      subjectId, teacherId, title, content, level, target, orderIndex, now(),
    );
    l = get('SELECT * FROM lessons WHERE id = ?', info.lastInsertRowid);
  }
  return l;
}

function main() {
  transaction(() => {
    const already = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if (already.n > 0) {
      console.log('Bewize is already seeded. Remove data/bewize.db to re-seed from scratch.');
      return;
    }

    // ---- subjects ----------------------------------------------------------
    const subjects = {};
    for (const name of ['arabic', 'french', 'english', 'math']) subjects[name] = ensureSubject(name);

    // ---- users ------------------------------------------------------------
    const admin = ensureUser('admin', 'admin@bewize.test', 'admin123', 'en');
    const teacher1 = ensureUser('teacher', 'teacher@bewize.test', 'teacher123', 'en');
    const teacher2 = ensureUser('teacher', 'teacher2@bewize.test', 'teacher123', 'fr');
    const parent1 = ensureUser('parent', 'parent@home.test', 'parent123', 'en');
    const parent2 = ensureUser('parent', 'parent2@home.test', 'parent123', 'fr');

    // ---- children ---------------------------------------------------------
    ensureChild(parent1.id, 'omar', 'omar123', 'Omar', 7, 'male', 'standard', 'ar');
    ensureChild(parent1.id, 'sara', 'sara123', 'Sara', 9, 'female', 'standard', 'en');
    ensureChild(parent2.id, 'max', 'max123', 'Max', 8, 'male', 'special_needs', 'fr');

    // ---- lessons ----------------------------------------------------------
    const l1 = getOrCreateLesson(teacher1.id, subjects.math, 'Numbers and Counting 1–10', [
      'Numbers 1 to 10: one, two, three, four, five, six, seven, eight, nine, ten.',
      'Counting tells us how many things there are.',
      'We can count stars, fingers, toys, and steps.',
      'Now let us practise counting with the number game.',
    ].join(' '), 1, 50, 1);

    const l2 = getOrCreateLesson(teacher1.id, subjects.math, 'Shapes around us', [
      'Shapes are everywhere: a circle is round like a ball.',
      'A square has 4 equal sides. A triangle has 3 sides.',
      'A rectangle has 2 long sides and 2 short sides.',
      'Find shapes all around you before playing the game.',
    ].join(' '), 1, 60, 2);

    getOrCreateLesson(teacher1.id, subjects.english, 'Animals and their babies', [
      'A dog has puppies, a cat has kittens, and a cow has calves.',
      'A hen has chicks. Many animal babies look like tiny versions of their parents.',
      'Learn the names of baby animals and play the match game.',
    ].join(' '), 1, 60, 1);

    getOrCreateLesson(teacher2.id, subjects.arabic, 'أيام الأسبوع', [
      'أيام الأسبوع سبعة أيام: السبت، الأحد، الاثنين، الثلاثاء، الأربعاء، الخميس، الجمعة.',
      'نبدأ الأسبوع يوم السبت وننهيه يوم الجمعة.',
      'مقال عن أيام الأسبوع مع لعبة ترتيب الكلمات.',
    ].join(' '), 1, 60, 1);

    getOrCreateLesson(teacher2.id, subjects.french, 'Les couleurs', [
      'Les couleurs : rouge, bleu, vert, jaune, orange, violet, noir et blanc.',
      'Le ciel est bleu, la pomme est rouge et l’herbe est verte.',
      'Retrouve les couleurs que tu connais dans le jeu de vocabulaire.',
    ].join(' '), 2, 60, 1);

    // ---- pre-approved games for lesson 1 (playable immediately) -----------
    const mathLessonId = l1.id;
    const numberQuiz = {
      type: 'quiz',
      instructions: 'Look at each sentence, read it slowly, and tap the right answer!',
      items: [
        { points: 10, question: 'How many legs does a dog have?', options: ['3', '4', '2'], correctIndex: 1, feedback: 'A dog has four legs.' },
        { points: 10, question: 'How many days are there in one week?', options: ['5', '7', '6'], correctIndex: 1, feedback: 'There are seven days in a week.' },
        { points: 10, question: 'How many wheels does a bicycle have?', options: ['2', '4', '1'], correctIndex: 0, feedback: 'A bicycle has two wheels.' },
        { points: 10, question: 'Add: 2 + 2 = ?', options: ['3', '4', '5'], correctIndex: 1, feedback: '2 + 2 = 4.' },
        { points: 10, question: 'Which number is bigger: 7 or 4?', options: ['4', '7'], correctIndex: 1, feedback: '7 is bigger than 4.' },
        { points: 10, question: 'How many fingers are on two hands?', options: ['8', '10', '12'], correctIndex: 1, feedback: 'Each hand has 5 fingers, so two hands have 10.' },
      ],
      theme: 'Space',
    };
    const simpleQuiz = {
      type: 'quiz',
      instructions: 'Read and choose the right answer. You can do it!',
      items: [
        { points: 10, question: 'How many legs does a dog have?', options: ['4', '2'], correctIndex: 0, feedback: 'Yes, four legs.' },
        { points: 10, question: 'How many days in a week?', options: ['7', '5'], correctIndex: 0, feedback: 'Seven days.' },
        { points: 10, question: 'Add: 2 + 2 = ?', options: ['4', '3'], correctIndex: 0, feedback: '2 + 2 = 4.' },
      ],
      theme: 'Animals',
    };
    const seedGames = [
      ['standard', 'male', numberQuiz],
      ['standard', 'female', numberQuiz],
      ['standard', 'neutral', numberQuiz],
      ['special_needs', 'male', simpleQuiz],
    ];
    for (const [variant, genderTheme, gameJson] of seedGames) {
      const ex = get("SELECT * FROM games WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND status = 'approved'", mathLessonId, variant, genderTheme);
      if (!ex) {
        run(
          `INSERT INTO games (lesson_id, variant, gender_theme, status, template_type, game_json, static_version_json, notes, created_at, approved_at, approved_by)
           VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
          mathLessonId, variant, genderTheme, gameJson.type,
          JSON.stringify(gameJson), JSON.stringify(deriveStaticVersion(gameJson)),
          'seeded demo game', now(), now(), teacher1.id,
        );
      }
    }

    console.log('√ Bewize seeded.');
    console.log('  Admin : admin@bewize.test / admin123');
    console.log('  Teacher: teacher@bewize.test / teacher123  (fr: teacher2@bewize.test / teacher123)');
    console.log('  Parent : parent@home.test / parent123       (fr: parent2@home.test / parent123)');
    console.log('  Kids   : omar / omar123 · sara / sara123 · max / max123');
  });
}

main();