const DATA_FILES = {
  config: "./data/config.json",
  meta: "./data/meta.json",
  feeds: [
    ["youtube", "./data/youtube.json"],
    ["news", "./data/news.json"],
    ["curated", "./data/curated.json"]
  ]
};

const CORE_SOURCES = ["news", "youtube", "curated"];

const CONFIDENCE_ORDER = {
  manual: 4,
  high: 3,
  medium: 2,
  low: 1
};

const PLATFORM_LABELS = {
  youtube: "YouTube",
  news: "新闻",
  bilibili: "Bilibili",
  xiaohongshu: "小红书",
  curated: "人工精选"
};

const SOURCE_LABELS = {
  news: "新闻",
  youtube: "YouTube",
  curated: "人工精选"
};

const state = {
  config: null,
  meta: null,
  items: [],
  feedErrors: {},
  filters: {
    groups: new Set(),
    members: new Set(),
    platforms: new Set(),
    q: "",
    sort: "latest",
    quality: "featured"
  }
};

const els = {
  freshness: document.querySelector("#freshness"),
  groupFilters: document.querySelector("#group-filters"),
  memberFilters: document.querySelector("#member-filters"),
  platformFilters: document.querySelector("#platform-filters"),
  qualityFilters: document.querySelector("#quality-filters"),
  searchInput: document.querySelector("#search-input"),
  sortSelect: document.querySelector("#sort-select"),
  statusBanner: document.querySelector("#status-banner"),
  summaryCount: document.querySelector("#summary-count"),
  summarySources: document.querySelector("#summary-sources"),
  summaryLatest: document.querySelector("#summary-latest"),
  feed: document.querySelector("#feed"),
  emptyState: document.querySelector("#empty-state"),
  clearFilters: document.querySelector("#clear-filters")
};

