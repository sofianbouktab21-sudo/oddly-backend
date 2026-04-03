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

function detecterBiais(pctFoule, probReelle) {
  const diff = pctFoule - probReelle;
  if (diff > 0.25) return { signal: '🔄 REVERSE FORT', force: 'FORT', desc: 'La foule surestime massivement — valeur de l\'autre côté' };
  if (diff > 0.12) return { signal: '⚠️ REVERSE MODÉRÉ', force: 'MODERE', desc: 'Légère surestimation détectée' };
  if (diff < -0.15) return { signal: '✅ FOULE A RAISON', force: 'CONFIRME', desc: 'Le biais confirme notre signal' };
  return { signal: '➡️ NEUTRE', force: 'FAIBLE', desc: 'Pas de biais significatif' };
}

function getLambdaFromMatchs(matchs, teamId) {
  if (!matchs || matchs.length === 0) return 1.2;
  let totalButs = 0, count = 0;
  matchs.slice(0, 6).forEach(m => {
    const isHome = m.homeTeam?.id === teamId;
    const buts = isHome ? (m.homeScore?.current || 0) : (m.awayScore?.current || 0);
    if (m.status?.type === 'finished') { totalButs += buts; count++; }
  });
  return count > 0 ? Math.max(0.4, +(totalButs / count).toFixed(2)) : 1.2;
}

function getLambdaDefense(matchs, teamId) {
  if (!matchs || matchs.length === 0) return 1.2;
  let totalEncaisses = 0, count = 0;
  matchs.slice(0, 6).forEach(m => {
    const isHome = m.homeTeam?.id === teamId;
    const buts = isHome ? (m.awayScore?.current || 0) : (m.homeScore?.current || 0);
    if (m.status?.type === 'finished') { totalEncaisses += buts; count++; }
  });
  return count > 0 ? Math.max(0.3, +(totalEncaisses / count).toFixed(2)) : 1.1;
}

function getFormeString(matchs, teamId) {
  if (!matchs || matchs.length === 0) return '? ? ? ? ?';
  return matchs.slice(0, 5).map(m => {
    if (m.status?.type !== 'finished') return '?';
    const isHome = m.homeTeam?.id === teamId;
    const sH = m.homeScore?.current || 0, sA = m.awayScore?.current || 0;
    if (isHome) return sH > sA ? 'V' : sH === sA ? 'N' : 'D';
    return sA > sH ? 'V' : sA === sH ? 'N' : 'D';
  }).join(' ');
}

function getDerniers5(matchs, teamId) {
  return (matchs || []).slice(0, 5).map(m => {
    const isHome = m.homeTeam?.id === teamId;
    return {
      domicile: m.homeTeam?.name,
      exterieur: m.awayTeam?.name,
      score: `${m.homeScore?.current || 0}-${m.awayScore?.current || 0}`,
      competition: m.tournament?.name,
      resultat: (() => {
        if (m.status?.type !== 'finished') return '?';
        const sH = m.homeScore?.current || 0, sA = m.awayScore?.current || 0;
        if (isHome) return sH > sA ? 'V' : sH === sA ? 'N' : 'D';
        return sA > sH ? 'V' : sA === sH ? 'N' : 'D';
      })(),
    };
  });
}

function getH2H(matchs, homeId, awayId) {
  if (!matchs || matchs.length === 0) return { homeWins: 0, draws: 0, awayWins: 0, matchs: [] };
  let hW = 0, dr = 0, aW = 0;
  const details = matchs.slice(0, 5).map(m => {
    const sH = m.homeScore?.current || 0, sA = m.awayScore?.current || 0;
    const res = sH > sA ? 'DOM' : sH === sA ? 'NUL' : 'EXT';
    if (res === 'DOM') hW++; else if (res === 'NUL') dr++; else aW++;
    return { domicile: m.homeTeam?.name, exterieur: m.awayTeam?.name, score: `${sH}-${sA}`, resultat: res };
  });
  return { homeWins: hW, draws: dr, awayWins: aW, matchs: details };
}

function getPariConseille(probs, cotes, mc, signal) {
  if (!cotes.home || !cotes.draw || !cotes.away) {
    return {
      pari: signal.pari,
      cote: null,
      ev: signal.ev,
      kelly: null,
      mise: signal.mise,
      confiance: signal.confiance,
      force: signal.force,
      explication: 'Cotes non disponibles — signal basé sur Poisson uniquement',
    };
  }

  const evH = ev(probs.home, cotes.home);
  const evD = ev(probs.draw, cotes.draw);
  const evA = ev(probs.away, cotes.away);
  const maxEV = Math.max(evH, evD, evA);

  let pariKey = evH === maxEV ? 'home' : evD === maxEV ? 'draw' : 'away';
  let pariLabel = pariKey === 'home' ? '🏠 DOMICILE GAGNE' : pariKey === 'draw' ? '🤝 MATCH NUL' : '✈️ EXTÉRIEUR GAGNE';
  let cotePari = pariKey === 'home' ? cotes.home : pariKey === 'draw' ? cotes.draw : cotes.away;
  let probPari = pariKey === 'home' ? probs.home : pariKey === 'draw' ? probs.draw : probs.away;
  let mcPari = pariKey === 'home' ? mc.home : pariKey === 'draw' ? mc.draw : mc.away;
  let kellyPari = kelly(probPari, cotePari);
  let misePct = Math.max(0, Math.min(10, +(kellyPari * 100).toFixed(1)));

  const confiance = Math.min(95, Math.round(
    (Math.abs(maxEV) * 200) +
    (probPari * 100 * 0.3) +
    (mcPari * 100 * 0.2) +
    (maxEV > 0.1 ? 20 : 0)
  ));

  const force = maxEV > 0.15 ? '🔥 SIGNAL FORT' : maxEV > 0.05 ? '⚡ SIGNAL MODÉRÉ' : '❌ PAS DE VALEUR';

  let explication = '';
  if (maxEV > 0.1) {
    explication = `Notre modèle calcule ${(probPari * 100).toFixed(1)}% de chances réelles contre ${(100/cotePari).toFixed(1)}% implicites dans la cote. EV positif de +${(maxEV*100).toFixed(1)}% — valeur détectée.`;
  } else if (maxEV > 0) {
    explication = `Légère valeur détectée. Probabilité réelle légèrement supérieure aux cotes bookmaker.`;
  } else {
    explication = `Pas de valeur significative sur ce match. Bookmaker correctement calibré.`;
  }

  return {
    pari: pariLabel,
    cote: cotePari,
    ev: maxEV,
    evPct: `${maxEV > 0 ? '+' : ''}${(maxEV * 100).toFixed(1)}%`,
    kelly: kellyPari,
    mise: `${misePct}% de la bankroll`,
    confiance,
    force,
    explication,
  };
}

