export const X_CONSENT_KEY = 'kpop-pulse:x-embed-consent:v1';

export function validXPost(url, id) {
  if (typeof url !== 'string' || typeof id !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.href === url && /^[1-9][0-9]{0,19}$/.test(id) && parsed.protocol === 'https:' &&
      ['x.com', 'twitter.com'].includes(parsed.hostname) && !parsed.port && !parsed.username &&
      !parsed.password && !parsed.search && !parsed.hash &&
      new RegExp('^/(?:[A-Za-z0-9_]{1,15}/status|i/status)/' + id + '$').test(parsed.pathname);
  } catch { return false; }
}

export function selectedXContent(data, filters) {
  const groups = filters.groups ?? new Set();
  const members = filters.members ?? new Set();
  const muted = filters.mutedMembers ?? new Set();
  const platforms = filters.platforms ?? new Set();
  const q = (filters.q ?? '').trim().toLocaleLowerCase();
  const visible = data.enabled !== false && (platforms.size === 0 || platforms.has('x'));
  return {
    visible,
    accounts: data.accounts.filter(account => groups.size === 0 || groups.has(account.group_id)),
    posts: data.manual_posts.filter(post =>
      (groups.size === 0 || post.group_ids.some(id => groups.has(id))) &&
      (members.size === 0 || post.member_ids.some(id => members.has(id))) &&
      !post.member_ids.some(id => muted.has(id)) && (!q || post.note.toLocaleLowerCase().includes(q))),
    timelineAllowed: visible && members.size === 0 && muted.size === 0 && !q,
  };
}

function safeHttps(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; }
  catch { return false; }
}

function checkDirectory(data, config) {
  const groups = new Set(config.groups.map(group => group.id));
  const members = new Map(config.members.map(member => [member.id, member.group_id]));
  if (data.schema_version !== 1 || typeof data.enabled !== 'boolean' || !Array.isArray(data.accounts) || !Array.isArray(data.manual_posts)) throw new Error('X directory');
  const handles = new Set(); const posts = new Set();
  for (const account of data.accounts) {
    if (!groups.has(account.group_id) || !/^[A-Za-z0-9_]{1,15}$/.test(account.handle) ||
        !safeHttps(account.source_url) || !['global', 'jp', 'kr'].includes(account.region) ||
        handles.has(account.handle.toLowerCase())) throw new Error('X account');
    handles.add(account.handle.toLowerCase());
  }
  for (const post of data.manual_posts) {
    if (!validXPost(post.url, post.id) || posts.has(post.id) || typeof post.note !== 'string' ||
        !post.note.trim() || !Array.isArray(post.group_ids) || !post.group_ids.length ||
        !Array.isArray(post.member_ids) || !post.group_ids.every(id => groups.has(id)) ||
        !post.member_ids.every(id => members.has(id) && post.group_ids.includes(members.get(id)))) throw new Error('X post');
    posts.add(post.id);
  }
}

