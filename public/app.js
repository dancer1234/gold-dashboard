const state = {
  snapshot: null,
  newsFilter: "all",
  lastError: null,
};

const els = {
  feedStatus: document.querySelector("#feed-status"),
  clock: document.querySelector("#clock"),
  primaryName: document.querySelector("#primary-name"),
  primaryUpdated: document.querySelector("#primary-updated"),
  primaryPrice: document.querySelector("#primary-price"),
  primaryUnit: document.querySelector("#primary-unit"),
  primaryUsdOunce: document.querySelector("#primary-usd-ounce"),
  primaryCnyGram: document.querySelector("#primary-cny-gram"),
  primaryNote: document.querySelector("#primary-note"),
  shortChange: document.querySelector("#short-change"),
  hourChange: document.querySelector("#hour-change"),
  dayChange: document.querySelector("#day-change"),
  chart: document.querySelector("#price-chart"),
  alertPanel: document.querySelector("#alert-panel"),
  alertTitle: document.querySelector("#alert-title"),
  alertMessage: document.querySelector("#alert-message"),
  alertCause: document.querySelector("#alert-cause"),
  icbcUpdated: document.querySelector("#icbc-updated"),
  icbcGrid: document.querySelector("#icbc-grid"),
  forecastLabel: document.querySelector("#forecast-label"),
  forecastConfidence: document.querySelector("#forecast-confidence"),
  gaugeFill: document.querySelector("#gauge-fill"),
  forecastSummary: document.querySelector("#forecast-summary"),
  forecastReasons: document.querySelector("#forecast-reasons"),
  divergence: document.querySelector("#divergence"),
  sourceGrid: document.querySelector("#source-grid"),
  factorGrid: document.querySelector("#factor-grid"),
  newsList: document.querySelector("#news-list"),
  newsTabs: document.querySelector("#news-tabs"),
  reasonStack: document.querySelector("#reason-stack"),
};

const categoryLabels = {
  geopolitics: "地缘",
  fed: "美联储",
  jobs: "就业",
  oil: "油价",
  technology: "科技",
  flows: "资金流",
};

function boot() {
  updateClock();
  setInterval(updateClock, 1000);
  fetchSnapshot();
  setInterval(fetchSnapshot, 30_000);
  els.newsTabs.addEventListener("click", onNewsTabClick);
}

function updateClock() {
  els.clock.textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

async function fetchSnapshot() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json();
    state.lastError = null;
    render();
  } catch (error) {
    state.lastError = error;
    els.feedStatus.textContent = "连接失败";
    els.feedStatus.className = "status-pill fallback";
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  renderStatus(snapshot);
  renderMarket(snapshot.market);
  renderAlert(snapshot.market.alert);
  renderIcbc(snapshot.icbc);
  renderForecast(snapshot.forecast);
  renderSources(snapshot.market);
  renderFactors(snapshot.factors);
  renderNews(snapshot.news.articles);
  renderReasons(snapshot.reasons);
}

function renderStatus(snapshot) {
  const status =
    snapshot.market.status === "live" &&
    snapshot.news.status === "live" &&
    (!snapshot.icbc || snapshot.icbc.status === "live")
      ? "live"
      : "fallback";
  els.feedStatus.textContent = status === "live" ? "实时连接" : "降级数据";
  els.feedStatus.className = `status-pill ${status}`;
}

function renderMarket(market) {
  const primary = market.primary || {};
  els.primaryName.textContent = primary.name || "黄金主行情";
  els.primaryUpdated.textContent = `更新 ${formatTime(primary.updatedAt || market.asOf)}`;
  els.primaryPrice.textContent = formatNumber(primary.latest, 2);
  els.primaryUnit.textContent = primary.unit || "USD/oz";
  els.primaryUsdOunce.textContent = `${formatNumber(primary.usdPerOunce ?? primary.latest, 2)} USD/oz`;
  els.primaryCnyGram.textContent = Number.isFinite(primary.cnyPerGram)
    ? `${formatNumber(primary.cnyPerGram, 2)} CNY/g`
    : "--";
  els.primaryNote.textContent =
    primary.conversionNote || market.sourceNote || "GoldPrice.org benchmark feed";
  setChange(els.shortChange, primary.shortChangePct);
  setChange(els.hourChange, primary.oneHourChangePct);
  setChange(els.dayChange, primary.changePct);
  drawPriceChart(primary.points || []);
}

function renderAlert(alert) {
  els.alertPanel.className = `alert-panel ${alert.severity || "normal"}`;
  els.alertTitle.textContent = alert.title || "未触发预警";
  els.alertMessage.textContent = alert.message || "--";
  els.alertCause.textContent = alert.cause || "--";
}

