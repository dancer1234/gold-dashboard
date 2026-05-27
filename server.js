const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");

const MARKET_TTL_MS = 20_000;
const NEWS_TTL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SHORT_WINDOW_MINUTES = 15;
const PRICE_ALERT_THRESHOLD = 1;
const TROY_OUNCE_GRAMS = 31.1034768;
const ICBC_TTL_MS = 60_000;

const GOLDPRICE_API_URL = "https://data-asg.goldprice.org/dbXRates/USD,CNY";
const GOLDPRICE_PAGE_URL = "https://www.goldprice.org/zh-hant";
const ICBC_RUYI_URL =
  "https://mybank.icbc.com.cn/servlet/ICBCBaseReqServletNoSession?dse_operationName=per_jcGoldIndexNSOp&p3bank_error_backid=1606&specialRequriement=0&prodcode=080020000501&Area_code=3004&requestChannel=302";
const ICBC_ACCUMULATION_URL =
  "https://mybank.icbc.com.cn/icbc/newperbank/perbank3/gold/goldaccrual_query_out.jsp";

const cache = {
  market: { at: 0, data: null },
  news: { at: 0, data: null },
  icbc: { at: 0, data: null },
};

const goldPriceHistory = [];

const channels = [
  {
    id: "goldprice_org",
    name: "GoldPrice.org Spot Gold Bid",
    shortName: "GoldPrice.org",
    venue: "GoldPrice.org",
    symbol: "USD-XAU,CNY-XAU",
    kind: "benchmark",
    unit: "USD/oz",
    primary: true,
  },
  {
    id: "comex_gc",
    name: "COMEX GC Gold Futures",
    shortName: "COMEX GC",
    venue: "CME/COMEX",
    symbol: "GC=F",
    kind: "futures",
    unit: "USD/oz",
    primary: true,
  },
  {
    id: "xauusd_spot",
    name: "XAU/USD Spot",
    shortName: "XAU/USD",
    venue: "Stooq",
    symbol: "xauusd",
    kind: "spot",
    unit: "USD/oz",
    primary: true,
  },
  {
    id: "gld_etf",
    name: "SPDR Gold Shares",
    shortName: "GLD",
    venue: "NYSE Arca",
    symbol: "GLD",
    kind: "etf",
    unit: "USD/share",
    primary: false,
  },
  {
    id: "crude_oil",
    name: "WTI Crude Oil Futures",
    shortName: "WTI",
    venue: "NYMEX",
    symbol: "CL=F",
    kind: "macro",
    unit: "USD/bbl",
    primary: false,
  },
  {
    id: "usd_cny_fx",
    name: "USD/CNY FX Rate",
    shortName: "USD/CNY",
    venue: "Yahoo Finance",
    symbol: "CNY=X",
    kind: "fx",
    unit: "CNY/USD",
    primary: false,
  },
];

const categories = [
  {
    id: "geopolitics",
    label: "地缘/战争",
    keywords: [
      "war",
      "conflict",
      "geopolitical",
      "israel",
      "iran",
      "russia",
      "ukraine",
      "sanction",
      "missile",
      "ceasefire",
      "tariff",
      "military",
    ],
  },
  {
    id: "fed",
    label: "美联储/利率",
    keywords: [
      "fed",
      "federal reserve",
      "powell",
      "rate",
      "fomc",
      "inflation",
      "cpi",
      "pce",
      "treasury",
      "yield",
      "dollar",
    ],
  },
  {
    id: "jobs",
    label: "就业/失业",
    keywords: [
      "jobs",
      "payroll",
      "employment",
      "unemployment",
      "labor",
      "jobless",
      "claims",
      "wage",
      "nfp",
    ],
  },
  {
    id: "oil",
    label: "油价/能源",
    keywords: [
      "oil",
      "crude",
      "brent",
      "wti",
      "opec",
      "energy",
      "gas",
      "supply",
    ],
  },
  {
    id: "technology",
    label: "科技/风险偏好",
    keywords: [
      "technology",
      "ai",
      "chip",
      "semiconductor",
      "nasdaq",
      "tech",
      "crypto",
      "bitcoin",
      "equities",
    ],
  },
  {
    id: "flows",
    label: "交易/资金流",
    keywords: [
      "comex",
      "futures",
      "options",
      "etf",
      "gld",
      "central bank",
      "reserve",
      "buying",
      "demand",
      "volume",
      "positioning",
    ],
  },
];

