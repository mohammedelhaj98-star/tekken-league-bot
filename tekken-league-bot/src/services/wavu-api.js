const DEFAULT_BASE_URL = process.env.WAVU_API_BASE_URL || 'https://wank.wavu.wiki';
const DEFAULT_TIMEOUT_MS = Number(process.env.WAVU_API_TIMEOUT_MS || 8000);
const DEFAULT_CACHE_TTL_MS = Number(process.env.WAVU_API_CACHE_TTL_MS || (30 * 60 * 1000));

function normalizeTekken8Id(raw) {
  const value = String(raw || '').trim().toUpperCase();
  return value;
}

function isValidTekken8Id(raw) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeTekken8Id(raw));
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

class WavuApiService {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, cacheTtlMs = DEFAULT_CACHE_TTL_MS, fetchFn = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.fetchFn = fetchFn;
    this.cache = new Map();
  }

  getCached(key) {
    const row = this.cache.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return row.value;
  }

  setCached(key, value) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  async fetchJson(pathOrUrl) {
    if (typeof this.fetchFn !== 'function') {
      return { ok: false, error: 'Fetch API unavailable in runtime.' };
    }

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'tekken-league-bot/1.0' },
        signal: ac.signal,
      });

      if (res.status === 404) return { ok: false, notFound: true, status: 404 };
      if (res.status === 429) return { ok: false, rateLimited: true, status: 429 };
      if (!res.ok) return { ok: false, status: res.status };

      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        return { ok: false, malformed: true };
      }
    } catch (err) {
      const isAbort = String(err?.name || '').toLowerCase() === 'aborterror';
      return { ok: false, timeout: isAbort, error: String(err?.message || err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeWavuPayload(payload, tekken8Id) {
    const root = payload?.data || payload?.player || payload?.profile || payload;
    if (!root || typeof root !== 'object') return null;

    const playerId = root.player_id || root.id || root.profile_id || root.uuid || null;
    const tekkenName = root.name || root.tekken_name || root.player_name || root.nickname || null;
    const platform = root.platform || root.system || null;

    const rankTierRaw = root.rank_tier ?? root.rank_score ?? root.rank ?? root.highest_rank_score ?? null;
    const recentWinRateRaw = root.recent_win_rate ?? root.win_rate ?? root.ranked_win_rate ?? null;
    const recentMatchesRaw = root.recent_matches ?? root.ranked_matches ?? root.matches_last_30d ?? root.match_count ?? 0;

    const rankTier = clamp(rankTierRaw == null ? 50 : Number(rankTierRaw));
    const recentWinRate = clamp(recentWinRateRaw == null ? 50 : Number(recentWinRateRaw));
    const recentMatches = Math.max(0, Math.trunc(Number(recentMatchesRaw) || 0));
    const recentActivity = clamp(Math.min(recentMatches, 30) / 30, 0, 1);

    return {
      wavuPlayerId: playerId ? String(playerId) : null,
      tekken8Id,
      tekkenName: tekkenName ? String(tekkenName) : null,
      tekkenPlatform: platform ? String(platform) : null,
      rankedTierScore: rankTier,
      rankedRecentWinRate: recentWinRate,
      rankedRecentMatches: recentMatches,
      rankedRecentActivity: recentActivity,
      rankedSource: 'wavu',
      raw: root,
    };
  }

  async lookupByTekken8Id(rawTekken8Id) {
    const tekken8Id = normalizeTekken8Id(rawTekken8Id);
    const cacheKey = `id:${tekken8Id}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const endpointCandidates = [
      `/api/players/${encodeURIComponent(tekken8Id)}`,
      `/api/player/${encodeURIComponent(tekken8Id)}`,
      `/api/profile/${encodeURIComponent(tekken8Id)}`,
      `/players/${encodeURIComponent(tekken8Id)}?_format=json`,
      `/player/${encodeURIComponent(tekken8Id)}?_format=json`,
      `/api/search?query=${encodeURIComponent(tekken8Id)}`,
    ];

    let lastError = null;
    for (const endpoint of endpointCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.fetchJson(endpoint);
      if (!result.ok) {
        lastError = result;
        continue;
      }

      const normalized = this.normalizeWavuPayload(result.data, tekken8Id);
      if (normalized) {
        const okResult = { ok: true, linked: true, value: normalized };
        this.setCached(cacheKey, okResult);
        return okResult;
      }
    }

    return {
      ok: false,
      linked: false,
      notFound: !!lastError?.notFound,
      rateLimited: !!lastError?.rateLimited,
      timeout: !!lastError?.timeout,
      error: lastError?.error || null,
    };
  }
}

module.exports = {
  WavuApiService,
  normalizeTekken8Id,
  isValidTekken8Id,
};