function renderIcbc(icbc) {
  if (!icbc) return;
  els.icbcUpdated.textContent = `更新 ${formatTime(icbc.asOf)}`;
  els.icbcGrid.innerHTML = "";

  for (const product of icbc.products || []) {
    const card = document.createElement("article");
    card.className = "icbc-card";
    const fields = (product.fields || [])
      .map(
        (field) => `
          <div class="icbc-field">
            <span>${escapeHtml(field.label)}</span>
            <strong>${escapeHtml(formatFieldValue(field.value, field.unit))}</strong>
          </div>
        `
      )
      .join("");
    card.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(product.name)}</h3>
          <div class="muted">${escapeHtml(product.productCode)} · ${escapeHtml(product.source || "ICBC")}</div>
        </div>
        <span class="badge ${icbc.status === "live" ? "live" : "error"}">${escapeHtml(icbc.status)}</span>
      </header>
      <div class="icbc-main-price">${formatFieldValue(product.activePrice, product.unit)}</div>
      <div class="icbc-fields">${fields}</div>
      <div class="muted">更新时间 ${formatTime(product.updatedAt || icbc.asOf)}</div>
    `;
    els.icbcGrid.appendChild(card);
  }
}

function renderForecast(forecast) {
  els.forecastLabel.textContent = `${forecast.label} · ${forecast.horizon}`;
  els.forecastConfidence.textContent = `${forecast.confidence}%`;
  els.forecastSummary.textContent = forecast.summary;
  const position = Math.max(4, Math.min(96, 50 + forecast.score * 7.5));
  els.gaugeFill.style.left = `${position}%`;
  els.forecastReasons.innerHTML = "";

  for (const reason of forecast.reasons || []) {
    const item = document.createElement("span");
    item.textContent = reason;
    els.forecastReasons.appendChild(item);
  }
}

function renderSources(market) {
  els.divergence.textContent = `价差 ${formatSigned(market.divergencePct)}%`;
  els.sourceGrid.innerHTML = "";

  for (const channel of market.channels || []) {
    const card = document.createElement("article");
    card.className = "source-card";
    const statusClass = channel.status === "live" ? "live" : channel.status === "error" ? "error" : "";
    const abnormal = (market.abnormalChannels || []).find((item) => item.channelId === channel.id);
    card.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(channel.shortName)}</h3>
          <div class="muted">${escapeHtml(channel.venue)} · ${escapeHtml(channel.kind)}</div>
        </div>
        <span class="badge ${statusClass}">${escapeHtml(channel.status)}</span>
      </header>
      <div class="source-price">${formatNumber(channel.latest, channel.kind === "etf" || channel.kind === "macro" ? 2 : 2)}</div>
      <div class="mini-row">
        <span>15分钟 ${signedSpan(channel.shortChangePct)}</span>
        <span>日内 ${signedSpan(channel.changePct)}</span>
        <span>量能 ${escapeHtml(channel.volumeSignal?.level || "unknown")}</span>
      </div>
      ${abnormal ? `<div class="badge alert">${escapeHtml(abnormal.type)}</div>` : ""}
    `;
    els.sourceGrid.appendChild(card);
  }
}

function renderFactors(factors) {
  els.factorGrid.innerHTML = "";

  for (const factor of factors || []) {
    const card = document.createElement("article");
    const directionClass =
      factor.direction === "bullish"
        ? "bullish"
        : factor.direction === "bearish"
          ? "bearish"
          : "";
    card.className = `factor-card ${factor.state} ${directionClass}`;
    card.innerHTML = `
      <header>
        <h3>${escapeHtml(factor.name)}</h3>
        <span class="badge ${factor.state === "alert" ? "alert" : ""}">${escapeHtml(labelState(factor.state))}</span>
      </header>
      <div class="meter"><span style="width:${Math.max(4, Math.min(100, factor.intensity || 0))}%"></span></div>
      <div class="mini-row">
        <span>方向 ${escapeHtml(labelDirection(factor.direction))}</span>
        <span>数值 ${escapeHtml(formatFactorValue(factor.value))}</span>
      </div>
      <div class="threshold">${escapeHtml(factor.threshold)}</div>
      <div class="muted">${escapeHtml((factor.evidence || []).slice(0, 2).join("；") || factor.polarity)}</div>
    `;
    els.factorGrid.appendChild(card);
  }
}

