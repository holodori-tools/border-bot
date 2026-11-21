const { Redis } = require("@upstash/redis");

class DataStore {
  constructor() {
    this.redis = null;
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      this.redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    } else {
      console.warn("[Store] Upstash Redis 未設定のため、インメモリ動作になります。");
    }

    this.subscriptions = new Map(); // channelId -> { channelId, guildId, nowBorder, borderPrediction, updatedAt }
    this.events = [];               // API /list から取得したイベント一覧キャッシュ
    this.graphs = {};               // `${key}::${rank}` -> 開催中イベントのグラフJSONキャッシュ
  }

  async init() {
    if (!this.redis) return;
    try {
      const [cachedSubs, cachedEvents, cachedGraphs] = await Promise.all([
        this.redis.get("borderbot:subscriptions"),
        this.redis.get("borderbot:events"),
        this.redis.get("borderbot:graphs"),
      ]);

      if (cachedSubs && typeof cachedSubs === "object") {
        for (const [chId, sub] of Object.entries(cachedSubs)) {
          this.subscriptions.set(chId, sub);
        }
      }
      if (Array.isArray(cachedEvents)) {
        this.events = cachedEvents;
      }
      if (cachedGraphs && typeof cachedGraphs === "object") {
        this.graphs = cachedGraphs;
      }

      console.log(
        `[Store] Redis 復元完了: 購読ch=${this.subscriptions.size}件, イベント一覧=${this.events.length}件, グラフ=${Object.keys(this.graphs).length}件`
      );
    } catch (err) {
      console.error("[Store] Redis 読込エラー:", err);
    }
  }

  async setSubscription(channelId, guildId, nowBorder, borderPrediction) {
    if (!nowBorder && !borderPrediction) {
      return await this.removeSubscription(channelId);
    }
    const entry = {
      channelId,
      guildId,
      nowBorder: Boolean(nowBorder),
      borderPrediction: Boolean(borderPrediction),
      updatedAt: Date.now(),
    };
    this.subscriptions.set(channelId, entry);
    await this.persistSubscriptions();
    return entry;
  }

  async removeSubscription(channelId) {
    const existed = this.subscriptions.delete(channelId);
    await this.persistSubscriptions();
    return existed;
  }

  async persistSubscriptions() {
    if (!this.redis) return;
    const obj = Object.fromEntries(this.subscriptions.entries());
    await this.redis.set("borderbot:subscriptions", obj);
  }

  async saveEvents(eventsArray) {
    this.events = eventsArray;
    if (this.redis) {
      await this.redis.set("borderbot:events", this.events);
    }
  }

  async saveGraphEntry(cacheKey, graphObj) {
    this.graphs[cacheKey] = graphObj;
    // 直近8件分のみRedisに保持して容量をスリムに維持
    const keys = Object.keys(this.graphs);
    if (keys.length > 8) {
      for (const oldKey of keys.slice(0, keys.length - 8)) {
        delete this.graphs[oldKey];
      }
    }
    if (this.redis) {
      await this.redis.set("borderbot:graphs", this.graphs);
    }
  }
}

module.exports = { DataStore };