const factorDefinitions = [
  {
    id: "price_momentum",
    name: "价格动量",
    threshold: `15分钟涨跌幅 >= ${PRICE_ALERT_THRESHOLD}% 触发预警；>= 0.4% 视为趋势增强`,
    polarity: "同方向延续",
  },
  {
    id: "venue_divergence",
    name: "渠道价差",
    threshold: "COMEX 与 XAU/USD 价差 >= 0.35% 标记为渠道分歧",
    polarity: "价差扩大代表流动性或交易渠道异常",
  },
  {
    id: "geopolitics",
    name: "地缘/战争热度",
    threshold: "2小时内相关新闻 >= 4 条且标题含冲突/制裁/战争词",
    polarity: "通常利多黄金避险需求",
  },
  {
    id: "fed",
    name: "美联储/美元利率",
    threshold: "2小时内相关新闻 >= 4 条，鹰派词频高为利空，降息/疲软词频高为利多",
    polarity: "真实利率和美元走强通常压制黄金",
  },
  {
    id: "jobs",
    name: "美国就业/失业",
    threshold: "就业疲软词频升高利多；就业强劲/工资压力升高利空",
    polarity: "影响降息预期和美元定价",
  },
  {
    id: "oil",
    name: "油价/通胀链条",
    threshold: "WTI 15分钟涨跌幅 >= 1.5% 或能源新闻 >= 3 条",
    polarity: "油价上行可能强化通胀和避险定价",
  },
  {
    id: "technology",
    name: "科技/风险偏好",
    threshold: "科技与股指风险偏好新闻 >= 3 条",
    polarity: "风险资产走强可能削弱避险买盘",
  },
  {
    id: "flows",
    name: "交易/资金流",
    threshold: "期货/ETF/央行买盘新闻 >= 3 条，或单渠道成交量高于近30点中位数 2.5 倍",
    polarity: "资金流异常优先用于解释短时波动",
  },
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 GoldRealtimeIntelligence/1.0 (+local dashboard)",
        accept: "application/json,text/plain,*/*",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoldPriceOrg() {
  const channel = channels.find((item) => item.id === "goldprice_org");
  const response = await fetchWithTimeout(`${GOLDPRICE_API_URL}?_=${Date.now()}`, {
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: "https://www.goldprice.org/",
      origin: "https://www.goldprice.org",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
  });
  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const usd = items.find((item) => item.curr === "USD");
  const cny = items.find((item) => item.curr === "CNY");
  const usdPerOunce = Number(usd?.xauPrice);
  const cnyPerOunce = Number(cny?.xauPrice);

  if (!Number.isFinite(usdPerOunce) || !Number.isFinite(cnyPerOunce)) {
    throw new Error("GoldPrice.org response missing USD/CNY XAU prices");
  }

  const updatedAt = Number.isFinite(payload.ts)
    ? new Date(payload.ts).toISOString()
    : new Date().toISOString();
  const cnyPerGram = cnyPerOunce / TROY_OUNCE_GRAMS;
  recordGoldPricePoint({
    time: updatedAt,
    price: round(usdPerOunce, 4),
    cnyPerGram: round(cnyPerGram, 4),
    volume: null,
  });

  const points = goldPriceHistory.length
    ? goldPriceHistory
    : [{ time: updatedAt, price: round(usdPerOunce, 4), volume: null }];
  const normalized = normalizeChannel(channel, points, "live", {
    previousClose: Number(usd?.xauClose),
    currency: "USD",
    exchangeName: "GoldPrice.org",
    marketState: "REALTIME",
  });

  return {
    ...normalized,
    latest: round(usdPerOunce, 4),
    changePct: Number.isFinite(usd?.pcXau) ? round(Number(usd.pcXau), 3) : normalized.changePct,
    usdPerOunce: round(usdPerOunce, 4),
    usdChange: Number.isFinite(usd?.chgXau) ? round(Number(usd.chgXau), 4) : null,
    cnyPerOunce: round(cnyPerOunce, 4),
    cnyPerGram: round(cnyPerGram, 4),
    cnyChange: Number.isFinite(cny?.chgXau) ? round(Number(cny.chgXau), 4) : null,
    displayPrices: [
      {
        label: "美元/盎司",
        value: round(usdPerOunce, 2),
        unit: "USD/oz",
      },
      {
        label: "人民币/克",
        value: round(cnyPerGram, 2),
        unit: "CNY/g",
      },
    ],
    sourceUrl: GOLDPRICE_PAGE_URL,
    rawDate: payload.date || "",
  };
}

async function fetchYahooChart(channel) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    channel.symbol
  )}?range=1d&interval=1m&includePrePost=true`;
  const response = await fetchWithTimeout(url);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];

  if (!result) {
    throw new Error(payload.chart?.error?.description || "empty chart result");
  }

  const quote = result.indicators?.quote?.[0] || {};
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const points = timestamps
    .map((timestamp, index) => {
      const price =
        quote.close?.[index] ??
        quote.regularMarketPrice?.[index] ??
        quote.open?.[index] ??
        null;

      if (!Number.isFinite(price)) return null;

      return {
        time: new Date(timestamp * 1000).toISOString(),
        price: round(price, 4),
        volume: Number.isFinite(quote.volume?.[index])
          ? quote.volume[index]
          : null,
      };
    })
    .filter(Boolean);

  if (!points.length && Number.isFinite(meta.regularMarketPrice)) {
    points.push({
      time: new Date().toISOString(),
      price: round(meta.regularMarketPrice, 4),
      volume: null,
    });
  }

  if (!points.length) {
    throw new Error("no price points");
  }

  return normalizeChannel(channel, points, "live", meta);
}

async function fetchStooqSpot() {
  const channel = {
    id: "stooq_xauusd",
    name: "Stooq XAU/USD",
    shortName: "Stooq XAU",
    venue: "Stooq",
    symbol: "xauusd",
    kind: "spot",
    unit: "USD/oz",
    primary: false,
  };
  const url = "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv";
  const response = await fetchWithTimeout(url, {
    headers: { accept: "text/csv,*/*" },
  });
  const csv = await response.text();
  const rows = csv.trim().split(/\r?\n/);
  const header = rows[0]?.split(",") || [];
  const row = rows[1]?.split(",") || [];
  const data = Object.fromEntries(header.map((key, index) => [key, row[index]]));
  const close = Number(data.Close);

  if (!Number.isFinite(close)) {
    throw new Error("invalid Stooq close");
  }

  return normalizeChannel(
    channel,
    [{ time: new Date().toISOString(), price: round(close, 4), volume: null }],
    "live",
    {}
  );
}

async function fetchStooqXauUsd() {
  const channel = channels.find((item) => item.id === "xauusd_spot");
  const url = "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv";
  const response = await fetchWithTimeout(url, {
    headers: { accept: "text/csv,*/*" },
  });
  const csv = await response.text();
  const rows = csv.trim().split(/\r?\n/);
  const header = rows[0]?.split(",") || [];
  const row = rows[1]?.split(",") || [];
  const data = Object.fromEntries(header.map((key, index) => [key, row[index]]));
  const close = Number(data.Close);

  if (!Number.isFinite(close)) {
    throw new Error("invalid Stooq XAU/USD close");
  }

  return normalizeChannel(
    channel,
    [{ time: new Date().toISOString(), price: round(close, 4), volume: null }],
    "live",
    { currency: "USD", exchangeName: "Stooq" }
  );
}

function normalizeChannel(channel, points, status, meta = {}) {
  const latestPoint = points[points.length - 1];
  const previousClose = Number.isFinite(meta.previousClose)
    ? meta.previousClose
    : points[0]?.price;
  const regularPrice = Number.isFinite(meta.regularMarketPrice)
    ? meta.regularMarketPrice
    : latestPoint.price;
  const latest = round(latestPoint.price ?? regularPrice, 4);
  const changePct = pctChange(latest, previousClose);
  const shortChangePct = pctChange(latest, findPriorPrice(points, SHORT_WINDOW_MINUTES));
  const oneHourChangePct = pctChange(latest, findPriorPrice(points, 60));
  const volumeStats = volumeSignal(points);

  return {
    ...channel,
    status,
    latest,
    previousClose: Number.isFinite(previousClose) ? round(previousClose, 4) : null,
    changePct,
    shortChangePct,
    oneHourChangePct,
    updatedAt: latestPoint.time,
    currency: meta.currency || "USD",
    exchangeName: meta.exchangeName || channel.venue,
    marketState: meta.marketState || "UNKNOWN",
    volume: latestPoint.volume,
    volumeSignal: volumeStats,
    points: points.slice(-160),
    error: null,
  };
}

function findPriorPrice(points, minutes) {
  if (!points.length) return null;
  const latestTime = Date.parse(points[points.length - 1].time);
  const target = latestTime - minutes * 60_000;
  let prior = points[0];

  for (const point of points) {
    if (Date.parse(point.time) <= target) {
      prior = point;
    } else {
      break;
    }
  }

  return prior?.price ?? null;
}

function recordGoldPricePoint(point) {
  const last = goldPriceHistory[goldPriceHistory.length - 1];
  if (last && last.time === point.time && last.price === point.price) {
    return;
  }

  goldPriceHistory.push(point);
  const cutoff = Date.now() - 6 * 60 * 60_000;

  while (
    goldPriceHistory.length > 1 &&
    Date.parse(goldPriceHistory[0].time) < cutoff
  ) {
    goldPriceHistory.shift();
  }
}

function volumeSignal(points) {
  const volumes = points
    .map((point) => point.volume)
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  if (volumes.length < 10) {
    return { ratioToMedian: null, level: "unknown" };
  }

  const recent = volumes[volumes.length - 1];
  const median = medianOf(volumes.slice(-30));
  const ratio = median ? recent / median : null;
  const level = ratio >= 2.5 ? "abnormal" : ratio >= 1.6 ? "elevated" : "normal";

  return {
    ratioToMedian: Number.isFinite(ratio) ? round(ratio, 2) : null,
    level,
  };
}

async function getMarketData() {
  if (cache.market.data && Date.now() - cache.market.at < MARKET_TTL_MS) {
    return cache.market.data;
  }

  const yahooChannels = channels.filter(
    (channel) => channel.id !== "goldprice_org" && channel.id !== "xauusd_spot"
  );
  const results = await Promise.allSettled([
    fetchGoldPriceOrg(),
    ...yahooChannels.map(fetchYahooChart),
    fetchStooqSpot(),
    fetchStooqXauUsd(),
  ]);

  const liveChannels = results
    .map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      // Map error results back to their channel
      const channel = result.status === "rejected" ? findChannelByIndex(index) : null;
      if (!channel) return null;
      return {
        ...channel,
        status: "error",
        latest: null,
        previousClose: null,
        changePct: null,
        shortChangePct: null,
        oneHourChangePct: null,
        updatedAt: new Date().toISOString(),
        marketState: "UNAVAILABLE",
        volume: null,
        volumeSignal: { ratioToMedian: null, level: "unknown" },
        points: [],
        error: result.reason?.message || "fetch failed",
      };
    })
    .filter(Boolean);

  // Helper to find channel by result index
  function findChannelByIndex(index) {
    if (index === 0) return channels.find((item) => item.id === "goldprice_org");
    if (index <= yahooChannels.length) return yahooChannels[index - 1];
    if (index === yahooChannels.length + 1) return { id: "stooq_xauusd", name: "Stooq XAU/USD", shortName: "Stooq XAU", venue: "Stooq", kind: "spot", unit: "USD/oz" };
    if (index === yahooChannels.length + 2) return channels.find((item) => item.id === "xauusd_spot");
    return null;
  }

  const usable = liveChannels.filter((channel) => Number.isFinite(channel.latest));
  const usingFallback = usable.length === 0;
  const data = usingFallback ? buildFallbackMarketData() : buildMarketEnvelope(liveChannels);

  cache.market = { at: Date.now(), data };
  return data;
}

function buildMarketEnvelope(channelData) {
  const primary = selectPrimaryGold(channelData);
  const goldprice = channelData.find((channel) => channel.id === "goldprice_org");
  const usdCny = channelData.find(
    (channel) => channel.id === "usd_cny_fx" && Number.isFinite(channel.latest)
  );
  const spot =
    channelData.find(
      (channel) => channel.id === "xauusd_spot" && Number.isFinite(channel.latest)
    ) ||
    channelData.find(
      (channel) => channel.id === "stooq_xauusd" && Number.isFinite(channel.latest)
    );
  const futures = channelData.find((channel) => channel.id === "comex_gc");
  const divergencePct =
    Number.isFinite(spot?.latest) && Number.isFinite(futures?.latest)
      ? round(((futures.latest - spot.latest) / spot.latest) * 100, 3)
      : null;

  if (
    primary &&
    !Number.isFinite(primary.cnyPerGram) &&
    Number.isFinite(primary.usdPerOunce) &&
    Number.isFinite(usdCny?.latest)
  ) {
    primary.cnyPerOunce = round(primary.usdPerOunce * usdCny.latest, 4);
    primary.cnyPerGram = round(primary.cnyPerOunce / TROY_OUNCE_GRAMS, 4);
    primary.displayPrices = [
      {
        label: "美元/盎司",
        value: round(primary.usdPerOunce, 2),
        unit: "USD/oz",
      },
      {
        label: "人民币/克",
        value: round(primary.cnyPerGram, 2),
        unit: "CNY/g",
      },
    ];
    primary.conversionNote = "GoldPrice.org blocked; RMB/g is converted with USD/CNY fallback.";
  }

  const abnormalChannels = detectAbnormalChannels(channelData, divergencePct);
  const alert = buildPriceAlert(primary, abnormalChannels, divergencePct);

  return {
    asOf: new Date().toISOString(),
    status: "live",
    sourceNote:
      goldprice?.status === "live"
        ? "GoldPrice.org is used as the benchmark price; other feeds are cross-venue signals."
        : "GoldPrice.org is unavailable; other feeds are displayed for continuity.",
    primary,
    goldprice: goldprice
      ? {
          status: goldprice.status,
          usdPerOunce: goldprice.usdPerOunce ?? goldprice.latest,
          cnyPerGram: goldprice.cnyPerGram ?? null,
          cnyPerOunce: goldprice.cnyPerOunce ?? null,
          changePct: goldprice.changePct,
          updatedAt: goldprice.updatedAt,
          sourceUrl: goldprice.sourceUrl || GOLDPRICE_PAGE_URL,
          error: goldprice.error || null,
        }
      : null,
    channels: channelData,
    divergencePct,
    divergencePair:
      Number.isFinite(divergencePct) && spot && futures
        ? `${futures.shortName} - ${spot.shortName}`
        : null,
    abnormalChannels,
    alert,
  };
}

function selectPrimaryGold(channelData) {
  const goldprice = channelData.find(
    (channel) => channel.id === "goldprice_org" && Number.isFinite(channel.latest)
  );
  const futures = channelData.find(
    (channel) => channel.id === "comex_gc" && Number.isFinite(channel.latest)
  );
  const spot = channelData.find(
    (channel) => channel.id === "xauusd_spot" && Number.isFinite(channel.latest)
  );
  const stooq = channelData.find(
    (channel) => channel.id === "stooq_xauusd" && Number.isFinite(channel.latest)
  );
  const selected =
    goldprice ||
    spot ||
    futures ||
    stooq ||
    channelData.find((channel) => Number.isFinite(channel.latest));

  if (!selected) {
    return null;
  }

  return {
    id: selected.id,
    name: selected.name,
    shortName: selected.shortName,
    venue: selected.venue,
    latest: selected.latest,
    unit: selected.unit,
    changePct: selected.changePct,
    shortChangePct: selected.shortChangePct,
    oneHourChangePct: selected.oneHourChangePct,
    updatedAt: selected.updatedAt,
    points: selected.points,
    usdPerOunce: selected.usdPerOunce ?? selected.latest,
    cnyPerGram: selected.cnyPerGram ?? null,
    cnyPerOunce: selected.cnyPerOunce ?? null,
    displayPrices: selected.displayPrices || [],
    sourceUrl: selected.sourceUrl || null,
  };
}

function detectAbnormalChannels(channelData, divergencePct) {
  const items = [];

  for (const channel of channelData) {
    const absMove = Math.abs(channel.shortChangePct ?? 0);
    if (absMove >= PRICE_ALERT_THRESHOLD) {
      items.push({
        channelId: channel.id,
        channel: channel.shortName,
        venue: channel.venue,
        type: "short_move",
        severity: "high",
        message: `${channel.shortName} ${SHORT_WINDOW_MINUTES}分钟涨跌幅 ${formatSigned(
          channel.shortChangePct
        )}%`,
        value: channel.shortChangePct,
      });
    }

    if (channel.volumeSignal?.level === "abnormal") {
      items.push({
        channelId: channel.id,
        channel: channel.shortName,
        venue: channel.venue,
        type: "volume",
        severity: "medium",
        message: `${channel.shortName} 最新成交量约为近30点中位数 ${channel.volumeSignal.ratioToMedian} 倍`,
        value: channel.volumeSignal.ratioToMedian,
      });
    }
  }

  if (Number.isFinite(divergencePct) && Math.abs(divergencePct) >= 0.35) {
    items.push({
      channelId: "venue_divergence",
      channel: "COMEX vs XAU/USD",
      venue: "Cross venue",
      type: "divergence",
      severity: "medium",
      message: `COMEX 与现货价差 ${formatSigned(divergencePct)}%，优先检查期货盘/现货流动性`,
      value: divergencePct,
    });
  }

  return items.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
}

function buildPriceAlert(primary, abnormalChannels, divergencePct) {
  if (!primary) {
    return {
      active: false,
      severity: "offline",
      title: "行情源暂不可用",
      message: "没有可用的主行情源，页面已进入降级模式。",
      cause: "数据源连接异常",
    };
  }

  const shortMove = primary.shortChangePct ?? 0;
  const priceAlert = Math.abs(shortMove) >= PRICE_ALERT_THRESHOLD;
  const channelAlert = abnormalChannels.length > 0;

  if (!priceAlert && !channelAlert) {
    return {
      active: false,
      severity: "normal",
      title: "未触发短线价格预警",
      message: `${SHORT_WINDOW_MINUTES}分钟波动 ${formatSigned(shortMove)}%，低于 ${PRICE_ALERT_THRESHOLD}% 阈值。`,
      cause: "无明显异常渠道",
    };
  }

  const top = abnormalChannels[0];
  const direction = shortMove > 0 ? "上行" : "下行";
  const severity = Math.abs(shortMove) >= 1.8 ? "critical" : "warning";

  return {
    active: true,
    severity,
    title: `黄金短线${direction}预警`,
    message: `${primary.shortName} 在 ${SHORT_WINDOW_MINUTES}分钟内波动 ${formatSigned(
      shortMove
    )}%，超过 ${PRICE_ALERT_THRESHOLD}% 阈值。`,
    cause:
      top?.message ||
      (Number.isFinite(divergencePct)
        ? `渠道价差 ${formatSigned(divergencePct)}%`
        : "主行情源短线波动异常"),
  };
}

async function getNewsData() {
  if (cache.news.data && Date.now() - cache.news.at < NEWS_TTL_MS) {
    return cache.news.data;
  }

  const results = await Promise.allSettled([
    fetchGdeltNews(),
    fetchGoogleNewsRss(),
    fetchYahooFinanceRss(),
  ]);
  const articles = dedupeArticles(
    results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  ).slice(0, 60);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message)
    .filter(Boolean);

  if (articles.length) {
    const data = buildNewsEnvelope(articles, "live", errors.join("; ") || null);
    cache.news = { at: Date.now(), data };
    return data;
  }

  const data = buildNewsEnvelope(buildFallbackNews(), "fallback", errors.join("; "));
  cache.news = { at: Date.now(), data };
  return data;
}

async function fetchGdeltNews() {
  const query =
    '(gold OR XAU OR bullion OR "gold futures") (price OR fed OR oil OR war OR jobs OR unemployment OR technology OR "central bank" OR ETF)';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=ArtList&format=json&sort=HybridRel&maxrecords=30&timespan=24h`;
  const response = await fetchWithTimeout(url);
  const payload = await response.json();
  return (payload.articles || []).map(normalizeArticle).filter(Boolean);
}

