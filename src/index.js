const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require("discord.js");

let createCanvas = null;
let registerCustomFont = null;
try {
  const napiCanvas = require("@napi-rs/canvas");
  createCanvas = napiCanvas.createCanvas;
  registerCustomFont = (fontPath, family) => {
    napiCanvas.GlobalFonts.registerFromPath(fontPath, family);
  };
} catch (_) {
  try {
    const nodeCanvas = require("canvas");
    createCanvas = nodeCanvas.createCanvas;
    registerCustomFont = (fontPath, family) => {
      nodeCanvas.registerFont(fontPath, { family, weight: "bold" });
      nodeCanvas.registerFont(fontPath, { family, weight: "normal" });
    };
  } catch (err) {
    console.warn("[Canvas] Canvasパッケージ未読込:", err.message);
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 8000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "2226";

const HOLODORI_API_BASE = "https://holodori-border.com/api";
const GITHUB_ARCHIVE_BASE = "https://raw.githubusercontent.com/holodori-tools/event-borders/main/archive";

const DAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const TIER_DEFS = [
  { rank: 1000, label: "ドリーム級" },
  { rank: 5000, label: "ダイヤ級" },
  { rank: 10000, label: "プラチナ級" },
];

// =========================================================================
// 1. 日本語フォント初期化（Linuxコンテナでの文字化け防止）
// =========================================================================
let serverFontFamily = "sans-serif";

async function ensureJapaneseFont() {
  if (!registerCustomFont) return;
  const jpFontPath = "/tmp/NotoSansJP-Bold.ttf";
  const symFontPath = "/tmp/NotoSansSymbols2-Regular.ttf";
  try {
    if (!fs.existsSync(jpFontPath)) {
      const jpUrls = [
        "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-jp@latest/japanese-700-normal.ttf",
        "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf",
      ];
      for (const url of jpUrls) {
        const res = await fetch(url);
        if (res.ok) {
          fs.writeFileSync(jpFontPath, Buffer.from(await res.arrayBuffer()));
          break;
        }
      }
    }
    if (!fs.existsSync(symFontPath)) {
      const symUrls = [
        "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf",
        "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-symbols-2@latest/symbols-400-normal.ttf",
      ];
      for (const url of symUrls) {
        const res = await fetch(url);
        if (res.ok) {
          fs.writeFileSync(symFontPath, Buffer.from(await res.arrayBuffer()));
          break;
        }
      }
    }
    const families = [];
    if (fs.existsSync(jpFontPath)) {
      registerCustomFont(jpFontPath, "NotoSansJP");
      families.push("NotoSansJP");
    }
    if (fs.existsSync(symFontPath)) {
      registerCustomFont(symFontPath, "NotoSymbols2");
      families.push("NotoSymbols2");
    }
    families.push("sans-serif");
    serverFontFamily = families.join(", ");
    console.log(`[Font] フォント登録完了: ${serverFontFamily}`);
  } catch (err) {
    console.warn("[Font] フォント取得スキップ:", err.message);
  }
}

// =========================================================================
// 2. Upstash Redis & メモリキャッシュ層
// =========================================================================
const memStore = {
  events: [],
  graphs: {},
  archiveItems: [],
  archiveGraphs: {},
  subscriptions: [],
  manualAdjustments: {},    // { [eventKey]: { "1000": -50000, "5000": 0, ... } }
  nowBorderCache: null,     // { text, timeLabel, updatedAt }
  predictionCache: null,    // { imageBase64, filename, timeLabel, updatedAt }
  lastManualUpdateAt: 0,    // 手動更新の最終タイムスタンプ（10分優先制御用）
  lastAutoFetchAt: 0,
  lastExecutedSlot: "",     // 二重配信防止用スロットキー
  activeEndCache: null,     // { endTime, checkedAt }
};

function normalizeSubscriptions(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val
      .map((v) => (typeof v === "string" ? v : v?.channelId || v?.id))
      .filter((id) => typeof id === "string" && id.length > 0);
  }
  if (typeof val === "object") {
    if (Array.isArray(val.subscriptions)) return normalizeSubscriptions(val.subscriptions);
    if (Array.isArray(val.channels)) return normalizeSubscriptions(val.channels);
    return Object.keys(val).filter((k) => /^\d+$/.test(k));
  }
  return [];
}

async function redisCommand(args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ?? null;
  } catch (err) {
    console.error("[Redis] 通信エラー:", err.message);
    return null;
  }
}

async function saveRedisJson(key, value) {
  await redisCommand(["SET", key, JSON.stringify(value)]);
}

async function loadStateFromRedis() {
  const [evRaw, grRaw, subRaw, nbRaw, prRaw, metaRaw, adjRaw] = await Promise.all([
    redisCommand(["GET", "borderbot:events"]),
    redisCommand(["GET", "borderbot:graphs"]),
    redisCommand(["GET", "borderbot:subscriptions"]),
    redisCommand(["GET", "borderbot:cache:nowborder"]),
    redisCommand(["GET", "borderbot:cache:prediction"]),
    redisCommand(["GET", "borderbot:meta"]),
    redisCommand(["GET", "borderbot:adjustments"]),
  ]);

  if (evRaw) {
    try {
      const parsedEv = JSON.parse(evRaw);
      memStore.events = Array.isArray(parsedEv) ? parsedEv : [];
    } catch (_) {}
  }
  if (grRaw) {
    try {
      const parsedGr = JSON.parse(grRaw);
      memStore.graphs = parsedGr && typeof parsedGr === "object" && !Array.isArray(parsedGr) ? parsedGr : {};
    } catch (_) {}
  }
  if (subRaw) {
    try {
      const parsedSub = JSON.parse(subRaw);
      memStore.subscriptions = normalizeSubscriptions(parsedSub);
      if (!Array.isArray(parsedSub)) {
        await saveRedisJson("borderbot:subscriptions", memStore.subscriptions);
      }
    } catch (_) {
      memStore.subscriptions = [];
    }
  }
  if (nbRaw) {
    try { memStore.nowBorderCache = JSON.parse(nbRaw); } catch (_) {}
  }
  if (prRaw) {
    try { memStore.predictionCache = JSON.parse(prRaw); } catch (_) {}
  }
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      memStore.lastManualUpdateAt = Number(meta.lastManualUpdateAt) || 0;
      memStore.lastAutoFetchAt = Number(meta.lastAutoFetchAt) || 0;
      memStore.lastExecutedSlot = String(meta.lastExecutedSlot || "");
    } catch (_) {}
  }
  if (adjRaw) {
    try {
      const parsedAdj = JSON.parse(adjRaw);
      memStore.manualAdjustments = parsedAdj && typeof parsedAdj === "object" ? parsedAdj : {};
    } catch (_) {}
  }
}

async function persistMeta() {
  await saveRedisJson("borderbot:meta", {
    lastManualUpdateAt: memStore.lastManualUpdateAt,
    lastAutoFetchAt: memStore.lastAutoFetchAt,
    lastExecutedSlot: memStore.lastExecutedSlot,
  });
}

