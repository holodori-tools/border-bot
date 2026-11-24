const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

// ★ 共通予測・描画エンジン（public/engine.js と単一ソース共有）
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public/engine.js"))
  ? path.join(__dirname, "public")
  : path.join(__dirname, "../public");

const Engine = require(path.join(PUBLIC_DIR, "engine.js"));

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
const BOT_OWNER_ID = process.env.BOT_OWNER_ID || "";

const HOLODORI_API_BASE = "https://holodori-border.com/api";
const GITHUB_ARCHIVE_BASE = "https://raw.githubusercontent.com/holodori-tools/event-borders/main/archive";

const { TIER_DEFS } = Engine;

// =========================================================================
// 1. 日本語フォント初期化 ＆ 共通レポートレンダラー生成
// =========================================================================
let serverFontFamily = "sans-serif";

const reportRenderer = createCanvas
  ? Engine.createReportRenderer({
      createCanvas,
      fontFamily: serverFontFamily,
      monoFamily: serverFontFamily,
    })
  : null;

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
    if (reportRenderer) {
      reportRenderer.setFontFamilies(serverFontFamily, serverFontFamily);
    }
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
  guildSettings: {},        // { [guildId]: { muteStart: 22, muteEnd: 6 } }
  manualAdjustments: {},    // { [eventKey]: { "1000": -50000, "5000": 0, ... } }
  nowBorderCache: null,     // { text, timeLabel, updatedAt }
  predictionCache: null,    // { imageBase64, filename, timeLabel, updatedAt }
  lastManualUpdateAt: 0,    // 手動更新の最終タイムスタンプ
  lastAutoFetchAt: 0,
  lastExecutedSlot: "",     // 二重実行防止用スロットキー（10分スロット対応）
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
  const [evRaw, grRaw, subRaw, nbRaw, prRaw, metaRaw, adjRaw, gsRaw] = await Promise.all([
    redisCommand(["GET", "borderbot:events"]),
    redisCommand(["GET", "borderbot:graphs"]),
    redisCommand(["GET", "borderbot:subscriptions"]),
    redisCommand(["GET", "borderbot:cache:nowborder"]),
    redisCommand(["GET", "borderbot:cache:prediction"]),
    redisCommand(["GET", "borderbot:meta"]),
    redisCommand(["GET", "borderbot:adjustments"]),
    redisCommand(["GET", "borderbot:guild_settings"]),
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
  if (gsRaw) {
    try {
      const parsedGs = JSON.parse(gsRaw);
      memStore.guildSettings = parsedGs && typeof parsedGs === "object" ? parsedGs : {};
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
// 2.5 サーバー別ミュート時間帯判定 ＆ Discord設定UIビルダー
// =========================================================================
function canManageSubscribe(interaction) {
  if (BOT_OWNER_ID && interaction.user?.id === BOT_OWNER_ID) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return false;
}

function isGuildMutedNow(guildId, nowMs = Date.now()) {
  if (!guildId) return false;
  const cfg = memStore.guildSettings[guildId];
  if (!cfg || cfg.muteStart == null || cfg.muteEnd == null) return false;
  const s = Number(cfg.muteStart);
  const e = Number(cfg.muteEnd);
  if (Number.isNaN(s) || Number.isNaN(e) || s === e) return false;

  const jstHour = new Date(nowMs + 9 * 3600 * 1000).getUTCHours();
  return s < e ? jstHour >= s && jstHour < e : jstHour >= s || jstHour < e;
}

function buildSubscribeMuteUI(guildId) {
  const cfg = guildId ? memStore.guildSettings[guildId] : null;
  const isMuted = Boolean(
    cfg && cfg.muteStart != null && cfg.muteEnd != null && Number(cfg.muteStart) !== Number(cfg.muteEnd)
  );
  const selectedStart = isMuted ? Number(cfg.muteStart) : 22;
  const selectedEnd = isMuted ? Number(cfg.muteEnd) : 6;

  let statusLine;
  if (isMuted) {
    const nextDayLabel = selectedStart > selectedEnd ? "翌" : "";
    const lastNotifyHour = (selectedStart + 23) % 24;
    statusLine =
      `🔕 **現在の設定：ミュート有効**\n` +
      `・通知停止（ミュート）：**${selectedStart}時 〜 ${nextDayLabel}${selectedEnd}時になる前まで**\n` +
      `・通知実行：**${selectedEnd}時 〜 ${lastNotifyHour}時台**`;
  } else {
    statusLine =
      `🔔 **現在の設定：ミュートなし（24時間通知ON）**\n` +
      `※下のプルダウンから時間を選ぶと即座に保存されます。`;
  }

  const startOptions = Array.from({ length: 24 }, (_, h) => ({
    label: `ミュート開始：${h}時`,
    description: `${h}:00 から通知を停止`,
    value: String(h),
    default: isMuted && h === selectedStart,
  }));

  const endOptions = Array.from({ length: 24 }, (_, h) => ({
    label: `通知再開：${h}時`,
    description: `${h}:00 から通知を再開`,
    value: String(h),
    default: isMuted && h === selectedEnd,
  }));

  const rowStart = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("mute_start_select")
      .setPlaceholder(isMuted ? `ミュート開始：${selectedStart}時` : "ミュート開始時刻を選択（0〜23時）")
      .addOptions(startOptions)
  );

  const rowEnd = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("mute_end_select")
      .setPlaceholder(isMuted ? `通知再開：${selectedEnd}時` : "通知再開時刻を選択（0〜23時）")
      .addOptions(endOptions)
  );

  const rowBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("mute_disable_btn")
      .setLabel("ミュートしない（24時間通知）")
      .setStyle(isMuted ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(!isMuted)
  );

  return {
    content: `✅ このチャンネルをボーダー予測の通知先に登録しました。\n\n${statusLine}`,
    components: [rowStart, rowEnd, rowBtn],
  };
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
        const cat = Engine.normalizeEventCategory(ent.category) || "spotlight";
        items.push({
          key,
          eventId: ent.eventId || "archive",
          chapterId: ent.chapterId || displayName,
          category: cat,
          catLabel: cat === "normal" ? "ポイントイベント" : "スポットライト",
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
// 4. NowBorder キャッシュ再構築ヘルパー（Engine.buildNowBorderPayloadFromGraphs を利用）
// =========================================================================
function rebuildNowBorderCacheFromGraphs(targetPrefix = null) {
  const built = Engine.buildNowBorderPayloadFromGraphs(memStore.graphs, targetPrefix);
  if (!built) return memStore.nowBorderCache;

  const cacheObj = {
    text: built.text,
    timeLabel: built.timeLabel,
    updatedAt: built.updatedAt,
  };
  memStore.nowBorderCache = cacheObj;
  saveRedisJson("borderbot:cache:nowborder", cacheObj).catch(() => {});
  return cacheObj;
}

// =========================================================================
// 5. holodori-border.com 新API自動取得 ＆ 定時配信スケジューラ
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
      const st = Engine.parseJstDateTime(cand.start);
      const et = Engine.parseJstDateTime(cand.end);
      if (st && et && now >= st && now <= et + 59 * 1000) {
        activeEv = cand;
      }
    }
  }
  if (!activeEv) {
    activeEv = events.find((e) => {
      const st = Engine.parseJstDateTime(e.start);
      const et = Engine.parseJstDateTime(e.end);
      return st && et && now >= st && now <= et + 59 * 1000;
    });
  }
  if (!activeEv) return null;

  // 楽曲ハイスコア系イベントは対象外
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

  const activeRanking = pointRankings.find((r) => {
    const cst = Engine.parseJstDateTime(r.chapter_start);
    const cet = Engine.parseJstDateTime(r.chapter_end);
    return cst && cet && now >= cst && now <= cet + 59 * 1000;
  });

  if (!activeRanking) return null;

  const matchedChapter = chapters.find((c) => c.chapter_id === activeRanking.chapter_id) || {};
  const startTime = Engine.parseJstDateTime(activeRanking.chapter_start || activeEv.start);
  const endTime = Engine.parseJstDateTime(activeRanking.chapter_end || activeEv.end);

  memStore.activeEndCache = { endTime, checkedAt: now };

  const isRelay = Number(activeEv.event_type) === 3 || chapters.length > 1;
  const category = isRelay ? "spotlight" : "normal";
  const catLabel = isRelay ? "スポットライト" : "ポイントイベント";
  const eventName = detail.event?.display_name || activeEv.display_name || activeEv.event_id;
  const chNum = matchedChapter.chapter_number || activeRanking.chapter_number || "";
  const chTitle = matchedChapter.display_name ? String(matchedChapter.display_name).trim() : "";
  const chapterName = chTitle
    ? `Chapter ${chNum}：${chTitle}`
    : isRelay && chNum
    ? `Chapter ${chNum}`
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
    shortLabel: chTitle ? `${eventName} / ${chTitle}` : chapterName ? `${eventName} / ${chapterName}` : eventName,
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
    const st = Engine.parseJstDateTime(ne.start);
    const et = Engine.parseJstDateTime(ne.end);
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

  let target = preFetchedTarget;
  if (!target) {
    try {
      target = await fetchActiveEventFromNewApi(now);
    } catch (err) {
      console.error("[AutoPoll] イベント情報取得エラー:", err.message);
      throw err;
    }
  }

  if (!target) {
    console.log("[AutoPoll] 現在開催中の対象イベント/チャプターがないためスキップしました。");
    return { fetched: false, reason: "no_active_event" };
  }

  if (now > target.endTime + 59 * 1000) {
    console.log("[AutoPoll] イベント/チャプター終了後のため更新・配信をスキップしました。");
    return { fetched: false, reason: "event_ended" };
  }

  mergeEventsListToStore(target.allEventsRaw);

  const evIdx = memStore.events.findIndex((e) => e.eventId === target.eventId);
  if (evIdx >= 0 && Array.isArray(target.detailRaw?.chapters)) {
    const chIds = [];
    const chMeta = { ...(memStore.events[evIdx].chapterMeta || {}) };
    const detailRankings = Array.isArray(target.detailRaw?.rankings) ? target.detailRaw.rankings : [];

    for (const c of target.detailRaw.chapters) {
      chIds.push(c.chapter_id);
      const rk = detailRankings.find(
        (r) => r.chapter_id === c.chapter_id && r.ranking_type === "event_points"
      );
      const chNum = c.chapter_number || rk?.chapter_number || "";
      const chTitle = c.display_name ? String(c.display_name).trim() : "";
      const cStart = Engine.parseJstDateTime(c.start || rk?.chapter_start);
      const cEnd = Engine.parseJstDateTime(c.end || rk?.chapter_end);

      chMeta[c.chapter_id] = {
        name: chTitle
          ? `Chapter ${chNum}：${chTitle}`
          : target.detailRaw.chapters.length > 1 && chNum
          ? `Chapter ${chNum}`
          : null,
        shortName: chTitle || (chNum && target.detailRaw.chapters.length > 1 ? `Chapter ${chNum}` : target.eventName),
        startTime: cStart,
        endTime: cEnd,
      };
    }
    memStore.events[evIdx].chapters = chIds;
    memStore.events[evIdx].chapterMeta = chMeta;
    memStore.events[evIdx].activeChapterId = target.chapterId;
    saveRedisJson("borderbot:events", memStore.events).catch(() => {});
  }

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
          .map((r) => [Engine.parseJstDateTime(r.requested_at), Number(r.score)])
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
  const timeLabel = nbCache ? nbCache.timeLabel : Engine.formatRoundedJstTime(now);

  // ★ 共通 Engine.computePrediction を使って3ランク分の予測を算出（admin.html と同一母集団・同一ロジック）
  const predsByRank = {};
  for (const tierDef of TIER_DEFS) {
    const targetGraph = memStore.graphs[`${target.key}::${tierDef.rank}`];
    if (!targetGraph) continue;

    const refMap = new Map();
    for (const aItem of memStore.archiveItems) {
      if (aItem.key === target.key) continue;
      const g = memStore.archiveGraphs[`${aItem.key}::${tierDef.rank}`];
      if (g) refMap.set(aItem.key, { item: aItem, graph: g });
    }
    for (const [gKey, gVal] of Object.entries(memStore.graphs)) {
      if (!gKey.endsWith(`::${tierDef.rank}`) || gKey.startsWith(`${target.key}::`)) continue;
      if (!gVal || !Array.isArray(gVal.tier) || gVal.tier.length < 15) continue;
      const gProg = (gVal.tier[gVal.tier.length - 1][0] - gVal.startTime) / Math.max(1, gVal.endTime - gVal.startTime);
      if (gProg < 0.98) continue;
      const prefix = gKey.replace(/::\d+$/, "");
      if (refMap.has(prefix)) continue;
      const gDurH = (gVal.endTime - gVal.startTime) / 3600000;
      refMap.set(prefix, {
        item: {
          key: prefix,
          eventId: gVal.eventId || prefix,
          chapterId: gVal.chapterId || prefix,
          category: gDurH >= 72 ? "normal" : "spotlight",
          durationH: gDurH,
          live: false,
        },
        graph: gVal,
      });
    }

    const refPairs = Array.from(refMap.values());
    const adjMap = memStore.manualAdjustments[target.key] || {};
    predsByRank[tierDef.rank] = Engine.computePrediction(
      target,
      targetGraph,
      refPairs,
      tierDef.rank,
      Number(adjMap[tierDef.rank]) || 0
    );
  }

  // ★ 共通 Engine.createReportRenderer を使ってトリプル画像を直接レンダリング
  const slots = TIER_DEFS.map((t) => ({
    item: target,
    rank: t.rank,
    pred: predsByRank[t.rank] || null,
  }));
  const rendered = reportRenderer
    ? reportRenderer.renderReportBuffer({
        mode: "triple",
        themeOverride: "auto",
        slots,
        primaryItem: target,
        nowMs: now,
      })
    : null;

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
    `[AutoPoll] 自動データ更新完了 (${triggerReason}): ${target.shortLabel} (${timeLabel}) / 画像生成(${rendered ? "成功" : "スキップ"})`
  );

  // ★ triggerReason === "scheduled" のときだけDiscordチャンネルへ一斉通知を送信
  if (triggerReason === "scheduled") {
    const subs = normalizeSubscriptions(memStore.subscriptions);
    if (subs.length === 0) {
      console.log("[AutoPoll] 購読チャンネル0件のため配信なし");
      return { fetched: true, targetKey: target.key, shortLabel: target.shortLabel, timeLabel };
    }

    let okCount = 0;
    let ngCount = 0;
    let mutedSkipCount = 0;
    for (const chId of subs) {
      try {
        const channel = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
          ngCount++;
          continue;
        }
        if (channel.guildId && isGuildMutedNow(channel.guildId, now)) {
          mutedSkipCount++;
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
    console.log(
      `[AutoPoll] 定時一斉配信完了（成功: ${okCount}ch / 失敗: ${ngCount}ch / ミュート時間スキップ: ${mutedSkipCount}ch）`
    );
  }

  return { fetched: true, targetKey: target.key, shortLabel: target.shortLabel, timeLabel };
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

      // ★ 10分毎（02分, 12分, 22分, 32分, 42分, 52分）の 30秒以降に発火
      if (mm % 10 !== 2 || ss < 30) return;

      const slotKey = `${yyyy}-${mo}-${dd}-${String(hh).padStart(2, "0")}-${String(mm).padStart(2, "0")}`;
      if (memStore.lastExecutedSlot === slotKey) return;

      const isHourlyNotifySlot = mm === 2;
      const isHalfHourSlot = mm === 32;

      let shouldNotify = isHourlyNotifySlot;
      let preFetchedTarget = null;

      // 32分スロットの場合、終了3時間前以内なら一斉通知も実行する
      if (isHalfHourSlot) {
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

        if (isFinal3Hours) {
          shouldNotify = true;
        }
      }

      memStore.lastExecutedSlot = slotKey;
      await persistMeta();

      const triggerReason = shouldNotify ? "scheduled" : "auto_cache_10m";
      console.log(
        `[Scheduler] 10分定期トリガー発火 (${slotKey} / モード=${triggerReason})`
      );
      await runAutomatedPollAndBroadcast(triggerReason, preFetchedTarget);
    } catch (err) {
      console.error("[Scheduler] タイマーエラー:", err);
    }
  }, 10 * 1000);
}

