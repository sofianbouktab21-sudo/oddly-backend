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
const KEY = process.env.RAPIDAPI_KEY;
const HOST = process.env.RAPIDAPI_HOST;

const api = axios.create({
  baseURL: `https://${HOST}/api/v1`,
  headers: { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST }
});

// ══ MOTEUR ODDLY ══

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
  return { home: +(h/n).toFixed(3), draw: +(d/n).toFixed(3), away: +(a/n).toFixed(3) };
}

function ev(prob, cote) { return +((prob * cote) - 1).toFixed(3); }
function kelly(prob, cote) { return +(((prob * cote - 1) / (cote - 1)) * 0.5).toFixed(3); }

function biais(pctFoule, probReelle) {
  const diff = pctFoule - probReelle;
  if (diff > 0.25) return { signal: '🔄 REVERSE FORT', force: 'FORT', desc: 'La foule surestime massivement — valeur de l\'autre côté' };
  if (diff > 0.12) return { signal: '⚠️ REVERSE MODÉRÉ', force: 'MODERE', desc: 'Légère surestimation — signal modéré' };
  if (diff < -0.15) return { signal: '✅ FOULE A RAISON', force: 'CONFIRME', desc: 'Le biais confirme notre signal' };
  return { signal: '➡️ NEUTRE', force: 'FAIBLE', desc: 'Pas de biais significatif détecté' };
}

function getLambda(matchs, isHome) {
  if (!matchs || matchs.length === 0) return 1.2;
  let totalButs = 0, count = 0;
  matchs.slice(0, 5).forEach(m => {
    if (!m.homeScore || !m.awayScore) return;
    const estDomicile = isHome ? m.homeTeam?.id === m.homeTeam?.id : false;
    const buts = isHome ? (m.homeScore.current || 0) : (m.awayScore.current || 0);
    totalButs += buts;
    count++;
  });
  return count > 0 ? Math.max(0.3, totalButs / count) : 1.2;
}

function getFormeString(matchs, teamId) {
  if (!matchs || matchs.length === 0) return 'N/A';
  return matchs.slice(0, 5).map(m => {
    const isHome = m.homeTeam?.id === teamId;
    const scoreHome = m.homeScore?.current || 0;
    const scoreAway = m.awayScore?.current || 0;
    if (isHome) return scoreHome > scoreAway ? 'V' : scoreHome === scoreAway ? 'N' : 'D';
    return scoreAway > scoreHome ? 'V' : scoreAway === scoreHome ? 'N' : 'D';
  }).join(' ');
}

function getSignal(probs, cH, cD, cA) {
  const evH = cH ? ev(probs.home, cH) : -99;
  const evD = cD ? ev(probs.draw, cD) : -99;
  const evA = cA ? ev(probs.away, cA) : -99;
  const maxEV = Math.max(evH, evD, evA);
  const pari = evH === maxEV ? '🏠 DOMICILE' : evD === maxEV ? '🤝 NUL' : '✈️ EXTÉRIEUR';
  const force = maxEV > 0.15 ? '🔥 FORT' : maxEV > 0.05 ? '⚡ MODÉRÉ' : '❌ AUCUN';
  const mise = maxEV > 0.05 ? +(Math.max(0, kelly(probs[maxEV === evH ? 'home' : maxEV === evD ? 'draw' : 'away'], maxEV === evH ? cH : maxEV === evD ? cD : cA)) * 100).toFixed(1) : 0;
  return { pari, ev: maxEV, force, mise: `${mise}% de la bankroll` };
}

// ══ ROUTES ══

app.get('/', (req, res) => {
  res.json({ status: 'Oddly Backend v2.0 ✅', timestamp: new Date() });
});