// =========================================================================
// 3. GitHub 過去アーカイブ読込（サーバー側自動予測の参照母集団）
// =========================================================================
async function loadArchiveFromGithubServer() {
  try {
    const res = await fetch(`${GITHUB_ARCHIVE_BASE}/index.json?t=${Math.floor(Date.now() / 60000)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const manifest = await res.json();
    const entries = Array.isArray(manifest) ? manifest : Array.isArray(manifest.items) ? manifest.items : [];

    const items = [];
    const graphs = {};

    for (const ent of entries) {
      const tierEntries = [];
      for (const [k, val] of Object.entries(ent)) {
        const m = /^t(\d+)$/i.exec(k);
        if (m && typeof val === "string" && val.trim() !== "") {
          tierEntries.push({ rankHint: Number(m[1]), file: val.trim() });
        }
      }
      if (tierEntries.length === 0 && typeof ent.file === "string") {
        tierEntries.push({ rankHint: ent.rank || 5000, file: ent.file.trim() });
      }

      const displayName = ent.tag || ent.name || ent.chapterId || ent.eventId || "archive";
      const key = ent.eventId && ent.chapterId ? `${ent.eventId}::${ent.chapterId}` : `archive::${displayName}`;

      const fetched = await Promise.all(
        tierEntries.map(async (te) => {
          try {
            const gRes = await fetch(`${GITHUB_ARCHIVE_BASE}/${te.file}`);
            if (!gRes.ok) return null;
            const graph = await gRes.json();
            if (!graph || !Array.isArray(graph.tier) || graph.tier.length === 0) return null;
            return { actualRank: Number(graph.rank) || te.rankHint, graph };
          } catch (_) {
            return null;
          }
        })
      );

      let repGraph = null;
      for (const item of fetched) {
        if (!item) continue;
        graphs[`${key}::${item.actualRank}`] = item.graph;
        if (!repGraph) repGraph = item.graph;
      }

      if (repGraph) {
        const durH = (repGraph.endTime - repGraph.startTime) / 3600000;
        const cat = ent.category || "spotlight";
        items.push({
          key,
          eventId: ent.eventId || "archive",
          chapterId: ent.chapterId || displayName,
          category: cat,
          catLabel: cat === "point" ? "ポイントイベント" : "スポットライト",
          eventName: displayName,
          chapterName: null,
          shortLabel: displayName,
          startTime: repGraph.startTime,
          endTime: repGraph.endTime,
          durationH: durH,
          live: false,
        });
      }
    }

    memStore.archiveItems = items;
    memStore.archiveGraphs = graphs;
    console.log(`[Archive] GitHub過去データ読込完了: ${items.length}イベント`);
  } catch (err) {
    console.warn("[Archive] GitHub過去データ読込エラー:", err.message);
  }
}

// =========================================================================
// 4. 日時・テキスト整形ヘルパー
// =========================================================================
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

function rebuildNowBorderCacheFromGraphs(targetPrefix = null) {
  const keys = Object.keys(memStore.graphs);
  if (keys.length === 0) return memStore.nowBorderCache;

  let chosenPrefix = targetPrefix;
  if (!chosenPrefix) {
    let newestTs = -1;
    for (const k of keys) {
      const g = memStore.graphs[k];
      if (!g || !Array.isArray(g.tier) || g.tier.length === 0) continue;
      const lastT = g.tier[g.tier.length - 1][0];
      if (lastT > newestTs) {
        newestTs = lastT;
        chosenPrefix = k.replace(/::\d+$/, "");
      }
    }
  }
  if (!chosenPrefix) return memStore.nowBorderCache;

  let latestTimestamp = 0;
  const lines = [];

  for (const tier of TIER_DEFS) {
    const g = memStore.graphs[`${chosenPrefix}::${tier.rank}`];
    if (g && Array.isArray(g.tier) && g.tier.length > 0) {
      const [lastT, lastVal] = g.tier[g.tier.length - 1];
      if (lastT > latestTimestamp) latestTimestamp = lastT;
      lines.push(`${tier.label} ${formatManRounded(lastVal)}`);
    } else {
      lines.push(`${tier.label} 未取得`);
    }
  }

  if (latestTimestamp === 0) return memStore.nowBorderCache;

  const timeLabel = formatRoundedJstTime(latestTimestamp);
  const text = [`最終更新(${timeLabel})時点のボーダーです！`, ...lines].join("\n");
  const cacheObj = {
    text,
    timeLabel,
    updatedAt: latestTimestamp,
  };
  memStore.nowBorderCache = cacheObj;
  saveRedisJson("borderbot:cache:nowborder", cacheObj).catch(() => {});
  return cacheObj;
}

// =========================================================================
// 5. サーバーサイド着地予測モデル（v5 キャリブレーション版・1分/10分両対応）
// =========================================================================
function calcMedian(values) {
  if (!values || values.length === 0) return 1.0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
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
  let lo = 0, hi = pts.length - 1;
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

function getJstHour(ms) {
  return new Date(ms + 9 * 3600 * 1000).getUTCHours();
}

function getJstDayOfWeek(ms) {
  return new Date(ms + 9 * 3600 * 1000).getUTCDay();
}

function getJstHourActivityFactor(ms) {
  const h = getJstHour(ms);
  const table = [
    0.55, 0.35, 0.22, 0.16, 0.15, 0.20,
    0.35, 0.55, 0.65, 0.65, 0.70, 0.75,
    0.85, 0.80, 0.80, 0.85, 0.90, 1.00,
    1.10, 1.20, 1.35, 1.40, 1.25, 0.90,
  ];
  return table[h] || 1.0;
}

function getWindowAvgJstActivity(graph, endT, winMs) {
  const st = graph.startTime;
  const actualWin = Math.max(60000, Math.min(winMs, endT - st));
  let sum = 0;
  for (let k = 0; k <= 4; k++) {
    sum += getJstHourActivityFactor(endT - actualWin * (k / 4));
  }
  return Math.max(0.20, sum / 5);
}

function getChapterFatigueFactor(item) {
  const rawId = `${item?.chapterId || ""} ${item?.key || ""}`;
  const m = /chapter[-_]?0*(\d+)/i.exec(rawId);
  if (!m) return 1.0;
  const ch = Number(m[1]);
  if (ch <= 1) return 1.00;
  if (ch === 2) return 0.99;
  if (ch === 3) return 0.975;
  return 0.955;
}

function getJstTimeZoneConfig(lastT, remH, pCur) {
  const h = getJstHour(lastT);
  let zone;
  if (h >= 1 && h <= 4) {
    zone = { label: "深夜停滞帯", winH: 6.0, wPace: 0.10, clampLo: 0.90, clampHi: 1.10 };
  } else if (h >= 5 && h <= 8) {
    zone = { label: "早朝・通勤帯", winH: 6.0, wPace: 0.15, clampLo: 0.88, clampHi: 1.12 };
  } else if (h >= 9 && h <= 16) {
    zone = { label: "日中巡航帯", winH: 3.0, wPace: 0.30, clampLo: 0.82, clampHi: 1.18 };
  } else if (h >= 17 && h <= 22) {
    zone = { label: "ゴールデン帯", winH: 2.0, wPace: 0.45, clampLo: 0.75, clampHi: 1.25 };
  } else {
    zone = { label: "深夜切替帯", winH: 3.0, wPace: 0.25, clampLo: 0.85, clampHi: 1.15 };
  }

  if (remH <= 2.0) {
    return { label: "最終追い込み(残2h内)", winH: 0.75, wPace: 0.80, clampLo: 0.70, clampHi: 1.65 };
  }
  if (remH <= 4.0) {
    return { label: "スパート加速(残4h内)", winH: 1.25, wPace: 0.65, clampLo: 0.75, clampHi: 1.55 };
  }
  if (remH <= 6.0) {
    return { label: "終盤スパート域(残6h内)", winH: 1.75, wPace: Math.max(zone.wPace, 0.52), clampLo: 0.78, clampHi: 1.45 };
  }
  if (pCur < 0.35) {
    const earlyBoost = 0.22 * (1.0 - pCur / 0.35);
    zone.wPace = Math.min(0.55, zone.wPace + earlyBoost);
  }
  return zone;
}

function calcHistoricalPaceLimit(targetGraph, eraAdjustedRefs, currentScore, elapsedMs, remH, recentPace) {
  if (!eraAdjustedRefs || eraAdjustedRefs.length === 0 || remH <= 0) {
    return Infinity;
  }
  const st = targetGraph.startTime;
  const et = targetGraph.endTime;
  const dur = et - st;
  const lastT = st + elapsedMs;
  const pCur = Math.min(1, elapsedMs / dur);

  // 1. 過去イベントにおける「残り同等時間（remH）」での歴代最高平均時速
  let maxHistRemPace = 0;
  for (const rObj of eraAdjustedRefs) {
    const g = rObj.graph;
    const gDur = g.endTime - g.startTime;
    const gCur = interpScoreAtProgress(g, pCur) * rObj.eraScale;
    const gFinal = g.tier[g.tier.length - 1][1] * rObj.eraScale;
    const gRemH = Math.max(0.1, (1 - pCur) * (gDur / 3600000));
    const gRemPace = Math.max(0, (gFinal - gCur) / gRemH);
    if (gRemPace > maxHistRemPace) maxHistRemPace = gRemPace;
  }
  if (maxHistRemPace <= 0) return Infinity;

  // 2. 例外判定：開始〜現在までの各区間で、過去イベント並み〜それ以上のハイペースを維持してきたか
  const checkpoints = [0.25, 0.50, 0.75, 1.0];
  let sustainedRatios = [];
  for (let i = 0; i < checkpoints.length; i++) {
    const frac = checkpoints[i];
    const prevFrac = i === 0 ? 0 : checkpoints[i - 1];
    const t0 = st + elapsedMs * prevFrac;
    const t1 = st + elapsedMs * frac;
    const segH = (t1 - t0) / 3600000;
    if (segH < 0.5) continue;

    const s0 = interpScoreAtTime(targetGraph, t0);
    const s1 = interpScoreAtTime(targetGraph, t1);
    const curSegPace = (s1 - s0) / segH;

    let maxHistSegPace = 0;
    for (const rObj of eraAdjustedRefs) {
      const g = rObj.graph;
      const gDur = g.endTime - g.startTime;
      const gp0 = ((t0 - st) / dur) * gDur + g.startTime;
      const gp1 = ((t1 - st) / dur) * gDur + g.startTime;
      const gs0 = interpScoreAtTime(g, gp0) * rObj.eraScale;
      const gs1 = interpScoreAtTime(g, gp1) * rObj.eraScale;
      const gSegH = Math.max(0.1, (gp1 - gp0) / 3600000);
      const gSegPace = (gs1 - gs0) / gSegH;
      if (gSegPace > maxHistSegPace) maxHistSegPace = gSegPace;
    }
    if (maxHistSegPace > 0) {
      sustainedRatios.push(curSegPace / maxHistSegPace);
    }
  }

  // 全区間の中央値・最小値が過去最高水準の95%以上なら「歴代最速ペース推移（例外）」と判定
  let capMultiplier = 1.10;
  if (sustainedRatios.length >= 2) {
    const minRatio = Math.min(...sustainedRatios);
    const medRatio = calcMedian(sustainedRatios);
    if (minRatio >= 0.95 && medRatio >= 1.00) {
      // 過去最高を継続的に上回っている超過分に応じて上限を緩和（最大1.30倍まで）
      capMultiplier = Math.min(1.30, Math.max(1.10, medRatio * 1.05));
    }
  }

  // 直近実測時速そのものは下回らないよう保護しつつ上限を設定
  return Math.max(recentPace * 1.05, maxHistRemPace * capMultiplier);
}

// 元の予測カーブの曲線形状を保ったまま、残り増分を比率伸縮して手動補正を適用
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

function computePredictionServer(targetItem, targetGraph, refPairs, targetRank, manualAdjustPt = 0) {
  const st = targetGraph.startTime;
  const et = targetGraph.endTime;
  const dur = et - st;
  const pts = targetGraph.tier;
  const lastPt = pts[pts.length - 1];
  const lastT = lastPt[0];
  const currentScore = lastPt[1];
  const elapsedMs = Math.max(60000, lastT - st);
  const elapsedH = elapsedMs / 3600000;
  const remH = Math.max(0, (et - lastT) / 3600000);
  const pCur = Math.min(1, elapsedMs / dur);
  const isFinished = pCur >= 0.998 && !targetItem.live;

  // 直近1時間時速（最低20分窓を確保）
  const display1hMs = Math.min(3600 * 1000, Math.max(20 * 60 * 1000, elapsedMs * 0.12));
  const sDisplayPrev = interpScoreAtTime(targetGraph, Math.max(st, lastT - display1hMs));
  const recentPace = ((currentScore - sDisplayPrev) / display1hMs) * 3600000;

  const zoneCfg = getJstTimeZoneConfig(lastT, remH, pCur);
  const zoneWinMs = Math.min(elapsedMs * 0.85, Math.max(20 * 60 * 1000, zoneCfg.winH * 3600 * 1000));
  const sZonePrev = interpScoreAtTime(targetGraph, Math.max(st, lastT - zoneWinMs));
  const zonePace = ((currentScore - sZonePrev) / zoneWinMs) * 3600000;
  const curZoneAct = getWindowAvgJstActivity(targetGraph, lastT, zoneWinMs);
  const normalizedCurPace = zonePace / curZoneAct;

  const win6hMs = Math.min(elapsedMs, 6 * 3600 * 1000);
  const pace6h = ((currentScore - interpScoreAtTime(targetGraph, Math.max(st, lastT - win6hMs))) / Math.max(1, win6hMs)) * 3600000;
  let trendFactor = 1.0;
  if (elapsedH >= 14.0) {
    const tMid6 = lastT - 6 * 3600 * 1000;
    const tPrev12 = Math.max(st, lastT - 12 * 3600 * 1000);
    if (tMid6 - tPrev12 >= 3 * 3600 * 1000) {
      const sMid6 = interpScoreAtTime(targetGraph, tMid6);
      const sPrev12 = interpScoreAtTime(targetGraph, tPrev12);
      const pLast6 = (currentScore - sMid6) / 6.0;
      const pPrev6 = (sMid6 - sPrev12) / ((tMid6 - tPrev12) / 3600000);
      const npLast6 = pLast6 / Math.max(0.2, getJstHourActivityFactor(lastT - 3 * 3600 * 1000));
      const npPrev6 = pPrev6 / Math.max(0.2, getJstHourActivityFactor((tMid6 + tPrev12) * 0.5));
      if (npPrev6 > 0) {
        const ratioTrend = npLast6 / npPrev6;
        if (ratioTrend < 0.96) {
          trendFactor = Math.max(0.96, Math.min(1.0, 1.0 + (ratioTrend - 1.0) * 0.18));
        }
      }
    }
  }

  // 終盤6時間以内の急加速モメンタム補正（直近1h時速が6h平均を大きく上回る場合）
  let accelBoost = 1.0;
  if (remH <= 6.0 && pace6h > 0 && recentPace > pace6h) {
    const surgeRatio = recentPace / pace6h;
    const rankGain = Number(targetRank) <= 1000 ? 0.22 : Number(targetRank) >= 10000 ? 0.18 : 0.04;
    accelBoost = Math.min(1.24, 1.0 + (surgeRatio - 1.0) * rankGain);
  }

  const naiveLinear = pCur > 0.02 ? currentScore / pCur : currentScore;

  const validRefs = refPairs
    .filter(({ graph }) => {
      if (!graph || !Array.isArray(graph.tier) || graph.tier.length < 15) return false;
      if (graph.rank && Number(graph.rank) !== Number(targetRank)) return false;
      const gDur = graph.endTime - graph.startTime;
      const gProg = (graph.tier[graph.tier.length - 1][0] - graph.startTime) / Math.max(1, gDur);
      return gProg >= 0.98;
    })
    .sort((a, b) => b.graph.endTime - a.graph.endTime);

  let monthlyGrowthRate = 0.005;
  if (validRefs.length >= 3) {
    const refPts = validRefs.map((r) => {
      const rDurH = (r.graph.endTime - r.graph.startTime) / 3600000;
      const rFinal = r.graph.tier[r.graph.tier.length - 1][1];
      return {
        tMonths: (r.graph.startTime - st) / (30 * 24 * 3600 * 1000),
        val: rFinal / Math.max(1, rDurH),
      };
    });
    const meanT = refPts.reduce((a, b) => a + b.tMonths, 0) / refPts.length;
    const meanV = refPts.reduce((a, b) => a + b.val, 0) / refPts.length;
    let num = 0, den = 0;
    for (const p of refPts) {
      num += (p.tMonths - meanT) * (p.val - meanV);
      den += Math.pow(p.tMonths - meanT, 2);
    }
    if (den > 0.05 && meanV > 0) {
      monthlyGrowthRate = Math.max(0.0, Math.min(0.008, num / den / meanV));
    }
  }

  const eraAdjustedRefs = validRefs.map((r) => {
    const monthsAgo = (st - r.graph.startTime) / (30 * 24 * 3600 * 1000);
    const eraScale = Math.max(0.95, Math.min(1.05, 1.0 + monthlyGrowthRate * monthsAgo));
    return {
      ...r,
      monthsAgo,
      eraScale,
      adjFinal: r.graph.tier[r.graph.tier.length - 1][1] * eraScale,
    };
  });

  const targetEndHour = getJstHour(et);
  const targetEndDay = getJstDayOfWeek(et);
  const targetStartDay = getJstDayOfWeek(st);
  const weekendEndFactor = targetEndDay === 0 && targetEndHour >= 17 ? 1.015 : 1.0;

  let resourceFactor = 1.0;
  if (Array.isArray(memStore.events) && memStore.events.length > 0) {
    const priorEvents = memStore.events
      .filter((ev) => ev.endTime && ev.endTime <= st + 3600000 && ev.eventId !== targetItem.eventId)
      .sort((a, b) => b.endTime - a.endTime);

    if (priorEvents.length > 0) {
      const prevEv = priorEvents[0];
      const prevName = prevEv.name || "";
      if (prevEv.isSongScore === true || prevName.includes("スコア")) {
        resourceFactor *= 1.02;
      }
    }
  }

  if (eraAdjustedRefs.length >= 3) {
    const medAdjFinal = calcMedian(eraAdjustedRefs.map((r) => r.adjFinal));
    const prevSameCat = eraAdjustedRefs.find(
      (r) => r.graph.endTime <= st + 3600000 && st - r.graph.endTime < 7 * 24 * 3600 * 1000
    );
    if (prevSameCat && medAdjFinal > 0) {
      const prevHeatRatio = prevSameCat.adjFinal / medAdjFinal;
      if (prevHeatRatio > 1.15) {
        const rebound = Math.max(0.90, Math.min(1.0, 1.0 - (prevHeatRatio - 1.0) * 0.10));
        resourceFactor *= rebound;
      }
    }
  }

  const rawFatigue = getChapterFatigueFactor(targetItem);
  const targetFatigue = remH <= 6.0 ? 1.0 - (1.0 - rawFatigue) * 0.45 : rawFatigue;
  const wPaceWeight = zoneCfg.wPace;
  const wLevelWeight = 1.0 - wPaceWeight;

  const rNows = [];
  const rPaces = [];
  const refCalcs = [];

  for (const rObj of eraAdjustedRefs) {
    const { item, graph, monthsAgo, eraScale } = rObj;
    const gDur = graph.endTime - graph.startTime;
    const rawHCur = interpScoreAtProgress(graph, pCur);
    const rawHFinal = graph.tier[graph.tier.length - 1][1];
    if (!rawHCur || rawHCur <= 0 || rawHFinal <= rawHCur) continue;

    const hCur = rawHCur * eraScale;
    const hFinal = rawHFinal * eraScale;
    const rNow = currentScore / hCur;

    const hTargetT = graph.startTime + pCur * gDur;
    const hRecentPrev = interpScoreAtTime(graph, Math.max(graph.startTime, hTargetT - zoneWinMs)) * eraScale;
    const hRecentPace = ((hCur - hRecentPrev) / zoneWinMs) * 3600000;
    const hActivity = getWindowAvgJstActivity(graph, hTargetT, zoneWinMs);
    const hNormPace = hRecentPace / hActivity;
    const rawRPace = hNormPace > 0 ? normalizedCurPace / hNormPace : rNow;
    const rPace = Math.max(rNow * zoneCfg.clampLo, Math.min(rNow * zoneCfg.clampHi, rawRPace));

    const h1Prev = interpScoreAtTime(graph, Math.max(graph.startTime, hTargetT - display1hMs)) * eraScale;
    const h1Pace = ((hCur - h1Prev) / display1hMs) * 3600000;

    const h6Prev = interpScoreAtTime(graph, Math.max(graph.startTime, hTargetT - win6hMs)) * eraScale;
    const hPace6h = ((hCur - h6Prev) / Math.max(1, win6hMs)) * 3600000;

    rNows.push(rNow);
    rPaces.push(rPace);
    refCalcs.push({ item, graph, monthsAgo, eraScale, rawHCur, rawHFinal, hCur, hFinal, rNow, rPace, h1Pace, hPace6h });
  }

  const medRNow = calcMedian(rNows);
  const medRPace = calcMedian(rPaces);
  const liveHeat = wLevelWeight * medRNow + wPaceWeight * medRPace;

  // 階級別の終盤スパート弾力性（ダイヤ級は0.07を維持、ドリーム・プラチナの終盤スパートを適正化）
  const alpha = Number(targetRank) <= 1000 ? 0.14 : Number(targetRank) >= 10000 ? 0.14 : 0.07;
  const clampedHeat = Math.max(0.65, Math.min(2.30, liveHeat));
  const remDamp = Math.pow(Math.max(0, 1.0 - pCur), 0.65);
  const tierElasticity = Math.pow(clampedHeat, alpha * remDamp);

  const gridSteps = 96;
  const stepDtH = remH / gridSteps;
  const isNightEnd = targetEndHour >= 1 && targetEndHour <= 6;
  const maxAllowedPace = calcHistoricalPaceLimit(
    targetGraph,
    eraAdjustedRefs,
    currentScore,
    elapsedMs,
    remH,
    recentPace
  );
  const refModels = [];

  for (const rc of refCalcs) {
    const { item, graph, monthsAgo, eraScale, rawHCur, rawHFinal, hCur, hFinal, rNow, rPace, h1Pace, hPace6h } = rc;
    const refFatigue = getChapterFatigueFactor(item);
    const relFatigue = targetFatigue / Math.max(0.5, refFatigue);
    const baseMultiplier = wLevelWeight * rNow + wPaceWeight * rPace;
    const envMultiplier = weekendEndFactor * resourceFactor * trendFactor * relFatigue * accelBoost;

    const stepCurve = [currentScore];
    let accScore = currentScore;
    let prevH = hCur;

    if (!isFinished) {
      for (let s = 1; s <= gridSteps; s++) {
        const pStep = pCur + ((1 - pCur) * s) / gridSteps;
        const pMid = pCur + ((1 - pCur) * (s - 0.5)) / gridSteps;
        const hStep = interpScoreAtProgress(graph, pStep) * eraScale;
        const dh = Math.max(0, hStep - prevH);
        prevH = hStep;

        const remHMid = ((1 - pMid) * dur) / 3600000;
        const elapsedFromNowH = (s - 0.5) * stepDtH;
        const stepElasticity = remHMid <= 4.5 ? tierElasticity : 1.0 + (tierElasticity - 1.0) * 0.45;

        let rawInc = dh * baseMultiplier * envMultiplier * stepElasticity;

        // 終盤6時間以内の予測曲線下限フロアー ＆ 初速の滑らかな接続
        if (remH <= 6.0 && recentPace > 0) {
          let floorRatio = 1.0;
          if (isNightEnd) {
            floorRatio = 0.70;
          } else if (remHMid > 3.0) {
            floorRatio = 0.90;
          } else if (remHMid > 1.5) {
            floorRatio = 0.95;
          } else {
            floorRatio = 1.00;
          }

          // 予測開始直後の30分間は現在時速の96%から滑らかに接続
          if (elapsedFromNowH < 0.5) {
            const blend = elapsedFromNowH / 0.5;
            const connRatio = 0.96 * (1.0 - blend) + floorRatio * blend;
            floorRatio = Math.max(floorRatio, connRatio);
          }

          const minInc = recentPace * floorRatio * stepDtH;
          rawInc = Math.max(rawInc, minInc);
        }

        if (Number.isFinite(maxAllowedPace) && stepDtH > 0) {
          rawInc = Math.min(rawInc, maxAllowedPace * stepDtH);
        }

        accScore += rawInc;
        stepCurve.push(accScore);
      }
    }

    const impliedFinal = isFinished ? currentScore : accScore;
    const recencyWeight = Math.exp(-Math.abs(monthsAgo) / 6.0);
    let simWeight = 1.0;
    const refEndHour = getJstHour(graph.endTime);
    const refStartDay = getJstDayOfWeek(graph.startTime);
    if (Math.abs(item.durationH - targetItem.durationH) < 2) simWeight += 0.7;
    if (refEndHour === targetEndHour) simWeight += 0.7;
    if (refStartDay === targetStartDay) simWeight += 1.2;
    if (item.eventId && item.eventId === targetItem.eventId) simWeight += 0.8;

    const rawScaleSim = Math.min(rNow, 1 / Math.max(1e-4, rNow));
    const scaleSim = Math.pow(rawScaleSim, 1.25);
    const weight = simWeight * recencyWeight * (0.20 + 0.80 * scaleSim);

    refModels.push({
      item,
      graph,
      eraScale,
      hCur: rawHCur,
      hFinal: rawHFinal,
      adjHCur: hCur,
      adjHFinal: hFinal,
      h1Pace,
      hPace6h,
      impliedFinal,
      stepCurve,
      weight,
    });
  }

  refModels.sort((a, b) => b.weight - a.weight);

  const forecastSeries = [];
  let centralFinal = currentScore;
  let minFinal = currentScore;
  let maxFinal = currentScore;

  if (!isFinished && refModels.length > 0) {
    const totalW = refModels.reduce((acc, m) => acc + m.weight, 0);
    const rawCentralFinal = refModels.reduce((acc, m) => acc + m.impliedFinal * m.weight, 0) / totalW;
    centralFinal = rawCentralFinal;

    // 緩和版上限キャップ（直近1hペースが上回っている場合はキャップ解除、それ以外は+15%〜+18%まで許容）
    const upperAnchors = refModels
      .filter((m) => m.adjHCur >= currentScore * 0.98)
      .sort((a, b) => a.adjHCur - b.adjHCur);

    let anchorScale = 1.0;
    if (upperAnchors.length > 0) {
      const ua = upperAnchors[0];
      const isSurgingPastRef = recentPace > ua.h1Pace * 1.03;
      if (!isSurgingPastRef && pace6h <= ua.hPace6h * 1.02) {
        const capMargin = liveHeat > 1.05 ? 1.18 : 1.15;
        const capVal = ua.adjHFinal * capMargin;
        if (centralFinal > capVal) {
          const rawGain = rawCentralFinal - currentScore;
          const cappedGain = Math.max(0, capVal - currentScore);
          anchorScale = rawGain > 0 ? cappedGain / rawGain : 1.0;
          centralFinal = capVal;
        }
      }
    }

    const variance =
      refModels.reduce((acc, m) => {
        const adjImp = currentScore + (m.impliedFinal - currentScore) * anchorScale;
        return acc + m.weight * Math.pow(adjImp - centralFinal, 2);
      }, 0) / totalW;
    const stdDev = Math.sqrt(variance);
    const spreadMargin = Math.max(stdDev * 1.05, (centralFinal - currentScore) * 0.065);

    minFinal = Math.max(currentScore, centralFinal - spreadMargin);
    maxFinal = centralFinal + spreadMargin;

    for (let i = 0; i <= gridSteps; i++) {
      const p = pCur + ((1 - pCur) * i) / gridSteps;
      if (i === 0) {
        forecastSeries.push({ p, central: currentScore, min: currentScore, max: currentScore });
        continue;
      }
      let wSum = 0;
      for (const m of refModels) wSum += m.stepCurve[i] * m.weight;
      const rawCVal = wSum / totalW;
      const cVal = currentScore + (rawCVal - currentScore) * anchorScale;
      const stepRatio = (p - pCur) / Math.max(1e-4, 1 - pCur);
      const curMargin = spreadMargin * Math.pow(stepRatio, 0.85);
      forecastSeries.push({
        p,
        central: cVal,
        min: Math.max(currentScore, cVal - curMargin),
        max: cVal + curMargin,
      });
    }
  } else if (!isFinished) {
    const remHours = Math.max(0, (et - lastT) / 3600000);
    const paceBased = currentScore + normalizedCurPace * remHours * 1.15;
    centralFinal = Math.max(naiveLinear * 1.12, paceBased);
    minFinal = centralFinal * 0.92;
    maxFinal = centralFinal * 1.10;
    forecastSeries.push({ p: pCur, central: currentScore, min: currentScore, max: currentScore });
    forecastSeries.push({ p: 1, central: centralFinal, min: minFinal, max: maxFinal });
  }

  const halfSpread = isFinished ? 0 : Math.max(centralFinal - minFinal, maxFinal - centralFinal);

  return applyNaturalManualAdjustment(
    {
      targetItem,
      targetGraph,
      rank: targetRank,
      currentScore,
      lastT,
      elapsedH,
      totalH: dur / 3600000,
      pCur,
      isFinished,
      recentPace,
      centralFinal,
      minFinal,
      maxFinal,
      halfSpread,
      forecastSeries,
      refModels,
    },
    manualAdjustPt
  );

// =========================================================================
// 6. サーバーサイド Canvas 描画（承認済み新レイアウト・トリプル 2160×820）
// =========================================================================
function getTierTheme(rank) {
  let key = "silver";
  if (rank <= 1000) key = "rainbow";
  else if (rank <= 5000) key = "purple";
  else if (rank <= 10000) key = "platinum";
  else if (rank <= 50000) key = "gold";

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
  };
  return themes[key];
}

function getTierRankTitle(rank) {
  const r = Number(rank);
  if (r === 1000) return "ドリーム級";
  if (r === 5000) return "ダイヤ級";
  if (r === 10000) return "プラチナ級";
  return null;
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

function renderServerTripleImageBuffer(targetItem, predsByRank) {
  if (!createCanvas) return null;

  const W = 2160;
  const H = 820;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const baseBg = ctx.createLinearGradient(0, 0, W, H);
  baseBg.addColorStop(0, "#090c15");
  baseBg.addColorStop(0.5, "#111626");
  baseBg.addColorStop(1, "#090c15");
  ctx.fillStyle = baseBg;
  ctx.fillRect(0, 0, W, H);

  const marginX = 32;
  const gapX = 24;

  // 上部共通タイトルバー
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

  ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
  ctx.font = `600 16px ${serverFontFamily}`;
  ctx.fillText(
    `${targetItem.catLabel}  ｜  開催期間: ${formatJST(targetItem.startTime)} 〜 ${formatJST(targetItem.endTime)}`,
    marginX + 36,
    topBarY + 32
  );

  const fullTitle = targetItem.chapterName
    ? `${targetItem.eventName}  ／  ${targetItem.chapterName}`
    : targetItem.eventName;

  ctx.fillStyle = "#ffffff";
  ctx.font = `800 32px ${serverFontFamily}`;
  drawFittedText(ctx, fullTitle, marginX + 36, topBarY + 72, W - marginX * 2 - 420);

  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.font = `700 16px ${serverFontFamily}`;
  ctx.textAlign = "right";
  ctx.fillText("BORDER FORECAST OVERVIEW", W - marginX - 22, topBarY + 34);

  ctx.fillStyle = "rgba(255, 255, 255, 0.52)";
  ctx.font = `600 15px ${serverFontFamily}`;
  ctx.fillText(`Generated at ${formatJST(Date.now())} JST`, W - marginX - 22, topBarY + 68);
  ctx.textAlign = "left";

  const cardY = topBarY + topBarH + 18;
  const cardH = H - cardY - 24;
  const cardW = (W - marginX * 2 - gapX * 2) / 3;

  TIER_DEFS.forEach((tierDef, idx) => {
    const cx = marginX + idx * (cardW + gapX);
    const pred = predsByRank[tierDef.rank] || null;
    drawServerComparisonSlot(ctx, cx, cardY, cardW, cardH, pred, tierDef.rank);
  });

  // 1MB制限対策：850KB超過時は高品質JPEGへ自動変換
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

function drawServerComparisonSlot(ctx, x, y, w, h, pred, rank) {
  const theme = getTierTheme(rank);
  const rankTitle = getTierRankTitle(rank);

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
  theme.borderStops.forEach((c, idx) => {
    borderGrad.addColorStop(idx / Math.max(1, theme.borderStops.length - 1), c);
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

  const pad = 26;

  // 枠内ヘッダー（階級名と順位バッジのみ）
  ctx.save();
  ctx.font = `800 30px ${serverFontFamily}`;
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
  ctx.font = `800 20px ${serverFontFamily}`;
  ctx.textAlign = "center";
  ctx.fillText(`T${rank.toLocaleString()}`, badgeX + badgeW / 2, badgeY + 27);
  ctx.restore();

  if (!pred) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.font = `600 17px ${serverFontFamily}`;
    ctx.fillText("データがまだ取得されていません。", x + pad, y + 120);
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
  ctx.font = `700 15px ${serverFontFamily}`;
  ctx.fillText(pred.isFinished ? "最終確定ボーダー" : "最終着地予測ボーダー（本命）", heroX + 18, heroY + 28);

  ctx.save();
  ctx.font = `800 44px ${serverFontFamily}`;
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
    ctx.font = `700 16px ${serverFontFamily}`;
    ctx.fillText(
      `誤差目安: ±${formatNumber(pred.halfSpread)} pt  (${formatNumber(pred.minFinal)} 〜 ${formatNumber(pred.maxFinal)})`,
      heroX + 18,
      heroY + 106
    );
  } else {
    ctx.fillStyle = theme.accent;
    ctx.font = `700 16px ${serverFontFamily}`;
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
    ctx.font = `600 14px ${serverFontFamily}`;
    ctx.fillText(cell.k, cell.cx + 12, cell.cy + 27);

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 15px ${serverFontFamily}`;
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
  ctx.font = `700 15px ${serverFontFamily}`;
  ctx.fillText("推移実績 & 着地予測レンジ", gBoxX + 16, gBoxY + 26);

  ctx.fillStyle = "rgba(255, 255, 255, 0.58)";
  ctx.font = `600 13px ${serverFontFamily}`;
  ctx.textAlign = "right";
  ctx.fillText(`基準: ${formatJST(pred.lastT)}`, gBoxX + gBoxW - 16, gBoxY + 26);
  ctx.textAlign = "left";

  const gPadL = 68, gPadR = 18, gPadT = 40, gPadB = 32;
  const plotX = gBoxX + gPadL;
  const plotY = gBoxY + gPadT;
  const plotW = gBoxW - gPadL - gPadR;
  const plotH = gBoxH - gPadT - gPadB;

  let maxY = Math.max(pred.maxFinal, pred.currentScore);
  for (const m of pred.refModels.slice(0, 3)) maxY = Math.max(maxY, m.hFinal);
  maxY = Math.ceil((maxY * 1.06) / 100000) * 100000 || 500000;

  const xOf = (p) => plotX + Math.max(0, Math.min(1, p)) * plotW;
  const yOf = (v) => plotY + plotH - (Math.max(0, v) / maxY) * plotH;

  ctx.font = `600 13px ${serverFontFamily}`;
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
  const stepH = pred.totalH <= 48 ? 12 : 24;
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

// =========================================================================
// 7. holodori-border.com 新API自動取得 ＆ 定時配信スケジューラ
// =========================================================================
async function fetchActiveEventFromNewApi(now = Date.now()) {
  const evListRes = await fetch(`${HOLODORI_API_BASE}/events`);
  if (!evListRes.ok) throw new Error(`/api/events HTTP ${evListRes.status}`);
  const evListData = await evListRes.json();

  const events = Array.isArray(evListData.events) ? evListData.events : [];
  if (events.length === 0) return null;

  let activeEv = null;
  if (evListData.current_event_id) {
    const cand = events.find((e) => e.event_id === evListData.current_event_id);
    if (cand) {
      const st = parseJstDateTime(cand.start);
      const et = parseJstDateTime(cand.end);
      if (st && et && now >= st && now <= et + 59 * 1000) {
        activeEv = cand;
      }
    }
  }
  if (!activeEv) {
    activeEv = events.find((e) => {
      const st = parseJstDateTime(e.start);
      const et = parseJstDateTime(e.end);
      return st && et && now >= st && now <= et + 59 * 1000;
    });
  }
  if (!activeEv) return null;

  // スコアチャレンジ(event_type === 2)はボーダー予測対象外
  if (Number(activeEv.event_type) === 2) return null;

  const detailRes = await fetch(`${HOLODORI_API_BASE}/event/${encodeURIComponent(activeEv.event_id)}`);
  if (!detailRes.ok) throw new Error(`/api/event/${activeEv.event_id} HTTP ${detailRes.status}`);
  const detail = await detailRes.json();

  const rankings = Array.isArray(detail.rankings) ? detail.rankings : [];
  const chapters = Array.isArray(detail.chapters) ? detail.chapters : [];

  const pointRankings = rankings.filter(
    (r) => r.ranking_type === "event_points" && Number(r.enabled) === 1
  );
  if (pointRankings.length === 0) return null;

  // 現在時刻に開催中のチャプターランキングを特定
  const activeRanking = pointRankings.find((r) => {
    const cst = parseJstDateTime(r.chapter_start);
    const cet = parseJstDateTime(r.chapter_end);
    return cst && cet && now >= cst && now <= cet + 59 * 1000;
  });

  if (!activeRanking) return null;

  const matchedChapter = chapters.find((c) => c.chapter_id === activeRanking.chapter_id) || {};
  const startTime = parseJstDateTime(activeRanking.chapter_start || activeEv.start);
  const endTime = parseJstDateTime(activeRanking.chapter_end || activeEv.end);

  memStore.activeEndCache = { endTime, checkedAt: now };

  const isRelay = Number(activeEv.event_type) === 3 || chapters.length > 1;
  const category = isRelay ? "spotlight" : "point";
  const catLabel = isRelay ? "スポットライト" : "ポイントイベント";
  const eventName = detail.event?.display_name || activeEv.display_name || activeEv.event_id;
  const chapterName =
    matchedChapter.display_name && String(matchedChapter.display_name).trim() !== ""
      ? `Chapter ${matchedChapter.chapter_number || activeRanking.chapter_number || ""}：${matchedChapter.display_name}`
      : null;

  return {
    key: `${activeEv.event_id}::${activeRanking.chapter_id}`,
    eventId: activeEv.event_id,
    chapterId: activeRanking.chapter_id,
    rankingId: activeRanking.id,
    category,
    catLabel,
    eventName,
    chapterName,
    shortLabel: chapterName ? `${eventName} / ${matchedChapter.display_name}` : eventName,
    startTime,
    endTime,
    durationH: (endTime - startTime) / 3600000,
    live: true,
    allEventsRaw: events,
    detailRaw: detail,
  };
}

function mergeEventsListToStore(newApiEvents) {
  if (!Array.isArray(newApiEvents) || newApiEvents.length === 0) return;
  const map = new Map();
  for (const ev of memStore.events) {
    if (ev && ev.eventId) map.set(ev.eventId, ev);
  }
  for (const ne of newApiEvents) {
    if (!ne || !ne.event_id) continue;
    const existing = map.get(ne.event_id) || {};
    const st = parseJstDateTime(ne.start);
    const et = parseJstDateTime(ne.end);
    const evType = Number(ne.event_type);
    map.set(ne.event_id, {
      ...existing,
      eventId: ne.event_id,
      name: ne.display_name || existing.name || ne.event_id,
      type: evType === 3 ? 2 : 1,
      isSongScore: evType === 2,
      hasData: true,
      startTime: st || existing.startTime,
      endTime: et || existing.endTime,
      live: st && et ? Date.now() >= st && Date.now() <= et : Boolean(existing.live),
    });
  }
  memStore.events = Array.from(map.values());
  saveRedisJson("borderbot:events", memStore.events).catch(() => {});
}

async function runAutomatedPollAndBroadcast(triggerReason = "scheduled", preFetchedTarget = null) {
  const now = Date.now();

  // 直近10分以内に手動更新が行われていた場合はスキップ
  if (triggerReason === "scheduled" && now - memStore.lastManualUpdateAt < 10 * 60 * 1000) {
    console.log("[AutoPoll] 直近10分以内に手動更新があるため、自動取得・定時配信をスキップしました。");
    return;
  }

  let target = preFetchedTarget;
  if (!target) {
    try {
      target = await fetchActiveEventFromNewApi(now);
    } catch (err) {
      console.error("[AutoPoll] イベント情報取得エラー:", err.message);
      return;
    }
  }

  if (!target) {
    console.log("[AutoPoll] 現在開催中の対象イベント/チャプターがないためスキップしました。");
    return;
  }

  // 終了時刻を過ぎている場合（最終確定ボーダー配信は行わない）
  if (now > target.endTime + 59 * 1000) {
    console.log("[AutoPoll] イベント/チャプター終了後のため配信をスキップしました。");
    return;
  }

  mergeEventsListToStore(target.allEventsRaw);

  const evIdx = memStore.events.findIndex((e) => e.eventId === target.eventId);
  if (evIdx >= 0 && Array.isArray(target.detailRaw?.chapters)) {
    const chIds = [];
    const chMeta = { ...(memStore.events[evIdx].chapterMeta || {}) };
    for (const c of target.detailRaw.chapters) {
      chIds.push(c.chapter_id);
      chMeta[c.chapter_id] = {
        name: c.display_name ? `Chapter ${c.chapter_number}：${c.display_name}` : null,
        shortName: c.display_name || target.eventName,
        startTime: parseJstDateTime(c.start),
        endTime: parseJstDateTime(c.end),
      };
    }
    memStore.events[evIdx].chapters = chIds;
    memStore.events[evIdx].chapterMeta = chMeta;
    memStore.events[evIdx].activeChapterId = target.chapterId;
    saveRedisJson("borderbot:events", memStore.events).catch(() => {});
  }

  // 3順位（T1000, T5000, T10000）の10分間隔履歴を並列取得
  const fetchedRanks = await Promise.all(
    TIER_DEFS.map(async (tierDef) => {
      const url = `${HOLODORI_API_BASE}/history?event_id=${encodeURIComponent(
        target.eventId
      )}&ranking_id=${encodeURIComponent(target.rankingId)}&rank=${tierDef.rank}`;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const tierPts = rows
          .filter((r) => r && r.requested_at != null && r.score != null)
          .map((r) => [parseJstDateTime(r.requested_at), Number(r.score)])
          .filter(([t, s]) => t != null && !Number.isNaN(s))
          .sort((a, b) => a[0] - b[0]);
        if (tierPts.length === 0) return null;
        return { rank: tierDef.rank, tierPts };
      } catch (err) {
        console.error(`[AutoPoll] history取得失敗 (rank=${tierDef.rank}):`, err.message);
        return null;
      }
    })
  );

  let updatedAny = false;
  for (const item of fetchedRanks) {
    if (!item) continue;
    const cacheKey = `${target.key}::${item.rank}`;
    const existing = memStore.graphs[cacheKey];
    const newLastT = item.tierPts[item.tierPts.length - 1][0];
    const oldLastT =
      existing && Array.isArray(existing.tier) && existing.tier.length > 0
        ? existing.tier[existing.tier.length - 1][0]
        : 0;

    if (newLastT >= oldLastT) {
      memStore.graphs[cacheKey] = {
        eventId: target.eventId,
        chapterId: target.chapterId,
        rank: item.rank,
        startTime: target.startTime,
        endTime: target.endTime,
        tier: item.tierPts,
        source: "api_10m",
        fetchedAt: now,
      };
      updatedAny = true;
    }
  }

  if (updatedAny) {
    await saveRedisJson("borderbot:graphs", memStore.graphs);
  }

  const nbCache = rebuildNowBorderCacheFromGraphs(target.key);
  const nowBorderText = nbCache ? nbCache.text : "";
  const timeLabel = nbCache ? nbCache.timeLabel : formatRoundedJstTime(now);

  const predsByRank = {};
  for (const tierDef of TIER_DEFS) {
    const targetGraph = memStore.graphs[`${target.key}::${tierDef.rank}`];
    if (!targetGraph) continue;

    const refPairs = [];
    for (const aItem of memStore.archiveItems) {
      if (aItem.key === target.key || aItem.category !== target.category) continue;
      const g = memStore.archiveGraphs[`${aItem.key}::${tierDef.rank}`];
      if (g) refPairs.push({ item: aItem, graph: g });
    }
    for (const [gKey, gVal] of Object.entries(memStore.graphs)) {
      if (!gKey.endsWith(`::${tierDef.rank}`) || gKey.startsWith(`${target.key}::`)) continue;
      if (!gVal || !Array.isArray(gVal.tier) || gVal.tier.length < 15) continue;
      const gProg = (gVal.tier[gVal.tier.length - 1][0] - gVal.startTime) / Math.max(1, gVal.endTime - gVal.startTime);
      if (gProg < 0.98) continue;
      const prefix = gKey.replace(/::\d+$/, "");
      refPairs.push({
        item: {
          key: prefix,
          eventId: gVal.eventId || prefix,
          chapterId: gVal.chapterId || prefix,
          category: target.category,
          durationH: (gVal.endTime - gVal.startTime) / 3600000,
          live: false,
        },
        graph: gVal,
      });
    }

    const adjMap = memStore.manualAdjustments[target.key] || {};
    predsByRank[tierDef.rank] = computePredictionServer(
      target,
      targetGraph,
      refPairs,
      tierDef.rank,
      Number(adjMap[tierDef.rank]) || 0
    );
  }

  const rendered = renderServerTripleImageBuffer(target, predsByRank);
  if (rendered && rendered.buffer) {
    memStore.predictionCache = {
      imageBase64: rendered.buffer.toString("base64"),
      filename: rendered.filename,
      timeLabel,
      updatedAt: now,
    };
    await saveRedisJson("borderbot:cache:prediction", memStore.predictionCache);
  }

  memStore.lastAutoFetchAt = now;
  await persistMeta();

  console.log(
    `[AutoPoll] 自動データ更新完了: ${target.shortLabel} (${timeLabel}) / 画像生成(${rendered ? "成功" : "スキップ"})`
  );

  if (triggerReason === "scheduled") {
    const subs = normalizeSubscriptions(memStore.subscriptions);
    if (subs.length === 0) {
      console.log("[AutoPoll] 購読チャンネル0件のため配信なし");
      return;
    }

    let okCount = 0;
    let ngCount = 0;
    for (const chId of subs) {
      try {
        const channel = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
          ngCount++;
          continue;
        }
        const files = rendered
          ? [new AttachmentBuilder(rendered.buffer, { name: rendered.filename })]
          : [];
        await channel.send({
          content: nowBorderText,
          files,
        });
        okCount++;
      } catch (err) {
        console.error(`[AutoPoll] 定時配信失敗 (${chId}):`, err.message);
        ngCount++;
      }
    }
    console.log(`[AutoPoll] 定時一斉配信完了（成功: ${okCount}ch / 失敗: ${ngCount}ch）`);
  }
}

function startScheduledPoller() {
  setInterval(async () => {
    try {
      const now = Date.now();
      const jst = new Date(now + 9 * 3600 * 1000);
      const yyyy = jst.getUTCFullYear();
      const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(jst.getUTCDate()).padStart(2, "0");
      const hh = jst.getUTCHours();
      const mm = jst.getUTCMinutes();
      const ss = jst.getUTCSeconds();

      const isHourlyTrigger = mm === 2 && ss >= 30;
      const isHalfHourTrigger = mm === 32 && ss >= 30;
      if (!isHourlyTrigger && !isHalfHourTrigger) return;

      const slotKey = `${yyyy}-${mo}-${dd}-${String(hh).padStart(2, "0")}-${String(mm).padStart(2, "0")}`;
      if (memStore.lastExecutedSlot === slotKey) return;

      // 32分30秒の場合は、現在のイベント/チャプター終了3時間前以内かどうかを確認
      let preFetchedTarget = null;
      if (isHalfHourTrigger) {
        let activeEnd =
          memStore.activeEndCache && now - memStore.activeEndCache.checkedAt < 20 * 60 * 1000
            ? memStore.activeEndCache.endTime
            : null;

        if (!activeEnd || now > activeEnd) {
          preFetchedTarget = await fetchActiveEventFromNewApi(now).catch(() => null);
          activeEnd = preFetchedTarget ? preFetchedTarget.endTime : null;
        }

        const isFinal3Hours =
          activeEnd != null && activeEnd - now <= 3 * 3600 * 1000 && now <= activeEnd + 59 * 1000;

        if (!isFinal3Hours) {
          return;
        }
      }

      memStore.lastExecutedSlot = slotKey;
      await persistMeta();

      console.log(`[Scheduler] 定時トリガー発火 (${slotKey} / 終盤30分モード=${isHalfHourTrigger})`);
      await runAutomatedPollAndBroadcast("scheduled", preFetchedTarget);
    } catch (err) {
      console.error("[Scheduler] タイマーエラー:", err);
    }
  }, 10 * 1000);
}

// =========================================================================
// 8. Discord Bot ＆ スラッシュコマンド設定
// =========================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("このチャンネルにボーダー予測の一斉通知を登録します"),
  new SlashCommandBuilder()
    .setName("unsubscribe")
    .setDescription("このチャンネルのボーダー予測通知を解除します"),
  new SlashCommandBuilder()
    .setName("prediction")
    .setDescription("最後にキャッシュされたボーダー予測画像をすぐに通知します"),
  new SlashCommandBuilder()
    .setName("nowborder")
    .setDescription("最新のキャッシュ済み現在ボーダーをすぐに通知します"),
  new SlashCommandBuilder()
    .setName("border")
    .setDescription("最新の現在ボーダーと予測画像をまとめてすぐに通知します"),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) return;
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: slashCommands,
    });
    console.log("[Discord] スラッシュコマンド登録完了 (/subscribe, /unsubscribe, /prediction, /nowborder, /border)");
  } catch (err) {
    console.error("[Discord] コマンド登録エラー:", err);
  }
}