async function fetchGoogleNewsRss() {
  const query =
    'gold price (Federal Reserve OR oil OR war OR jobs OR unemployment OR technology OR "central bank" OR COMEX) when:1d';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/rss+xml,text/xml,*/*" },
  });
  const xml = await response.text();
  return parseRss(xml, "Google News");
}

async function fetchYahooFinanceRss() {
  const url =
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F,XAUUSD=X,GLD&region=US&lang=en-US";
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/rss+xml,text/xml,*/*" },
  });
  const xml = await response.text();
  return parseRss(xml, "Yahoo Finance");
}

function parseRss(xml, fallbackDomain) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .map((match) => {
      const item = match[0];
      const title = decodeXml(stripTags(readXmlTag(item, "title")));
      if (!title) return null;

      const link = decodeXml(stripTags(readXmlTag(item, "link")));
      const source = decodeXml(stripTags(readXmlTag(item, "source")));
      const pubDate = decodeXml(stripTags(readXmlTag(item, "pubDate")));
      const description = decodeXml(stripTags(readXmlTag(item, "description")));
      const text = `${title} ${description} ${source}`.toLowerCase();
      const matched = classifyText(text);
      const tone = scoreArticleTone(text, matched);

      return {
        id: hash(`${title}-${link}`),
        title: cleanText(title),
        url: link,
        domain: cleanText(source) || hostFromUrl(link) || fallbackDomain,
        sourceCountry: "",
        language: "English",
        seenAt: parseRssDate(pubDate),
        image: "",
        categories: matched,
        tone,
      };
    })
    .filter(Boolean);
}

function readXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "") : "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseRssDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function dedupeArticles(articles) {
  const seen = new Set();
  const deduped = [];

  for (const article of articles) {
    const key = cleanText(article.title).toLowerCase().replace(/[^\w]+/g, " ").slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(article);
  }

  return deduped.sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt));
}

function normalizeArticle(article) {
  const title = cleanText(article.title);
  if (!title) return null;
  const url = article.url || "";
  const domain = article.domain || hostFromUrl(url) || "unknown";
  const text = `${title} ${cleanText(article.seendate)} ${cleanText(
    article.sourcecountry
  )}`.toLowerCase();
  const matched = classifyText(text);
  const tone = scoreArticleTone(text, matched);

  return {
    id: hash(`${title}-${url}`),
    title,
    url,
    domain,
    sourceCountry: article.sourcecountry || "",
    language: article.language || "",
    seenAt: parseGdeltDate(article.seendate),
    image: article.socialimage || "",
    categories: matched,
    tone,
  };
}

// ======== 内置英中翻译词典 ========
const translationDict = [
  // 长词组优先匹配（按长度降序）
  ["federal reserve", "美联储"], ["safe haven", "避险"], ["safe-haven", "避险"],
  ["central bank", "央行"], ["interest rate", "利率"],
  ["rate cut", "降息"], ["rate hike", "加息"],
  ["trade war", "贸易战"], ["tariff war", "关税战"],
  ["all-time", "历史"], ["one-week", "一周"], ["one-day", "一日"],
  ["us-iran", "美国-伊朗"], ["us-china", "美中"],
  // 金融核心词（长词优先）
  ["geopolitical", "地缘政治"], ["semiconductor", "半导体"],
  ["unemployment", "失业"], ["employment", "就业"],
  ["inflation", "通胀"], ["expectations", "预期"],
  ["recession", "衰退"], ["recovery", "复苏"],
  ["positioning", "头寸"], ["escalation", "升级"],
  ["volatility", "波动性"], ["development", "进展"], ["developments", "动态"],
  ["sanctions", "制裁"], ["sanction", "制裁"],
  ["technology", "科技"], ["nonfarm", "非农"], ["non-farm", "非农"],
  ["bullion", "金银条"], ["futures", "期货"], ["options", "期权"],
  ["treasury", "国债"], ["comex", "COMEX"],
  // 动词
  ["surges", "飙升"], ["surged", "飙升"], ["surge", "飙升"],
  ["rallying", "反弹"], ["rallies", "反弹"], ["rally", "上涨"],
  ["rising", "上涨"], ["rises", "上涨"], ["rose", "上涨"], ["rise", "上涨"],
  ["falling", "下跌"], ["falls", "下跌"], ["fell", "下跌"], ["fall", "下跌"],
  ["drops", "下跌"], ["dropping", "下跌"], ["dropped", "下跌"], ["drop", "下跌"],
  ["declines", "下跌"], ["decline", "下跌"], ["declining", "下跌"],
  ["slides", "下滑"], ["slid", "下滑"], ["slide", "下滑"],
  ["extends", "延续"], ["extended", "延续"], ["extend", "延续"],
  ["climbs", "攀升"], ["climbed", "攀升"], ["climb", "攀升"],
  ["gains", "涨幅"], ["gain", "上涨"], ["losses", "跌幅"], ["lose", "下跌"],
  ["cools", "降温"], ["cool", "降温"],
  ["eases", "缓解"], ["eased", "缓解"], ["ease", "缓解"],
  ["strengthens", "走强"], ["strengthen", "走强"],
  ["weakens", "走弱"], ["weaken", "走弱"],
  ["recovering", "回升"], ["recovers", "回升"], ["recover", "回升"],
  ["continue", "继续"], ["continues", "继续"],
  ["remains", "仍"], ["remain", "仍"], ["remained", "仍"],
  ["approaches", "逼近"], ["approach", "逼近"],
  ["breaks", "突破"], ["break", "突破"], ["broke", "突破"],
  ["tests", "测试"], ["test", "测试"],
  ["delivers", "带来"], ["deliver", "带来"],
  ["raises", "上调"], ["raise", "上调"], ["raised", "上调"],
  // 名词
  ["gold", "黄金"], ["prices", "价格"], ["price", "价格"],
  ["market", "市场"], ["markets", "市场"],
  ["optimism", "乐观情绪"], ["pessimism", "悲观情绪"],
  ["fears", "担忧"], ["fear", "担忧"], ["concerns", "担忧"], ["concern", "担忧"],
  ["hopes", "希望"], ["hope", "希望"],
  ["momentum", "动能"], ["sentiment", "情绪"],
  ["returns", "回报"], ["return", "回报"],
  ["confidence", "信心"], ["uncertainty", "不确定性"],
  ["outlook", "前景"], ["forecast", "预测"], ["estimate", "估计"],
  ["record", "纪录"], ["historic", "历史性"],
  ["guidance", "指引"], ["guidance", "指引"],
  ["missile", "导弹"], ["ceasefire", "停火"],
  ["tariffs", "关税"], ["tariff", "关税"], ["military", "军事"],
  ["tension", "紧张局势"], ["tensions", "紧张局势"],
  ["nuclear", "核"],
  ["crude", "原油"], ["brent", "布伦特"], ["energy", "能源"],
  ["crypto", "加密货币"], ["bitcoin", "比特币"],
  ["equities", "股票"], ["stocks", "股市"], ["stock", "股票"],
  ["buying", "买盘"], ["demand", "需求"], ["volume", "成交量"],
  ["spot", "现货"], ["ounce", "盎司"], ["ounces", "盎司"],
  ["signal", "信号"], ["signals", "信号"],
  ["suggest", "暗示"], ["suggests", "暗示"],
  ["support", "支撑"], ["resistance", "阻力"],
  ["report", "报告"], ["reports", "报告"],
  ["dollar", "美元"], ["dollars", "美元"],
  ["investors", "投资者"], ["investor", "投资者"],
  ["traders", "交易员"], ["trader", "交易员"],
  ["analysts", "分析师"], ["analyst", "分析师"],
  // 形容词
  ["strong", "强劲"], ["weak", "疲软"], ["mixed", "喜忧参半"],
  ["sharply", "急剧"], ["higher", "更高"], ["lower", "更低"],
  ["bullish", "看涨"], ["bearish", "看跌"], ["volatile", "波动"],
  ["hefty", "大幅"], ["sharp", "急剧"], ["steady", "企稳"], ["stable", "稳定"],
  ["record-high", "创纪录高点"], ["record", "纪录"],
  // 介词/连词
  ["amid", "在...之中"], ["despite", "尽管"],
  ["above", "上方"], ["below", "下方"], ["near", "接近"],
  ["around", "约"], ["about", "约"], ["past", "突破"], ["over", "超过"],
  ["ahead", "前夕"], ["between", "之间"],
  // 国家/地区
  ["global", "全球"], ["european", "欧洲"], ["europe", "欧洲"],
  ["asia", "亚洲"], ["asian", "亚洲"], ["world", "世界"],
  ["american", "美国"], ["china", "中国"], ["chinese", "中国"],
  ["indian", "印度"], ["israel", "以色列"], ["iran", "伊朗"],
  ["russia", "俄罗斯"], ["ukraine", "乌克兰"],
  // 经济
  ["economy", "经济"], ["economic", "经济"], ["growth", "增长"],
  ["inflation", "通胀"], ["deflation", "通缩"],
  ["decision", "决定"], ["meeting", "会议"], ["minutes", "纪要"],
  ["policy", "政策"], ["policies", "政策"],
  ["bank", "银行"], ["banks", "银行"],
  // 美联储
  ["fed", "美联储"], ["powell", "鲍威尔"],
  ["fomc", "联邦公开市场委员会"],
  ["cpi", "消费者价格指数"], ["pce", "个人消费支出"],
  ["rate", "利率"], ["rates", "利率"],
  ["cut", "降息"], ["cuts", "降息"],
  ["hike", "加息"], ["hikes", "加息"],
  ["dovish", "鸽派"], ["hawkish", "鹰派"],
  ["yield", "收益率"], ["yields", "收益率"],
  // 就业
  ["jobs", "就业"], ["payrolls", "非农就业"], ["payroll", "薪资"],
  ["jobless", "失业"], ["claims", "申请"], ["nfp", "非农"],
  // 能源
  ["oil", "石油"], ["gas", "天然气"], ["wti", "WTI"],
  ["opec", "欧佩克"],
  // 科技
  ["nasdaq", "纳斯达克"], ["tech", "科技"],
  ["etf", "ETF"], ["gld", "GLD基金"],
  ["ai", "人工智能"], ["chip", "芯片"],
  // 其他
  ["reserve", "储备"], ["haven", "避险"],
  ["future", "期货"], ["spot", "现货"],
  ["high", "高点"], ["low", "低点"], ["peak", "峰值"],
  ["data", "数据"], ["week", "周"], ["month", "月"],
  ["today", "今天"], ["launch", "推出"], ["catch", "注意"],
  ["focus", "焦点"], ["automotive", "汽车"],
  ["income", "收入"], ["since", "自"],
  ["prospect", "前景"], ["prospects", "前景"],
  ["developing", "发展"], ["development", "发展"],
  // 常用连词/介词/代词（保证句子连贯性）
  ["as", "随着"], ["and", "及"], ["but", "但"], ["or", "或"],
  ["on", "因"], ["at", "于"], ["in", "在"], ["of", "的"],
  ["the", ""], ["a", ""], ["an", ""], ["is", ""], ["are", ""],
  ["was", ""], ["were", ""], ["has", ""], ["have", ""], ["had", ""],
  ["will", "将"], ["may", "可能"], ["could", "可能"], ["would", "将"],
  ["should", "应"], ["can", "可"],
  ["again", "再次"], ["nearing", "接近"], ["nears", "逼近"], ["near", "接近"],
  ["end", "结束"], ["new", "新"],
  ["reports", "报告"], ["reported", "报告"],
  ["discovers", "发现"], ["discoveries", "发现"], ["discovery", "发现"],
  ["commences", "启动"], ["advance", "推进"], ["program", "计划"],
  ["priority", "优先"], ["targets", "目标"], ["target", "目标"],
  ["field", "实地"], ["promising", "有前景"],
  ["puts", "使"], ["with", "伴随"], ["from", "从"], ["into", "进入"],
  ["for", "因"], ["its", "其"], ["their", "其"],
  ["why", "为何"], ["how", "如何"], ["what", "什么"],
  ["trapped", "陷入"], ["trap", "困境"],
];

