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
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;

// ══ MOTEUR ODDLY ══

function poisson(k, lambda) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

function calculPoisson(lambdaA, lambdaB) {
  const probs = { home: 0, draw: 0, away: 0 };
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const p = poisson(i, lambdaA) * poisson(j, lambdaB);
      if (i > j) probs.home += p;
      else if (i === j) probs.draw += p;
      else probs.away += p;
    }
  }
  return probs;
}

function poissonRandom(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function monteCarlo(lambdaA, lambdaB, n = 10000) {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < n; i++) {
    const a = poissonRandom(lambdaA);
    const b = poissonRandom(lambdaB);
    if (a > b) home++;
    else if (a === b) draw++;
    else away++;
  }
  return {
    home: (home / n).toFixed(3),
    draw: (draw / n).toFixed(3),
    away: (away / n).toFixed(3),
  };
}

function calculEV(prob, cote) {
  return ((prob * cote) - 1).toFixed(3);
}

function calculKelly(prob, cote) {
  return (((prob * cote - 1) / (cote - 1)) * 0.5).toFixed(3);
}

function detecterBiais(biasFoule, probReelle) {
  const diff = biasFoule - probReelle;
  if (diff > 0.2) return { signal: 'REVERSE 🔄', force: 'FORT', description: 'La foule surestime massivement' };
  if (diff > 0.1) return { signal: 'ATTENTION ⚠️', force: 'MODERE', description: 'Légère surestimation foule' };
  return { signal: 'OK ✅', force: 'FAIBLE', description: 'Pas de biais détecté' };
}

function getSignal(probs, cH, cD, cA) {
  const evH = cH ? parseFloat(calculEV(probs.home, cH)) : -1;
  const evD = cD ? parseFloat(calculEV(probs.draw, cD)) : -1;
  const evA = cA ? parseFloat(calculEV(probs.away, cA)) : -1;
  const maxEV = Math.max(evH, evD, evA);
  if (maxEV > 0.1) return {
    pari: evH === maxEV ? 'HOME 🏠' : evD === maxEV ? 'DRAW 🤝' : 'AWAY ✈️',
    ev: maxEV,
    force: maxEV > 0.2 ? '🔥 FORT' : '⚡ MODERE'
  };
  return { pari: 'AUCUN ❌', ev: maxEV, force: 'FAIBLE' };
}

// ══ ROUTES ══

app.get('/', (req, res) => {
  res.json({
    status: 'Oddly Backend v1.0 — Online ✅',
    timestamp: new Date(),
    endpoints: [
      'GET  /api/matchs-aujourd-hui',
      'GET  /api/matchs-live',
      'POST /api/analyse',
    ]
  });
});

// Matchs du jour
app.get('/api/matchs-aujourd-hui', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await axios.get('https://sportapi7.p.rapidapi.com/api/v1/sport/football/scheduled-events/' + today, {
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      }
    });
    const matchs = response.data.events?.slice(0, 20).map(e => ({
      id: e.id,
      competition: e.tournament?.name,
      domicile: e.homeTeam?.name,
      exterieur: e.awayTeam?.name,
      heure: new Date(e.startTimestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      statut: e.status?.description,
    }));
    res.json({ success: true, date: today, total: matchs?.length, matchs });
  } catch (err) {
    res.status(500).json({ error: 'Erreur API', details: err.message });
  }
});

// Matchs live
app.get('/api/matchs-live', async (req, res) => {
  try {
    const response = await axios.get('https://sportapi7.p.rapidapi.com/api/v1/sport/football/events/live', {
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      }
    });
    const matchs = response.data.events?.slice(0, 10).map(e => ({
      id: e.id,
      competition: e.tournament?.name,
      domicile: e.homeTeam?.name,
      scoreDom: e.homeScore?.current,
      scoreExt: e.awayScore?.current,
      exterieur: e.awayTeam?.name,
      minute: e.time?.played,
      statut: e.status?.description,
    }));
    res.json({ success: true, total: matchs?.length, matchs });
  } catch (err) {
    res.status(500).json({ error: 'Erreur API', details: err.message });
  }
});

// Analyse moteur Oddly
app.post('/api/analyse', (req, res) => {
  const { lambdaHome, lambdaAway, coteHome, coteDraw, coteAway, biasFoule } = req.body;
  if (!lambdaHome || !lambdaAway) {
    return res.status(400).json({ error: 'lambdaHome et lambdaAway requis' });
  }
  const probs = calculPoisson(lambdaHome, lambdaAway);
  const mc = monteCarlo(lambdaHome, lambdaAway);
  res.json({
    success: true,
    analyse: {
      poisson: probs,
      monteCarlo: mc,
      ev: {
        home: coteHome ? calculEV(probs.home, coteHome) : null,
        draw: coteDraw ? calculEV(probs.draw, coteDraw) : null,
        away: coteAway ? calculEV(probs.away, coteAway) : null,
      },
      kelly: {
        home: coteHome ? calculKelly(probs.home, coteHome) : null,
        draw: coteDraw ? calculKelly(probs.draw, coteDraw) : null,
        away: coteAway ? calculKelly(probs.away, coteAway) : null,
      },
      biais: biasFoule ? detecterBiais(biasFoule, probs.home) : null,
      signal: getSignal(probs, coteHome, coteDraw, coteAway),
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Oddly Backend démarré sur http://localhost:${PORT}`);
  console.log(`📅 Matchs du jour : http://localhost:${PORT}/api/matchs-aujourd-hui`);
  console.log(`🔴 Matchs live    : http://localhost:${PORT}/api/matchs-live`);
});