client.once("clientReady", async () => {
  console.log(`[Discord] ログイン完了: ${client.user.tag}`);
  await registerSlashCommands();
  startScheduledPoller();

  // 起動時に開催中イベントの最新データを同期（通知は送らない）
  runAutomatedPollAndBroadcast("boot_sync").catch(() => {});
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId } = interaction;

  try {
    if (commandName === "subscribe") {
      if (!Array.isArray(memStore.subscriptions)) memStore.subscriptions = [];
      if (!memStore.subscriptions.includes(channelId)) {
        memStore.subscriptions.push(channelId);
        await saveRedisJson("borderbot:subscriptions", memStore.subscriptions);
      }
      await interaction.reply({
        content: "✅ このチャンネルをボーダー予測の一斉通知先に登録しました。",
        ephemeral: true,
      });
      return;
    }

    if (commandName === "unsubscribe") {
      if (!Array.isArray(memStore.subscriptions)) memStore.subscriptions = [];
      memStore.subscriptions = memStore.subscriptions.filter((id) => id !== channelId);
      await saveRedisJson("borderbot:subscriptions", memStore.subscriptions);
      await interaction.reply({
        content: "🔕 このチャンネルのボーダー予測通知を解除しました。",
        ephemeral: true,
      });
      return;
    }

    if (commandName === "prediction") {
      const pred = memStore.predictionCache;
      if (!pred || !pred.imageBase64) {
        await interaction.reply({
          content: "⚠️ まだ予測画像がキャッシュされていません。",
          ephemeral: true,
        });
        return;
      }
      const imgBuffer = Buffer.from(pred.imageBase64, "base64");
      const attachment = new AttachmentBuilder(imgBuffer, {
        name: pred.filename || "border_prediction.png",
      });
      await interaction.reply({
        content: `最終更新(${pred.timeLabel})時点のボーダー予測です！`,
        files: [attachment],
      });
      return;
    }

    if (commandName === "nowborder") {
      const nb = memStore.nowBorderCache || rebuildNowBorderCacheFromGraphs();
      if (!nb || !nb.text) {
        await interaction.reply({
          content: "⚠️ まだボーダーデータがキャッシュされていません。",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: nb.text,
      });
      return;
    }

    if (commandName === "border") {
      const nb = memStore.nowBorderCache || rebuildNowBorderCacheFromGraphs();
      const pred = memStore.predictionCache;

      if ((!nb || !nb.text) && (!pred || !pred.imageBase64)) {
        await interaction.reply({
          content: "⚠️ まだボーダーデータおよび予測画像がキャッシュされていません。",
          ephemeral: true,
        });
        return;
      }

      const content = nb && nb.text
        ? nb.text
        : `最終更新(${pred.timeLabel})時点のボーダー予測です！`;
      const files = [];
      if (pred && pred.imageBase64) {
        const imgBuffer = Buffer.from(pred.imageBase64, "base64");
        files.push(
          new AttachmentBuilder(imgBuffer, {
            name: pred.filename || "border_prediction.png",
          })
        );
      }

      await interaction.reply({
        content,
        files,
      });
      return;
    }
  } catch (err) {
    console.error(`[Discord] コマンド処理エラー (${commandName}):`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "⚠️ コマンドの実行中にエラーが発生しました。",
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

// =========================================================================
// 9. Express Webサーバー ＆ 管理画面API
// =========================================================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, time: Date.now() });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid password" });
});

app.get("/api/admin/bootstrap", requireAdmin, (_req, res) => {
  const subs = normalizeSubscriptions(memStore.subscriptions);
  res.json({
    events: memStore.events,
    graphs: memStore.graphs,
    manualAdjustments: memStore.manualAdjustments,
    subscriptionCount: subs.length,
    lastManualUpdateAt: memStore.lastManualUpdateAt,
    lastAutoFetchAt: memStore.lastAutoFetchAt,
    nowBorderCache: memStore.nowBorderCache
      ? { text: memStore.nowBorderCache.text, timeLabel: memStore.nowBorderCache.timeLabel }
      : null,
    predictionCacheMeta: memStore.predictionCache
      ? { timeLabel: memStore.predictionCache.timeLabel, updatedAt: memStore.predictionCache.updatedAt }
      : null,
  });
});

app.post("/api/admin/cache-events", requireAdmin, async (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: "Invalid events" });
  }
  memStore.events = events;
  await saveRedisJson("borderbot:events", events);
  res.json({ ok: true });
});