function translateToChinese(text) {
  if (!text) return text;
  // 检测是否已经是中文为主
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseChars.length > text.length * 0.3) return text;

  let translated = text;

  // 使用占位符替换法，避免中文干扰后续匹配
  const placeholders = [];
  function addPlaceholder(chineseWord) {
    const idx = placeholders.length;
    placeholders.push(chineseWord);
    return `\u200B${idx}\u200B`; // 零宽空格作为分隔
  }

  // 按英文长度降序排列，先匹配长词组
  for (const [eng, chn] of translationDict) {
    // 使用大小写不敏感的全局替换
    const escaped = eng.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 匹配完整单词（前后为非字母字符或字符串边界）
    const regex = new RegExp(`(?<=^|[^a-zA-Z])${escaped}(?=[^a-zA-Z]|$)`, "gi");
    translated = translated.replace(regex, (match) => addPlaceholder(chn));
  }

  // 还原占位符
  for (let i = placeholders.length - 1; i >= 0; i--) {
    translated = translated.split(`\u200B${i}\u200B`).join(placeholders[i]);
  }

  // 清理残留的多余空格和空词
  translated = translated
    .replace(/\s{2,}/g, " ")
    .replace(/\s([,，.。;；:：!！?？)）])/g, "$1")
    .replace(/(\()(\s+)/g, "$1")
    .replace(/(\s+)(\))/g, "$2")
    .replace(/^\s+|\s+$/g, "")
    .trim();

  // 如果仍有大量英文残留，标记为[英]
  const remainingEnglish = translated.match(/[a-zA-Z]{4,}/g) || [];
  if (remainingEnglish.length > 3) {
    translated = "[英] " + translated;
  }

  return translated;
}

function translateArticle(article) {
  if (!article) return article;
  const translatedTitle = translateToChinese(article.title);
  return {
    ...article,
    title: translatedTitle,
    titleOriginal: article.title !== translatedTitle ? article.title : null,
  };
}

function buildNewsEnvelope(articles, status, error = null) {
  const heat = {};
  const heatWindowHours = 2;
  const heatWindowStart = Date.now() - heatWindowHours * 60 * 60_000;

  // 翻译所有新闻标题
  const translatedArticles = articles.map(translateArticle);

  for (const category of categories) {
    heat[category.id] = {
      id: category.id,
      label: category.label,
      count: 0,
      score: 0,
      direction: "neutral",
    };
  }

  for (const article of translatedArticles.filter((item) => Date.parse(item.seenAt) >= heatWindowStart)) {
    for (const id of article.categories) {
      if (!heat[id]) continue;
      heat[id].count += 1;
      heat[id].score += article.tone.score;
    }
  }

  for (const item of Object.values(heat)) {
    item.score = round(item.score, 2);
    item.direction = item.score > 1 ? "bullish" : item.score < -1 ? "bearish" : "neutral";
    item.intensity = Math.min(100, item.count * 18 + Math.abs(item.score) * 8);
  }

  return {
    asOf: new Date().toISOString(),
    status,
    error,
    heatWindowHours,
    articles: translatedArticles,
    heat: Object.values(heat).sort((a, b) => b.count - a.count),
  };
}