// Matchs du jour
app.get('/api/matchs-aujourd-hui', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await api.get(`/sport/football/scheduled-events/${today}`);
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
    res.json({ success: true, total: matchs.length, matchs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Matchs live
app.get('/api/matchs-live', async (req, res) => {
  try {
    const r = await api.get('/sport/football/events/live');
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

// Analyse complète d'un match
app.get('/api/analyse/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    // Récupère les détails du match
    const matchR = await api.get(`/event/${matchId}`);
    const match = matchR.data.event;
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;

    // Récupère la forme des deux équipes en parallèle
    const [homeFormR, awayFormR, oddsR] = await Promise.allSettled([
      api.get(`/team/${homeId}/events/last/0`),
      api.get(`/team/${awayId}/events/last/0`),
      api.get(`/event/${matchId}/odds/1/all/1`),
    ]);

    const homeMatchs = homeFormR.status === 'fulfilled' ? (homeFormR.value.data.events || []) : [];
    const awayMatchs = awayFormR.status === 'fulfilled' ? (awayFormR.value.data.events || []) : [];

    // Calcul lambdas réels
    const lambdaHome = getLambda(homeMatchs, true);
    const lambdaAway = getLambda(awayMatchs, false);

    // Forme récente
    const formeHome = getFormeString(homeMatchs, homeId);
    const formeAway = getFormeString(awayMatchs, awayId);

    // Stats derniers 5 matchs
    const statsHome = homeMatchs.slice(0, 5).map(m => ({
      adversaire: m.homeTeam?.id === homeId ? m.awayTeam?.name : m.homeTeam?.name,
      score: `${m.homeScore?.current || 0}-${m.awayScore?.current || 0}`,
      competition: m.tournament?.name,
    }));

    const statsAway = awayMatchs.slice(0, 5).map(m => ({
      adversaire: m.homeTeam?.id === awayId ? m.awayTeam?.name : m.homeTeam?.name,
      score: `${m.homeScore?.current || 0}-${m.awayScore?.current || 0}`,
      competition: m.tournament?.name,
    }));

    // Cotes bookmakers
    let cotes = { home: null, draw: null, away: null, bookmaker: 'N/A' };
    if (oddsR.status === 'fulfilled') {
      const markets = oddsR.value.data?.markets || [];
      const ft = markets.find(m => m.marketName === 'Full time');
      if (ft && ft.choices) {
        ft.choices.forEach(c => {
          if (c.name === '1') cotes.home = parseFloat(c.fractionalValue || c.odd);
          if (c.name === 'X') cotes.draw = parseFloat(c.fractionalValue || c.odd);
          if (c.name === '2') cotes.away = parseFloat(c.fractionalValue || c.odd);
        });
        cotes.bookmaker = ft.bookmakerName || 'Bookmaker';
      }
    }

    // Calculs moteur
    const probs = calculPoisson(lambdaHome, lambdaAway);
    const mc = monteCarlo(lambdaHome, lambdaAway);
    const signal = getSignal(probs, cotes.home, cotes.draw, cotes.away);

    // Biais foule (estimation basée sur les cotes implicites)
    const impliedHome = cotes.home ? 1 / cotes.home : 0.45;
    const biaisResult = biais(impliedHome, probs.home);

    // Confiance globale
    const confiance = Math.min(99, Math.round(
      (Math.abs(signal.ev) * 100 * 0.4) +
      (homeMatchs.length * 2 * 0.3) +
      (cotes.home ? 20 : 0) * 0.3
    ));

    res.json({
      success: true,
      match: {
        domicile: match.homeTeam.name,
        exterieur: match.awayTeam.name,
        competition: match.tournament?.name,
        heure: new Date(match.startTimestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      },
      lambdas: { home: +lambdaHome.toFixed(2), away: +lambdaAway.toFixed(2) },
      forme: {
        home: formeHome,
        away: formeAway,
        derniers5Home: statsHome,
        derniers5Away: statsAway,
      },
      cotes,
      probs: {
        home: +(probs.home * 100).toFixed(1),
        draw: +(probs.draw * 100).toFixed(1),
        away: +(probs.away * 100).toFixed(1),
      },
      monteCarlo: {
        home: +(mc.home * 100).toFixed(1),
        draw: +(mc.draw * 100).toFixed(1),
        away: +(mc.away * 100).toFixed(1),
      },
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
      signal,
      biais: biaisResult,
      confiance,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Oddly Backend v2.0 — http://localhost:${PORT}`);
});