app.post("/api/admin/cache-graph", requireAdmin, async (req, res) => {
  const { cacheKey, graph } = req.body || {};
  if (!cacheKey || !graph) {
    return res.status(400).json({ error: "Invalid graph payload" });
  }
  memStore.graphs[cacheKey] = {
    ...graph,
    source: graph.source || "manual_1m",
  };
  await saveRedisJson("borderbot:graphs", memStore.graphs);

  const prefix = cacheKey.replace(/::\d+$/, "");
  rebuildNowBorderCacheFromGraphs(prefix);

  res.json({ ok: true });
});

app.post("/api/admin/cache-prediction", requireAdmin, upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }
  const timeLabel = (req.body.timeLabel || formatRoundedJstTime(Date.now())).trim();
  const filename = req.file.originalname || "border_prediction.png";
  const cacheObj = {
    imageBase64: req.file.buffer.toString("base64"),
    filename,
    timeLabel,
    updatedAt: Date.now(),
  };
  memStore.predictionCache = cacheObj;
  await saveRedisJson("borderbot:cache:prediction", cacheObj);
  res.json({ ok: true, timeLabel });
});

// 一斉通知送信 ＆ データのみ更新（notify === "false"）両対応
app.post("/api/admin/broadcast", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const nowBorderText = (req.body.nowBorderText || "").trim();
    const customText = (req.body.customText || "").trim();
    const customTextPosition = req.body.customTextPosition || "below";
    const shouldNotify = String(req.body.notify || "true") !== "false";
    const imageBuffer = req.file ? req.file.buffer : null;
    const filename = req.file?.originalname || "border_prediction.png";

    const now = Date.now();
    memStore.lastManualUpdateAt = now;
    await persistMeta();

    const eventKey = (req.body.eventKey || "").trim();
    if (eventKey && req.body.manualAdjustments) {
      try {
        const parsedAdj = JSON.parse(req.body.manualAdjustments);
        memStore.manualAdjustments[eventKey] = parsedAdj;
        await saveRedisJson("borderbot:adjustments", memStore.manualAdjustments);
      } catch (_) {}
    }

    if (nowBorderText) {
      const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
      const timeLabel = m ? m[1] : formatRoundedJstTime(now);
      memStore.nowBorderCache = {
        text: nowBorderText,
        timeLabel,
        updatedAt: now,
      };
      await saveRedisJson("borderbot:cache:nowborder", memStore.nowBorderCache);
    }

    if (imageBuffer) {
      const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
      const timeLabel = m ? m[1] : formatRoundedJstTime(now);
      memStore.predictionCache = {
        imageBase64: imageBuffer.toString("base64"),
        filename,
        timeLabel,
        updatedAt: now,
      };
      await saveRedisJson("borderbot:cache:prediction", memStore.predictionCache);
    }

    // 「データのみ更新（通知は送信しない）」の場合
    if (!shouldNotify) {
      return res.json({
        ok: true,
        message: "✅ データを新しく更新しました（Discordへの一斉通知は送信していません / 10分間は自動更新を待機します）。",
      });
    }

    const subs = normalizeSubscriptions(memStore.subscriptions);
    memStore.subscriptions = subs;

    if (subs.length === 0) {
      return res.json({
        ok: true,
        message: "キャッシュを更新しました（通知購読チャンネルは現在0件です）。",
      });
    }

    let successCount = 0;
    let failCount = 0;

    for (const chId of subs) {
      try {
        const channel = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
          failCount++;
          continue;
        }

        const files = imageBuffer
          ? [new AttachmentBuilder(imageBuffer, { name: filename })]
          : [];

        if (customText && customTextPosition === "above") {
          await channel.send({
            content: `${customText}\n\n${nowBorderText}`,
            files,
          });
        } else {
          await channel.send({
            content: nowBorderText,
            files,
          });
          if (customText && customTextPosition === "below") {
            await channel.send({ content: customText });
          }
        }
        successCount++;
      } catch (err) {
        console.error(`[Broadcast] 送信失敗 (${chId}):`, err.message);
        failCount++;
      }
    }

    return res.json({
      ok: true,
      message: `一斉通知を完了しました（成功: ${successCount}ch / 失敗: ${failCount}ch）`,
    });
  } catch (err) {
    console.error("[Broadcast] 致命的エラー:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================================
// 10. 起動シーケンス
// =========================================================================
(async () => {
  await ensureJapaneseFont();
  await loadStateFromRedis();
  await loadArchiveFromGithubServer();

  if (!memStore.nowBorderCache) {
    rebuildNowBorderCacheFromGraphs();
  }

  const graphCount = Object.keys(memStore.graphs).length;
  const hasPred = Boolean(memStore.predictionCache?.imageBase64);
  const nbTime = memStore.nowBorderCache?.timeLabel || "未生成";
  console.log(
    `[Redis] 読込完了: 購読チャンネル ${memStore.subscriptions.length}ch / イベント ${memStore.events.length}件 / グラフ ${graphCount}件 / NowBorder(${nbTime}) / 予測画像(${hasPred ? "あり" : "なし"})`
  );

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Web] 管理画面サーバー起動: http://0.0.0.0:${PORT}`);
  });

  if (DISCORD_TOKEN) {
    await client.login(DISCORD_TOKEN);
  } else {
    console.warn("[Discord] DISCORD_TOKEN が設定されていません。");
  }
})();