function classifyText(text) {
  const matched = categories
    .filter((category) => category.keywords.some((keyword) => text.includes(keyword)))
    .map((category) => category.id);
  return matched.length ? matched : ["flows"];
}

function scoreArticleTone(text, matched) {
  const bullishWords = [
    "war",
    "conflict",
    "sanction",
    "missile",
    "safe haven",
    "cuts",
    "cut",
    "dovish",
    "weak",
    "slows",
    "unemployment",
    "jobless",
    "inflation",
    "central bank buying",
    "demand",
  ];
  const bearishWords = [
    "hawkish",
    "higher rates",
    "rate hike",
    "strong dollar",
    "strong jobs",
    "payrolls rise",
    "rally in stocks",
    "risk appetite",
    "yields rise",
  ];
  let score = 0;

  for (const word of bullishWords) {
    if (text.includes(word)) score += 1;
  }
  for (const word of bearishWords) {
    if (text.includes(word)) score -= 1;
  }

  if (matched.includes("geopolitics")) score += 0.8;
  if (matched.includes("oil") && (text.includes("rise") || text.includes("surge"))) {
    score += 0.5;
  }
  if (matched.includes("technology") && (text.includes("rally") || text.includes("record"))) {
    score -= 0.5;
  }

  return {
    score: round(score, 2),
    label: score > 0.6 ? "利多" : score < -0.6 ? "利空" : "中性",
  };
}

async function getIcbcData() {
  if (cache.icbc.data && Date.now() - cache.icbc.at < ICBC_TTL_MS) {
    return cache.icbc.data;
  }

  const results = await Promise.allSettled([fetchIcbcRuyiPrice(), fetchIcbcAccumulationPrice()]);
  const products = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message)
    .filter(Boolean);
  const status = products.length ? "live" : "fallback";
  const data = {
    asOf: new Date().toISOString(),
    status,
    sourceUrls: {
      ruyi: ICBC_RUYI_URL,
      accumulation: ICBC_ACCUMULATION_URL,
    },
    products: products.length ? products : buildFallbackIcbcProducts(),
    error: errors.join("; ") || null,
  };

  cache.icbc = { at: Date.now(), data };
  return data;
}

