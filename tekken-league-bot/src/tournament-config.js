function parseTimeSlotStarts(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Time slot starts cannot be empty.' };

  const parts = text.split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'Provide at least one time slot start.' };

  const seen = new Set();
  const normalized = [];
  for (const p of parts) {
    const m = p.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) return { ok: false, error: `Invalid time format: ${p}. Use HH:MM (24h).` };
    const hh = m[1].padStart(2, '0');
    const mm = m[2];
    const t = `${hh}:${mm}`;
    if (seen.has(t)) return { ok: false, error: `Duplicate time slot start found: ${t}.` };
    seen.add(t);
    normalized.push(t);
  }

  return { ok: true, times: normalized };
}

function parseTournamentStartDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Tournament start date cannot be empty.' };
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: 'Tournament start date must be in YYYY-MM-DD format.' };

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(dt.getTime())
    || dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month - 1
    || dt.getUTCDate() !== day
  ) {
    return { ok: false, error: 'Tournament start date is invalid.' };
  }

  return { ok: true, value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function validateTournamentSetupInput(input) {
  const out = {};

  if (input.maxPlayers !== undefined && input.maxPlayers !== null) {
    if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 2 || input.maxPlayers > 1024) {
      return { ok: false, error: 'No. of players must be an integer between 2 and 1024.' };
    }
    out.max_players = input.maxPlayers;
  }

  if (input.timeslotCount !== undefined && input.timeslotCount !== null) {
    if (!Number.isInteger(input.timeslotCount) || input.timeslotCount < 1 || input.timeslotCount > 24) {
      return { ok: false, error: 'No. of timeslots must be an integer between 1 and 24.' };
    }
    out.timeslot_count = input.timeslotCount;
  }

  if (input.timeslotDurationMinutes !== undefined && input.timeslotDurationMinutes !== null) {
    if (!Number.isInteger(input.timeslotDurationMinutes) || input.timeslotDurationMinutes < 15 || input.timeslotDurationMinutes > 1440) {
      return { ok: false, error: 'Timeslot duration must be an integer between 15 and 1440 minutes.' };
    }
    out.timeslot_duration_minutes = input.timeslotDurationMinutes;
  }

  if (input.totalTournamentDays !== undefined && input.totalTournamentDays !== null) {
    if (!Number.isInteger(input.totalTournamentDays) || input.totalTournamentDays < 1 || input.totalTournamentDays > 365) {
      return { ok: false, error: 'Total tournament days must be an integer between 1 and 365.' };
    }
    out.season_days = input.totalTournamentDays;
  }

  if (input.minimumShowupPercent !== undefined && input.minimumShowupPercent !== null) {
    if (typeof input.minimumShowupPercent !== 'number' || Number.isNaN(input.minimumShowupPercent) || input.minimumShowupPercent < 0 || input.minimumShowupPercent > 100) {
      return { ok: false, error: 'Minimum show up % must be a number between 0 and 100.' };
    }
    out.eligibility_min_percent = Number((input.minimumShowupPercent / 100).toFixed(4));
  }

  if (input.timeSlotStartsRaw !== undefined && input.timeSlotStartsRaw !== null) {
    const parsed = parseTimeSlotStarts(input.timeSlotStartsRaw);
    if (!parsed.ok) return parsed;
    out.timeslot_starts = parsed.times.join(',');
  }

  if (input.clearTimeslotStarts === true) {
    out.timeslot_starts = '';
  }

  if (input.tournamentStartDateRaw !== undefined && input.tournamentStartDateRaw !== null) {
    const parsedDate = parseTournamentStartDate(input.tournamentStartDateRaw);
    if (!parsedDate.ok) return parsedDate;
    out.tournament_start_date = parsedDate.value;
  }

  if (out.timeslot_count && out.timeslot_starts) {
    const startsCount = out.timeslot_starts.split(',').length;
    if (startsCount !== out.timeslot_count) {
      return { ok: false, error: `No. of timeslots (${out.timeslot_count}) must match start times count (${startsCount}).` };
    }
  }

  return { ok: true, values: out };
}

module.exports = {
  parseTimeSlotStarts,
  parseTournamentStartDate,
  validateTournamentSetupInput,
};
