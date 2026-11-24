/**
 * engine.js
 * ホロドリ イベントボーダー着地予測 ＆ 高解像度レポート描画 共通エンジン（v6.4 加算リード型ハイブリッド統合版）
 *
 * - Node.js (index.js) と ブラウザ (admin.html) の双方で 100% 同一ロジックを動作させる UMD モジュール
 * - スポットライトイベント（全順位）および通常イベント・ダイヤ級（5,000位帯）は従来v6.1ロジックを完全維持
 * - 通常イベント・ドリーム級（<=1,000位）およびプラチナ級（>=10,000位）のみ加算リード型ハイブリッドを適用
 * - 解像度 (2160x820 / 1600x900) を一切落とさず、低スペックサーバー向けに
 *   「キャンバス再利用」および「静的背景レイヤーのオフスクリーンキャッシュ」を内蔵
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HolodoriBorderEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // =========================================================================
  // 1. 共通定数 ＆ 日時・数値フォーマット
  // =========================================================================
  const DAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];

  const TIER_DEFS = [
    { rank: 1000, label: "ドリーム級" },
    { rank: 5000, label: "ダイヤ級" },
    { rank: 10000, label: "プラチナ級" },
  ];

  function normalizeEventCategory(cat) {
    if (!cat) return null;
    const c = String(cat).trim().toLowerCase();
    if (c === "point") return "normal";
    return c;
  }

  function parseJstDateTime(str) {
    if (str == null) return null;
    if (typeof str === "number") return str < 1e12 ? str * 1000 : str;
    const trimmed = String(str).trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return num < 1e12 ? num * 1000 : num;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (m) {
      const [, y, mo, d, h, mi, s = "00"] = m;
      return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function formatNumber(n) {
    if (n == null || Number.isNaN(n)) return "-";
    return Math.round(n).toLocaleString("ja-JP");
  }

  function formatJST(ms, withDate = true) {
    const jst = new Date(ms + 9 * 3600 * 1000);
    const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
    const day = String(jst.getUTCDate()).padStart(2, "0");
    const wd = DAYS_JP[jst.getUTCDay()];
    const hh = String(jst.getUTCHours()).padStart(2, "0");
    const mm = String(jst.getUTCMinutes()).padStart(2, "0");
    return withDate ? `${m}/${day}(${wd}) ${hh}:${mm}` : `${hh}:${mm}`;
  }

  function formatRoundedJstTime(ms) {
    const jst = new Date(ms + 9 * 3600 * 1000);
    const hh = jst.getUTCHours();
    const mm = jst.getUTCMinutes();
    const totalMinutes = hh * 60 + mm;
    const roundedTotalMinutes = Math.round(totalMinutes / 5) * 5;
    const finalHour = Math.floor(roundedTotalMinutes / 60) % 24;
    const finalMin = roundedTotalMinutes % 60;
    return finalMin === 0 ? `${finalHour}時` : `${finalHour}時${finalMin}分`;
  }

  function formatManRounded(score) {
    if (score == null || Number.isNaN(score)) return "未取得";
    return `${Math.round(score / 10000)}万`;
  }

  /**
   * グラフ集合から /nowborder 用のテキストとタイムラベルを構築する共通関数
   * @param {Object|Map} graphsSource - キー `${eventKey}::${rank}` のグラフオブジェクト群
   * @param {string|null} targetPrefix - 対象イベントキー（nullの場合は最新タイムスタンプのイベントを自動選択）
   */
  function buildNowBorderPayloadFromGraphs(graphsSource, targetPrefix = null) {
    if (!graphsSource) return null;
    const getGraph = (k) => (graphsSource instanceof Map ? graphsSource.get(k) : graphsSource[k]);
    const keys = graphsSource instanceof Map ? Array.from(graphsSource.keys()) : Object.keys(graphsSource);
    if (keys.length === 0) return null;

    let chosenPrefix = targetPrefix;
    if (!chosenPrefix) {
      let newestTs = -1;
      for (const k of keys) {
        const g = getGraph(k);
        if (!g || !Array.isArray(g.tier) || g.tier.length === 0) continue;
        const lastT = g.tier[g.tier.length - 1][0];
        if (lastT > newestTs) {
          newestTs = lastT;
          chosenPrefix = k.replace(/::\d+$/, "");
        }
      }
    }
    if (!chosenPrefix) return null;

    let latestTimestamp = 0;
    const lines = [];

    for (const tier of TIER_DEFS) {
      const g = getGraph(`${chosenPrefix}::${tier.rank}`);
      if (g && Array.isArray(g.tier) && g.tier.length > 0) {
        const [lastT, lastVal] = g.tier[g.tier.length - 1];
        if (lastT > latestTimestamp) latestTimestamp = lastT;
        lines.push(`${tier.label} ${formatManRounded(lastVal)}`);
      } else {
        lines.push(`${tier.label} 未取得`);
      }
    }

    if (latestTimestamp === 0) return null;

    const timeLabel = formatRoundedJstTime(latestTimestamp);
    const text = [`最終更新(${timeLabel})時点のボーダーです！`, ...lines].join("\n");
    return {
      eventKey: chosenPrefix,
      text,
      timeLabel,
      updatedAt: latestTimestamp,
    };
  }

  // =========================================================================
  // 2. 着地予測モデル（v6.4 加算リード型ハイブリッド ＋ スポットライト完全保護）
  // =========================================================================
  function calcMedian(values) {
    if (!values || values.length === 0) return 1.0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
  }

  function calcWeightedMedian(itemsWithWeights) {
    const valid = itemsWithWeights.filter((x) => x.weight > 0);
    if (valid.length === 0) return 0;
    valid.sort((a, b) => a.value - b.value);
    const totalW = valid.reduce((s, x) => s + x.weight, 0);
    let acc = 0;
    for (let i = 0; i < valid.length; i++) {
      acc += valid[i].weight;
      if (acc >= totalW * 0.5) {
        if (i > 0 && Math.abs(acc - valid[i].weight - totalW * 0.5) < 1e-9) {
          return (valid[i - 1].value + valid[i].value) * 0.5;
        }
        return valid[i].value;
      }
    }
    return valid[valid.length - 1].value;
  }

  function interpScoreAtTime(graph, targetT) {
    const st = graph.startTime;
    const pts = graph.tier;
    if (!pts || pts.length === 0) return null;
    if (targetT <= st) return 0;
    if (targetT <= pts[0][0]) {
      return pts[0][1] * Math.max(0, (targetT - st) / Math.max(1, pts[0][0] - st));
    }
    if (targetT >= pts[pts.length - 1][0]) {
      return pts[pts.length - 1][1];
    }
    let lo = 0;
    let hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= targetT) lo = mid;
      else hi = mid;
    }
    const [t0, v0] = pts[lo];
    const [t1, v1] = pts[hi];
    return v0 + (v1 - v0) * ((targetT - t0) / Math.max(1, t1 - t0));
  }

  function interpScoreAtProgress(graph, prog) {
    const targetT = graph.startTime + prog * (graph.endTime - graph.startTime);
    return interpScoreAtTime(graph, targetT);
  }

  function getJstParts(ms) {
    const jst = new Date(ms + 9 * 3600 * 1000);
    const year = jst.getUTCFullYear();
    const month = jst.getUTCMonth() + 1;
    const day = jst.getUTCDate();
    const dow = jst.getUTCDay();
    const hour = jst.getUTCHours();
    const minute = jst.getUTCMinutes();
    const slot30 = hour * 2 + (minute >= 30 ? 1 : 0);
    return { year, month, day, dow, hour, minute, slot30 };
  }

  function getJstHour(ms) {
    return getJstParts(ms).hour;
  }

  function getJstDayOfWeek(ms) {
    return getJstParts(ms).dow;
  }

  // 日本の祝日判定（JST基準・固定祝日/ハッピーマンデー/春分秋分/振替休日/国民の休日）
  const _jpHolidayCache = new Map();

  function isSingleDayHolidayJST(y, m, d, dow) {
    const nthMonday = (targetM, n) => {
      const firstDow = new Date(Date.UTC(y, targetM - 1, 1)).getUTCDay();
      const firstMon = 1 + ((8 - firstDow) % 7);
      return firstMon + (n - 1) * 7;
    };
    if (m === 1 && d === 1) return true; // 元日
    if (m === 1 && d === nthMonday(1, 2)) return true; // 成人の日
    if (m === 2 && d === 11) return true; // 建国記念の日
    if (m === 2 && d === 23) return true; // 天皇誕生日
    if (m === 3) {
      const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      if (d === vernal) return true; // 春分の日
    }
    if (m === 4 && d === 29) return true; // 昭和の日
    if (m === 5 && (d === 3 || d === 4 || d === 5)) return true; // 憲法記念日・みどりの日・こどもの日
    if (m === 7 && d === nthMonday(7, 3)) return true; // 海の日
    if (m === 8 && d === 11) return true; // 山の日
    if (m === 9 && d === nthMonday(9, 3)) return true; // 敬老の日
    if (m === 9) {
      const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      if (d === autumnal) return true; // 秋分の日
    }
    if (m === 10 && d === nthMonday(10, 2)) return true; // スポーツの日
    if (m === 11 && (d === 3 || d === 23)) return true; // 文化の日・勤労感謝の日
    return false;
  }

  function isJapaneseHolidayJST(ms) {
    const { year, month, day, dow } = getJstParts(ms);
    const key = `${year}-${month}-${day}`;
    if (_jpHolidayCache.has(key)) return _jpHolidayCache.get(key);

    const checkDirect = (tMs) => {
      const p = getJstParts(tMs);
      return isSingleDayHolidayJST(p.year, p.month, p.day, p.dow);
    };

    let isHol = checkDirect(ms);
    // 振替休日（日曜が祝日の場合、その後の最初の平日）
    if (!isHol && dow !== 0) {
      for (let back = 1; back <= 3; back++) {
        const prevMs = ms - back * 86400000;
        const pp = getJstParts(prevMs);
        if (!checkDirect(prevMs)) break;
        if (pp.dow === 0) {
          isHol = true;
          break;
        }
      }
    }
    // 国民の休日（前日と翌日が祝日）
    if (!isHol && checkDirect(ms - 86400000) && checkDirect(ms + 86400000)) {
      isHol = true;
    }

    _jpHolidayCache.set(key, isHol);
    return isHol;
  }

  // 30分スロット（48枠）のデフォルト基礎活性係数（平日 / 休日・祝日）
  function getDefaultSlot30Factor(slot30, isWeekendOrHoliday) {
    const h = Math.floor(slot30 / 2);
    const isHalf = slot30 % 2 === 1;
    const weekday24 = [
      0.58, 0.36, 0.22, 0.16, 0.15, 0.20,
      0.34, 0.52, 0.62, 0.62, 0.66, 0.72,
      0.84, 0.78, 0.78, 0.84, 0.92, 1.05,
      1.18, 1.30, 1.44, 1.48, 1.32, 0.94,
    ];
    const holiday24 = [
      0.66, 0.44, 0.28, 0.20, 0.18, 0.22,
      0.34, 0.48, 0.64, 0.78, 0.90, 0.98,
      1.05, 1.08, 1.12, 1.16, 1.22, 1.28,
      1.34, 1.42, 1.50, 1.52, 1.36, 0.98,
    ];
    const tbl = isWeekendOrHoliday ? holiday24 : weekday24;
    const cur = tbl[h] || 1.0;
    const next = tbl[(h + 1) % 24] || cur;
    return isHalf ? (cur + next) * 0.5 : cur;
  }

  // 過去データから「曜日 × 祝日 × 30分スロット」の速度係数を自動学習
  function buildCalendarProfileFromRefs(refGraphs) {
    const buckets = new Map(); // `${effDow}_${slot30}` -> number[]
    const stepMs = 30 * 60 * 1000;

    for (const g of refGraphs) {
      if (!g || !Array.isArray(g.tier) || g.tier.length < 10) continue;
      const durH = (g.endTime - g.startTime) / 3600000;
      const finalScore = g.tier[g.tier.length - 1][1];
      const avgPace = finalScore / Math.max(1, durH);
      if (avgPace <= 0) continue;

      // 開始直後1hと終了直前3hの特殊スパートを除いた定常区間から時間帯係数を抽出
      const scanStart = g.startTime + 60 * 60 * 1000;
      const scanEnd = g.endTime - 3 * 60 * 60 * 1000;
      for (let t = scanStart; t + stepMs <= scanEnd; t += stepMs) {
        const s0 = interpScoreAtTime(g, t);
        const s1 = interpScoreAtTime(g, t + stepMs);
        if (s0 == null || s1 == null) continue;
        const slotPace = (s1 - s0) / 0.5;
        const ratio = Math.max(0.10, Math.min(3.50, slotPace / avgPace));

        const midMs = t + stepMs * 0.5;
        const { dow, slot30 } = getJstParts(midMs);
        const isHol = isJapaneseHolidayJST(midMs);
        const effDow = isHol ? 0 : dow; // 祝日は日曜相当（休日）プロファイルに統合
        const bKey = `${effDow}_${slot30}`;
        if (!buckets.has(bKey)) buckets.set(bKey, []);
        buckets.get(bKey).push(ratio);
      }
    }

    // 事前集計済み中央値マップを構築（推論時のソートコストをゼロ化）
    const medianCache = new Map();
    for (const [bKey, samples] of buckets.entries()) {
      if (samples.length > 0) {
        const learnedMed = calcMedian(samples);
        const trust = Math.min(0.75, samples.length / 8);
        medianCache.set(bKey, { learnedMed, trust });
      }
    }

    return function getCalendarSlotFactor(ms) {
      const { dow, slot30 } = getJstParts(ms);
      const isHol = isJapaneseHolidayJST(ms);
      const isWeekendOrHoliday = isHol || dow === 0 || dow === 6;
      const defaultVal = getDefaultSlot30Factor(slot30, isWeekendOrHoliday);

      const effDow = isHol ? 0 : dow;
      const entry = medianCache.get(`${effDow}_${slot30}`);
      if (!entry) return defaultVal;

      return defaultVal * (1 - entry.trust) + entry.learnedMed * entry.trust;
    };
  }

  /**
   * 終了直前（ラスト6時間以内）のカレンダー係数緩和
   * 最終日は曜日差よりも駆け込みスパートが支配的になるため、振れ幅をマイルドに減衰させる
   */
  function getEffectiveCalFactor(getCalFactor, ms, remHours) {
    const raw = Math.max(0.18, getCalFactor(ms));
    if (remHours >= 6.0) return raw;
    const damp = 0.45 + 0.55 * (Math.max(0, remHours) / 6.0);
    return 1.0 + (raw - 1.0) * damp;
  }

  // EMA（指数移動平均）で30分速・10分速を取得
  function computeEmaPace(graph, lastT, slotMin, numSlots = 4, alpha = 0.52) {
    const st = graph.startTime;
    const slotMs = slotMin * 60 * 1000;
    const elapsedMs = lastT - st;
    if (elapsedMs <= 60000) return 0;

    const actualSlots = Math.max(1, Math.min(numSlots, Math.floor(elapsedMs / slotMs)));
    const paces = [];
    for (let i = actualSlots; i >= 1; i--) {
      const t1 = lastT - (i - 1) * slotMs;
      const t0 = Math.max(st, lastT - i * slotMs);
      const dtH = (t1 - t0) / 3600000;
      if (dtH <= 0) continue;
      const v1 = interpScoreAtTime(graph, t1);
      const v0 = interpScoreAtTime(graph, t0);
      paces.push(Math.max(0, (v1 - v0) / dtH));
    }
    if (paces.length === 0) return 0;
    let ema = paces[0];
    for (let i = 1; i < paces.length; i++) {
      ema = alpha * paces[i] + (1 - alpha) * ema;
    }
    return ema;
  }

  // 開始から現在までの「伸び方（カーブ形状）」の類似度を算出（0.15 〜 1.0）
  function calcTrajectoryShapeSimilarity(targetGraph, refGraph, pCur) {
    const tSt = targetGraph.startTime;
    const tDur = targetGraph.endTime - tSt;
    const rSt = refGraph.startTime;
    const rDur = refGraph.endTime - rSt;

    const tCurVal = interpScoreAtProgress(targetGraph, pCur);
    const rCurVal = interpScoreAtProgress(refGraph, pCur);
    if (!tCurVal || tCurVal <= 0 || !rCurVal || rCurVal <= 0) return 0.5;

    const bins = Math.max(4, Math.min(24, Math.round(pCur * 48)));
    const vecT = [];
    const vecR = [];
    let prevT = 0;
    let prevR = 0;

    for (let i = 1; i <= bins; i++) {
      const p = (pCur * i) / bins;
      const curT = interpScoreAtTime(targetGraph, tSt + p * tDur);
      const curR = interpScoreAtTime(refGraph, rSt + p * rDur);
      vecT.push(Math.max(0, curT - prevT) / tCurVal);
      vecR.push(Math.max(0, curR - prevR) / rCurVal);
      prevT = curT;
      prevR = curR;
    }

    let dot = 0;
    let normT = 0;
    let normR = 0;
    for (let i = 0; i < bins; i++) {
      dot += vecT[i] * vecR[i];
      normT += vecT[i] * vecT[i];
      normR += vecR[i] * vecR[i];
    }
    const cosSim = normT > 0 && normR > 0 ? dot / Math.sqrt(normT * normR) : 0.5;

    // 前半半分 vs 後半半分の傾き比（加速型か減速型か）の一致度
    const halfIdx = Math.floor(bins / 2);
    const tFirst = vecT.slice(0, halfIdx).reduce((a, b) => a + b, 0);
    const tSecond = vecT.slice(halfIdx).reduce((a, b) => a + b, 0);
    const rFirst = vecR.slice(0, halfIdx).reduce((a, b) => a + b, 0);
    const rSecond = vecR.slice(halfIdx).reduce((a, b) => a + b, 0);

    const tSlope = (tSecond + 0.05) / (tFirst + 0.05);
    const rSlope = (rSecond + 0.05) / (rFirst + 0.05);
    const slopeRatio = Math.min(tSlope, rSlope) / Math.max(tSlope, rSlope);

    const combined = Math.pow(Math.max(0, cosSim), 2.0) * (0.4 + 0.6 * slopeRatio);
    return Math.max(0.15, Math.min(1.0, combined));
  }

  function getChapterNumber(item) {
    const rawId = `${item?.chapterId || ""} ${item?.key || ""}`;
    const m = /chapter[-_]?0*(\d+)/i.exec(rawId);
    return m ? Number(m[1]) : null;
  }

  /**
   * 管理画面からの手動補正値（±pt）を現在時刻から最終着地まで自然なカーブ比率で適用
   */
  function applyNaturalManualAdjustment(pred, adjustPt) {
    const delta = Number(adjustPt) || 0;
    if (pred.isFinished || delta === 0) {
      return { ...pred, manualAdjustPt: 0 };
    }
    const cur = pred.currentScore;
    const origFinal = pred.centralFinal;
    const origGain = origFinal - cur;
    const targetFinal = Math.max(cur, origFinal + delta);
    const newGain = targetFinal - cur;
    const scale = origGain > 1 ? newGain / origGain : 0;

    const newMin = Math.max(cur, cur + (pred.minFinal - cur) * scale);
    const newMax = Math.max(targetFinal, cur + (pred.maxFinal - cur) * scale);
    const newSeries = pred.forecastSeries.map((pt, idx) => {
      if (idx === 0) return pt;
      return {
        p: pt.p,
        central: Math.max(cur, cur + (pt.central - cur) * scale),
        min: Math.max(cur, cur + (pt.min - cur) * scale),
        max: Math.max(cur, cur + (pt.max - cur) * scale),
      };
    });

    return {
      ...pred,
      centralFinal: targetFinal,
      minFinal: newMin,
      maxFinal: newMax,
      halfSpread: Math.max(targetFinal - newMin, newMax - targetFinal),
      forecastSeries: newSeries,
      manualAdjustPt: Math.round(targetFinal - origFinal),
    };
  }

  /**
   * 着地予測メイン計算関数（サーバー・ブラウザ完全共通）
   * @param {Object} targetItem - 対象イベントメタ情報
   * @param {Object} targetGraph - 対象ランクの推移グラフ ({ startTime, endTime, tier: [[ms, pt], ...] })
   * @param {Array} refPairs - 参照過去データペア配列 [{ item, graph }, ...]
   * @param {number} targetRank - 対象順位 (1000, 5000, 10000 等)
   * @param {number|Object} [optionsOrAdjustPt=0] - 手動補正pt または { manualAdjustPt, getCalFactor }
   */
  function computePrediction(targetItem, targetGraph, refPairs, targetRank, optionsOrAdjustPt = 0) {
    const opts =
      typeof optionsOrAdjustPt === "object" && optionsOrAdjustPt !== null
        ? optionsOrAdjustPt
        : { manualAdjustPt: Number(optionsOrAdjustPt) || 0 };

    const manualAdjustPt = Number(opts.manualAdjustPt) || 0;

    const st = targetGraph.startTime;
    const et = targetGraph.endTime;
    const dur = et - st;
    const totalH = dur / 3600000;
    const pts = targetGraph.tier;
    const lastPt = pts[pts.length - 1];
    const lastT = lastPt[0];
    const currentScore = lastPt[1];
    const elapsedMs = Math.max(60000, lastT - st);
    const elapsedH = elapsedMs / 3600000;
    const remMs = Math.max(0, et - lastT);
    const remH = remMs / 3600000;
    const pCur = Math.min(1, elapsedMs / dur);
    const isFinished = pCur >= 0.998 && !targetItem.live;

    // 開催期間（totalH）に応じた動的スケール定数（48h〜72hまでは従来スポットライト基準と同一）
    const fastZoneHours = Math.max(3.0, Math.min(8.0, totalH * 0.04));
    const surgeWindowHours = Math.max(12.0, Math.min(24.0, totalH * 0.12));
    const spurtFocusHours = Math.max(6.0, Math.min(12.0, totalH * 0.06));
    const decayTauMs = Math.max(18, totalH * 0.25) * 3600 * 1000;

    // 有効な過去完了データの抽出
    const validRefs = refPairs
      .filter(({ graph }) => {
        if (!graph || !Array.isArray(graph.tier) || graph.tier.length < 15) return false;
        if (graph.rank && Number(graph.rank) !== Number(targetRank)) return false;
        const gDur = graph.endTime - graph.startTime;
        const gProg = (graph.tier[graph.tier.length - 1][0] - graph.startTime) / Math.max(1, gDur);
        return gProg >= 0.98;
      })
      .sort((a, b) => b.graph.endTime - a.graph.endTime);

    // 事前学習済みのカレンダー係数関数があれば使い回し、無ければ学習構築
    const getCalFactor =
      typeof opts.getCalFactor === "function"
        ? opts.getCalFactor
        : buildCalendarProfileFromRefs(validRefs.map((r) => r.graph));

    // 1. 常に30分速EMA、終了終盤ゾーン（fastZoneHours）から10分速EMAへ移行
    const ema30m = computeEmaPace(targetGraph, lastT, 30, 4, 0.52);
    const ema10m = computeEmaPace(targetGraph, lastT, 10, 4, 0.58);

    let w10m = 0;
    if (!isFinished && remH <= fastZoneHours) {
      const fastRatio = (fastZoneHours - remH) / fastZoneHours;
      w10m =
        fastRatio <= 0.34
          ? (fastRatio / 0.34) * 0.65
          : Math.min(0.90, 0.65 + ((fastRatio - 0.34) / 0.66) * 0.25);
    }
    const activeEmaPace = w10m > 0 ? ema30m * (1 - w10m) + ema10m * w10m : ema30m;
    const curCalFactor = getEffectiveCalFactor(getCalFactor, lastT - 15 * 60 * 1000, remH);
    const normalizedEmaPace = activeEmaPace / curCalFactor;

    // 2. 残り時間スロット列の構築（終盤ゾーン前は30分刻み、終盤ゾーン〜終了は10分刻み）
    const futureSlots = [];
    if (!isFinished && remMs > 0) {
      const finalZoneStart = et - fastZoneHours * 3600 * 1000;
      let cursor = lastT;
      while (cursor < et - 1000) {
        const slotMs = cursor >= finalZoneStart ? 10 * 60 * 1000 : 30 * 60 * 1000;
        const nextT = Math.min(et, cursor + slotMs);
        const midT = (cursor + nextT) * 0.5;
        const remHMid = (et - midT) / 3600000;
        futureSlots.push({
          t0: cursor,
          t1: nextT,
          p0: (cursor - st) / dur,
          p1: (nextT - st) / dur,
          pMid: (midT - st) / dur,
          dtH: (nextT - cursor) / 3600000,
          remHMid,
          calFactor: getEffectiveCalFactor(getCalFactor, midT, remHMid),
          is10mZone: cursor >= finalZoneStart,
        });
        cursor = nextT;
      }
    }

    // 3. 伸び方（形状）類似度＋カテゴリ親和性＋期間長類似度に基づく参照イベント重み付け
    const targetCat = normalizeEventCategory(targetItem?.category);
    const targetChNum = getChapterNumber(targetItem);
    const rankNum = Number(targetRank);

    // スポットライトイベント判定（スポットライトは全順位で現行v6.1ロジックを100%完全維持）
    const isSpotlight = targetCat === "spotlight";
    const isDiamond = rankNum > 1000 && rankNum < 10000;
    const isDream = rankNum <= 1000;
    const isPlatinum = rankNum >= 10000;
    const isSprintEvent = totalH <= 84;
    const useLegacyV61 = isDiamond || isSpotlight;

    // 通常イベントのドリーム・プラチナ用：開始直後8%ダッシュ区間を除外した巡航増分
    const hasCruise = !useLegacyV61 && pCur >= 0.16;
    const dashCutP = hasCruise ? 0.08 : 0.0;
    const cruiseS0 = hasCruise ? interpScoreAtProgress(targetGraph, dashCutP) || 0 : 0;
    const tCruiseInc = Math.max(0, currentScore - cruiseS0);

    const refModels = [];
    const rNows = [];
    const rPaces = [];

    for (const rObj of validRefs) {
      const { item, graph } = rObj;
      const gSt = graph.startTime;
      const gDur = graph.endTime - gSt;
      const rDurH = gDur / 3600000;
      const hCur = interpScoreAtProgress(graph, pCur);
      const hFinal = graph.tier[graph.tier.length - 1][1];
      if (!hCur || hCur <= 0 || hFinal <= hCur) continue;

      // 伸び方（形状）類似度
      const shapeSim = calcTrajectoryShapeSimilarity(targetGraph, graph, pCur);

      // 現在水準比と直近EMA速度比（カレンダー正規化後）
      const rNow = currentScore / hCur;
      const hTargetT = gSt + pCur * gDur;
      const hEma30m = computeEmaPace(graph, hTargetT, 30, 4, 0.52);
      const hEma10m = computeEmaPace(graph, hTargetT, 10, 4, 0.58);
      const hActiveEma = w10m > 0 ? hEma30m * (1 - w10m) + hEma10m * w10m : hEma30m;
      const hCalFactor = getEffectiveCalFactor(getCalFactor, hTargetT - 15 * 60 * 1000, remH);
      const hNormEma = hActiveEma / hCalFactor;

      let rPace;
      let baseScale;
      let longTermScale;
      let durWeight;
      let scaleSim;

      if (useLegacyV61) {
        // === スポットライト（全順位）＆ 通常イベント・ダイヤ級：v6.1 現行ロジック完全維持 ===
        const rawRPace = hNormEma > 0 ? normalizedEmaPace / hNormEma : rNow;
        const clampRange = remH <= fastZoneHours ? 0.55 : 0.32;
        rPace = Math.max(rNow * (1 - clampRange), Math.min(rNow * (1 + clampRange), rawRPace));

        const wPace =
          remH <= fastZoneHours ? 0.72 : remH <= spurtFocusHours ? 0.52 : pCur < 0.25 ? 0.42 : 0.32;
        baseScale = (1 - wPace) * rNow + wPace * rPace;
        longTermScale = rNow;

        const durSim = Math.min(totalH, rDurH) / Math.max(1e-4, Math.max(totalH, rDurH));
        durWeight = 0.25 + 0.75 * Math.pow(durSim, 0.9);
        scaleSim = Math.min(rNow, 1 / Math.max(1e-4, rNow));
      } else {
        // === 通常イベント・ドリーム級（<=1,000位）＆ プラチナ級（>=10,000位）：加算リード型ハイブリッド ===
        let rAnchor = 1.0;
        if (hasCruise) {
          const hCruiseS0 = interpScoreAtProgress(graph, dashCutP) || 0;
          const hCruiseInc = Math.max(1.0, hCur - hCruiseS0);
          const rCruiseRaw = tCruiseInc / hCruiseInc;
          const rCruise = Math.max(0.55, Math.min(1.55, rCruiseRaw));
          const wCruise = Math.min(0.75, ((pCur - 0.16) / 0.45) * 0.75);
          rAnchor = (1 - wCruise) * 1.0 + wCruise * rCruise;
        }

        const betaLearn = isSprintEvent ? 0.45 : isDream ? 0.85 : 0.95;
        const lambdaMult = Math.min(1.0, Math.pow(pCur, betaLearn));
        longTermScale = (1 - lambdaMult) * rAnchor + lambdaMult * rNow;

        const rawRPace = hNormEma > 0 ? normalizedEmaPace / hNormEma : longTermScale;
        const clampRange = remH <= fastZoneHours ? 0.55 : 0.32;
        rPace = Math.max(
          longTermScale * (1 - clampRange),
          Math.min(longTermScale * (1 + clampRange), rawRPace)
        );

        const wPace =
          remH <= fastZoneHours ? 0.72 : remH <= spurtFocusHours ? 0.52 : pCur < 0.25 ? 0.35 : 0.30;
        baseScale = (1 - wPace) * longTermScale + wPace * rPace;

        const durSim = Math.min(totalH, rDurH) / Math.max(1e-4, Math.max(totalH, rDurH));
        durWeight = 0.18 + 0.82 * Math.pow(durSim, 1.1);
        scaleSim = Math.min(longTermScale, 1 / Math.max(1e-4, longTermScale));
      }

      rNows.push(rNow);
      rPaces.push(rPace);

      // 各未来スロットの増分を「参照イベントの純粋増分 × 今回の曜日・祝日係数」で再合成
      const slotCurve = [currentScore];
      let acc = currentScore;

      if (!isFinished) {
        for (let i = 0; i < futureSlots.length; i++) {
          const sl = futureSlots[i];
          const gT0 = gSt + sl.p0 * gDur;
          const gT1 = gSt + sl.p1 * gDur;
          const gMid = (gT0 + gT1) * 0.5;
          const rawDh = Math.max(0, interpScoreAtTime(graph, gT1) - interpScoreAtTime(graph, gT0));

          // 参照回側の当時のカレンダー係数を剥がし、今回のカレンダー係数を乗せる
          const refCal = getEffectiveCalFactor(getCalFactor, gMid, sl.remHMid);
          const calAdjustedDh = rawDh * (sl.calFactor / refCal);

          // 時間の経過とともに実測EMA倍率から長期ベース水準へ緩やかに減衰
          const elapsedFromNowMs = (sl.t0 + sl.t1) * 0.5 - lastT;
          const decay = Math.exp(-Math.max(0, elapsedFromNowMs) / decayTauMs);
          const slotScale = longTermScale * (1 - decay) + baseScale * decay;

          acc += calAdjustedDh * slotScale;
          slotCurve.push(acc);
        }
      }

      // 総合重み：伸び方（形状）類似度 × カテゴリ親和性 × 期間長類似度 × チャプター種別一致 × 規模の近さ
      const refCat = normalizeEventCategory(item?.category);
      let catWeight = 1.0;
      if (targetCat && refCat) {
        catWeight = targetCat === refCat ? 1.45 : 0.55;
      }

      const refChNum = getChapterNumber(item);
      let chWeight = 1.0;
      if (targetCat === "spotlight" && refCat === "spotlight" && targetChNum != null && refChNum != null) {
        if (targetChNum === refChNum) chWeight = 1.35;
        else if ((targetChNum === 5) === (refChNum === 5)) chWeight = 1.15;
      }

      const weight =
        Math.pow(shapeSim, 1.6) * catWeight * durWeight * chWeight * (0.35 + 0.65 * scaleSim);

      refModels.push({
        item,
        graph,
        hCur,
        hFinal,
        rNow,
        rPace,
        shapeSim,
        impliedFinal: isFinished ? currentScore : acc,
        slotCurve,
        weight,
      });
    }

    refModels.sort((a, b) => b.weight - a.weight);

    const medRNow = calcMedian(rNows);
    const medRPace = calcMedian(rPaces);
    const liveHeat = 0.55 * medRNow + 0.45 * medRPace;

    // 4. 実測加速検知に基づく「条件付き」終盤スパート補正
    let spurtBoost = 1.0;
    let surgeDetectedRatio = 1.0;
    if (!isFinished && remH <= surgeWindowHours && elapsedH >= 4.0) {
      const prevCheckT = Math.max(st + 60 * 60 * 1000, lastT - 2.5 * 3600 * 1000);
      const prevEma = computeEmaPace(targetGraph, prevCheckT, 30, 3, 0.52);
      const prevCal = getEffectiveCalFactor(getCalFactor, prevCheckT - 15 * 60 * 1000, remH + 2.5);
      const normPrevEma = prevEma / prevCal;

      if (normPrevEma > 0) {
        surgeDetectedRatio = normalizedEmaPace / normPrevEma;
        // カレンダー要因を除いた純粋な時速が2.5時間前より6%以上加速している場合のみ発動
        if (surgeDetectedRatio > 1.06) {
          const tierSensitivity = rankNum <= 1000 ? 0.34 : rankNum >= 10000 ? 0.22 : 0.14;
          const maxCap = rankNum <= 1000 ? 1.32 : rankNum >= 10000 ? 1.20 : 1.12;
          spurtBoost = Math.min(maxCap, 1.0 + (surgeDetectedRatio - 1.06) * tierSensitivity);
        }
      }
    }

    // 5. 全スロット積算 ＆ 過去データの加重標準偏差（σ）による動的レンジ算出
    const forecastSeries = [];
    let centralFinal = currentScore;
    let minFinal = currentScore;
    let maxFinal = currentScore;

    if (!isFinished && refModels.length > 0 && futureSlots.length > 0) {
      const totalW = refModels.reduce((acc, m) => acc + m.weight, 0);

      // 各スロットのベース増分を加重平均し、条件付きスパート補正を適用して積算
      let runningCentral = currentScore;
      const centralPoints = [{ p: pCur, val: currentScore }];
      const spurtFocusSpan = Math.max(4.0, spurtFocusHours * 0.67);

      for (let i = 0; i < futureSlots.length; i++) {
        const sl = futureSlots[i];
        let slotBaseInc = 0;
        for (const m of refModels) {
          const mInc = m.slotCurve[i + 1] - m.slotCurve[i];
          slotBaseInc += mInc * m.weight;
        }
        slotBaseInc /= totalW;

        // 条件付きスパート補正は終盤スパート集中時間（spurtFocusHours）以内に集中適用
        const spurtWeight =
          sl.remHMid <= spurtFocusHours
            ? Math.min(1.0, (spurtFocusHours - sl.remHMid) / spurtFocusSpan + 0.35)
            : 0.15;
        const effSpurt = 1.0 + (spurtBoost - 1.0) * spurtWeight;

        runningCentral += slotBaseInc * effSpurt;
        centralPoints.push({ p: sl.p1, val: runningCentral });
      }

      const meanImplied = refModels.reduce((acc, m) => acc + m.impliedFinal * m.weight, 0) / totalW;

      if (useLegacyV61) {
        centralFinal = runningCentral;
      } else {
        // 通常イベント（ドリーム・プラチナ）：加重平均と加重中央値をブレンドし外れ値イベントの影響を抑制
        const medBase = calcWeightedMedian(
          refModels.map((m) => ({ value: m.impliedFinal, weight: m.weight }))
        );
        const spurtRatio =
          meanImplied > currentScore
            ? (runningCentral - currentScore) / Math.max(1, meanImplied - currentScore)
            : 1.0;
        const medCentral = currentScore + Math.max(0, medBase - currentScore) * spurtRatio;
        const wMed = isDream ? 0.35 : 0.25;
        centralFinal = runningCentral * (1 - wMed) + medCentral * wMed;

        // グラフ系列（centralPoints）の終着点も centralFinal に滑らかに整合
        const gainBeforeBlend = runningCentral - currentScore;
        const gainAfterBlend = centralFinal - currentScore;
        if (gainBeforeBlend > 1) {
          const curveRatio = gainAfterBlend / gainBeforeBlend;
          for (let i = 1; i < centralPoints.length; i++) {
            centralPoints[i].val = currentScore + (centralPoints[i].val - currentScore) * curveRatio;
          }
        }
      }

      // 類似イベント群の「最終着地予測値」の加重標準偏差 σ を算出
      const spurtScaleTotal =
        meanImplied > currentScore
          ? (centralFinal - currentScore) / Math.max(1, meanImplied - currentScore)
          : 1.0;

      const variance =
        refModels.reduce((acc, m) => {
          const scaledImp = currentScore + (m.impliedFinal - currentScore) * spurtScaleTotal;
          return acc + m.weight * Math.pow(scaledImp - centralFinal, 2);
        }, 0) / totalW;

      const stdDev = Math.sqrt(variance);
      let spreadMargin;
      if (useLegacyV61) {
        // スポットライト（全順位）＆ 通常イベント・ダイヤ級：v6.1 現行レンジ計算を完全維持
        const sigmaMult = rankNum <= 1000 ? 1.25 : rankNum >= 10000 ? 1.15 : 1.05;
        const minFloorRatio = Math.max(0.025, 0.065 * Math.pow(1 - pCur, 0.7));
        spreadMargin = Math.max(stdDev * sigmaMult, (centralFinal - currentScore) * minFloorRatio);
      } else if (isDream) {
        const sigmaMult = 1.30;
        const remFloor = (centralFinal - currentScore) * Math.max(0.035, 0.085 * Math.pow(1 - pCur, 0.7));
        const totalFloor = centralFinal * Math.max(0.022, 0.20 * Math.pow(1 - pCur, 1.0));
        spreadMargin = Math.max(stdDev * sigmaMult, remFloor, totalFloor);
      } else {
        const sigmaMult = 1.35;
        const remFloor = (centralFinal - currentScore) * Math.max(0.04, 0.11 * Math.pow(1 - pCur, 0.65));
        const totalFloor = centralFinal * Math.max(0.022, 0.13 * Math.pow(1 - pCur, 0.90));
        spreadMargin = Math.max(stdDev * sigmaMult, remFloor, totalFloor);
      }

      minFinal = Math.max(currentScore, centralFinal - spreadMargin);
      maxFinal = centralFinal + spreadMargin;

      for (let i = 0; i < centralPoints.length; i++) {
        const pt = centralPoints[i];
        if (i === 0) {
          forecastSeries.push({ p: pt.p, central: currentScore, min: currentScore, max: currentScore });
          continue;
        }
        const stepRatio = (pt.p - pCur) / Math.max(1e-4, 1 - pCur);
        const curMargin = spreadMargin * Math.pow(stepRatio, 0.85);
        forecastSeries.push({
          p: pt.p,
          central: pt.val,
          min: Math.max(currentScore, pt.val - curMargin),
          max: pt.val + curMargin,
        });
      }
    } else if (!isFinished) {
      const naiveLinear = pCur > 0.02 ? currentScore / pCur : currentScore;
      centralFinal = Math.max(naiveLinear * 1.08, currentScore + normalizedEmaPace * remH);
      minFinal = centralFinal * 0.93;
      maxFinal = centralFinal * 1.09;
      forecastSeries.push({ p: pCur, central: currentScore, min: currentScore, max: currentScore });
      forecastSeries.push({ p: 1, central: centralFinal, min: minFinal, max: maxFinal });
    }

    const halfSpread = isFinished ? 0 : Math.max(centralFinal - minFinal, maxFinal - centralFinal);
    const topMatch = refModels[0];

    return applyNaturalManualAdjustment(
      {
        targetItem,
        targetGraph,
        rank: targetRank,
        currentScore,
        lastT,
        elapsedH,
        totalH,
        pCur,
        isFinished,
        recentPace: activeEmaPace,
        centralFinal,
        minFinal,
        maxFinal,
        halfSpread,
        forecastSeries,
        refModels,
        metaInfo: {
          refCount: refModels.length,
          targetCategory: targetCat || "unknown",
          modelMode: useLegacyV61 ? "v6.1_multiplicative" : "v6.4_additive_lead_hybrid",
          zoneLabel: remH <= fastZoneHours ? "終盤10分速EMA域" : "通常30分速EMA域",
          wPacePct: remH <= fastZoneHours ? 72 : remH <= spurtFocusHours ? 52 : useLegacyV61 ? 35 : 30,
          w10mPct: Math.round(w10m * 100),
          pace10m: ema10m,
          pace30m: ema30m,
          liveHeat,
          spurtBoost,
          topShapeSim: topMatch ? topMatch.shapeSim : 0,
          topMatchName: topMatch ? topMatch.item.shortLabel : "-",
        },
      },
      manualAdjustPt
    );
  }

  // =========================================================================
  // 3. 高解像度 Canvas 描画エンジン（解像度維持 ＋ 背景キャッシュ・再利用最適化）
  // =========================================================================
  function getTierRankTitle(rank) {
    const r = Number(rank);
    if (r === 1000) return "ドリーム級";
    if (r === 5000) return "ダイヤ級";
    if (r === 10000) return "プラチナ級";
    return null;
  }

  function getTierTheme(rank, themeOverride = "auto") {
    let key = themeOverride || "auto";
    if (key === "auto") {
      if (rank <= 1000) key = "rainbow";
      else if (rank <= 5000) key = "purple";
      else if (rank <= 10000) key = "platinum";
      else if (rank <= 50000) key = "gold";
      else if (rank <= 100000) key = "silver";
      else key = "bronze";
    }

    const themes = {
      rainbow: {
        bgStops: ["#0c0a1d", "#181236", "#0b192c"],
        borderStops: ["#ff4d6d", "#ffb703", "#06d6a0", "#3a86ff", "#c77dff", "#ff4d6d"],
        primary: "#ffffff",
        accent: "#38bdf8",
        forecast: "#ffbe0b",
        bandFill: "rgba(255, 190, 11, 0.22)",
        glowColor: "rgba(168, 85, 247, 0.75)",
        sparkle: true,
        rainbow: true,
      },
      purple: {
        bgStops: ["#120724", "#240e47", "#140829"],
        borderStops: ["#a855f7", "#f0abfc", "#7e22ce", "#e879f9"],
        primary: "#f3e8ff",
        accent: "#d8b4fe",
        forecast: "#f0abfc",
        bandFill: "rgba(216, 180, 254, 0.22)",
        glowColor: "rgba(217, 70, 239, 0.85)",
        sparkle: true,
        rainbow: false,
      },
      platinum: {
        bgStops: ["#101822", "#1e2c3d", "#131c28"],
        borderStops: ["#e0f2fe", "#7dd3fc", "#f8fafc", "#38bdf8"],
        primary: "#f0f9ff",
        accent: "#7dd3fc",
        forecast: "#bae6fd",
        bandFill: "rgba(125, 211, 252, 0.20)",
        glowColor: "rgba(125, 211, 252, 0.55)",
        sparkle: false,
        rainbow: false,
      },
      gold: {
        bgStops: ["#1c1507", "#33260c", "#1a1306"],
        borderStops: ["#fde047", "#f59e0b", "#fef08a", "#d97706"],
        primary: "#fef9c3",
        accent: "#fde047",
        forecast: "#fbbf24",
        bandFill: "rgba(251, 191, 36, 0.20)",
        glowColor: "rgba(245, 158, 11, 0.50)",
        sparkle: false,
        rainbow: false,
      },
      silver: {
        bgStops: ["#14171c", "#262b34", "#161920"],
        borderStops: ["#e2e8f0", "#94a3b8", "#f1f5f9", "#64748b"],
        primary: "#f1f5f9",
        accent: "#cbd5e1",
        forecast: "#e2e8f0",
        bandFill: "rgba(203, 213, 225, 0.18)",
        glowColor: "rgba(148, 163, 184, 0.35)",
        sparkle: false,
        rainbow: false,
      },
      bronze: {
        bgStops: ["#1a100b", "#2e1c13", "#180e0a"],
        borderStops: ["#fdba74", "#c2410c", "#fed7aa", "#9a3412"],
        primary: "#ffedd5",
        accent: "#fdba74",
        forecast: "#fb923c",
        bandFill: "rgba(251, 146, 60, 0.18)",
        glowColor: "rgba(194, 65, 12, 0.35)",
        sparkle: false,
        rainbow: false,
      },
    };
    return themes[key] || themes.silver;
  }

  function drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawFittedText(ctx, text, x, y, maxWidth) {
    let str = String(text || "");
    if (ctx.measureText(str).width <= maxWidth) {
      ctx.fillText(str, x, y);
      return;
    }
    while (str.length > 1 && ctx.measureText(str + "…").width > maxWidth) {
      str = str.slice(0, -1);
    }
    ctx.fillText(str + "…", x, y);
  }

  /**
   * 省メモリ・高速描画インスタンスを生成するファクトリ
   * - 解像度 (2160x820 / 1600x900) を完全維持したまま、
   *   1) メインキャンバスの再利用（毎回のメモリ確保・GC防止）
   *   2) 背景・枠線・オーラ・スパークルレイヤーのオフスクリーン事前キャッシュ
   *   により低スペックサーバーでも軽量に高精細PNG/JPEGを生成できる。
   *
   * @param {Object} [initOptions]
   * @param {Function} [initOptions.createCanvas] - Node.js の createCanvas(w, h)
   * @param {string} [initOptions.fontFamily] - 日本語フォントファミリー名
   * @param {string} [initOptions.monoFamily] - 等幅フォントファミリー名
   */
  function createReportRenderer(initOptions = {}) {
    const canvasFactory =
      typeof initOptions.createCanvas === "function"
        ? initOptions.createCanvas
        : typeof document !== "undefined"
        ? (w, h) => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            return c;
          }
        : null;

    let fontSans = initOptions.fontFamily || "sans-serif";
    let fontMono = initOptions.monoFamily || initOptions.fontFamily || "monospace";

    // メインキャンバスプール（解像度キーごとに1枚を保持し使い回す）
    const mainCanvasPool = new Map();
    // 静的背景キャッシュ（設定シグネチャが変わらない限り再利用）
    let bgCacheEntry = { key: "", canvas: null };

    function setFontFamilies(sans, mono) {
      if (sans) fontSans = sans;
      if (mono) fontMono = mono;
    }

    function getPooledCanvas(w, h, targetCanvas = null) {
      if (targetCanvas) {
        if (targetCanvas.width !== w) targetCanvas.width = w;
        if (targetCanvas.height !== h) targetCanvas.height = h;
        return targetCanvas;
      }
      if (!canvasFactory) return null;
      const key = `${w}x${h}`;
      let c = mainCanvasPool.get(key);
      if (!c) {
        c = canvasFactory(w, h);
        mainCanvasPool.set(key, c);
      }
      return c;
    }

    // シングルカード用の静的背景（グラデ背景＋オーラ＋スパークル＋外枠＋左右パネル枠）を描画
    function paintSingleStaticBackground(ctx, W, H, rank, themeOverride) {
      const theme = getTierTheme(rank, themeOverride);

      const bgGrad = ctx.createLinearGradient(0, 0, W, H);
      bgGrad.addColorStop(0, theme.bgStops[0]);
      bgGrad.addColorStop(0.5, theme.bgStops[1]);
      bgGrad.addColorStop(1, theme.bgStops[2]);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      const radial = ctx.createRadialGradient(W * 0.78, H * 0.22, 30, W * 0.78, H * 0.22, 620);
      radial.addColorStop(0, theme.glowColor);
      radial.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, W, H);

      if (theme.rainbow) {
        const rbAura = ctx.createLinearGradient(0, 0, W, H);
        rbAura.addColorStop(0, "rgba(255, 77, 109, 0.14)");
        rbAura.addColorStop(0.25, "rgba(255, 183, 3, 0.12)");
        rbAura.addColorStop(0.5, "rgba(6, 214, 160, 0.12)");
        rbAura.addColorStop(0.75, "rgba(58, 134, 255, 0.14)");
        rbAura.addColorStop(1, "rgba(199, 125, 255, 0.16)");
        ctx.fillStyle = rbAura;
        ctx.fillRect(0, 0, W, H);
      }

      if (theme.sparkle) {
        const stars = [
          [120, 126, 4.0], [320, 82, 2.6], [1440, 118, 4.8], [1490, 280, 3.2],
          [1300, 186, 3.6], [1010, 100, 2.8], [1370, 745, 3.8], [186, 785, 3.2],
          [826, 146, 2.4], [1170, 810, 2.8], [1520, 640, 3.6], [610, 76, 3.0],
        ];
        for (const [sx, sy, sr] of stars) {
          ctx.save();
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = theme.forecast;
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      const borderGrad = ctx.createLinearGradient(0, 0, W, H);
      theme.borderStops.forEach((c, idx) => {
        borderGrad.addColorStop(idx / Math.max(1, theme.borderStops.length - 1), c);
      });
      ctx.save();
      drawRoundRect(ctx, 22, 22, W - 44, H - 44, 24);
      ctx.lineWidth = 6;
      ctx.strokeStyle = borderGrad;
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 28;
      }
      ctx.stroke();
      ctx.restore();

      // 左メイン情報パネル背景
      const leftX = 64;
      const leftY = 188;
      const leftW = 572;
      const leftH = 630;
      ctx.save();
      drawRoundRect(ctx, leftX, leftY, leftW, leftH, 18);
      ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(leftX + 32, leftY + 252);
      ctx.lineTo(leftX + leftW - 32, leftY + 252);
      ctx.stroke();

      // 右グラフパネル背景
      const rightX = 668;
      const rightY = 188;
      const rightW = W - rightX - 64;
      const rightH = 630;
      ctx.save();
      drawRoundRect(ctx, rightX, rightY, rightW, rightH, 18);
      ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.stroke();
      ctx.restore();
    }

    // マルチカード（デュアル・トリプル）用の静的背景（全体背景＋トップバー枠＋各カード外枠・パネル枠）を描画
    function paintMultiStaticBackground(ctx, W, H, slotRanks, themeOverride) {
      const baseBg = ctx.createLinearGradient(0, 0, W, H);
      baseBg.addColorStop(0, "#090c15");
      baseBg.addColorStop(0.5, "#111626");
      baseBg.addColorStop(1, "#090c15");
      ctx.fillStyle = baseBg;
      ctx.fillRect(0, 0, W, H);

      const marginX = 32;
      const gapX = 24;
      const topBarY = 22;
      const topBarH = 88;

      ctx.save();
      drawRoundRect(ctx, marginX, topBarY, W - marginX * 2, topBarH, 14);
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.stroke();
      ctx.restore();

      ctx.save();
      drawRoundRect(ctx, marginX + 16, topBarY + 16, 6, topBarH - 32, 3);
      ctx.fillStyle = "#38bdf8";
      ctx.fill();
      ctx.restore();

      const cardY = topBarY + topBarH + 18;
      const cardH = H - cardY - 24;
      const cardW = (W - marginX * 2 - gapX * (slotRanks.length - 1)) / slotRanks.length;

      slotRanks.forEach((rank, idx) => {
        const x = marginX + idx * (cardW + gapX);
        const y = cardY;
        const w = cardW;
        const h = cardH;
        const theme = getTierTheme(rank, themeOverride);

        ctx.save();
        drawRoundRect(ctx, x, y, w, h, 18);
        const cardBg = ctx.createLinearGradient(x, y, x + w, y + h);
        cardBg.addColorStop(0, theme.bgStops[0]);
        cardBg.addColorStop(0.5, theme.bgStops[1]);
        cardBg.addColorStop(1, theme.bgStops[2]);
        ctx.fillStyle = cardBg;
        ctx.fill();

        const aura = ctx.createRadialGradient(x + w * 0.8, y + 80, 15, x + w * 0.8, y + 80, 320);
        aura.addColorStop(0, theme.glowColor);
        aura.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = aura;
        ctx.fillRect(x, y, w, h);

        if (theme.rainbow) {
          const rbAura = ctx.createLinearGradient(x, y, x + w, y + h);
          rbAura.addColorStop(0, "rgba(255, 77, 109, 0.14)");
          rbAura.addColorStop(0.35, "rgba(255, 183, 3, 0.12)");
          rbAura.addColorStop(0.7, "rgba(6, 214, 160, 0.12)");
          rbAura.addColorStop(1, "rgba(58, 134, 255, 0.16)");
          ctx.fillStyle = rbAura;
          ctx.fillRect(x, y, w, h);
        }
        ctx.restore();

        if (theme.sparkle) {
          const relStars = [
            [44, 46, 2.8], [w - 50, 40, 3.2], [w - 100, 125, 2.5],
            [w - 44, h - 46, 2.8], [52, h - 42, 2.3], [w * 0.55, 32, 2.2],
          ];
          for (const [sx, sy, sr] of relStars) {
            ctx.save();
            ctx.fillStyle = "#ffffff";
            ctx.shadowColor = theme.forecast;
            ctx.shadowBlur = 14;
            ctx.beginPath();
            ctx.arc(x + sx, y + sy, sr, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }

        const borderGrad = ctx.createLinearGradient(x, y, x + w, y + h);
        theme.borderStops.forEach((c, cIdx) => {
          borderGrad.addColorStop(cIdx / Math.max(1, theme.borderStops.length - 1), c);
        });
        ctx.save();
        drawRoundRect(ctx, x, y, w, h, 18);
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = borderGrad;
        if (theme.sparkle) {
          ctx.shadowColor = theme.glowColor;
          ctx.shadowBlur = 20;
        }
        ctx.stroke();
        ctx.restore();
      });
    }

    function applyCachedBackground(ctx, W, H, cacheKey, paintFn) {
      if (!canvasFactory) {
        paintFn(ctx);
        return;
      }
      if (bgCacheEntry.key !== cacheKey || !bgCacheEntry.canvas) {
        const bgCanvas = canvasFactory(W, H);
        const bgCtx = bgCanvas.getContext("2d");
        paintFn(bgCtx);
        bgCacheEntry = { key: cacheKey, canvas: bgCanvas };
      }
      ctx.drawImage(bgCacheEntry.canvas, 0, 0);
    }

    function drawSingleCard(canvas, pred, options = {}) {
      const themeOverride = options.themeOverride || "auto";
      const nowMs = options.nowMs || Date.now();
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      if (!pred) {
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 30px ${fontSans}`;
        ctx.fillText("対象イベントのグラフデータが未取得です。上のボタンからAPIデータをコピーしてください。", 64, 120);
        return;
      }

      const bgKey = `single:${W}x${H}:r${pred.rank}:t${themeOverride}`;
      applyCachedBackground(ctx, W, H, bgKey, (bCtx) =>
        paintSingleStaticBackground(bCtx, W, H, pred.rank, themeOverride)
      );

      const theme = getTierTheme(pred.rank, themeOverride);
      const rankTitle = getTierRankTitle(pred.rank);

      const borderGrad = ctx.createLinearGradient(0, 0, W, H);
      theme.borderStops.forEach((c, idx) => {
        borderGrad.addColorStop(idx / Math.max(1, theme.borderStops.length - 1), c);
      });

      ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
      ctx.font = `600 23px ${fontSans}`;
      ctx.fillText(
        `${pred.targetItem.catLabel}  ｜  開催: ${formatJST(pred.targetItem.startTime)} 〜 ${formatJST(pred.targetItem.endTime)}`,
        64,
        88
      );

      const rankBadgeW = rankTitle ? 360 : 310;
      const rankBadgeH = 70;
      const rankBadgeX = W - 64 - rankBadgeW;
      const rankBadgeY = 64;

      ctx.save();
      ctx.font = `800 46px ${fontSans}`;
      ctx.fillStyle = theme.primary;
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 20;
      }
      drawFittedText(ctx, pred.targetItem.shortLabel, 64, 148, W - 150 - rankBadgeW);
      ctx.restore();

      ctx.save();
      drawRoundRect(ctx, rankBadgeX, rankBadgeY, rankBadgeW, rankBadgeH, 14);
      ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = borderGrad;
      ctx.stroke();
      ctx.fillStyle = theme.primary;
      ctx.font = `800 32px ${fontSans}`;
      ctx.textAlign = "center";
      const badgeTxt = rankTitle ? `${rankTitle} / T${pred.rank.toLocaleString()}` : `T${pred.rank.toLocaleString()} ボーダー`;
      ctx.fillText(badgeTxt, rankBadgeX + rankBadgeW / 2, rankBadgeY + 46);
      ctx.restore();

      const leftX = 64;
      const leftY = 188;
      const leftW = 572;

      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.font = `700 22px ${fontSans}`;
      ctx.fillText(pred.isFinished ? "最終確定ボーダー" : "最終着地予測ボーダー（本命）", leftX + 34, leftY + 54);

      ctx.save();
      ctx.font = `800 60px ${fontMono}`;
      if (theme.rainbow) {
        const txtGrad = ctx.createLinearGradient(leftX + 34, 0, leftX + 520, 0);
        txtGrad.addColorStop(0, "#ff758f");
        txtGrad.addColorStop(0.35, "#ffd166");
        txtGrad.addColorStop(0.7, "#06d6a0");
        txtGrad.addColorStop(1, "#60a5fa");
        ctx.fillStyle = txtGrad;
      } else {
        ctx.fillStyle = theme.forecast;
      }
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 22;
      }
      ctx.fillText(`${formatNumber(pred.centralFinal)} pt`, leftX + 34, leftY + 130);
      ctx.restore();

      if (!pred.isFinished) {
        ctx.fillStyle = theme.accent;
        ctx.font = `700 28px ${fontMono}`;
        ctx.fillText(`誤差目安: ±${formatNumber(pred.halfSpread)} pt`, leftX + 34, leftY + 180);

        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        ctx.font = `600 21px ${fontMono}`;
        ctx.fillText(`レンジ: ${formatNumber(pred.minFinal)} 〜 ${formatNumber(pred.maxFinal)}`, leftX + 34, leftY + 220);
      } else {
        ctx.fillStyle = theme.accent;
        ctx.font = `700 26px ${fontSans}`;
        ctx.fillText("イベント終了・確定値", leftX + 34, leftY + 184);
      }

      const subRows = [
        ["現在スコア", `${formatNumber(pred.currentScore)} pt`],
        ["経過 / 進捗", `${pred.elapsedH.toFixed(1)}h / ${pred.totalH.toFixed(0)}h (${(pred.pCur * 100).toFixed(1)}%)`],
        ["直近平均時速", `${formatNumber(pred.recentPace)} pt/h`],
        ["残り予測増分", pred.isFinished ? "0 pt" : `+${formatNumber(Math.max(0, pred.centralFinal - pred.currentScore))} pt`],
        ["基準データ時刻", formatJST(pred.lastT)],
      ];

      subRows.forEach(([k, v], idx) => {
        const ry = leftY + 308 + idx * 62;
        ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
        ctx.font = `600 21px ${fontSans}`;
        ctx.fillText(k, leftX + 34, ry);

        ctx.fillStyle = "#ffffff";
        ctx.font = `700 22px ${fontMono}`;
        ctx.textAlign = "right";
        ctx.fillText(v, leftX + leftW - 34, ry);
        ctx.textAlign = "left";
      });

      const rightX = 668;
      const rightY = 188;
      const rightW = W - rightX - 64;
      const rightH = 630;

      const gPadL = 102;
      const gPadR = 34;
      const gPadT = 64;
      const gPadB = 60;
      const plotX = rightX + gPadL;
      const plotY = rightY + gPadT;
      const plotW = rightW - gPadL - gPadR;
      const plotH = rightH - gPadT - gPadB;

      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = `700 20px ${fontSans}`;
      ctx.fillText("推移実績 & 着地予測レンジ", rightX + 32, rightY + 40);

      let maxY = Math.max(pred.maxFinal, pred.currentScore);
      for (const m of pred.refModels.slice(0, 3)) maxY = Math.max(maxY, m.hFinal);
      maxY = Math.ceil((maxY * 1.06) / 100000) * 100000 || 500000;

      const xOf = (p) => plotX + Math.max(0, Math.min(1, p)) * plotW;
      const yOf = (v) => plotY + plotH - (Math.max(0, v) / maxY) * plotH;

      ctx.font = `600 17px ${fontMono}`;
      ctx.textAlign = "right";
      for (let i = 0; i <= 5; i++) {
        const val = (maxY * i) / 5;
        const gy = yOf(val);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
        const lbl = val >= 10000 ? `${(val / 10000).toFixed(0)}万` : formatNumber(val);
        ctx.fillText(lbl, plotX - 14, gy + 6);
      }

      ctx.textAlign = "center";
      const stepH = pred.totalH <= 48 ? 6 : pred.totalH <= 120 ? 24 : 48;
      for (let h = 0; h <= pred.totalH; h += stepH) {
        const gx = xOf(h / pred.totalH);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
        ctx.beginPath();
        ctx.moveTo(gx, plotY);
        ctx.lineTo(gx, plotY + plotH);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
        ctx.fillText(`${h}h`, gx, plotY + plotH + 28);
      }
      ctx.textAlign = "left";

      pred.refModels.slice(0, 2).forEach((m) => {
        const g = m.graph;
        const dur = g.endTime - g.startTime;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const step = Math.max(1, Math.floor(g.tier.length / 150));
        for (let i = 0; i < g.tier.length; i += step) {
          const [t, v] = g.tier[i];
          const px = xOf((t - g.startTime) / dur);
          const py = yOf(v);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      });

      if (!pred.isFinished && pred.forecastSeries.length > 1) {
        ctx.save();
        ctx.fillStyle = theme.bandFill;
        ctx.beginPath();
        pred.forecastSeries.forEach((pt, i) => {
          const px = xOf(pt.p);
          const py = yOf(pt.max);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        for (let i = pred.forecastSeries.length - 1; i >= 0; i--) {
          const pt = pred.forecastSeries[i];
          ctx.lineTo(xOf(pt.p), yOf(pt.min));
        }
        ctx.closePath();
        ctx.fill();

        ctx.setLineDash([10, 8]);
        ctx.lineWidth = 4.2;
        ctx.strokeStyle = theme.forecast;
        if (theme.sparkle) {
          ctx.shadowColor = theme.glowColor;
          ctx.shadowBlur = 14;
        }
        ctx.beginPath();
        pred.forecastSeries.forEach((pt, i) => {
          const px = xOf(pt.p);
          const py = yOf(pt.central);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.restore();
      }

      const tPts = pred.targetGraph.tier;
      const tDur = pred.targetGraph.endTime - pred.targetGraph.startTime;
      ctx.save();
      if (theme.rainbow) {
        const lineGrad = ctx.createLinearGradient(plotX, 0, plotX + plotW, 0);
        lineGrad.addColorStop(0, "#ff4d6d");
        lineGrad.addColorStop(0.3, "#ffb703");
        lineGrad.addColorStop(0.6, "#06d6a0");
        lineGrad.addColorStop(1, "#3a86ff");
        ctx.strokeStyle = lineGrad;
      } else {
        ctx.strokeStyle = theme.accent;
      }
      ctx.lineWidth = 5;
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 16;
      }
      ctx.beginPath();
      const step = Math.max(1, Math.floor(tPts.length / 220));
      for (let i = 0; i < tPts.length; i += step) {
        const [t, v] = tPts[i];
        const px = xOf((t - pred.targetGraph.startTime) / tDur);
        const py = yOf(v);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      const [lt, lv] = tPts[tPts.length - 1];
      const lx = xOf((lt - pred.targetGraph.startTime) / tDur);
      const ly = yOf(lv);
      ctx.lineTo(lx, ly);
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const endY = yOf(pred.centralFinal);
      ctx.save();
      ctx.fillStyle = theme.forecast;
      ctx.beginPath();
      ctx.arc(xOf(1), endY, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = "rgba(255, 255, 255, 0.48)";
      ctx.font = `600 17px ${fontMono}`;
      ctx.textAlign = "right";
      ctx.fillText(`Generated at ${formatJST(nowMs)} JST`, W - 64, H - 38);
      ctx.textAlign = "left";
    }

    function drawComparisonSlot(ctx, x, y, w, h, pred, meta, themeOverride = "auto") {
      const rank = pred ? pred.rank : meta.rank || 5000;
      const theme = getTierTheme(rank, themeOverride);
      const rankTitle = getTierRankTitle(rank);

      const borderGrad = ctx.createLinearGradient(x, y, x + w, y + h);
      theme.borderStops.forEach((c, idx) => {
        borderGrad.addColorStop(idx / Math.max(1, theme.borderStops.length - 1), c);
      });

      const pad = 26;

      ctx.save();
      ctx.font = `800 30px ${fontSans}`;
      ctx.fillStyle = theme.primary;
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 14;
      }
      ctx.fillText(rankTitle || `T${rank.toLocaleString()} ボーダー`, x + pad, y + 54);
      ctx.restore();

      const badgeW = 136;
      const badgeH = 40;
      const badgeX = x + w - pad - badgeW;
      const badgeY = y + 23;

      ctx.save();
      drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, 10);
      ctx.fillStyle = "rgba(255, 255, 255, 0.11)";
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = borderGrad;
      ctx.stroke();
      ctx.fillStyle = theme.primary;
      ctx.font = `800 20px ${fontMono}`;
      ctx.textAlign = "center";
      ctx.fillText(`T${rank.toLocaleString()}`, badgeX + badgeW / 2, badgeY + 27);
      ctx.restore();

      if (!pred) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
        ctx.font = `600 17px ${fontSans}`;
        ctx.fillText("このイベント・順位のJSONデータが未取得です。", x + pad, y + 120);
        ctx.fillText("上のボタンからAPIデータをコピーしてください。", x + pad, y + 152);
        return;
      }

      const heroX = x + pad;
      const heroY = y + 78;
      const heroW = w - pad * 2;
      const heroH = 122;
      ctx.save();
      drawRoundRect(ctx, heroX, heroY, heroW, heroH, 12);
      ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "rgba(255, 255, 255, 0.74)";
      ctx.font = `700 15px ${fontSans}`;
      ctx.fillText(pred.isFinished ? "最終確定ボーダー" : "最終着地予測ボーダー（本命）", heroX + 18, heroY + 28);

      ctx.save();
      ctx.font = `800 44px ${fontMono}`;
      if (theme.rainbow) {
        const txtGrad = ctx.createLinearGradient(heroX + 18, 0, heroX + 380, 0);
        txtGrad.addColorStop(0, "#ff758f");
        txtGrad.addColorStop(0.35, "#ffd166");
        txtGrad.addColorStop(0.7, "#06d6a0");
        txtGrad.addColorStop(1, "#60a5fa");
        ctx.fillStyle = txtGrad;
      } else {
        ctx.fillStyle = theme.forecast;
      }
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 16;
      }
      ctx.fillText(`${formatNumber(pred.centralFinal)} pt`, heroX + 18, heroY + 76);
      ctx.restore();

      if (!pred.isFinished) {
        ctx.fillStyle = theme.accent;
        ctx.font = `700 16px ${fontMono}`;
        ctx.fillText(
          `誤差目安: ±${formatNumber(pred.halfSpread)} pt  (${formatNumber(pred.minFinal)} 〜 ${formatNumber(pred.maxFinal)})`,
          heroX + 18,
          heroY + 106
        );
      } else {
        ctx.fillStyle = theme.accent;
        ctx.font = `700 16px ${fontSans}`;
        ctx.fillText("イベント終了・確定スコア", heroX + 18, heroY + 106);
      }

      const gridY = heroY + heroH + 14;
      const colW = (w - pad * 2 - 14) / 2;
      const cellH = 44;
      const subCells = [
        { k: "現在スコア", v: `${formatNumber(pred.currentScore)} pt`, cx: x + pad, cy: gridY },
        {
          k: "経過 / 進捗",
          v: `${pred.elapsedH.toFixed(1)}h / ${pred.totalH.toFixed(0)}h (${(pred.pCur * 100).toFixed(1)}%)`,
          cx: x + pad + colW + 14,
          cy: gridY,
        },
        { k: "直近時速", v: `${formatNumber(pred.recentPace)} pt/h`, cx: x + pad, cy: gridY + cellH + 8 },
        {
          k: "残り予測増分",
          v: pred.isFinished ? "0 pt" : `+${formatNumber(Math.max(0, pred.centralFinal - pred.currentScore))} pt`,
          cx: x + pad + colW + 14,
          cy: gridY + cellH + 8,
        },
      ];

      for (const cell of subCells) {
        ctx.save();
        drawRoundRect(ctx, cell.cx, cell.cy, colW, cellH, 8);
        ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = "rgba(255, 255, 255, 0.64)";
        ctx.font = `600 14px ${fontSans}`;
        ctx.fillText(cell.k, cell.cx + 12, cell.cy + 27);

        ctx.fillStyle = "#ffffff";
        ctx.font = `700 15px ${fontMono}`;
        ctx.textAlign = "right";
        ctx.fillText(cell.v, cell.cx + colW - 12, cell.cy + 27);
        ctx.textAlign = "left";
      }

      const topSplitY = gridY + cellH * 2 + 20;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + pad, topSplitY);
      ctx.lineTo(x + w - pad, topSplitY);
      ctx.stroke();

      const gBoxX = x + pad;
      const gBoxY = topSplitY + 10;
      const gBoxW = w - pad * 2;
      const gBoxH = y + h - 20 - gBoxY;

      ctx.save();
      drawRoundRect(ctx, gBoxX, gBoxY, gBoxW, gBoxH, 12);
      ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = `700 15px ${fontSans}`;
      ctx.fillText("推移実績 & 着地予測レンジ", gBoxX + 16, gBoxY + 26);

      ctx.fillStyle = "rgba(255, 255, 255, 0.58)";
      ctx.font = `600 13px ${fontMono}`;
      ctx.textAlign = "right";
      ctx.fillText(`基準: ${formatJST(pred.lastT)}`, gBoxX + gBoxW - 16, gBoxY + 26);
      ctx.textAlign = "left";

      const gPadL = 68;
      const gPadR = 18;
      const gPadT = 40;
      const gPadB = 32;
      const plotX = gBoxX + gPadL;
      const plotY = gBoxY + gPadT;
      const plotW = gBoxW - gPadL - gPadR;
      const plotH = gBoxH - gPadT - gPadB;

      let maxY = Math.max(pred.maxFinal, pred.currentScore);
      for (const m of pred.refModels.slice(0, 3)) maxY = Math.max(maxY, m.hFinal);
      maxY = Math.ceil((maxY * 1.06) / 100000) * 100000 || 500000;

      const xOf = (p) => plotX + Math.max(0, Math.min(1, p)) * plotW;
      const yOf = (v) => plotY + plotH - (Math.max(0, v) / maxY) * plotH;

      ctx.font = `600 13px ${fontMono}`;
      ctx.textAlign = "right";
      for (let i = 0; i <= 4; i++) {
        const val = (maxY * i) / 4;
        const gy = yOf(val);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
        const lbl = val >= 10000 ? `${(val / 10000).toFixed(0)}万` : formatNumber(val);
        ctx.fillText(lbl, plotX - 10, gy + 4);
      }

      ctx.textAlign = "center";
      const stepH = pred.totalH <= 48 ? 12 : pred.totalH <= 120 ? 24 : 48;
      for (let hr = 0; hr <= pred.totalH; hr += stepH) {
        const gx = xOf(hr / pred.totalH);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
        ctx.beginPath();
        ctx.moveTo(gx, plotY);
        ctx.lineTo(gx, plotY + plotH);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
        ctx.fillText(`${hr}h`, gx, plotY + plotH + 20);
      }
      ctx.textAlign = "left";

      pred.refModels.slice(0, 2).forEach((m) => {
        const g = m.graph;
        const dur = g.endTime - g.startTime;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const step = Math.max(1, Math.floor(g.tier.length / 120));
        for (let i = 0; i < g.tier.length; i += step) {
          const [t, v] = g.tier[i];
          const px = xOf((t - g.startTime) / dur);
          const py = yOf(v);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      });

      if (!pred.isFinished && pred.forecastSeries.length > 1) {
        ctx.save();
        ctx.fillStyle = theme.bandFill;
        ctx.beginPath();
        pred.forecastSeries.forEach((pt, i) => {
          const px = xOf(pt.p);
          const py = yOf(pt.max);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        for (let i = pred.forecastSeries.length - 1; i >= 0; i--) {
          const pt = pred.forecastSeries[i];
          ctx.lineTo(xOf(pt.p), yOf(pt.min));
        }
        ctx.closePath();
        ctx.fill();

        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = theme.forecast;
        if (theme.sparkle) {
          ctx.shadowColor = theme.glowColor;
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        pred.forecastSeries.forEach((pt, i) => {
          const px = xOf(pt.p);
          const py = yOf(pt.central);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.restore();
      }

      const tPts = pred.targetGraph.tier;
      const tDur = pred.targetGraph.endTime - pred.targetGraph.startTime;
      ctx.save();
      if (theme.rainbow) {
        const lineGrad = ctx.createLinearGradient(plotX, 0, plotX + plotW, 0);
        lineGrad.addColorStop(0, "#ff4d6d");
        lineGrad.addColorStop(0.3, "#ffb703");
        lineGrad.addColorStop(0.6, "#06d6a0");
        lineGrad.addColorStop(1, "#3a86ff");
        ctx.strokeStyle = lineGrad;
      } else {
        ctx.strokeStyle = theme.accent;
      }
      ctx.lineWidth = 3.8;
      if (theme.sparkle) {
        ctx.shadowColor = theme.glowColor;
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      const step = Math.max(1, Math.floor(tPts.length / 180));
      for (let i = 0; i < tPts.length; i += step) {
        const [t, v] = tPts[i];
        const px = xOf((t - pred.targetGraph.startTime) / tDur);
        const py = yOf(v);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      const [lt, lv] = tPts[tPts.length - 1];
      const lx = xOf((lt - pred.targetGraph.startTime) / tDur);
      const ly = yOf(lv);
      ctx.lineTo(lx, ly);
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(lx, ly, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const endY = yOf(pred.centralFinal);
      ctx.save();
      ctx.fillStyle = theme.forecast;
      ctx.beginPath();
      ctx.arc(xOf(1), endY, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawMultiCards(canvas, slots, options = {}) {
      const themeOverride = options.themeOverride || "auto";
      const nowMs = options.nowMs || Date.now();
      const primaryItem = options.primaryItem || slots[0]?.pred?.targetItem || slots[0]?.item || null;
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      const isTriple = slots.length >= 3;
      ctx.clearRect(0, 0, W, H);

      const slotRanks = slots.map((s) => (s.pred ? s.pred.rank : s.rank || 5000));
      const bgKey = `multi:${W}x${H}:ranks=${slotRanks.join(",")}:t${themeOverride}`;
      applyCachedBackground(ctx, W, H, bgKey, (bCtx) =>
        paintMultiStaticBackground(bCtx, W, H, slotRanks, themeOverride)
      );

      const marginX = 32;
      const gapX = 24;
      const topBarY = 22;
      const topBarH = 88;

      if (primaryItem) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
        ctx.font = `600 16px ${fontSans}`;
        ctx.fillText(
          `${primaryItem.catLabel}  ｜  開催期間: ${formatJST(primaryItem.startTime)} 〜 ${formatJST(primaryItem.endTime)}`,
          marginX + 36,
          topBarY + 32
        );

        const fullTitle = primaryItem.chapterName
          ? `${primaryItem.eventName}  ／  ${primaryItem.chapterName}`
          : primaryItem.eventName || primaryItem.shortLabel;

        ctx.fillStyle = "#ffffff";
        ctx.font = `800 32px ${fontSans}`;
        drawFittedText(ctx, fullTitle, marginX + 36, topBarY + 72, W - marginX * 2 - 420);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.font = `800 30px ${fontSans}`;
        ctx.fillText("イベントデータ待機中", marginX + 36, topBarY + 56);
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.font = `700 16px ${fontSans}`;
      ctx.textAlign = "right";
      ctx.fillText(
        isTriple ? "BORDER FORECAST OVERVIEW" : "BORDER FORECAST COMPARISON",
        W - marginX - 22,
        topBarY + 34
      );

      ctx.fillStyle = "rgba(255, 255, 255, 0.52)";
      ctx.font = `600 15px ${fontMono}`;
      ctx.fillText(`Generated at ${formatJST(nowMs)} JST`, W - marginX - 22, topBarY + 68);
      ctx.textAlign = "left";

      const cardY = topBarY + topBarH + 18;
      const cardH = H - cardY - 24;
      const cardW = (W - marginX * 2 - gapX * (slots.length - 1)) / slots.length;

      slots.forEach((slot, idx) => {
        const cx = marginX + idx * (cardW + gapX);
        drawComparisonSlot(
          ctx,
          cx,
          cardY,
          cardW,
          cardH,
          slot.pred || null,
          { item: slot.item || null, rank: slot.rank },
          themeOverride
        );
      });
    }

    /**
     * 統合描画エントリポイント（single / dual / triple 全対応）
     * @param {Object} params
     * @param {"single"|"dual"|"triple"} [params.mode="triple"]
     * @param {string} [params.themeOverride="auto"]
     * @param {Object} [params.singleSlot] - { item, rank, pred }
     * @param {Array} [params.slots] - [{ item, rank, pred }, ...]
     * @param {Object} [params.primaryItem]
     * @param {HTMLCanvasElement|null} [params.targetCanvas] - ブラウザ上の既存<canvas>要素（省略時はプールキャンバスを使用）
     * @param {number} [params.nowMs]
     */
    function renderReport(params = {}) {
      const mode = params.mode || "triple";
      const themeOverride = params.themeOverride || "auto";
      const nowMs = params.nowMs || Date.now();

      if (mode === "single") {
        const canvas = getPooledCanvas(1600, 900, params.targetCanvas || null);
        if (!canvas) return null;
        const pred = params.singleSlot?.pred || params.slots?.[0]?.pred || null;
        drawSingleCard(canvas, pred, { themeOverride, nowMs });
        return canvas;
      }

      if (mode === "dual") {
        const canvas = getPooledCanvas(1600, 900, params.targetCanvas || null);
        if (!canvas) return null;
        const slots = (params.slots || []).slice(0, 2);
        drawMultiCards(canvas, slots, {
          themeOverride,
          nowMs,
          primaryItem: params.primaryItem || null,
        });
        return canvas;
      }

      // デフォルト: triple (2160 x 820)
      const canvas = getPooledCanvas(2160, 820, params.targetCanvas || null);
      if (!canvas) return null;
      const slots = (params.slots || []).slice(0, 3);
      drawMultiCards(canvas, slots, {
        themeOverride,
        nowMs,
        primaryItem: params.primaryItem || null,
      });
      return canvas;
    }

    /**
     * Node.js サーバー用：描画して Discord 送信用 Buffer（850KB以下最適化）を直接返す
     */
    function renderReportBuffer(params = {}) {
      const canvas = renderReport(params);
      if (!canvas || typeof canvas.toBuffer !== "function") return null;

      const pngBuf = canvas.toBuffer("image/png");
      if (pngBuf.length <= 850 * 1024) {
        return { buffer: pngBuf, filename: "border_prediction.png" };
      }
      let jpgBuf;
      try {
        jpgBuf = canvas.toBuffer("image/jpeg", 90);
      } catch (_) {
        jpgBuf = canvas.toBuffer("image/jpeg", { quality: 0.90 });
      }
      return { buffer: jpgBuf, filename: "border_prediction.jpg" };
    }

    return {
      setFontFamilies,
      drawSingleCard,
      drawMultiCards,
      renderReport,
      renderReportBuffer,
    };
  }

  return {
    // 定数
    DAYS_JP,
    TIER_DEFS,
    // 日時・テキストユーティリティ
    normalizeEventCategory,
    parseJstDateTime,
    formatNumber,
    formatJST,
    formatRoundedJstTime,
    formatManRounded,
    buildNowBorderPayloadFromGraphs,
    // 予測モデル v6.4 ＆ 補正ロジック
    calcMedian,
    calcWeightedMedian,
    interpScoreAtTime,
    interpScoreAtProgress,
    getJstParts,
    getJstHour,
    getJstDayOfWeek,
    isSingleDayHolidayJST,
    isJapaneseHolidayJST,
    getDefaultSlot30Factor,
    buildCalendarProfileFromRefs,
    getEffectiveCalFactor,
    computeEmaPace,
    calcTrajectoryShapeSimilarity,
    getChapterNumber,
    applyNaturalManualAdjustment,
    computePrediction,
    // 描画ユーティリティ ＆ 省負荷レンダラー
    getTierRankTitle,
    getTierTheme,
    drawRoundRect,
    drawFittedText,
    createReportRenderer,
  };
});
