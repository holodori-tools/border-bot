require("dotenv").config();
const path = require("path");
const express = require("express");
const multer = require("multer");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  AttachmentBuilder,
  Events,
} = require("discord.js");
const { DataStore } = require("./store");
const { commands } = require("./commands");

const PORT = Number(process.env.PORT) || 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "2226";

const store = new DataStore();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 最大8MB
});

// =========================================================================
// 1. Discord Bot セットアップ
// =========================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function registerSlashCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    console.warn("[Discord] DISCORD_TOKEN または DISCORD_CLIENT_ID が未設定です。");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("[Discord] スラッシュコマンド（/subscribe, /unsubscribe）を登録しました。");
}

client.once(Events.ClientReady, (c) => {
  console.log(`[Discord] ログイン完了: ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "subscribe") {
      const nowBorder = interaction.options.getBoolean("now_border", true);
      const borderPrediction = interaction.options.getBoolean("border_prediction", true);

      if (!nowBorder && !borderPrediction) {
        await store.removeSubscription(interaction.channelId);
        await interaction.reply({
          content: "両方のオプションが `False` のため、このチャンネルのボーダー通知を解除しました。",
          ephemeral: true,
        });
        return;
      }

      await store.setSubscription(
        interaction.channelId,
        interaction.guildId || "DM",
        nowBorder,
        borderPrediction
      );

      const modes = [];
      if (nowBorder) modes.push("最新ボーダーテキスト（NowBorder）");
      if (borderPrediction) modes.push("着地予測レポート画像（BorderPrediction）");

      await interaction.reply({
        content: `✅ このチャンネルをボーダー通知先に登録しました。\n・配信内容: **${modes.join(" ＋ ")}**\n・管理画面から「Botに反映」が実行されると自動通知されます。`,
        ephemeral: true,
      });
    } else if (interaction.commandName === "unsubscribe") {
      const removed = await store.removeSubscription(interaction.channelId);
      await interaction.reply({
        content: removed
          ? "🔕 このチャンネルのボーダー通知を解除しました。"
          : "このチャンネルは通知リストに登録されていません。",
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("[Discord] コマンド処理エラー:", err);
    if (!interaction.replied) {
      await interaction.reply({ content: "エラーが発生しました。", ephemeral: true });
    }
  }
});

// =========================================================================
// 2. Express 管理画面 ＆ 軽量APIサーバー
// =========================================================================
const app = express();
app.use(express.json({ limit: "6mb" }));

// Northflank ヘルスチェック用（認証不要）
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, status: "running" });
});

// 管理画面HTML配信
app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});

// 認証ミドルウェア
function requireAdminAuth(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (String(pw) !== String(ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, error: "パスワードが正しくありません。" });
  }
  next();
}

// ログイン確認
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (String(password) === String(ADMIN_PASSWORD)) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "パスワードが違います。" });
});

// キャッシュ状態と購読数を取得
app.get("/api/admin/bootstrap", requireAdminAuth, (_req, res) => {
  res.json({
    ok: true,
    events: store.events,
    graphs: store.graphs,
    subscriptionCount: store.subscriptions.size,
  });
});

// イベント一覧キャッシュの保存
app.post("/api/admin/cache-events", requireAdminAuth, async (req, res) => {
  try {
    const { events } = req.body || {};
    if (!Array.isArray(events)) {
      return res.status(400).json({ ok: false, error: "events 配列が不正です。" });
    }
    await store.saveEvents(events);
    res.json({ ok: true, count: events.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// グラフデータキャッシュの保存
app.post("/api/admin/cache-graph", requireAdminAuth, async (req, res) => {
  try {
    const { cacheKey, graph } = req.body || {};
    if (!cacheKey || !graph || !Array.isArray(graph.tier)) {
      return res.status(400).json({ ok: false, error: "グラフデータが不正です。" });
    }
    await store.saveGraphEntry(cacheKey, graph);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 「Botに反映」一斉通知エンドポイント（パターンA: 画像下テキスト時は2通分割送信）
app.post(
  "/api/admin/broadcast",
  requireAdminAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const subs = Array.from(store.subscriptions.values());
      if (subs.length === 0) {
        return res.json({
          ok: true,
          sentCount: 0,
          failedCount: 0,
          message: "購読登録されているチャンネルが0件のため、送信をスキップされました。",
        });
      }

      const nowBorderText = (req.body.nowBorderText || "").trim();
      const customText = (req.body.customText || "").trim();
      const customTextPosition = req.body.customTextPosition === "above" ? "above" : "below";
      const imageBuffer = req.file ? req.file.buffer : null;
      const fileName = `border_prediction_${Date.now()}.png`;

      let sentCount = 0;
      let failedCount = 0;

      for (const sub of subs) {
        try {
          const channel = await client.channels.fetch(sub.channelId);
          if (!channel || !channel.isTextBased()) {
            failedCount++;
            continue;
          }

          const hasNow = Boolean(sub.nowBorder && nowBorderText);
          const hasImg = Boolean(sub.borderPrediction && imageBuffer);
          const hasCustom = Boolean(customText);

          // 何も送る要素がないチャンネルはスキップ
          if (!hasNow && !hasImg && !hasCustom) {
            continue;
          }

          if (hasCustom && customTextPosition === "above") {
            // 【NowBorder の上】1通目の先頭に任意テキストを配置
            const textParts = [customText];
            if (hasNow) textParts.push(nowBorderText);

            const payload = {
              content: textParts.join("\n\n"),
            };
            if (hasImg) {
              payload.files = [new AttachmentBuilder(imageBuffer, { name: fileName })];
            }
            await channel.send(payload);
            sentCount++;
          } else {
            // 【BorderPrediction の下（または任意テキストなし）】パターンA：1通目で本体、2通目で任意テキストを送信
            const firstPayload = {};
            if (hasNow) {
              firstPayload.content = nowBorderText;
            }
            if (hasImg) {
              firstPayload.files = [new AttachmentBuilder(imageBuffer, { name: fileName })];
            }

            if (firstPayload.content || firstPayload.files) {
              await channel.send(firstPayload);
            }

            if (hasCustom) {
              await channel.send({ content: customText });
            }

            sentCount++;
          }
        } catch (sendErr) {
          console.error(`[Broadcast] チャンネル ${sub.channelId} への送信失敗:`, sendErr.message);
          failedCount++;
        }
      }

      res.json({
        ok: true,
        sentCount,
        failedCount,
        message: `一斉通知を完了しました（成功: ${sentCount}ch / 失敗: ${failedCount}ch）`,
      });
    } catch (err) {
      console.error("[Broadcast] 一斉通知エラー:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// =========================================================================
// 3. 起動シーケンス
// =========================================================================
async function bootstrap() {
  await store.init();
  await registerSlashCommands();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Web] 管理画面サーバー起動: http://0.0.0.0:${PORT}`);
  });

  if (process.env.DISCORD_TOKEN) {
    await client.login(process.env.DISCORD_TOKEN);
  }
}

bootstrap().catch((err) => {
  console.error("[Fatal] 起動失敗:", err);
  process.exit(1);
});
