'use strict';
// Smoke test: exercise the offline triple-pack pipeline end to end without
// any network calls. Asserts that:
//   1. generateTripleFromSpec returns 3 normalized games
//   2. The result plays through validateTripleJson cleanly
//   3. Inserting into the real DB succeeds for all three rows under one combo
//   4. The unique (lesson, variant, gender_theme, template_type) index allows
//      all three rows to coexist (was impossible before the migration).
//
// Run with: node src/smokeTriple.js

const path = require('node:path');
const ai = require('./services/ai');
const db = require('./db');
const { Game, Lesson } = require('./models');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('OK  :', msg);
}

(async () => {
  const lessonText = [
    'Insects',
    'Insects are small animals with six legs.',
    'Bees, butterflies and ants are common insects.',
    'Spiders have eight legs and are not insects.',
    'Many insects can fly and pollinate flowers.',
  ].join('\n');
  const out = await ai.generateTripleFromSpec({
    lessonText,
    level: 'cp',
    lang: 'en',
    variant: 'normale',
    genderTheme: 'neutral',
    subjectName: 'english',
  });

  assert(out && out.games, 'generateTripleFromSpec returns games');
  assert(out.games.airplane, 'airplane present');
  assert(out.games.whack_a_mole, 'whack_a_mole present');
  assert(out.games.flying_fruit, 'flying_fruit present');
  assert(Array.isArray(out.games.airplane.questions), 'airplane has questions');
  assert(out.games.airplane.questions.length >= 2, 'airplane has at least 2 questions');
  assert(Array.isArray(out.games.whack_a_mole.targets), 'whack_a_mole has targets');
  assert(out.games.whack_a_mole.targets.filter((t) => t.is_correct).length >= 2, 'whack_a_mole has correct targets');
  assert(Array.isArray(out.games.flying_fruit.items), 'flying_fruit has items');
  assert(out.games.flying_fruit.items.length >= 2, 'flying_fruit has items');

  // Round-trip through the spec API
  const tri = ai.extractTripleGames(out);
  assert(tri, 'extractTripleGames finds all three');

  // Validate that the canonical shape survives the same validator the JSON API uses.
  const v = ai.validateTripleJson(out);
  assert(v.ok, 'validateTripleJson roundtrip: ok');

  // DB persistence: insert a one-off subject + lesson via raw SQL (subjects
  // table is read-only in the public API), then push 3 rows for one combo
  // and verify all three land and are independently addressable.
  const subjectName = '__smoke_' + Date.now();
  db.run('INSERT INTO subjects (name) VALUES (?)', subjectName);
  const subjectRow = db.get('SELECT id FROM subjects WHERE name = ?', subjectName);
  const lessonId = Lesson.create({
    subjectId: subjectRow.id,
    teacherId: 1,
    title: 'Smoke lesson',
    rawLessonText: lessonText,
    level: 1,
    targetScore: 60,
    orderIndex: 0,
    schoolLevel: 'cp',
    created_at: new Date().toISOString(),
  });
  console.log('OK  : lesson created id=' + lessonId);

  // Lesson.create returns the rowid directly, not a wrapper.
  const lessonRow = { id: lessonId };

  const ids = [];
  for (const tpl of ai.TEMPLATES) {
    const game = out.games[tpl];
    const id = Game.create({
      lessonId: lessonRow.id,
      variant: 'normale',
      genderTheme: 'neutral',
      templateType: tpl,
      gameJson: JSON.stringify(game),
      staticVersionJson: JSON.stringify(out.staticVersions[tpl]),
      notes: 'smoke',
    });
    ids.push(id);
  }
  assert(ids.length === 3, 'three game rows inserted for one combo');
  for (const tpl of ai.TEMPLATES) {
    const rows = Game.listByLesson(lessonRow.id).filter(
      (g) => g.variant === 'normale' && g.gender_theme === 'neutral' && g.template_type === tpl,
    );
    assert(rows.length === 1, `${tpl} row present and unique per combo`);
  }

  // Cleanup
  db.run('DELETE FROM games WHERE lesson_id = ?', lessonRow.id);
  db.run('DELETE FROM lessons WHERE id = ?', lessonRow.id);
  db.run('DELETE FROM subjects WHERE id = ?', subjectRow.id);
  console.log('OK  : smoke test cleaned up');
})();