async function fetchIcbcRuyiPrice() {
  const html = await httpsRequestText(ICBC_RUYI_URL, "gbk", {
      accept: "text/html,application/xhtml+xml,*/*",
      referer: "https://mybank.icbc.com.cn/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const match = html.match(
    /ProductPrice\('99990','080020000501','([\d.]+)','([\d.]+)'\)/
  );

  if (!match) {
    throw new Error("ICBC ruyi price not found");
  }

  return {
    id: "icbc_ruyi",
    name: "如意金积存",
    productCode: "080020000501",
    activePrice: Number(match[1]),
    sellPrice: Number(match[2]),
    unit: "CNY/g",
    source: "ICBC",
    sourceUrl: ICBC_RUYI_URL,
    updatedAt: parseIcbcTimestamp(html) || new Date().toISOString(),
    fields: [
      { label: "实时主动积存价", value: Number(match[1]), unit: "CNY/g" },
      { label: "赎回价", value: Number(match[2]), unit: "CNY/g" },
    ],
  };
}

async function fetchIcbcAccumulationPrice() {
  const html = await httpsRequestText(ICBC_ACCUMULATION_URL, "gbk", {
      accept: "text/html,application/xhtml+xml,*/*",
      referer: "https://mybank.icbc.com.cn/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const productCode = "080020000521";
  const activePrice = readHtmlCellById(html, `activeprice_${productCode}`);

  if (!Number.isFinite(activePrice)) {
    throw new Error("ICBC accumulation active price not found");
  }

  const regPrice = readHtmlCellById(html, `regprice_${productCode}`);
  const sellPrice = readHtmlCellById(html, `sellprice_${productCode}`);
  const lowPrice = readHtmlCellById(html, `lowprice_${productCode}`);
  const highPrice = readHtmlCellById(html, `highprice_${productCode}`);

  return {
    id: "icbc_accumulation",
    name: "积存金",
    productCode,
    activePrice,
    regPrice,
    sellPrice,
    lowPrice,
    highPrice,
    unit: "CNY/g",
    source: "ICBC",
    sourceUrl: ICBC_ACCUMULATION_URL,
    updatedAt: parseIcbcTimestamp(html) || new Date().toISOString(),
    fields: [
      { label: "实时主动积存价", value: activePrice, unit: "CNY/g" },
      { label: "定期积存价", value: regPrice, unit: "CNY/g" },
      { label: "赎回价", value: sellPrice, unit: "CNY/g" },
      { label: "日内区间", value: `${formatPrice(lowPrice)} - ${formatPrice(highPrice)}`, unit: "CNY/g" },
    ],
  };
}

async function responseText(response, preferredEncoding = "utf-8") {
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    return new TextDecoder(preferredEncoding).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function httpsRequestText(url, preferredEncoding = "utf-8", headers = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const req = https.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: "GET",
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        rejectUnauthorized: false,
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const bytes = Buffer.concat(chunks);
          try {
            resolve(new TextDecoder(preferredEncoding).decode(bytes));
          } catch {
            resolve(bytes.toString("utf8"));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function readHtmlCellById(html, id) {
  const pattern = new RegExp(`id=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const match = html.match(pattern);
  if (!match) return null;
  const value = Number(cleanText(decodeXml(stripTags(match[1]))).replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseIcbcTimestamp(html) {
  const match = html.match(/更新时间[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9:]+)/);
  if (!match) return null;
  const parsed = Date.parse(match[1].replace(" ", "T") + "+08:00");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function buildFallbackIcbcProducts() {
  return [
    {
      id: "icbc_ruyi",
      name: "如意金积存",
      productCode: "080020000501",
      activePrice: null,
      sellPrice: null,
      unit: "CNY/g",
      source: "ICBC",
      sourceUrl: ICBC_RUYI_URL,
      updatedAt: new Date().toISOString(),
      fields: [{ label: "实时主动积存价", value: null, unit: "CNY/g" }],
    },
    {
      id: "icbc_accumulation",
      name: "积存金",
      productCode: "080020000521",
      activePrice: null,
      sellPrice: null,
      unit: "CNY/g",
      source: "ICBC",
      sourceUrl: ICBC_ACCUMULATION_URL,
      updatedAt: new Date().toISOString(),
      fields: [{ label: "实时主动积存价", value: null, unit: "CNY/g" }],
    },
  ];
}

async function buildSnapshot() {
  // Use allSettled so one slow API doesn't kill the entire snapshot
  const results = await Promise.allSettled([
    getMarketData(),
    getNewsData(),
    getIcbcData(),
  ]);

  const [marketResult, newsResult, icbcResult] = results;

  // Use fallback data for any failed API
  const market = marketResult.status === "fulfilled"
    ? marketResult.value
    : (() => {
        console.warn("Market API failed, using fallback:", marketResult.reason?.message);
        return buildFallbackMarketEnvelope();
      })();

  const news = newsResult.status === "fulfilled"
    ? newsResult.value
    : (() => {
        console.warn("News API failed, using fallback:", newsResult.reason?.message);
        return buildFallbackNews();
      })();

  const icbc = icbcResult.status === "fulfilled"
    ? icbcResult.value
    : (() => {
        console.warn("ICBC API failed, using fallback");
        return null;
      })();

  const factors = buildFactors(market, news);
  const forecast = buildForecast(market, news, factors);
  const reasons = explainCurrentMove(market, news, factors);

  return {
    asOf: new Date().toISOString(),
    refresh: {
      marketSeconds: MARKET_TTL_MS / 1000,
      newsSeconds: NEWS_TTL_MS / 1000,
      alertWindowMinutes: SHORT_WINDOW_MINUTES,
    },
    market,
    icbc,
    news,
    factors,
    forecast,
    reasons,
    thresholds: factorDefinitions,
  };
}

/** Fallback market envelope when all external APIs fail */
function buildFallbackMarketEnvelope() {
  const now = new Date().toISOString();
  const basePrice = 2340 + Math.sin(Date.now() / 100000) * 6;
  const points = Array.from({ length: 60 }, (_, i) => ({
    time: new Date(Date.now() - (59 - i) * 20000).toISOString(),
    price: basePrice + Math.sin((i * Math.PI) / 30) * 4 + (Math.random() - 0.5) * 1.5,
    volume: Math.round(100 + Math.random() * 500),
  }));
  const latest = points[points.length - 1].price;
  const previousClose = points[0].price;
  const changePct = round(((latest - previousClose) / previousClose) * 100, 3);
  const shortChangePct = round(((latest - points[Math.max(0, points.length - 4)].price) / points[Math.max(0, points.length - 4)].price) * 100, 3);

  const primary = {
    name: "XAU/USD Spot (Fallback)",
    latest: round(latest, 4),
    usdPerOunce: round(latest, 4),
    cnyPerGram: round(latest * 7.24 / TROY_OUNCE_GRAMS, 4),
    cnyPerOunce: round(latest * 7.24, 4),
    unit: "USD/oz",
    shortChangePct,
    oneHourChangePct: shortChangePct,
    changePct,
    updatedAt: now,
    points,
    displayPrices: [
      { label: "美元/盎司", value: round(latest, 2), unit: "USD/oz" },
      { label: "人民币/克", value: round(latest * 7.24 / TROY_OUNCE_GRAMS, 2), unit: "CNY/g" },
    ],
    conversionNote: "外部数据源暂不可用，使用估算值（汇率 7.24）",
  };

  const channelBase = [
    { id: "goldprice_org", name: "GoldPrice.org Spot Gold", shortName: "GoldPrice.org", venue: "GoldPrice.org", kind: "benchmark", unit: "USD/oz", latest: round(latest, 4), changePct, shortChangePct, volumeSignal: { level: "low" } },
    { id: "comex_gc", name: "COMEX GC Futures", shortName: "COMEX GC", venue: "CME/COMEX", kind: "futures", unit: "USD/oz", latest: round(latest + 2, 4), changePct, shortChangePct: round(shortChangePct + 0.02, 3), volumeSignal: { level: "low" } },
    { id: "xauusd_spot", name: "XAU/USD Spot", shortName: "XAU/USD", venue: "Stooq", kind: "spot", unit: "USD/oz", latest: round(latest - 0.3, 4), changePct, shortChangePct, volumeSignal: { level: "low" } },
    { id: "gld_etf", name: "SPDR Gold Shares (GLD)", shortName: "GLD", venue: "NYSE Arca", kind: "etf", unit: "USD/share", latest: round(latest * 0.092, 4), changePct: round(changePct * 0.9, 3), shortChangePct, volumeSignal: { level: "low" } },
    { id: "crude_oil", name: "WTI Crude Oil Futures", shortName: "WTI", venue: "NYMEX", kind: "macro", unit: "USD/bbl", latest: round(79 + Math.random() * 2, 2), changePct: round((Math.random() - 0.5) * 2, 3), shortChangePct: round((Math.random() - 0.5) * 0.5, 3), volumeSignal: { level: "low" } },
    { id: "usd_cny_fx", name: "USD/CNY FX Rate", shortName: "USD/CNY", venue: "Yahoo Finance", kind: "fx", unit: "CNY/USD", latest: round(7.24 + (Math.random() - 0.5) * 0.02, 4), changePct: round((Math.random() - 0.5) * 0.1, 3), shortChangePct: round((Math.random() - 0.5) * 0.03, 3), volumeSignal: { level: "low" } },
  ];

  return {
    asOf: now,
    status: "fallback",
    sourceNote: "所有外部数据源暂不可用，展示估算参考数据",
    primary,
    channels: channelBase,
    abnormalChannels: [],
    divergencePct: 0.02,
    divergencePair: "COMEX - 现货",
    alert: { severity: "normal", title: "数据源降级", message: "外部API暂不可用，显示估算参考价格", cause: "网络连接失败", active: false },
  };
}

function buildFactors(market, news) {
  const factorMap = {};
  for (const definition of factorDefinitions) {
    factorMap[definition.id] = {
      ...definition,
      value: null,
      intensity: 0,
      direction: "neutral",
      state: "normal",
      evidence: [],
    };
  }

  const primary = market.primary;
  const shortMove = primary?.shortChangePct ?? 0;
  const absShortMove = Math.abs(shortMove);
  factorMap.price_momentum.value = round(shortMove, 3);
  factorMap.price_momentum.intensity = Math.min(100, absShortMove * 70);
  factorMap.price_momentum.direction =
    shortMove > 0.12 ? "bullish" : shortMove < -0.12 ? "bearish" : "neutral";
  factorMap.price_momentum.state =
    absShortMove >= PRICE_ALERT_THRESHOLD ? "alert" : absShortMove >= 0.4 ? "watch" : "normal";
  factorMap.price_momentum.evidence.push(
    `${SHORT_WINDOW_MINUTES}分钟涨跌幅 ${formatSigned(shortMove)}%`
  );

  const divergence = market.divergencePct ?? 0;
  factorMap.venue_divergence.value = Number.isFinite(market.divergencePct)
    ? market.divergencePct
    : null;
  factorMap.venue_divergence.intensity = Math.min(100, Math.abs(divergence) * 160);
  factorMap.venue_divergence.direction =
    divergence > 0.2 ? "futures-premium" : divergence < -0.2 ? "spot-premium" : "neutral";
  factorMap.venue_divergence.state =
    Math.abs(divergence) >= 0.35 ? "watch" : "normal";
  if (Number.isFinite(market.divergencePct)) {
    factorMap.venue_divergence.evidence.push(
      `${market.divergencePair || "COMEX - 现货"} 价差 ${formatSigned(market.divergencePct)}%`
    );
  }

  for (const heat of news.heat) {
    if (!factorMap[heat.id]) continue;
    factorMap[heat.id].value = heat.count;
    factorMap[heat.id].intensity = round(heat.intensity, 1);
    factorMap[heat.id].direction = heat.direction;
    factorMap[heat.id].state = heat.count >= 4 ? "watch" : "normal";
    factorMap[heat.id].evidence.push(
      `${heat.label} ${news.heatWindowHours || 2}小时新闻 ${heat.count} 条`
    );
  }

  const oilChannel = market.channels.find((channel) => channel.id === "crude_oil");
  if (oilChannel && Number.isFinite(oilChannel.shortChangePct)) {
    factorMap.oil.evidence.push(`WTI 15分钟 ${formatSigned(oilChannel.shortChangePct)}%`);
    factorMap.oil.intensity = Math.max(
      factorMap.oil.intensity,
      Math.min(100, Math.abs(oilChannel.shortChangePct) * 45)
    );
    if (Math.abs(oilChannel.shortChangePct) >= 1.5) {
      factorMap.oil.state = "watch";
    }
  }

  const flowAbnormal = market.abnormalChannels.filter(
    (item) => item.type === "volume" || item.type === "short_move"
  );
  if (flowAbnormal.length) {
    factorMap.flows.state = "alert";
    factorMap.flows.intensity = Math.max(factorMap.flows.intensity, 80);
    factorMap.flows.evidence.push(flowAbnormal[0].message);
  }

  return Object.values(factorMap);
}

function buildForecast(market, news, factors) {
  let score = 0;
  const reasons = [];
  const primary = market.primary;
  const shortMove = primary?.shortChangePct ?? 0;

  if (shortMove > 0.4) {
    score += 2;
    reasons.push(`短线动量上行 ${formatSigned(shortMove)}%`);
  } else if (shortMove < -0.4) {
    score -= 2;
    reasons.push(`短线动量下行 ${formatSigned(shortMove)}%`);
  }

  const factorWeights = {
    geopolitics: 1.5,
    fed: 1.25,
    jobs: 1,
    oil: 0.75,
    technology: 0.7,
    flows: 1.3,
  };

  for (const factor of factors) {
    const weight = factorWeights[factor.id] || 0;
    if (!weight) continue;
    const directionScore =
      factor.direction === "bullish" ? 1 : factor.direction === "bearish" ? -1 : 0;
    const contribution = directionScore * weight * Math.min(1.5, factor.intensity / 55);
    score += contribution;

    if (Math.abs(contribution) > 0.45 && factor.evidence[0]) {
      reasons.push(factor.evidence[0]);
    }
  }

  const alignedGoldChannels = market.channels
    .filter(
      (channel) =>
        ["comex_gc", "xauusd_spot", "stooq_xauusd"].includes(channel.id) &&
        Number.isFinite(channel.shortChangePct)
    )
    .map((channel) => Math.sign(channel.shortChangePct));

  if (alignedGoldChannels.length >= 2) {
    const sum = alignedGoldChannels.reduce((total, item) => total + item, 0);
    if (Math.abs(sum) === alignedGoldChannels.length) {
      score += sum > 0 ? 1 : -1;
      reasons.push(sum > 0 ? "主要黄金渠道同向上行" : "主要黄金渠道同向下行");
    }
  }

  const clamped = Math.max(-6, Math.min(6, score));
  const confidence = Math.round(50 + Math.min(35, Math.abs(clamped) * 6));
  const direction =
    clamped > 1.4 ? "bullish" : clamped < -1.4 ? "bearish" : "neutral";
  const label =
    direction === "bullish" ? "偏强" : direction === "bearish" ? "偏弱" : "震荡";

  return {
    horizon: "30-90分钟",
    direction,
    label,
    score: round(clamped, 2),
    confidence,
    summary: buildForecastSummary(label, confidence, market.alert.active),
    reasons: reasons.slice(0, 5),
  };
}

function explainCurrentMove(market, news, factors) {
  const items = [];
  if (market.alert.active) {
    items.push({
      title: market.alert.title,
      detail: market.alert.cause,
      priority: "high",
    });
  }

  for (const abnormal of market.abnormalChannels.slice(0, 3)) {
    items.push({
      title: `异常渠道：${abnormal.channel}`,
      detail: abnormal.message,
      priority: abnormal.severity,
    });
  }

  const hotFactors = factors
    .filter((factor) => factor.state !== "normal")
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 4);

  for (const factor of hotFactors) {
    items.push({
      title: factor.name,
      detail: factor.evidence.join("；"),
      priority: factor.state,
    });
  }

  const topNews = news.articles
    .filter((article) => Math.abs(article.tone.score) >= 1)
    .slice(0, 3);

  for (const article of topNews) {
    items.push({
      title: `新闻线索：${article.domain}`,
      detail: article.title,
      priority: article.tone.label,
    });
  }

  if (!items.length) {
    items.push({
      title: "当前解释",
      detail: "短线波动未越过预警阈值，新闻热度和渠道价差未显示强异常。",
      priority: "normal",
    });
  }

  return items.slice(0, 8);
}

function buildForecastSummary(label, confidence, hasAlert) {
  const risk = hasAlert ? "波动率处于预警状态，预测应优先看渠道确认。" : "波动率未触发强预警。";
  return `模型给出${label}判断，置信度 ${confidence}%。${risk}`;
}

function buildFallbackMarketData() {
  const base = 2368 + Math.sin(Date.now() / 100000) * 8;
  const points = Array.from({ length: 120 }, (_, index) => {
    const t = Date.now() - (119 - index) * 60_000;
    const wave = Math.sin(index / 11) * 4 + Math.cos(index / 23) * 2;
    const drift = (index - 80) * 0.025;
    return {
      time: new Date(t).toISOString(),
      price: round(base + wave + drift, 2),
      volume: Math.round(1000 + Math.sin(index / 7) * 250 + index * 3),
    };
  });
  const spotPoints = points.map((point) => ({
    ...point,
    price: round(point.price - 1.8 + Math.sin(Date.parse(point.time) / 900000) * 0.6, 2),
    volume: null,
  }));
  const gldPoints = points.map((point) => ({
    ...point,
    price: round(point.price / 10.05, 2),
  }));
  const oilPoints = points.map((point, index) => ({
    ...point,
    price: round(82 + Math.sin(index / 15) * 0.8, 2),
  }));
  const fallbackCnyPerOunce = base * 7.2;
  const fallbackCnyPerGram = fallbackCnyPerOunce / TROY_OUNCE_GRAMS;
  const goldpriceFallback = {
    ...normalizeChannel(channels.find((channel) => channel.id === "goldprice_org"), points, "fallback", {
      currency: "USD",
    }),
    usdPerOunce: round(points[points.length - 1].price, 4),
    cnyPerOunce: round(fallbackCnyPerOunce, 4),
    cnyPerGram: round(fallbackCnyPerGram, 4),
    displayPrices: [
      {
        label: "美元/盎司",
        value: round(points[points.length - 1].price, 2),
        unit: "USD/oz",
      },
      {
        label: "人民币/克",
        value: round(fallbackCnyPerGram, 2),
        unit: "CNY/g",
      },
    ],
    sourceUrl: GOLDPRICE_PAGE_URL,
  };

  const data = [
    goldpriceFallback,
    normalizeChannel(channels.find((channel) => channel.id === "comex_gc"), points, "fallback", { currency: "USD" }),
    normalizeChannel(channels.find((channel) => channel.id === "xauusd_spot"), spotPoints, "fallback", { currency: "USD" }),
    normalizeChannel(channels.find((channel) => channel.id === "gld_etf"), gldPoints, "fallback", { currency: "USD" }),
    normalizeChannel(channels.find((channel) => channel.id === "crude_oil"), oilPoints, "fallback", { currency: "USD" }),
  ];

  return {
    ...buildMarketEnvelope(data),
    status: "fallback",
    sourceNote: "Live feeds unavailable; generated market data is displayed for UI continuity.",
  };
}

function buildFallbackNews() {
  const now = Date.now();
  const samples = [
    {
      title:
        "黄金企稳，交易员权衡美联储利率路径与美元走势",
      domain: "marketwatch.com",
      categories: ["fed", "flows"],
      tone: { score: -0.8, label: "利空" },
    },
    {
      title:
        "地缘政治紧张局势与央行买盘支撑金银需求",
      domain: "reuters.com",
      categories: ["geopolitics", "flows"],
      tone: { score: 1.9, label: "利多" },
    },
    {
      title: "供应风险重现能源市场，石油价格上涨",
      domain: "bloomberg.com",
      categories: ["oil", "geopolitics"],
      tone: { score: 1.2, label: "利多" },
    },
    {
      title: "科技股上涨，部分避险需求回落",
      domain: "cnbc.com",
      categories: ["technology"],
      tone: { score: -1.1, label: "利空" },
    },
  ];

  return samples.map((sample, index) => ({
    id: `fallback-${index}`,
    url: "",
    sourceCountry: "US",
    language: "English",
    seenAt: new Date(now - index * 18 * 60_000).toISOString(),
    image: "",
    ...sample,
  }));
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  });
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pctChange(latest, prior) {
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) {
    return null;
  }
  return round(((latest - prior) / prior) * 100, 3);
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value > 0 ? "+" : ""}${round(value, 3)}`;
}

function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseGdeltDate(value) {
  if (!value) return new Date().toISOString();
  const clean = String(value).replace(/\s/g, "");
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }

  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

function hash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, asOf: new Date().toISOString() });
      return;
    }

    if (requestUrl.pathname === "/api/snapshot") {
      const snapshot = await buildSnapshot();
      sendJson(res, 200, snapshot);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: "internal_error",
      message: error.message,
      asOf: new Date().toISOString(),
    });
  }
});

server.listen(PORT, () => {
  console.log(`Gold intelligence dashboard running at http://localhost:${PORT}`);
});
