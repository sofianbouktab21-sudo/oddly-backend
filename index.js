const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const sportApi = axios.create({
  baseURL: `https://${process.env.RAPIDAPI_HOST}/api/v1`,
  headers: {
    'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
    'X-RapidAPI-Host': process.env.RAPIDAPI_HOST
  }
});

const footballApi = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══ CACHE ══
const cache = new Map();
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > item.ttl) { cache.delete(key); return null; }
  return item.data;
}
function setCache(key, data, ttl = 3600000) {
  cache.set(key, { data, time: Date.now(), ttl });
}

// ══ MOTEUR ══
function poisson(k, lambda) {
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function calculPoisson(lA, lB) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lA) * poisson(j, lB);
      if (i > j) h += p;
      else if (i === j) d += p;
      else a += p;
    }
  }
  return { home: h, draw: d, away: a };
}

function poissonRandom(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function monteCarlo(lA, lB, n = 10000) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i < n; i++) {
    const ga = poissonRandom(lA), gb = poissonRandom(lB);
    if (ga > gb) h++;
    else if (ga === gb) d++;
    else a++;
  }
  return {
    home: +(h/n*100).toFixed(1),
    draw: +(d/n*100).toFixed(1),
    away: +(a/n*100).toFixed(1)
  };
}

function ev(prob, cote) { return +((prob * cote) - 1).toFixed(3); }
function kelly(prob, cote) { return +(((prob * cote - 1) / (cote - 1)) * 0.5).toFixed(3); }

function detecterBiais(impliedHome, probReelle) {
  const diff = impliedHome - probReelle;
  if (diff > 0.25) return { signal: '🔄 REVERSE FORT', force: 'FORT', desc: 'La foule surestime massivement — valeur de l\'autre côté' };
  if (diff > 0.12) return { signal: '⚠️ REVERSE MODÉRÉ', force: 'MODERE', desc: 'Légère surestimation détectée' };
  if (diff < -0.15) return { signal: '✅ FOULE A RAISON', force: 'CONFIRME', desc: 'Le biais confirme notre signal' };
  return { signal: '➡️ NEUTRE', force: 'FAIBLE', desc: 'Pas de biais significatif' };
}

function getPariConseille(probs, cotes, mc) {
  if (!cotes.home || !cotes.draw || !cotes.away) {
    return {
      pari: '⚠️ Cotes indisponibles',
      cote: null, ev: 0, evPct: '0%',
      kelly: null, mise: '0% de la bankroll',
      confiance: 50, force: '❌ PAS DE VALEUR',
      explication: 'Cotes bookmaker non disponibles pour ce match.'
    };
  }
  const evH = ev(probs.home, cotes.home);
  const evD = ev(probs.draw, cotes.draw);
  const evA = ev(probs.away, cotes.away);
  const maxEV = Math.max(evH, evD, evA);
  const pariKey = evH === maxEV ? 'home' : evD === maxEV ? 'draw' : 'away';
  const labels = { home: '🏠 DOMICILE GAGNE', draw: '🤝 MATCH NUL', away: '✈️ EXTÉRIEUR GAGNE' };
  const cotePari = pariKey === 'home' ? cotes.home : pariKey === 'draw' ? cotes.draw : cotes.away;
  const probPari = pariKey === 'home' ? probs.home : pariKey === 'draw' ? probs.draw : probs.away;
  const kellyVal = kelly(probPari, cotePari);
  const misePct = Math.max(0, Math.min(10, +(kellyVal * 100).toFixed(1)));
  const confiance = Math.min(95, Math.round(50 + (maxEV * 150) + (probPari * 20)));
  const force = maxEV > 0.15 ? '🔥 SIGNAL FORT' : maxEV > 0.05 ? '⚡ SIGNAL MODÉRÉ' : '❌ PAS DE VALEUR';
  const explication = maxEV > 0.1
    ? `Notre modèle calcule ${(probPari*100).toFixed(1)}% de chances réelles contre ${(100/cotePari).toFixed(1)}% implicites. EV +${(maxEV*100).toFixed(1)}% — valeur détectée.`
    : maxEV > 0
    ? `Légère valeur détectée. Probabilité réelle légèrement supérieure aux cotes.`
    : `Pas de valeur sur ce match. On passe.`;
  return {
    pari: labels[pariKey], cote: cotePari, ev: maxEV,
    evPct: `${maxEV > 0 ? '+' : ''}${(maxEV*100).toFixed(1)}%`,
    kelly: kellyVal, mise: `${misePct}% de la bankroll`,
    confiance, force, explication
  };
}

