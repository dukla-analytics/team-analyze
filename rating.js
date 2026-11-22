/**
 * rating.js – Z-score výpočet ratingu (5.0 – 10.0) podle postů a kategorií
 * Použití: const hraciSRatingem = RatingEngine.calculate(vsichniHraci, 300);
 */
const RatingEngine = (() => {
  // 1. Konfigurace parametrů modelu
  const PARAMS = {
    minutesColumn: 'Minutes played', // Název sloupce s minutáží ve tvém CSV
    positionColumn: 'Position',      // Název sloupce s pozicí ve tvém CSV
    categoryColumn: 'Kategorie',     // Název sloupce s kategorií (U19, U17...)
    baseRating: 6.6,                 // Rating pro přesný medián ligy (Z = 0)
    posMultiplier: 1.5,              // Sklon nad průměrem
    negMultiplier: 1.2,              // Sklon pod průměrem (stlačuje spodek k 5.0)
    clampZMin: -2.5,                 // Ořez extrémů pro jednotlivé metriky (dole)
    clampZMax: 2.5,                  // Ořez extrémů pro jednotlivé metriky (nahoře)
    fullTrustMins: 600,              // Od 600 minut bereme data na 100 % vážně
    minRating: 5.0,
    maxRating: 10.0
  };

  // 2. Váhy a metriky pro všech 6 funkčních skupin (součet každé skupiny = 1.00)
  const WEIGHTS = {
    GK: {
      'Prevented goals per 90': 0.35,
      'Save rate %': 0.15,
      'Progressive passes per 90': 0.12,
      'Accurate long passes %': 0.10,
      'Accurate passes %': 0.08,
      'Exits per 90': 0.12,
      'PAdj Interceptions': 0.08
    },
    CB: {
      'Defensive duels won %': 0.15,
      'PAdj Interceptions': 0.12,
      'Successful defensive actions per 90': 0.10,
      'Aerial duels won %': 0.08,
      'Progressive passes per 90': 0.12,
      'Passes to final third per 90': 0.12,
      'Accurate forward passes %': 0.11,
      'Successful dribbles per 90': 0.10,
      'Accurate passes %': 0.10
    },
    FB: {
      'Defensive duels won %': 0.12,
      'PAdj Interceptions': 0.12,
      'Successful defensive actions per 90': 0.11,
      'Passes to final third per 90': 0.12,
      'Progressive passes per 90': 0.10,
      'Successful dribbles per 90': 0.13,
      'xA per 90': 0.12,
      'Deep completions per 90': 0.10,
      'Accurate crosses %': 0.08
    },
    CM: {
      'Progressive passes per 90': 0.13,
      'Passes to final third per 90': 0.12,
      'Accurate forward passes %': 0.10,
      'PAdj Interceptions': 0.12,
      'Defensive duels won %': 0.10,
      'Successful defensive actions per 90': 0.08,
      'Accurate passes %': 0.10,
      'Successful attacking actions per 90': 0.09,
      'Successful dribbles per 90': 0.08,
      'Touches in box per 90': 0.08
    },
    AMW: {
      'xG per 90': 0.15,
      'xA per 90': 0.15,
      'Touches in box per 90': 0.08,
      'Deep completions per 90': 0.07,
      'Successful dribbles per 90': 0.15,
      'Successful attacking actions per 90': 0.10,
      'Progressive passes per 90': 0.10,
      'Successful defensive actions per 90': 0.10,
      'PAdj Interceptions': 0.10
    },
    CF: {
      'xG per 90': 0.20,
      'Goals per 90': 0.15,
      'Touches in box per 90': 0.10,
      'Successful dribbles per 90': 0.12,
      'xA per 90': 0.10,
      'Successful attacking actions per 90': 0.10,
      'Aerial duels won %': 0.08,
      'Successful defensive actions per 90': 0.10,
      'PAdj Interceptions': 0.05
    }
  };

  let lastCalculated = [];

  // Pomocné funkce
  function parseNum(val) {
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    if (typeof val === 'string') {
      const cleaned = val.replace(',', '.').replace('%', '').trim();
      const num = parseFloat(cleaned);
      return isNaN(num) ? 0 : num;
    }
    return 0;
  }

  function hasVal(p, key) {
    return p[key] !== undefined && p[key] !== null && p[key] !== '';
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function getMedian(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function getStdDev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length;
    const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  }

  // Tlumení výsledného Z-score podle odehraných minut (Super-sub pojistka)
  function applyMinutesConfidence(zFinal, mins, fullTrustMins = PARAMS.fullTrustMins) {
    const safeMins = Number(mins) || 0;
    if (safeMins >= fullTrustMins) return zFinal;
    const confidence = Math.sqrt(Math.min(1, safeMins / fullTrustMins));
    return zFinal * confidence;
  }

  // Získání a dopočet hodnot metrik
  function getMetricValue(p, metric) {
    if (metric === 'Successful dribbles per 90') {
      const dribbles = parseNum(p['Dribbles per 90']);
      const pct = parseNum(p['Successful dribbles %']);
      return dribbles * (pct / 100);
    }

    if (metric === 'Goals per 90') {
      const goals = parseNum(p['Goals']);
      const mins = parseNum(p[PARAMS.minutesColumn]);
      return mins > 0 ? (goals / mins) * 90 : 0;
    }

    if (metric === 'Prevented goals per 90') {
      let val = null;
      if (hasVal(p, 'Prevented goals per 90_GK')) val = parseNum(p['Prevented goals per 90_GK']);
      else if (hasVal(p, 'Prevented goals per 90')) val = parseNum(p['Prevented goals per 90']);
      else {
        const mins = parseNum(p[PARAMS.minutesColumn]);
        const total = hasVal(p, 'Prevented goals_GK') ? parseNum(p['Prevented goals_GK']) : parseNum(p['Prevented goals']);
        val = mins > 0 ? (total / mins) * 90 : 0;
      }
      if (Math.abs(val) > 10) val = val / 1000;
      return val;
    }

    if (metric === 'Save rate %') {
      return hasVal(p, 'Save rate %_GK') ? parseNum(p['Save rate %_GK']) : parseNum(p['Save rate %']);
    }

    if (metric === 'Exits per 90') {
      return hasVal(p, 'Exits per 90_GK') ? parseNum(p['Exits per 90_GK']) : parseNum(p['Exits per 90']);
    }

    return parseNum(p[metric]);
  }

  // Mapování Wyscout zkratek na 6 skupin
  function mapPositionGroup(posString) {
    if (!posString) return null;
    const primary = String(posString).split(',')[0].trim().toUpperCase().replace(/[0-9]/g, '');

    if (primary === 'GK') return 'GK';
    if (primary.includes('CB')) return 'CB';
    if (['LB', 'RB', 'LWB', 'RWB'].includes(primary)) return 'FB';
    if (primary.includes('DMF') || primary.includes('CMF')) return 'CM';
    if (primary.includes('AMF') || ['LW', 'RW', 'LWF', 'RWF'].includes(primary)) return 'AMW';
    if (primary === 'CF') return 'CF';

    return null;
  }

  // Hlavní funkce výpočtu
  function calculate(players, minMinutes = 300) {
    const buckets = {};

    players.forEach(p => {
      const mins = parseNum(p[PARAMS.minutesColumn]);
      const group = mapPositionGroup(p[PARAMS.positionColumn]);
      const cat = hasVal(p, PARAMS.categoryColumn) ? String(p[PARAMS.categoryColumn]).trim() : 'ALL';

      if (mins >= minMinutes && group && WEIGHTS[group]) {
        const key = `${cat}__${group}`;
        if (!buckets[key]) buckets[key] = { cat, group, players: [] };
        buckets[key].players.push(p);
      }
    });

    // Výpočet mediánu a směrodatné odchylky pro každý bucket a metriku
    const stats = {};
    Object.entries(buckets).forEach(([key, bucket]) => {
      stats[key] = {};
      Object.keys(WEIGHTS[bucket.group]).forEach(metric => {
        const values = bucket.players.map(p => getMetricValue(p, metric));
        const stdDev = getStdDev(values);

        if (stdDev === 0 && bucket.players.length >= 2) {
          console.warn(`⚠️ RatingEngine [${bucket.cat} | ${bucket.group}]: Metrika "${metric}" nebyla v CSV nalezena (nebo jsou všude nuly)!`);
        }

        stats[key][metric] = {
          median: getMedian(values),
          stdDev: stdDev
        };
      });
    });

    // Výpočet ratingu pro každého hráče
    lastCalculated = players.map(p => {
      const mins = parseNum(p[PARAMS.minutesColumn]);
      const group = mapPositionGroup(p[PARAMS.positionColumn]);
      const cat = hasVal(p, PARAMS.categoryColumn) ? String(p[PARAMS.categoryColumn]).trim() : 'ALL';
      const key = `${cat}__${group}`;

      if (mins < minMinutes || !group || !stats[key] || buckets[key].players.length < 2) {
        return { ...p, ratingGroup: group, ratingZ: null, rating: null, ratingBreakdown: null };
      }

      const metricWeights = WEIGHTS[group];
      let zFinal = 0;
      const breakdown = [];

      Object.entries(metricWeights).forEach(([metric, weight]) => {
        const { median, stdDev } = stats[key][metric];
        const val = getMetricValue(p, metric);

        const rawZ = stdDev > 0 ? (val - median) / stdDev : 0;
        const clampedZ = clamp(rawZ, PARAMS.clampZMin, PARAMS.clampZMax);
        const contribution = clampedZ * weight;
        zFinal += contribution;

        breakdown.push({
          Metrika: metric,
          Hodnota: Number(val.toFixed(2)),
          MedianLigy: Number(median.toFixed(2)),
          StdDev: Number(stdDev.toFixed(2)),
          Z_score: Number(clampedZ.toFixed(2)),
          Vaha: `${Math.round(weight * 100)}%`,
          Prispevek: Number(contribution.toFixed(3))
        });
      });

      const adjustedZ = applyMinutesConfidence(zFinal, mins);
      const multiplier = adjustedZ >= 0 ? PARAMS.posMultiplier : PARAMS.negMultiplier;
      const rawRating = PARAMS.baseRating + (adjustedZ * multiplier);
      const finalRating = clamp(rawRating, PARAMS.minRating, PARAMS.maxRating);

      return {
        ...p,
        ratingGroup: group,
        ratingZ: Number(adjustedZ.toFixed(2)),
        rating: Number(finalRating.toFixed(1)),
        ratingBreakdown: breakdown
      };
    });

    return lastCalculated;
  }

  // Rentgen konkrétního hráče v konzoli (F12)
  function inspect(namePart) {
    const found = lastCalculated.find(p =>
      p.Player && p.Player.toLowerCase().includes(String(namePart).toLowerCase())
    );
    if (!found) {
      console.warn(`Hráč obsahující "${namePart}" nebyl nalezen.`);
      return;
    }
    console.group(`📊 Rentgen: ${found.Player} (${found.ratingGroup || 'bez postu'}) → Rating: ${found.rating ?? 'N/A'} (Z_final: ${found.ratingZ ?? 'N/A'})`);
    if (found.ratingBreakdown) {
      console.table(found.ratingBreakdown);
    } else {
      console.log('Hráč nesplnil limit minutáže nebo nemá přiřazenou skupinu.');
    }
    console.groupEnd();
  }

  return {
    calculate,
    inspect,
    mapPositionGroup,
    PARAMS,
    WEIGHTS
  };
})();