// ══ ROUTES ══

app.get('/', (req, res) => {
  res.json({ status: 'Oddly Backend v3.0 ✅', timestamp: new Date() });
});

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

// ANALYSE COMPLÈTE
app.get('/api/analyse/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    const matchR = await api.get(`/event/${matchId}`);
    const match = matchR.data.event;
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;

    // Tout en parallèle
    const [homeFormR, awayFormR, oddsR, h2hR, homeStatsR, awayStatsR] = await Promise.allSettled([
      api.get(`/team/${homeId}/events/last/0`),
      api.get(`/team/${awayId}/events/last/0`),
      api.get(`/event/${matchId}/odds/1/all/1`),
      api.get(`/event/${matchId}/h2h`),
      api.get(`/team/${homeId}/statistics/season/61/tournament/17`),
      api.get(`/team/${awayId}/statistics/season/61/tournament/17`),
    ]);

    const homeMatchs = homeFormR.status === 'fulfilled' ? (homeFormR.value.data.events || []) : [];
    const awayMatchs = awayFormR.status === 'fulfilled' ? (awayFormR.value.data.events || []) : [];
    const h2hMatchs = h2hR.status === 'fulfilled' ? (h2hR.value.data.events || []) : [];

    // Lambdas réels attaque + défense
    const lambdaHomeAtt = getLambdaFromMatchs(homeMatchs, homeId);
    const lambdaAwayDef = getLambdaDefense(awayMatchs, awayId);
    const lambdaAwayAtt = getLambdaFromMatchs(awayMatchs, awayId);
    const lambdaHomeDef = getLambdaDefense(homeMatchs, homeId);

    // Lambda final = attaque équipe × défense adverse / moyenne ligue
    const moyLigue = 1.35;
    const lHome = +(lambdaHomeAtt * lambdaAwayDef / moyLigue).toFixed(2);
    const lAway = +(lambdaAwayAtt * lambdaHomeDef / moyLigue).toFixed(2);

    // Forme
    const formeHome = getFormeString(homeMatchs, homeId);
    const formeAway = getFormeString(awayMatchs, awayId);
    const derniers5Home = getDerniers5(homeMatchs, homeId);
    const derniers5Away = getDerniers5(awayMatchs, awayId);
    const h2h = getH2H(h2hMatchs, homeId, awayId);

    // Cotes
    let cotes = { home: null, draw: null, away: null, bookmaker: 'N/A' };
    if (oddsR.status === 'fulfilled') {
      const markets = oddsR.value.data?.markets || [];
      const ft = markets.find(m => m.marketName === 'Full time') || markets[0];
      if (ft?.choices) {
        ft.choices.forEach(c => {
          if (c.name === '1' || c.name === 'Home') cotes.home = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
          if (c.name === 'X' || c.name === 'Draw') cotes.draw = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
          if (c.name === '2' || c.name === 'Away') cotes.away = parseFloat(c.fractionalValue || c.odd || c.initialOdds);
        });
        cotes.bookmaker = ft.bookmakerName || 'Bookmaker';
      }
    }

    // Calculs
    const probs = calculPoisson(lHome, lAway);
    const mc = monteCarlo(lHome, lAway);

    // Biais foule
    const impliedHome = cotes.home ? +(1 / cotes.home).toFixed(3) : 0.45;
    const biaisResult = detecterBiais(impliedHome, probs.home);

    // Confiance globale
    const confiance = Math.min(95, Math.round(
      50 +
      (homeMatchs.length >= 5 ? 15 : homeMatchs.length * 3) +
      (cotes.home ? 15 : 0) +
      (h2hMatchs.length >= 3 ? 10 : 0) +
      (Math.abs(lHome - lAway) * 5)
    ));

    // Paris conseillé
    const signal = {
      pari: '', ev: 0, force: '', mise: '', confiance
    };
    const pariConseille = getPariConseille(probs, cotes, mc, signal);

    res.json({
      success: true,
      match: {
        domicile: match.homeTeam.name,
        exterieur: match.awayTeam.name,
        competition: match.tournament?.name,
        heure: new Date(match.startTimestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        statut: match.status?.description,
      },
      pariConseille,
      lambdas: { home: lHome, away: lAway },
      forme: { home: formeHome, away: formeAway },
      derniers5: { home: derniers5Home, away: derniers5Away },
      h2h,
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
      biais: biaisResult,
      confiance,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Oddly Backend v3.0 — http://localhost:${PORT}`);
});