function getLambda(fixtures, teamId) {
  const fin = fixtures.filter(f => f.fixture?.status?.short === 'FT');
  if (fin.length === 0) return 1.2;
  let total = 0;
  fin.slice(0, 5).forEach(f => {
    const isHome = f.teams?.home?.id === teamId;
    total += isHome ? (f.goals?.home || 0) : (f.goals?.away || 0);
  });
  return Math.max(0.4, +(total / Math.min(fin.length, 5)).toFixed(2));
}

function getForme(fixtures, teamId) {
  const fin = fixtures.filter(f => f.fixture?.status?.short === 'FT').slice(0, 5);
  if (fin.length === 0) return '? ? ? ? ?';
  return fin.map(f => {
    const isHome = f.teams?.home?.id === teamId;
    const gH = f.goals?.home || 0, gA = f.goals?.away || 0;
    if (isHome) return gH > gA ? 'V' : gH === gA ? 'N' : 'D';
    return gA > gH ? 'V' : gA === gH ? 'N' : 'D';
  }).join(' ');
}

function getDerniers(fixtures, teamId) {
  return fixtures.filter(f => f.fixture?.status?.short === 'FT').slice(0, 5).map(f => {
    const isHome = f.teams?.home?.id === teamId;
    const gH = f.goals?.home || 0, gA = f.goals?.away || 0;
    let res;
    if (isHome) res = gH > gA ? 'V' : gH === gA ? 'N' : 'D';
    else res = gA > gH ? 'V' : gA === gH ? 'N' : 'D';
    return {
      domicile: f.teams?.home?.name,
      exterieur: f.teams?.away?.name,
      score: `${gH}-${gA}`,
      competition: f.league?.name,
      resultat: res
    };
  });
}

// ══ ROUTES ══
app.get('/', (req, res) => {
  res.json({ status: 'Oddly Backend v4.0 ✅', timestamp: new Date() });
});