function renderNews(articles) {
  const filtered =
    state.newsFilter === "all"
      ? articles
      : articles.filter((article) => article.categories.includes(state.newsFilter));
  els.newsList.innerHTML = "";

  for (const article of filtered.slice(0, 14)) {
    const item = document.createElement("article");
    item.className = "news-item";
    const initials = (article.domain || "NEWS")
      .split(".")[0]
      .slice(0, 2)
      .toUpperCase();
    const title = escapeHtml(article.title);
    const titleOriginal = article.titleOriginal ? escapeHtml(article.titleOriginal) : "";
    const href = article.url ? escapeHtml(article.url) : "#";
    const target = article.url ? ' target="_blank" rel="noreferrer"' : "";
    const titleHtml = titleOriginal
      ? `${title}<br><small class="muted" style="font-size:0.78em;opacity:0.7">${titleOriginal}</small>`
      : title;
    item.innerHTML = `
      <div class="news-visual">${escapeHtml(initials)}</div>
      <div>
        <header>
          <div class="news-meta">
            <span class="badge">${escapeHtml(article.domain || "unknown")}</span>
            <span class="badge">${escapeHtml(article.tone?.label || "中性")}</span>
          </div>
          <span class="muted">${formatRelative(article.seenAt)}</span>
        </header>
        <h3><a href="${href}"${target}>${titleHtml}</a></h3>
        <div class="news-meta">
          ${(article.categories || [])
            .slice(0, 3)
            .map((id) => `<span class="badge">${escapeHtml(categoryLabels[id] || id)}</span>`)
            .join("")}
        </div>
      </div>
    `;
    els.newsList.appendChild(item);
  }

  if (!filtered.length) {
    els.newsList.innerHTML = `<div class="muted">当前筛选下暂无新闻。</div>`;
  }
}

function renderReasons(reasons) {
  els.reasonStack.innerHTML = "";

  for (const reason of reasons || []) {
    const item = document.createElement("article");
    item.innerHTML = `
      <h3>${escapeHtml(reason.title)}</h3>
      <p>${escapeHtml(reason.detail)}</p>
      <span class="badge">${escapeHtml(reason.priority)}</span>
    `;
    els.reasonStack.appendChild(item);
  }
}

function drawPriceChart(points) {
  const canvas = els.chart;
  const context = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width * pixelRatio));
  const height = Math.max(220, Math.round(rect.height * pixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbfaf6";
  context.fillRect(0, 0, width, height);

  const padding = {
    top: 20 * pixelRatio,
    right: 18 * pixelRatio,
    bottom: 28 * pixelRatio,
    left: 48 * pixelRatio,
  };

  const usable = points.filter((point) => Number.isFinite(point.price));
  if (usable.length < 2) {
    context.fillStyle = "#68737d";
    context.font = `${14 * pixelRatio}px sans-serif`;
    context.fillText("等待行情数据", padding.left, height / 2);
    return;
  }

  const prices = usable.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  context.strokeStyle = "#e5dfd3";
  context.lineWidth = 1 * pixelRatio;
  context.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (innerHeight / 4) * i;
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
  }
  context.stroke();

  const gradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, "rgba(184, 138, 44, 0.28)");
  gradient.addColorStop(1, "rgba(184, 138, 44, 0)");

  const pathPoints = usable.map((point, index) => {
    const x = padding.left + (index / (usable.length - 1)) * innerWidth;
    const y = padding.top + (1 - (point.price - min) / range) * innerHeight;
    return { x, y };
  });

  context.beginPath();
  pathPoints.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.lineTo(pathPoints[pathPoints.length - 1].x, height - padding.bottom);
  context.lineTo(pathPoints[0].x, height - padding.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  pathPoints.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = prices[prices.length - 1] >= prices[0] ? "#177c5f" : "#b73d42";
  context.lineWidth = 2.5 * pixelRatio;
  context.stroke();

  const latest = pathPoints[pathPoints.length - 1];
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#26323a";
  context.lineWidth = 2 * pixelRatio;
  context.beginPath();
  context.arc(latest.x, latest.y, 5 * pixelRatio, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.fillStyle = "#68737d";
  context.font = `${11 * pixelRatio}px sans-serif`;
  context.fillText(formatNumber(max, 2), 8 * pixelRatio, padding.top + 4 * pixelRatio);
  context.fillText(formatNumber(min, 2), 8 * pixelRatio, height - padding.bottom);
}

function onNewsTabClick(event) {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.newsFilter = button.dataset.filter;
  els.newsTabs.querySelectorAll("button").forEach((node) => {
    node.classList.toggle("active", node === button);
  });
  if (state.snapshot) renderNews(state.snapshot.news.articles);
}

function setChange(el, value) {
  el.textContent = `${formatSigned(value)}%`;
  el.className = Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "neutral";
}

function signedSpan(value) {
  const className = Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "neutral";
  return `<strong class="${className}">${formatSigned(value)}%</strong>`;
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRelative(value) {
  const date = value ? new Date(value) : new Date();
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return "--";
  const minutes = Math.max(0, Math.round(diff / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.round(hours / 24)}天前`;
}

function labelState(value) {
  if (value === "alert") return "预警";
  if (value === "watch") return "观察";
  return "正常";
}

function labelDirection(value) {
  const map = {
    bullish: "利多",
    bearish: "利空",
    neutral: "中性",
    "futures-premium": "期货升水",
    "spot-premium": "现货升水",
  };
  return map[value] || value || "中性";
}

function formatFactorValue(value) {
  if (value === null || value === undefined) return "--";
  if (Number.isFinite(value)) return String(value);
  return value;
}

function formatFieldValue(value, unit) {
  if (value === null || value === undefined || value === "") return "--";
  if (Number.isFinite(value)) return `${formatNumber(value, 2)} ${unit || ""}`.trim();
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

boot();
