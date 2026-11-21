const express = require("express");
const path = require("path");
const multer = require("multer");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require("discord.js");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 8000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "2226";

const DAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const TIER_DEFS = [
  { rank: 1000, label: "ドリーム級" },
  { rank: 5000, label: "ダイヤ級" },
  { rank: 10000, label: "プラチナ級" },
];

// =========================================================================
// 1. Upstash Redis & メモリキャッシュ層
// =========================================================================
const memStore = {
  events: [],
  graphs: {},
  subscriptions: [],
  nowBorderCache: null,   // { text, timeLabel, updatedAt }
  predictionCache: null,  // { imageBase64, timeLabel, updatedAt }
};

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

async function loadStateFromRedis() {
  const [evRaw, grRaw, subRaw, nbRaw, prRaw] = await Promise.all([
    redisCommand(["GET", "borderbot:events"]),
    redisCommand(["GET", "borderbot:graphs"]),
    redisCommand(["GET", "borderbot:subscriptions"]),
    redisCommand(["GET", "borderbot:cache:nowborder"]),
    redisCommand(["GET", "borderbot:cache:prediction"]),
  ]);

  if (evRaw) {
    try { memStore.events = JSON.parse(evRaw); } catch (_) {}
  }
  if (grRaw) {
    try { memStore.graphs = JSON.parse(grRaw); } catch (_) {}
  }
  if (subRaw) {
    try { memStore.subscriptions = JSON.parse(subRaw); } catch (_) {}
  }
  if (nbRaw) {
    try { memStore.nowBorderCache = JSON.parse(nbRaw); } catch (_) {}
  }
  if (prRaw) {
    try { memStore.predictionCache = JSON.parse(prRaw); } catch (_) {}
  }
}

async function saveRedisJson(key, value) {
  await redisCommand(["SET", key, JSON.stringify(value)]);
}

// =========================================================================
// 2. NowBorder テキスト自動生成ヘルパー（5分丸め ＋ 万単位四捨五入）
// =========================================================================
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

  // prefix が未指定の場合、最も新しいデータ時刻を持つイベントキーを自動選択
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
// 3. Discord Bot ＆ スラッシュコマンド設定
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

client.once("ready", async () => {
  console.log(`[Discord] ログイン完了: ${client.user.tag}`);
  await registerSlashCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId } = interaction;

  try {
    if (commandName === "subscribe") {
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
          content: "⚠️ まだ予測画像がキャッシュされていません。管理画面でデータを読み込むか通知を実行してください。",
          ephemeral: true,
        });
        return;
      }
      const imgBuffer = Buffer.from(pred.imageBase64, "base64");
      const attachment = new AttachmentBuilder(imgBuffer, { name: "border_prediction.png" });
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
        files.push(new AttachmentBuilder(imgBuffer, { name: "border_prediction.png" }));
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
// 4. Express Webサーバー ＆ 管理画面API
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
  res.json({
    events: memStore.events,
    graphs: memStore.graphs,
    subscriptionCount: memStore.subscriptions.length,
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
  memStore.graphs[cacheKey] = graph;
  await saveRedisJson("borderbot:graphs", memStore.graphs);

  const prefix = cacheKey.replace(/::\d+$/, "");
  rebuildNowBorderCacheFromGraphs(prefix);

  res.json({ ok: true });
});

// 管理画面から予測画像キャッシュのみを静かに更新するエンドポイント
app.post("/api/admin/cache-prediction", requireAdmin, upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }
  const timeLabel = (req.body.timeLabel || formatRoundedJstTime(Date.now())).trim();
  const cacheObj = {
    imageBase64: req.file.buffer.toString("base64"),
    timeLabel,
    updatedAt: Date.now(),
  };
  memStore.predictionCache = cacheObj;
  await saveRedisJson("borderbot:cache:prediction", cacheObj);
  res.json({ ok: true, timeLabel });
});

// 登録チャンネルへの一斉通知（Pattern A）＋ キャッシュ同時更新
app.post("/api/admin/broadcast", requireAdmin, upload.single("image"), async (req, res) => {
  const nowBorderText = (req.body.nowBorderText || "").trim();
  const customText = (req.body.customText || "").trim();
  const customTextPosition = req.body.customTextPosition || "below";
  const imageBuffer = req.file ? req.file.buffer : null;

  // キャッシュも最新状態に更新
  if (nowBorderText) {
    const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
    const timeLabel = m ? m[1] : formatRoundedJstTime(Date.now());
    memStore.nowBorderCache = {
      text: nowBorderText,
      timeLabel,
      updatedAt: Date.now(),
    };
    await saveRedisJson("borderbot:cache:nowborder", memStore.nowBorderCache);
  }

  if (imageBuffer) {
    const m = /最終更新\(([^)]+)\)/.exec(nowBorderText);
    const timeLabel = m ? m[1] : formatRoundedJstTime(Date.now());
    memStore.predictionCache = {
      imageBase64: imageBuffer.toString("base64"),
      timeLabel,
      updatedAt: Date.now(),
    };
    await saveRedisJson("borderbot:cache:prediction", memStore.predictionCache);
  }

  if (memStore.subscriptions.length === 0) {
    return res.json({
      ok: true,
      message: "キャッシュを更新しました（通知購読チャンネルは現在0件です）。",
    });
  }

  let successCount = 0;
  let failCount = 0;

  for (const chId of memStore.subscriptions) {
    try {
      const channel = await client.channels.fetch(chId);
      if (!channel || !channel.isTextBased()) {
        failCount++;
        continue;
      }

      const files = imageBuffer
        ? [new AttachmentBuilder(imageBuffer, { name: "border_prediction.png" })]
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

  res.json({
    ok: true,
    message: `一斉通知を完了しました（成功: ${successCount}ch / 失敗: ${failCount}ch）`,
  });
});

// =========================================================================
// 5. 起動シーケンス
// =========================================================================
(async () => {
  await loadStateFromRedis();
  if (!memStore.nowBorderCache) {
    rebuildNowBorderCacheFromGraphs();
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Web] 管理画面サーバー起動: http://0.0.0.0:${PORT}`);
  });

  if (DISCORD_TOKEN) {
    await client.login(DISCORD_TOKEN);
  } else {
    console.warn("[Discord] DISCORD_TOKEN が設定されていません。");
  }
})();