async function fetchJson(path) {
  const response = await fetch(path, {
    cache: "no-cache",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }

  return response.json();
}

async function loadAppData() {
  const [config, meta] = await Promise.all([
    fetchJson(DATA_FILES.config),
    fetchJson(DATA_FILES.meta)
  ]);
  const feeds = await Promise.all(
    DATA_FILES.feeds.map(async ([source, path]) => {
      try {
        return { source, feed: await fetchJson(path) };
      } catch (error) {
        return { source, error };
      }
    })
  );

  state.config = config;
  state.meta = meta;
  state.feedErrors = {};
  state.items = [];
  for (const result of feeds) {
    if (result.feed) {
      state.items.push(...(result.feed.items ?? []));
    } else {
      state.feedErrors[result.source] = result.error;
    }
  }
}

function parseUrlState() {
  const params = new URLSearchParams(window.location.search);
  state.filters.groups = new Set(parseList(params.get("groups")));
  state.filters.members = new Set(parseList(params.get("members")));
  state.filters.platforms = new Set(parseList(params.get("platforms")));
  state.filters.q = params.get("q") ?? "";
  state.filters.sort = parseEnum(params.get("sort"), ["latest", "confidence"], "latest");
  state.filters.quality = parseEnum(params.get("quality"), ["featured", "all"], "featured");
}

function sanitizeUrlFilters() {
  retainAllowed(state.filters.groups, state.config.groups.filter((group) => group.active).map((group) => group.id));
  retainAllowed(state.filters.members, state.config.members.filter((member) => member.active).map((member) => member.id));
  retainAllowed(state.filters.platforms, state.items.map((item) => item.platform));
  pruneMembersForSelectedGroups();
}

function retainAllowed(values, allowedValues) {
  const allowed = new Set(allowedValues);
  for (const value of values) {
    if (!allowed.has(value)) {
      values.delete(value);
    }
  }
}

function syncUrlState() {
  const params = new URLSearchParams();
  writeList(params, "groups", state.filters.groups);
  writeList(params, "members", state.filters.members);
  writeList(params, "platforms", state.filters.platforms);

  if (state.filters.q) {
    params.set("q", state.filters.q);
  }

  if (state.filters.sort !== "latest") {
    params.set("sort", state.filters.sort);
  }

  if (state.filters.quality !== "featured") {
    params.set("quality", state.filters.quality);
  }

  const query = params.toString();
  const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, "", nextUrl);
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function writeList(params, key, valueSet) {
  if (valueSet.size > 0) {
    params.set(key, Array.from(valueSet).join(","));
  }
}

function parseEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function render() {
  renderFreshness();
  renderStatusBanner();
  renderFilters();
  renderFeed();
}

function renderFreshness() {
  els.freshness.textContent = CORE_SOURCES.map(sourceFreshnessText).join(" · ");
}

function renderStatusBanner() {
  const issues = CORE_SOURCES.map(sourceIssue).filter(Boolean);

  if (issues.length === 0) {
    els.statusBanner.className = "status-banner";
    els.statusBanner.textContent = "";
    return;
  }

  const hasFailure = issues.some((issue) => issue.severity === "warning");
  els.statusBanner.className = `status-banner is-visible ${hasFailure ? "is-warning" : "is-info"}`;
  els.statusBanner.textContent = issues.map((issue) => issue.message).join(" · ");
}

function sourceFreshnessText(source) {
  const label = SOURCE_LABELS[source] ?? source;
  if (state.feedErrors[source]) {
    return `${label}加载失败`;
  }

  const detail = state.meta.sources?.[source];
  if (detail?.last_success_at) {
    return `${label} ${formatRelativeDate(detail.last_success_at)}更新`;
  }
  if (detail?.status === "disabled") {
    return `${label}未接入`;
  }
  if (detail?.status === "manual_only") {
    return `${label}暂无内容`;
  }
  return `${label}状态未知`;
}

function sourceIssue(source) {
  const label = SOURCE_LABELS[source] ?? source;
  if (state.feedErrors[source]) {
    return { severity: "warning", message: `${label}数据加载失败，其他来源仍可浏览` };
  }

  const detail = state.meta.sources?.[source];
  if (!detail) {
    return { severity: "warning", message: `${label}缺少状态信息` };
  }
  if (detail.status === "partial") {
    return { severity: "warning", message: `${label}仅部分来源更新成功` };
  }
  if (detail.status === "disabled") {
    return { severity: "info", message: `${label}尚未接入` };
  }
  if (detail.status === "manual_only" && detail.item_count === 0) {
    return { severity: "info", message: `${label}暂无已验证内容` };
  }
  if (!detail.ok) {
    return { severity: "warning", message: `${label}当前使用历史数据或暂不可用` };
  }
  return null;
}

function renderFilters() {
  renderGroupFilters();
  renderMemberFilters();
  renderPlatformFilters();
  renderQualityFilters();
  els.searchInput.value = state.filters.q;
  els.sortSelect.value = state.filters.sort;
}

function renderGroupFilters() {
  const groups = [...state.config.groups]
    .filter((group) => group.active)
    .sort((a, b) => a.order - b.order);

  els.groupFilters.replaceChildren(
    makeChip("全部", state.filters.groups.size === 0, () => {
      state.filters.groups.clear();
      state.filters.members.clear();
      commitState();
    }, "group:all"),
    ...groups.map((group) =>
      makeChip(group.display_name, state.filters.groups.has(group.id), () => {
        toggleSet(state.filters.groups, group.id);
        pruneMembersForSelectedGroups();
        commitState();
      }, `group:${group.id}`)
    )
  );
}

function renderMemberFilters() {
  const selectedGroups = state.filters.groups;
  const members = state.config.members
    .filter((member) => member.active)
    .filter((member) => selectedGroups.size === 0 || selectedGroups.has(member.group_id));

  els.memberFilters.replaceChildren(
    makeChip("全部", state.filters.members.size === 0, () => {
      state.filters.members.clear();
      commitState();
    }, "member:all"),
    ...members.map((member) => {
      const group = findGroup(member.group_id);
      const label = selectedGroups.size === 0 ? `${member.display_name} · ${group.display_name}` : member.display_name;

      return makeChip(label, state.filters.members.has(member.id), () => {
        toggleSet(state.filters.members, member.id);

        if (state.filters.members.has(member.id)) {
          state.filters.groups.add(member.group_id);
        }

        commitState();
      }, `member:${member.id}`);
    })
  );
}

function renderPlatformFilters() {
  const platforms = unique(state.items.map((item) => item.platform)).sort();

  els.platformFilters.replaceChildren(
    makeChip("全部", state.filters.platforms.size === 0, () => {
      state.filters.platforms.clear();
      commitState();
    }, "platform:all"),
    ...platforms.map((platform) =>
      makeChip(platformLabel(platform), state.filters.platforms.has(platform), () => {
        toggleSet(state.filters.platforms, platform);
        commitState();
      }, `platform:${platform}`)
    )
  );
}

function renderQualityFilters() {
  const options = [
    ["featured", "高相关"],
    ["all", "全部"]
  ];

  els.qualityFilters.replaceChildren(
    ...options.map(([value, label]) =>
      makeChip(label, state.filters.quality === value, () => {
        state.filters.quality = value;
        commitState();
      }, `quality:${value}`)
    )
  );
}

function makeChip(label, pressed, onClick, filterKey) {
  const button = document.createElement("button");
  button.className = "chip";
  button.type = "button";
  button.textContent = label;
  button.dataset.filterKey = filterKey;
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", onClick);
  return button;
}

function toggleSet(set, value) {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
}

function pruneMembersForSelectedGroups() {
  if (state.filters.groups.size === 0) {
    return;
  }

  for (const memberId of Array.from(state.filters.members)) {
    const member = findMember(memberId);
    if (!member || !state.filters.groups.has(member.group_id)) {
      state.filters.members.delete(memberId);
    }
  }
}

function renderFeed() {
  const items = getVisibleItems();
  const publishedTimes = items.map(publishedTimestamp).filter(Number.isFinite);
  els.summaryCount.textContent = String(items.length);
  els.summarySources.textContent = String(unique(items.map((item) => item.platform)).length);
  els.summaryLatest.textContent = publishedTimes.length
    ? formatRelativeDate(Math.max(...publishedTimes))
    : items.length ? "时间未知" : "—";
  els.emptyState.hidden = items.length > 0;
  els.feed.replaceChildren(...items.map(renderCard));
}

function getVisibleItems() {
  const q = normalizeText(state.filters.q);

  return state.items
    .filter((item) => item.available !== false)
    .filter((item) => state.filters.platforms.size === 0 || state.filters.platforms.has(item.platform))
    .filter((item) => state.filters.groups.size === 0 || hasAny(item.matched_groups, state.filters.groups))
    .filter((item) => state.filters.members.size === 0 || hasAny(item.matched_members, state.filters.members))
    .filter((item) => state.filters.quality === "all" || isFeaturedItem(item))
    .filter((item) => !q || searchableText(item).includes(q))
    .sort(compareItems);
}

function compareItems(a, b) {
  if (state.filters.sort === "confidence") {
    return confidenceScore(b.match_confidence) - confidenceScore(a.match_confidence)
      || publishedTimestamp(b) - publishedTimestamp(a);
  }

  return publishedTimestamp(b) - publishedTimestamp(a);
}

function publishedTimestamp(item) {
  const timestamp = Date.parse(item.published_at);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function renderCard(item) {
  const card = document.createElement("article");
  card.className = isLowConfidence(item) ? "content-card is-low-confidence" : "content-card";

  const thumb = document.createElement("div");
  thumb.className = `thumb thumb-${item.platform}`;

  const cover = renderCover(item);
  const coverLink = externalLink(item.url, item.title, "cover-link");
  coverLink.append(cover);

  const platform = document.createElement("span");
  platform.className = `platform-pill platform-${item.platform}`;
  platform.textContent = platformLabel(item.platform);

  thumb.append(coverLink, platform);

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("h3");
  title.className = "card-title";
  const titleLink = externalLink(item.url, item.title, "title-link");
  titleLink.textContent = item.title;
  title.append(titleLink);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.append(
    textSpan(item.author?.name || "Unknown source"),
    textSpan(formatRelativeDate(item.published_at)),
    textSpan(sourceTypeLabel(item.source_type))
  );

  const metrics = document.createElement("div");
  metrics.className = "metrics";
  if ((item.metrics?.views ?? 0) > 0) {
    metrics.append(metricEl("播放/阅读", formatNumber(item.metrics.views)));
  }
  const engagement = totalEngagement(item.metrics);
  if (engagement > 0) {
    metrics.append(metricEl("互动", formatNumber(engagement)));
  }

  const tags = document.createElement("div");
  tags.className = "tag-row";

  const groupTags = item.matched_groups.map((id) => tagEl(findGroup(id)?.display_name ?? id));
  const memberTags = item.matched_members.map((id) => tagEl(findMember(id)?.display_name ?? id));
  const confidence = tagEl(`匹配 ${confidenceLabel(item.match_confidence)}`, "tag-confidence");
  const quality = isLowConfidence(item) ? tagEl("低置信", "tag-low-confidence") : null;
  tags.append(...groupTags, ...memberTags, confidence);
  if (quality) {
    tags.append(quality);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const explainButton = document.createElement("button");
  const detailsId = `details-${safeDomId(item.id)}`;
  explainButton.className = "explain-button";
  explainButton.type = "button";
  explainButton.textContent = "匹配说明";
  explainButton.setAttribute("aria-expanded", "false");
  explainButton.setAttribute("aria-controls", detailsId);

  const details = renderDetails(item);
  details.id = detailsId;
  details.hidden = true;

  explainButton.addEventListener("click", () => {
    const expanded = explainButton.getAttribute("aria-expanded") === "true";
    explainButton.setAttribute("aria-expanded", String(!expanded));
    explainButton.textContent = expanded ? "匹配说明" : "收起";
    details.hidden = expanded;
  });

  actions.append(explainButton);
  body.append(title, meta);
  if (metrics.childElementCount > 0) {
    body.append(metrics);
  }
  body.append(tags, actions, details);
  card.append(thumb, body);
  return card;
}

function externalLink(url, label, className) {
  const link = document.createElement("a");
  link.className = className;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `${label}，在新标签页打开`);
  return link;
}

function renderDetails(item) {
  const details = document.createElement("div");
  details.className = "explain-panel";

  const reasonList = document.createElement("ul");
  reasonList.className = "reason-list";
  const reasons = item.match_reason?.length ? item.match_reason : [];

  if (reasons.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "没有明确团体或成员命中，属于低置信泛 K-pop 内容。";
    reasonList.append(empty);
  } else {
    for (const reason of reasons.slice(0, 4)) {
      const li = document.createElement("li");
      li.textContent = matchReasonText(reason);
      reasonList.append(li);
    }
  }

  details.append(reasonList);
  return details;
}

function matchReasonText(reason) {
  const targetName =
    reason.target_type === "member"
      ? findMember(reason.target_id)?.display_name ?? reason.target_id
      : findGroup(reason.target_id)?.display_name ?? reason.target_id;
  const fieldName = {
    title: "标题",
    description: "描述",
    author: "来源",
    tags: "标签",
    curator_note: "人工备注",
  }[reason.field] ?? reason.field;
  return `${fieldName} 命中 ${targetName}：${reason.alias}`;
}

function renderCover(item) {
  if (hasRealThumbnail(item.thumbnail)) {
    const image = document.createElement("img");
    image.src = item.thumbnail;
    image.alt = item.title;
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.replaceWith(renderGeneratedCover(item));
    });
    return image;
  }

  return renderGeneratedCover(item);
}

