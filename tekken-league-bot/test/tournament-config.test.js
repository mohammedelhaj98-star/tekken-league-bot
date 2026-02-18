const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTimeSlotStarts, parseTournamentStartDate, validateTournamentSetupInput } = require('../src/tournament-config');

test('parseTimeSlotStarts normalizes valid times', () => {
  const parsed = parseTimeSlotStarts('8:00, 20:30,00:05');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.times, ['08:00', '20:30', '00:05']);
});

test('parseTimeSlotStarts rejects invalid format and duplicates', () => {
  assert.equal(parseTimeSlotStarts('25:00').ok, false);
  assert.equal(parseTimeSlotStarts('18:00,18:00').ok, false);
});

test('validateTournamentSetupInput maps percent and validates counts', () => {
  const ok = validateTournamentSetupInput({
    maxPlayers: 64,
    timeslotCount: 2,
    timeslotDurationMinutes: 90,
    timeSlotStartsRaw: '18:00,20:00',
    totalTournamentDays: 20,
    minimumShowupPercent: 75,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.eligibility_min_percent, 0.75);
  assert.equal(ok.values.timeslot_starts, '18:00,20:00');

  const bad = validateTournamentSetupInput({ timeslotCount: 2, timeSlotStartsRaw: '18:00' });
  assert.equal(bad.ok, false);
});

test('parseTournamentStartDate validates and normalizes YYYY-MM-DD', () => {
  const ok = parseTournamentStartDate('2026-03-01');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '2026-03-01');

  assert.equal(parseTournamentStartDate('2026-13-01').ok, false);
  assert.equal(parseTournamentStartDate('01-03-2026').ok, false);
});

test('validateTournamentSetupInput supports clearing timeslots and setting start date', () => {
  const ok = validateTournamentSetupInput({
    clearTimeslotStarts: true,
    tournamentStartDateRaw: '2026-03-01',
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.values.timeslot_starts, '');
  assert.equal(ok.values.tournament_start_date, '2026-03-01');
});