export function createXSection(root, config, onLoaded = () => {}) {
  const query = id => root.querySelector('#' + id);
  const select = query('x-account-select');
  const link = query('x-account-link'); const receipt = query('x-account-source');
  const check = query('x-consent-check'); const accept = query('x-consent-accept');
  const revoke = query('x-consent-revoke'); const retry = query('x-embed-retry');
  const slot = query('x-embed-slot'); const status = query('x-status');
  const list = query('x-manual-posts'); const empty = query('x-manual-empty');
  const hint = query('x-filter-hint'); const directoryNote = query('x-directory-note');
  const activeGroups = new Set(config.groups.filter(group => group.active).map(group => group.id));
  const groupNames = new Map(config.groups.map(group => [group.id, group.display_name]));
  let data; let filters = {}; let selected; let target; let frame; let frameKey = ''; let watchdog;
  let consent = false; let storageAvailable = true; let failed = false; let loaded = false;
  try { consent = localStorage.getItem(X_CONSENT_KEY) === 'accepted'; } catch { storageAvailable = false; }

  function removeFrame() {
    clearTimeout(watchdog); frame?.remove(); frame = undefined; frameKey = ''; loaded = false; slot.replaceChildren();
  }
  function saveConsent(value) {
    consent = value;
    try { if (value) localStorage.setItem(X_CONSENT_KEY, 'accepted'); else localStorage.removeItem(X_CONSENT_KEY); }
    catch { storageAvailable = false; }
  }
  function controls() {
    check.checked = consent; accept.hidden = consent; accept.disabled = !check.checked;
    revoke.hidden = !consent;
    retry.hidden = !consent || (!failed && !loaded) || !selected?.visible || !target ||
      (target.kind === 'profile' && !selected.timelineAllowed);
    query('x-storage-note').hidden = storageAvailable;
  }
  function unavailable() {
    removeFrame(); failed = true; status.textContent = 'X 暂未返回可显示的内容。可重试，或打开官方原页。'; controls();
  }
  function preview() {
    controls();
    if (!data || !selected?.visible) { removeFrame(); return; }
    if (!consent) { removeFrame(); status.textContent = '尚未连接 X。原页链接无需开启嵌入即可使用。'; return; }
    if (!target || (target.kind === 'profile' && !selected.timelineAllowed)) {
      removeFrame(); status.textContent = '当前条件下不加载时间线。可选择符合筛选的人工精选帖。'; return;
    }
    const key = target.kind + ':' + target.value;
    if (frame && frameKey === key) return;
    removeFrame(); failed = false; controls(); frameKey = key;
    const instance = crypto.randomUUID();
    const next = document.createElement('iframe');
    next.className = 'x-embed-frame'; next.title = target.kind === 'profile' ? 'X 官方账号时间线' : '人工精选 X 原帖';
    // This trusted same-site bridge runs only our code; its vendor child is sandboxed on X's own origin.
    next.referrerPolicy = 'no-referrer';
    next.src = './x-embed.html#' + new URLSearchParams({instance});
    next.addEventListener('load', () => {
      if (frame !== next || !consent || !selected.visible) return;
      next.contentWindow.postMessage({type:'kpop-x-start', instance, ...target}, '*');
    });
    next.dataset.instance = instance; frame = next; slot.append(next);
    status.textContent = '正在连接 X；加载失败时仍可打开原页。';
    watchdog = setTimeout(() => { if (frame === next) unavailable(); }, 12000);
  }
  function render() {
    if (!data) return;
    selected = selectedXContent(data, filters); root.hidden = !selected.visible;
    const previous = select.value;
    select.replaceChildren(...selected.accounts.map(account => {
      const option = document.createElement('option'); option.value = account.handle;
      const region = account.region === 'jp' ? '日本官方' : account.region === 'kr' ? '韩国官方' : '官方';
      option.textContent = groupNames.get(account.group_id) + ' · ' + region + ' · @' + account.handle;
      return option;
    }));
    if (selected.accounts.some(account => account.handle === previous)) select.value = previous;
    select.disabled = selected.accounts.length === 0;
    const account = selected.accounts.find(item => item.handle === select.value);
    link.hidden = receipt.hidden = !account;
    if (account) { link.href = 'https://x.com/' + account.handle; receipt.href = account.source_url; }
    if (!target || target.kind === 'profile' || !selected.posts.some(post => post.id === target.value)) {
      target = account ? {kind:'profile', value:account.handle} : undefined;
    }
    hint.hidden = selected.timelineAllowed;
    directoryNote.textContent = '目录核验：' + data.reviewed_on + ' · 区域账号已单独标注；不是推文更新时间。';
    list.replaceChildren(...selected.posts.map(post => {
      const row = document.createElement('article'); row.className = 'x-post-row';
      const heading = document.createElement('h4'); heading.textContent = post.note;
      const meta = document.createElement('p'); meta.className = 'x-note';
      meta.textContent = post.group_ids.map(id => groupNames.get(id)).join(' / ') + ' · 人工精选于 ' + post.added_on;
      const actions = document.createElement('div'); actions.className = 'x-actions';
      const original = document.createElement('a'); original.href = post.url; original.textContent = '打开原帖';
      original.target = '_blank'; original.rel = 'noopener noreferrer';
      const show = document.createElement('button'); show.type = 'button'; show.className = 'ghost-button'; show.textContent = '嵌入此帖';
      show.addEventListener('click', () => {
        target = {kind:'post', value:post.id}; failed = false;
        if (!consent) { status.textContent = '请先同意下方 X 隐私说明，再显示原帖。'; check.focus(); return; }
        preview();
      });
      actions.append(original, show); row.append(heading, meta, actions); return row;
    }));
    empty.hidden = selected.posts.length !== 0;
    empty.textContent = data.manual_posts.length ? '当前筛选没有人工精选帖。' : '暂无人工精选。这里只展示真实选入的原帖，不生成演示热帖。';
    preview();
  }
  check.addEventListener('change', () => {
    if (consent && !check.checked) { saveConsent(false); failed = false; preview(); }
    accept.disabled = !check.checked;
  });
  accept.addEventListener('click', () => { if (!check.checked) return; saveConsent(true); failed = false; preview(); });
  revoke.addEventListener('click', () => { saveConsent(false); failed = false; preview(); check.focus(); });
  retry.addEventListener('click', () => { removeFrame(); failed = false; preview(); });
  select.addEventListener('change', () => { target = {kind:'profile',value:select.value}; failed = false; render(); });
  window.addEventListener('storage', event => {
    if (event.key !== X_CONSENT_KEY && event.key !== null) return;
    consent = event.newValue === 'accepted'; failed = false; preview();
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!frame || event.source !== frame.contentWindow || !consent ||
        message?.type !== 'kpop-x-status' || message.instance !== frame.dataset.instance) return;
    if (message.phase === 'ready') {
      clearTimeout(watchdog); loaded = true; controls();
      status.textContent = 'X 嵌入已建立。若平台显示空白或限制，请打开原页查看。';
    } else if (message.phase === 'unavailable') unavailable();
  });
  controls();
  fetch('./data/x.json', {cache:'no-cache',headers:{Accept:'application/json'}})
    .then(response => { if (!response.ok) throw new Error('X directory'); return response.json(); })
    .then(document => {
      checkDirectory(document, config); data = {...document, accounts:document.accounts.filter(a => activeGroups.has(a.group_id))};
      render(); onLoaded(data.enabled);
    }).catch(() => { removeFrame(); status.textContent = 'X 目录暂时不可用，不影响新闻和视频。'; });
  return {update(next) { filters = {...next}; render(); }};
}
