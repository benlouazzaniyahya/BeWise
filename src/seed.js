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

function ensureChild(parentId, loginId, password, displayName, age, gender, profileType, language, schoolLevel) {
  let c = get('SELECT * FROM children WHERE child_login_id = ?', loginId);
  if (!c) {
    const info = run(
      'INSERT INTO children (parent_id, child_login_id, password_hash, display_name, age, gender, profile_type, language, school_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      parentId, loginId, hash(password), displayName, age, gender, profileType, language, schoolLevel, now(),
    );
    c = get('SELECT * FROM children WHERE id = ?', info.lastInsertRowid);
  } else if (c.school_level !== schoolLevel) {
    run('UPDATE children SET school_level = ? WHERE id = ?', schoolLevel, c.id);
    c = get('SELECT * FROM children WHERE id = ?', c.id);
  }
  return c;
}

function getOrCreateLesson(teacherId, subjectId, title, content, level, target, orderIndex, schoolLevel) {
  let l = get('SELECT * FROM lessons WHERE teacher_id = ? AND subject_id = ? AND title = ?', teacherId, subjectId, title);
  if (!l) {
    const info = run(
      'INSERT INTO lessons (subject_id, teacher_id, title, raw_lesson_text, level, target_score, order_index, school_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      subjectId, teacherId, title, content, level, target, orderIndex, schoolLevel, now(),
    );
    l = get('SELECT * FROM lessons WHERE id = ?', info.lastInsertRowid);
  } else if (l.school_level !== schoolLevel) {
    run('UPDATE lessons SET school_level = ?, level = ? WHERE id = ?', schoolLevel, level, l.id);
    l = get('SELECT * FROM lessons WHERE id = ?', l.id);
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
    // Age is an independent column: Omar (8) is still in CP — children start
    // school at different ages, so the class is chosen directly by the parent.
    ensureChild(parent1.id, 'omar', 'omar123', 'Omar', 8, 'male', 'normale', 'ar', 'cp');
    ensureChild(parent1.id, 'sara', 'sara123', 'Sara', 9, 'female', 'normale', 'en', 'cm1');
    ensureChild(parent2.id, 'max', 'max123', 'Max', 8, 'male', 'autisme', 'fr', 'ce1');

    // ---- lessons ----------------------------------------------------------
    // Each class has its OWN levels, decided by the teacher (per subject).
    // e.g. CP maths = 2 levels (Counting L1, Shapes L2); CM1 English = 2 levels.
    const l1 = getOrCreateLesson(teacher1.id, subjects.math, 'Numbers and Counting 1–10', [
      'Numbers 1 to 10: one, two, three, four, five, six, seven, eight, nine, ten.',
      'Counting tells us how many things there are.',
      'We can count stars, fingers, toys, and steps.',
      'Now let us practise counting with the number game.',
    ].join(' '), 1, 50, 1, 'cp');

    const l2 = getOrCreateLesson(teacher1.id, subjects.math, 'Shapes around us', [
      'Shapes are everywhere: a circle is round like a ball.',
      'A square has 4 equal sides. A triangle has 3 sides.',
      'A rectangle has 2 long sides and 2 short sides.',
      'Find shapes all around you before playing the game.',
    ].join(' '), 2, 60, 2, 'cp');

    getOrCreateLesson(teacher1.id, subjects.english, 'Animals and their babies', [
      'A dog has puppies, a cat has kittens, and a cow has calves.',
      'A hen has chicks. Many animal babies look like tiny versions of their parents.',
      'Learn the names of baby animals and play the match game.',
    ].join(' '), 1, 60, 1, 'cp');

    getOrCreateLesson(teacher2.id, subjects.arabic, 'أيام الأسبوع', [
      'أيام الأسبوع سبعة أيام: السبت، الأحد، الاثنين، الثلاثاء، الأربعاء، الخميس، الجمعة.',
      'نبدأ الأسبوع يوم السبت وننهيه يوم الجمعة.',
      'مقال عن أيام الأسبوع مع لعبة ترتيب الكلمات.',
    ].join(' '), 1, 60, 1, 'cp');

    getOrCreateLesson(teacher2.id, subjects.french, 'Les couleurs', [
      'Les couleurs : rouge, bleu, vert, jaune, orange, violet, noir et blanc.',
      'Le ciel est bleu, la pomme est rouge et l’herbe est verte.',
      'Retrouve les couleurs que tu connais dans le jeu de vocabulaire.',
    ].join(' '), 1, 60, 1, 'ce1');

    getOrCreateLesson(teacher1.id, subjects.english, 'Plural nouns: one apple, two apples', [
      'We say one apple but two apples. Add -s (or -es) to make plurals: cat → cats, box → boxes.',
      'Some plurals change: one child, two children; one foot, two feet.',
      'Look at the words and choose their plural form in the game.',
    ].join(' '), 1, 60, 1, 'ce2');

    getOrCreateLesson(teacher1.id, subjects.english, 'Opposites: hot and cold, big and small', [
      'Opposites are words with different meanings: hot ↔ cold, big ↔ small, up ↔ down.',
      'Day is the opposite of night, and happy is the opposite of sad.',
      'Match every word with its opposite in the game.',
    ].join(' '), 2, 60, 2, 'ce2');

    const lReading = getOrCreateLesson(teacher1.id, subjects.english, 'Reading: My school day', [
      "Every day I get up at seven o'clock. I wash my face, eat breakfast and put on my school bag.",
      'My school starts at eight. We read, we count and we play.',
      'At noon I eat lunch with my friends. After school I do my homework, then I play outside.',
      'Read the text and answer the questions in the game.',
    ].join(' '), 1, 60, 1, 'cm1');

    getOrCreateLesson(teacher1.id, subjects.english, 'Grammar: yesterday, last week (past simple)', [
      'To speak about the past we often add -ed: walk → walked, play → played.',
      'Some verbs change: go → went, come → came, see → saw.',
      'Yesterday I walked to school and I saw my friends.',
      'Choose the correct past form in the game.',
    ].join(' '), 2, 60, 2, 'cm1');

    getOrCreateLesson(teacher1.id, subjects.math, 'Multiplying by 10, 100 and 1000', [
      'When you multiply by 10, the number grows 10 times bigger: 25 × 10 = 250.',
      'By 100: 25 × 100 = 2500. By 1000: 25 × 1000 = 25000.',
      'The digits move to the left and we add zeroes.',
      'Practise with the multiplication game.',
    ].join(' '), 1, 60, 1, 'cm2');

    getOrCreateLesson(teacher1.id, subjects.math, 'Solving simple equations', [
      'An equation is a balance: x + 3 = 10 means x is the number that makes both sides equal.',
      'x = 7 because 7 + 3 = 10. Find the unknown and keep the balance.',
      'Solve each equation step by step in the game.',
    ].join(' '), 1, 60, 1, 'sixieme');

    getOrCreateLesson(teacher1.id, subjects.math, 'Two-step equations', [
      'Some equations need two steps: 2x + 3 = 11. First remove 3: 2x = 8.',
      'Then divide by 2: x = 4. Check: 2 × 4 + 3 = 11. Correct!',
      'Practise balancing equations of two steps in the game.',
    ].join(' '), 2, 60, 2, 'sixieme');

    // ---- pre-approved games for lesson 1 (playable immediately) -----------
    const mathLessonId = l1.id;
    const numberQuest = {
      template: 'airplane',
      title: 'Counting Challenge',
      theme: 'Space',
      instructions: 'Look at each question, read it slowly, and tap the right answer!',
      intro: 'Fly the plane and answer every question to land safely!',
      questions: [
        { id: 'q1', question: 'How many legs does a dog have?', correct_answer: '4', distractors: ['3', '2'] },
        { id: 'q2', question: 'How many days are there in one week?', correct_answer: '7', distractors: ['5', '6'] },
        { id: 'q3', question: 'How many wheels does a bicycle have?', correct_answer: '2', distractors: ['4', '1'] },
        { id: 'q4', question: 'Add: 2 + 2 = ?', correct_answer: '4', distractors: ['3', '5'] },
      ],
    };
    const simpleQuest = {
      template: 'airplane',
      title: 'Easy Counting',
      theme: 'Animals',
      instructions: 'Read and choose the right answer. You can do it!',
      intro: 'Answer each question to fly the plane!',
      questions: [
        { id: 'q1', question: 'How many legs does a dog have?', correct_answer: '4', distractors: ['2', '3'] },
        { id: 'q2', question: 'How many days in a week?', correct_answer: '7', distractors: ['5'] },
        { id: 'q3', question: 'Add: 2 + 2 = ?', correct_answer: '4', distractors: ['3'] },
      ],
    };
    const seedGames = [
      ['normale', 'male', numberQuest],
      ['normale', 'female', numberQuest],
      ['autisme', 'female', simpleQuest],
      ['autisme', 'male', simpleQuest],
    ];
    for (const [variant, genderTheme, gameJson] of seedGames) {
      const ex = get("SELECT * FROM games WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND status = 'approved'", mathLessonId, variant, genderTheme);
      if (!ex) {
        run(
          `INSERT INTO games (lesson_id, variant, gender_theme, status, template_type, game_json, static_version_json, notes, created_at, approved_at, approved_by)
           VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
          mathLessonId, variant, genderTheme, gameJson.template,
          JSON.stringify(gameJson), JSON.stringify(deriveStaticVersion(gameJson)),
          'seeded demo game', now(), now(), teacher1.id,
        );
      }
    }

    // ---- pre-approved game for the CM1 reading lesson (sara can play) -----
    const readingMission = {
      template: 'airplane',
      title: 'My School Day',
      theme: 'School',
      instructions: 'Read each question and answer to fly the plane!',
      intro: 'Every day the child wakes up, packs a bag and goes to school. Help the day unfold!',
      questions: [
        { id: 'q1', question: 'What time does the child get up?', correct_answer: "At seven o'clock", distractors: ['At noon', 'After school'] },
        { id: 'q2', question: 'When does school start?', correct_answer: 'At eight', distractors: ['At ten', 'At six'] },
        { id: 'q3', question: 'What do they do at school?', correct_answer: 'Read, count and play', distractors: ['Fly', 'Sleep'] },
        { id: 'q4', question: 'When does the child do homework?', correct_answer: 'After school', distractors: ['Before breakfast', 'At midnight'] },
      ],
    };
    for (const readGender of ['male', 'female']) {
      const readEx = get("SELECT * FROM games WHERE lesson_id = ? AND variant = 'normale' AND gender_theme = ? AND status = 'approved'", lReading.id, readGender);
      if (!readEx) {
        run(
          `INSERT INTO games (lesson_id, variant, gender_theme, status, template_type, game_json, static_version_json, notes, created_at, approved_at, approved_by)
           VALUES (?, 'normale', ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
          lReading.id, readGender, readingMission.template,
          JSON.stringify(readingMission), JSON.stringify(deriveStaticVersion(readingMission)),
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