function renderGeneratedCover(item) {
  const cover = document.createElement("div");
  cover.className = `generated-cover generated-cover-${item.platform}`;

  const source = document.createElement("span");
  source.className = "cover-source";
  source.textContent = item.author?.name || platformLabel(item.platform);

  const title = document.createElement("strong");
  title.className = "cover-title";
  title.textContent = compactTitle(item.title);

  const subject = document.createElement("span");
  subject.className = "cover-subject";
  subject.textContent = coverSubject(item);

  cover.append(source, title, subject);
  return cover;
}

function hasRealThumbnail(thumbnail) {
  return Boolean(thumbnail) && !thumbnail.includes("/placeholders/");
}

function compactTitle(title) {
  return title.length > 62 ? `${title.slice(0, 59)}...` : title;
}

function coverSubject(item) {
  const groups = item.matched_groups.map((id) => findGroup(id)?.display_name ?? id);
  const members = item.matched_members.map((id) => findMember(id)?.display_name ?? id);
  const subjects = [...groups, ...members].slice(0, 3);
  return subjects.length ? subjects.join(" / ") : sourceTypeLabel(item.source_type);
}

function safeDomId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "-");
}

function textSpan(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function metricEl(label, value) {
  const box = document.createElement("div");
  box.className = "metric";

  const labelEl = document.createElement("span");
  labelEl.className = "metric-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("strong");
  valueEl.textContent = value;

  box.append(labelEl, valueEl);
  return box;
}

function tagEl(text, extraClass = "") {
  const tag = document.createElement("span");
  tag.className = extraClass ? `tag ${extraClass}` : "tag";
  tag.textContent = text;
  return tag;
}

function searchableText(item) {
  return normalizeText(
    [
      item.title,
      item.description,
      item.author?.name,
      item.platform,
      item.source_type,
      ...item.matched_groups.map((id) => findGroup(id)?.display_name ?? id),
      ...item.matched_members.map((id) => findMember(id)?.display_name ?? id)
    ].join(" ")
  );
}

function hasAny(values, selectedSet) {
  return values.some((value) => selectedSet.has(value));
}

function isFeaturedItem(item) {
  return ["manual", "high", "medium"].includes(item.match_confidence);
}

function isLowConfidence(item) {
  return item.match_confidence === "low";
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function findGroup(id) {
  return state.config.groups.find((group) => group.id === id);
}

function findMember(id) {
  return state.config.members.find((member) => member.id === id);
}

function normalizeText(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .trim();
}

function confidenceScore(value) {
  return CONFIDENCE_ORDER[value] ?? 0;
}

function confidenceLabel(value) {
  const labels = {
    manual: "人工",
    high: "高",
    medium: "中",
    low: "低"
  };
  return labels[value] ?? "未知";
}

function sourceTypeLabel(value) {
  const labels = {
    official: "官方源",
    media: "媒体源",
    fan: "粉丝源",
    community: "社区源",
    curated: "人工精选",
    unknown: "未知来源"
  };
  return labels[value] ?? value;
}

function platformLabel(value) {
  return PLATFORM_LABELS[value] ?? value;
}

function formatNumber(value) {
  const number = Number(value ?? 0);

  if (number >= 100000000) {
    return `${(number / 100000000).toFixed(1)}亿`;
  }

  if (number >= 10000) {
    return `${(number / 10000).toFixed(1)}万`;
  }

  return new Intl.NumberFormat("zh-CN").format(number);
}

function totalEngagement(metrics = {}) {
  return (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.danmaku ?? 0);
}

function formatRelativeDate(value) {
  if (value === null || value === undefined || value === "") {
    return "时间未知";
  }
  const published = new Date(value);
  const diffMs = Date.now() - published.getTime();
  const hours = Math.round(diffMs / 36e5);

  if (Number.isNaN(hours)) {
    return "时间未知";
  }

  if (hours < 1) {
    return "刚刚";
  }

  if (hours < 48) {
    return `${hours} 小时前`;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).format(published);
}

function commitState() {
  const focusKey = document.activeElement?.dataset?.filterKey;
  syncUrlState();
  render();
  restoreFilterFocus(focusKey);
}

function restoreFilterFocus(focusKey) {
  if (!focusKey) {
    return;
  }

  const nextFocus = Array.from(document.querySelectorAll("[data-filter-key]"))
    .find((element) => element.dataset.filterKey === focusKey);
  nextFocus?.focus({ preventScroll: true });
}

function bindEvents() {
  els.searchInput.addEventListener("input", () => {
    state.filters.q = els.searchInput.value.trim();
    commitState();
  });

  els.sortSelect.addEventListener("change", () => {
    state.filters.sort = els.sortSelect.value;
    commitState();
  });

  els.clearFilters.addEventListener("click", () => {
    state.filters.groups.clear();
    state.filters.members.clear();
    state.filters.platforms.clear();
    state.filters.q = "";
    state.filters.sort = "latest";
    state.filters.quality = "featured";
    commitState();
  });

  window.addEventListener("popstate", () => {
    parseUrlState();
    sanitizeUrlFilters();
    syncUrlState();
    render();
  });
}

async function init() {
  try {
    parseUrlState();
    await loadAppData();
    sanitizeUrlFilters();
    syncUrlState();
    bindEvents();
    render();
  } catch (error) {
    els.freshness.textContent = "数据加载失败";
    els.statusBanner.className = "status-banner is-visible is-warning";
    els.statusBanner.textContent = error instanceof Error ? error.message : "Unknown error";
  }
}

init();