// =========================================================================
// 6. Discord Bot ＆ スラッシュコマンド設定
// =========================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("このチャンネルにボーダー予測の一斉通知を登録します")
    .addBooleanOption((opt) =>
      opt
        .setName("mutetime")
        .setDescription("Trueにすると通知をミュートする時間帯の設定UIを表示します")
        .setRequired(false)
    ),
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

client.once(Events.ClientReady, async () => {
  console.log(`[Discord] ログイン完了: ${client.user.tag}`);
  console.log(`[Discord] 導入サーバー一覧 (計 ${client.guilds.cache.size} サーバー):`);
  client.guilds.cache.forEach((g) => {
    console.log(`  - ${g.name} (ID: ${g.id} / メンバー数: ${g.memberCount}人)`);
  });

  await registerSlashCommands();
  startScheduledPoller();

  // 起動時に開催中イベントの最新データを同期（通知は送らない）
  runAutomatedPollAndBroadcast("boot_sync").catch(() => {});
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`[Discord] 新規サーバーに参加: ${guild.name} (ID: ${guild.id} / メンバー数: ${guild.memberCount}人)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // 1. ミュート時間帯セレクトメニュー操作
  if (
    interaction.isStringSelectMenu() &&
    (interaction.customId === "mute_start_select" || interaction.customId === "mute_end_select")
  ) {
    if (!canManageSubscribe(interaction)) {
      await interaction.reply({
        content: "⚠️ この設定は「サーバー管理」権限を持つメンバーのみ変更できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const guildId = interaction.guildId;
    if (!guildId) return;

    const prev = memStore.guildSettings[guildId] || { muteStart: 22, muteEnd: 6 };
    const pickedHour = Number(interaction.values[0]);
    memStore.guildSettings[guildId] = {
      muteStart: interaction.customId === "mute_start_select" ? pickedHour : Number(prev.muteStart ?? 22),
      muteEnd: interaction.customId === "mute_end_select" ? pickedHour : Number(prev.muteEnd ?? 6),
    };
    await saveRedisJson("borderbot:guild_settings", memStore.guildSettings);
    await interaction.update(buildSubscribeMuteUI(guildId));
    return;
  }

  // 2. 「ミュートしない」ボタン操作
  if (interaction.isButton() && interaction.customId === "mute_disable_btn") {
    if (!canManageSubscribe(interaction)) {
      await interaction.reply({
        content: "⚠️ この設定は「サーバー管理」権限を持つメンバーのみ変更できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const guildId = interaction.guildId;
    if (guildId && memStore.guildSettings[guildId]) {
      delete memStore.guildSettings[guildId];
      await saveRedisJson("borderbot:guild_settings", memStore.guildSettings);
    }
    await interaction.update(buildSubscribeMuteUI(guildId));
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId, guildId } = interaction;

  try {
    if (commandName === "subscribe") {
      if (!canManageSubscribe(interaction)) {
        await interaction.reply({
          content: "⚠️ このコマンドは「サーバー管理」権限を持つメンバーのみ実行できます。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!Array.isArray(memStore.subscriptions)) memStore.subscriptions = [];
      if (!memStore.subscriptions.includes(channelId)) {
        memStore.subscriptions.push(channelId);
        await saveRedisJson("borderbot:subscriptions", memStore.subscriptions);
      }

      const openMuteUI = interaction.options.getBoolean("mutetime") ?? false;
      if (!openMuteUI) {
        if (guildId && memStore.guildSettings[guildId]) {
          delete memStore.guildSettings[guildId];
          await saveRedisJson("borderbot:guild_settings", memStore.guildSettings);
        }
        await interaction.reply({
          content: "✅ このチャンネルをボーダー予測の一斉通知先に登録しました（ミュートなし・24時間通知）。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!guildId) {
        await interaction.reply({
          content: "✅ 通知先に登録しました（※時間帯ミュート設定はサーバー内チャンネルでのみ利用できます）。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const uiPayload = buildSubscribeMuteUI(guildId);
      await interaction.reply({
        ...uiPayload,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === "unsubscribe") {
      if (!canManageSubscribe(interaction)) {
        await interaction.reply({
          content: "⚠️ このコマンドは「サーバー管理」権限を持つメンバーのみ実行できます。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!Array.isArray(memStore.subscriptions)) memStore.subscriptions = [];
      memStore.subscriptions = memStore.subscriptions.filter((id) => id !== channelId);
      await saveRedisJson("borderbot:subscriptions", memStore.subscriptions);
      await interaction.reply({
        content: "🔕 このチャンネルのボーダー予測通知を解除しました。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === "prediction") {
      const pred = memStore.predictionCache;
      if (!pred || !pred.imageBase64) {
        await interaction.reply({
          content: "⚠️ まだ予測画像がキャッシュされていません。",
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

// =========================================================================
// 7. Express Webサーバー ＆ 管理画面API
// =========================================================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

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
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
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
    guildSettings: memStore.guildSettings,
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

// 管理画面からAPI最新データを即時取得（通知は送信しない）
app.post("/api/admin/fetch-api", requireAdmin, async (_req, res) => {
  try {
    const result = await runAutomatedPollAndBroadcast("manual_api_fetch");
    return res.json({
      ok: true,
      result,
      events: memStore.events,
      graphs: memStore.graphs,
      nowBorderCache: memStore.nowBorderCache
        ? { text: memStore.nowBorderCache.text, timeLabel: memStore.nowBorderCache.timeLabel }
        : null,
    });
  } catch (err) {
    console.error("[AdminFetchApi] エラー:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
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
  const timeLabel = (req.body.timeLabel || Engine.formatRoundedJstTime(Date.now())).trim();
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

async function saveAdminCachePayload(req, imageBuffer, filename) {
  const now = Date.now();
  const nowBorderText = String(req.body?.nowBorderText || "").trim();
  const eventKey = String(req.body?.eventKey || "").trim();

  memStore.lastManualUpdateAt = now;
  await persistMeta();

  if (eventKey && req.body?.manualAdjustments) {
    try {
      const parsedAdj = JSON.parse(req.body.manualAdjustments);
      memStore.manualAdjustments[eventKey] = parsedAdj;
      await saveRedisJson("borderbot:adjustments", memStore.manualAdjustments);
    } catch (_) {}
  }

  if (nowBorderText) {
    const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
    const timeLabel = m ? m[1] : Engine.formatRoundedJstTime(now);
    memStore.nowBorderCache = {
      text: nowBorderText,
      timeLabel,
      updatedAt: now,
    };
    await saveRedisJson("borderbot:cache:nowborder", memStore.nowBorderCache);
  }

  if (imageBuffer) {
    const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
    const timeLabel = m ? m[1] : Engine.formatRoundedJstTime(now);
    memStore.predictionCache = {
      imageBase64: imageBuffer.toString("base64"),
      filename,
      timeLabel,
      updatedAt: now,
    };
    await saveRedisJson("borderbot:cache:prediction", memStore.predictionCache);
  }

  return { now, nowBorderText };
}

// データのみ更新専用エンドポイント（絶対にDiscord通知を送信しない）
app.post("/api/admin/update-cache", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const imageBuffer = req.file ? req.file.buffer : null;
    const filename = req.file?.originalname || "border_prediction.png";
    await saveAdminCachePayload(req, imageBuffer, filename);
    return res.json({
      ok: true,
      message: "✅ データを新しく更新しました（Discordへの一斉通知は送信していません）。",
    });
  } catch (err) {
    console.error("[UpdateCache] エラー:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 一斉通知送信エンドポイント（notify === "true" の場合のみ送信）
app.post("/api/admin/broadcast", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const customText = String(req.body?.customText || "").trim();
    const customTextPosition = req.body?.customTextPosition || "below";
    const shouldNotify = req.body?.notify === "true";
    const respectMuteTime = req.body?.respectMuteTime === "true";
    const imageBuffer = req.file ? req.file.buffer : null;
    const filename = req.file?.originalname || "border_prediction.png";

    const { now, nowBorderText } = await saveAdminCachePayload(req, imageBuffer, filename);

    if (!shouldNotify) {
      return res.json({
        ok: true,
        message: "✅ データを新しく更新しました（Discordへの一斉通知は送信していません）。",
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
    let mutedSkipCount = 0;

    for (const chId of subs) {
      try {
        const channel = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
          failCount++;
          continue;
        }

        if (respectMuteTime && channel.guildId && isGuildMutedNow(channel.guildId, now)) {
          mutedSkipCount++;
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

    const skipNote = mutedSkipCount > 0 ? ` / ミュート時間スキップ: ${mutedSkipCount}ch` : "";
    return res.json({
      ok: true,
      message: `一斉通知を完了しました（成功: ${successCount}ch / 失敗: ${failCount}ch${skipNote}）`,
    });
  } catch (err) {
    console.error("[Broadcast] 致命的エラー:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================================
// 8. 起動シーケンス ＆ 安全停止処理
// =========================================================================
process.on("SIGINT", () => {
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});

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