app.get('/api/matchs-aujourd-hui', async (req, res) => {
  const cached = getCache('matchs-aujourd-hui');
  if (cached) return res.json(cached);
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await sportApi.get(`/sport/football/scheduled-events/${today}`);
    const matchs = (r.data.events || []).slice(0, 25).map(e => ({
      id: e.id,
      competition: e.tournament?.name,
      domicile: e.homeTeam?.name,
      domicileId: e.homeTeam?.id,
      exterieur: e.awayTeam?.name,
      exterieurId: e.awayTeam?.id,
      heure: new Date(e.startTimestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      statut: e.status?.description,
    }));
    const result = { success: true, total: matchs.length, matchs };
    setCache('matchs-aujourd-hui', result, 900000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matchs-live', async (req, res) => {
  try {
    const r = await sportApi.get('/sport/football/events/live');
    const matchs = (r.data.events || []).slice(0, 15).map(e => ({
      id: e.id,
      competition: e.tournament?.name,
      domicile: e.homeTeam?.name,
      domicileId: e.homeTeam?.id,
      scoreDom: e.homeScore?.current,
      scoreExt: e.awayScore?.current,
      exterieur: e.awayTeam?.name,
      exterieurId: e.awayTeam?.id,
      minute: e.time?.played,
      statut: e.status?.description,
    }));
    res.json({ success: true, total: matchs.length, matchs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ANALYSE — utilise les noms passés en query params pour éviter appel SportAPI
app.get('/api/analyse/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const { home, away, competition } = req.query;

  const cached = getCache(`analyse-${matchId}`);
  if (cached) return res.json(cached);

  try {
    const homeName = home || 'Domicile';
    const awayName = away || 'Extérieur';

    await sleep(200);

    // Cherche les équipes sur API-Football
    const [homeSearch, awaySearch] = await Promise.all([
      footballApi.get(`/teams?search=${encodeURIComponent(homeName)}`),
      footballApi.get(`/teams?search=${encodeURIComponent(awayName)}`),
    ]);

    const homeTeam = homeSearch.data.response?.[0]?.team;
    const awayTeam = awaySearch.data.response?.[0]?.team;

    let homeFixtures = [], awayFixtures = [], h2hFixtures = [];

    if (homeTeam && awayTeam) {
      await sleep(300);
      const [homeF, awayF, h2hF] = await Promise.all([
        footballApi.get(`/fixtures?team=${homeTeam.id}&last=6`),
        footballApi.get(`/fixtures?team=${awayTeam.id}&last=6`),
        footballApi.get(`/fixtures?h2h=${homeTeam.id}-${awayTeam.id}&last=5`),
      ]);
      homeFixtures = homeF.data.response || [];
      awayFixtures = awayF.data.response || [];
      h2hFixtures = h2hF.data.response || [];
    }

    const lHome = homeTeam ? getLambda(homeFixtures, homeTeam.id) : 1.2;
    const lAway = awayTeam ? getLambda(awayFixtures, awayTeam.id) : 1.1;
    const formeHome = homeTeam ? getForme(homeFixtures, homeTeam.id) : '? ? ? ? ?';
    const formeAway = awayTeam ? getForme(awayFixtures, awayTeam.id) : '? ? ? ? ?';
    const derniers5Home = homeTeam ? getDerniers(homeFixtures, homeTeam.id) : [];
    const derniers5Away = awayTeam ? getDerniers(awayFixtures, awayTeam.id) : [];

    let h2hStats = { homeWins: 0, draws: 0, awayWins: 0, matchs: [] };
    if (h2hFixtures.length > 0) {
      h2hFixtures.filter(f => f.fixture?.status?.short === 'FT').slice(0, 5).forEach(f => {
        const gH = f.goals?.home || 0, gA = f.goals?.away || 0;
        const res = gH > gA ? 'DOM' : gH === gA ? 'NUL' : 'EXT';
        if (res === 'DOM') h2hStats.homeWins++;
        else if (res === 'NUL') h2hStats.draws++;
        else h2hStats.awayWins++;
        h2hStats.matchs.push({
          domicile: f.teams?.home?.name,
          exterieur: f.teams?.away?.name,
          score: `${gH}-${gA}`,
          resultat: res
        });
      });
    }

    // Cotes depuis SportAPI
    let cotes = { home: null, draw: null, away: null, bookmaker: 'N/A' };
    try {
      await sleep(200);
      const oddsR = await sportApi.get(`/event/${matchId}/odds/1/all/1`);
      const markets = oddsR.data?.markets || [];
      const ft = markets.find(m => m.marketName === 'Full time') || markets[0];
      if (ft?.choices) {
        ft.choices.forEach(c => {
          if (c.name === '1' || c.name === 'Home') cotes.home = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
          if (c.name === 'X' || c.name === 'Draw') cotes.draw = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
          if (c.name === '2' || c.name === 'Away') cotes.away = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
        });
        cotes.bookmaker = ft.bookmakerName || 'Bookmaker';
      }
    } catch (e) {}

    const probs = calculPoisson(lHome, lAway);
    const mc = monteCarlo(lHome, lAway);
    const pariConseille = getPariConseille(probs, cotes, mc);
    const impliedHome = cotes.home ? +(1/cotes.home).toFixed(3) : 0.45;
    const biaisResult = detecterBiais(impliedHome, probs.home);

    const confiance = Math.min(95, Math.round(
      50 +
      (homeFixtures.length >= 5 ? 15 : homeFixtures.length * 3) +
      (cotes.home ? 15 : 0) +
      (h2hFixtures.length >= 3 ? 10 : 0) +
      (Math.abs(lHome - lAway) * 5)
    ));

    const result = {
      success: true,
      match: {
        domicile: homeName,
        exterieur: awayName,
        competition: competition || '',
        heure: '',
        statut: '',
      },
      pariConseille,
      lambdas: { home: lHome, away: lAway },
      forme: { home: formeHome, away: formeAway },
      derniers5: { home: derniers5Home, away: derniers5Away },
      h2h: h2hStats,
      cotes,
      probs: {
        home: +(probs.home * 100).toFixed(1),
        draw: +(probs.draw * 100).toFixed(1),
        away: +(probs.away * 100).toFixed(1),
      },
      monteCarlo: mc,
      ev: {
        home: cotes.home ? ev(probs.home, cotes.home) : null,
        draw: cotes.draw ? ev(probs.draw, cotes.draw) : null,
        away: cotes.away ? ev(probs.away, cotes.away) : null,
      },
      kelly: {
        home: cotes.home ? kelly(probs.home, cotes.home) : null,
        draw: cotes.draw ? kelly(probs.draw, cotes.draw) : null,
        away: cotes.away ? kelly(probs.away, cotes.away) : null,
      },
      biais: biaisResult,
      confiance,
    };

    setCache(`analyse-${matchId}`, result, 3600000);
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Oddly Backend v4.0 — http://localhost:${PORT}`);
});