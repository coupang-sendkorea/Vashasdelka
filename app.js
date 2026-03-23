const cfg = window.APP_CONFIG || {};
const isConfigured = cfg.supabaseUrl && !cfg.supabaseUrl.includes('PASTE_') && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes('PASTE_');

const el = (id) => document.getElementById(id);
const qsa = (s) => Array.from(document.querySelectorAll(s));

const state = {
  user: null,
  settings: { initial_cash: 0, initial_code: 0, lock_settings: false },
  cycles: [],
  deals: [],
  selectedCycleId: null,
  search: '',
  localDrafts: {}
};

const CURRENT_APP_VERSION = String(window.__APP_ASSET_VERSION__ || '2026.03.23-storage-2');
const saveTimers = new Map();
let supabase = null;

const authView = el('authView');
const mainView = el('mainView');
const configWarning = el('configWarning');

function showToast(message, isError = false) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.style.borderColor = isError ? 'rgba(255,93,108,.35)' : 'rgba(50,210,150,.35)';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

function formatNum(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

function parseNum(value) {
  if (value == null) return 0;
  const normalized = String(value)
    .replace(/\s+/g, '')
    .replace(/,/g, '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function isoDate(dateStr) {
  return dateStr ? new Date(dateStr + 'T00:00:00') : null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function transliterateRu(value) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'',
    'ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  return String(value || '').split('').map((ch) => {
    const lower = ch.toLowerCase();
    if (!(lower in map)) return ch;
    const out = map[lower];
    return ch === lower ? out : out.charAt(0).toUpperCase() + out.slice(1);
  }).join('');
}

function sanitizeFilename(name) {
  const original = String(name || 'file').trim();
  const dot = original.lastIndexOf('.');
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '';

  const safeBase = transliterateRu(base)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\. -]+|[_\. -]+$/g, '')
    .slice(0, 100) || 'file';

  const safeExt = transliterateRu(ext)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9.]+/g, '')
    .slice(0, 16);

  return `${safeBase}${safeExt}`;
}

function buildStoragePath(deal, file) {
  const safeName = sanitizeFilename(file?.name || 'file');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${state.user.id}/${deal.cycle_id}/${deal.id}/${stamp}-${safeName}`;
}

function debounceSave(key, fn, wait = 450) {
  const existing = saveTimers.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(async () => {
    saveTimers.delete(key);
    try { await fn(); } catch (e) { console.error(e); showToast(e.message || 'Ошибка сохранения', true); }
  }, wait);
  saveTimers.set(key, { timer, fn });
}


async function flushPendingSaves() {
  const entries = Array.from(saveTimers.entries());
  saveTimers.clear();
  for (const [, entry] of entries) {
    if (entry?.timer) clearTimeout(entry.timer);
    if (typeof entry?.fn === 'function') {
      try { await entry.fn(); } catch (e) { console.error(e); }
    }
  }
  await flushDraftsToCloud();
}

function draftStorageKey() {
  return state.user ? `vsk_drafts_${state.user.id}` : 'vsk_drafts_guest';
}

function loadDraftStore() {
  try {
    const raw = localStorage.getItem(draftStorageKey());
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDraftStore() {
  try {
    localStorage.setItem(draftStorageKey(), JSON.stringify(state.localDrafts || {}));
  } catch {}
}

function setDraftValue(dealId, field, value) {
  state.localDrafts ||= {};
  state.localDrafts[dealId] ||= {};
  state.localDrafts[dealId][field] = value;
  saveDraftStore();
}

function clearDraftValue(dealId, field) {
  if (!state.localDrafts?.[dealId]) return;
  delete state.localDrafts[dealId][field];
  if (!Object.keys(state.localDrafts[dealId]).length) delete state.localDrafts[dealId];
  saveDraftStore();
}

function applyDraftsToState() {
  state.localDrafts = loadDraftStore();
  state.deals = state.deals.map((deal) => {
    const draft = state.localDrafts?.[deal.id];
    return draft ? { ...deal, ...draft } : deal;
  });
}

async function flushDraftsToCloud() {
  const entries = Object.entries(state.localDrafts || {});
  for (const [dealId, fields] of entries) {
    if (!state.deals.some((d) => d.id === dealId)) continue;
    for (const [field, value] of Object.entries(fields || {})) {
      await persistDealField(dealId, field, value, true, false);
    }
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Некорректный формат файла.');
  }
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) throw new Error('Некорректный формат файла.');
  const meta = dataUrl.slice(5, commaIndex);
  const body = dataUrl.slice(commaIndex + 1);
  const isBase64 = /;base64/i.test(meta);
  const mimeType = (meta.split(';')[0] || 'application/octet-stream').trim() || 'application/octet-stream';

  if (isBase64) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([decodeURIComponent(body)], { type: mimeType });
}

function openBlobInNewTab(blob, filename = 'file') {
  const blobUrl = URL.createObjectURL(blob);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const canPreview = (blob.type || '').startsWith('image/') || blob.type === 'application/pdf' || ['png','jpg','jpeg','gif','webp','svg','pdf'].includes(ext);

  if (canPreview) {
    const win = window.open(blobUrl, '_blank', 'noopener');
    if (win) {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return;
    }
  }

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
}

async function applyAppRefresh(versionTag = '') {
  await flushPendingSaves();
  saveDraftStore();
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (error) {
      console.warn('Cache clear skipped', error);
    }
  }
  const url = new URL(window.location.href);
  if (versionTag) url.searchParams.set('appv', versionTag);
  url.searchParams.set('_t', String(Date.now()));
  window.location.href = url.toString();
}

async function checkForAppUpdate(showLatestToast = true) {
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Не удалось проверить обновление.');
    const versionInfo = await response.json();
    const latest = String(versionInfo.version || '').trim();
    if (latest && latest !== CURRENT_APP_VERSION) {
      const accepted = confirm(`Доступно обновление программы (${latest}). Обновить программу сейчас?`);
      if (accepted) await applyAppRefresh(latest);
      return;
    }
    if (showLatestToast) showToast('У вас уже последняя версия программы.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Не удалось проверить обновление.', true);
  }
}

function setAuthTab(tab) {
  qsa('[data-auth-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.authTab === tab));
  el('loginForm').classList.toggle('hidden', tab !== 'login');
  el('signupForm').classList.toggle('hidden', tab !== 'signup');
}

function setMainTab(tab) {
  qsa('[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  qsa('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab}`));
}

function getCycleDeals(cycleId) {
  return state.deals
    .filter((d) => d.cycle_id === cycleId)
    .sort((a, b) => (a.row_no || 0) - (b.row_no || 0) || (a.created_at || '').localeCompare(b.created_at || ''));
}

function getSortedCycles() {
  return [...state.cycles].sort((a, b) => {
    const ad = a.cycle_date || '';
    const bd = b.cycle_date || '';
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

function cycleStats(cycleId) {
  const sorted = getSortedCycles();
  let runningCash = parseNum(state.settings.initial_cash);
  let runningCode = parseNum(state.settings.initial_code);

  for (const cycle of sorted) {
    const deals = getCycleDeals(cycle.id);
    const rub = deals.reduce((sum, d) => sum + parseNum(d.cash_in) - parseNum(d.cash_out) + parseNum(d.other_rub), 0);
    const code = deals.reduce((sum, d) => sum + parseNum(d.code_in) - parseNum(d.code_out) + parseNum(d.code_adjustment), 0);
    const spread = deals.reduce((sum, d) => sum + parseNum(d.cash_in) - parseNum(d.cash_out) + parseNum(d.code_in) - parseNum(d.code_out), 0);
    const snapshot = {
      cycleId: cycle.id,
      cashStart: runningCash,
      codeStart: runningCode,
      rubFlow: rub,
      codeFlow: code,
      spread,
      cashAfter: runningCash + rub,
      codeAfter: runningCode + code,
      dealsCount: deals.length,
    };
    if (cycle.id === cycleId) return snapshot;
    runningCash += rub;
    runningCode += code;
  }

  return {
    cycleId,
    cashStart: runningCash,
    codeStart: runningCode,
    rubFlow: 0,
    codeFlow: 0,
    spread: 0,
    cashAfter: runningCash,
    codeAfter: runningCode,
    dealsCount: 0,
  };
}

function allTotals() {
  return getSortedCycles().reduce((acc, c) => {
    const s = cycleStats(c.id);
    acc.cash = s.cashAfter;
    acc.code = s.codeAfter;
    return acc;
  }, { cash: parseNum(state.settings.initial_cash), code: parseNum(state.settings.initial_code) });
}

function render() {
  renderSettings();
  renderCyclesStrip();
  renderSelectedCycle();
  renderCycleSummary();
  renderOperatorFilter();
  renderSearch();
  const totals = allTotals();
  el('totalCashDisplay').textContent = formatNum(totals.cash);
  el('totalCodeDisplay').textContent = formatNum(totals.code);
}

function refreshCycleMetricsOnly() {
  const totals = allTotals();
  el('totalCashDisplay').textContent = formatNum(totals.cash);
  el('totalCodeDisplay').textContent = formatNum(totals.code);

  const cycle = state.cycles.find((c) => c.id === state.selectedCycleId);
  if (cycle) {
    const stats = cycleStats(cycle.id);
    el('cycleCashStart').textContent = formatNum(stats.cashStart);
    el('cycleCodeStart').textContent = formatNum(stats.codeStart);
    el('cycleRubFlow').textContent = formatNum(stats.rubFlow);
    el('cycleCodeFlow').textContent = formatNum(stats.codeFlow);
    el('cycleCashAfter').textContent = formatNum(stats.cashAfter);
    el('cycleCodeAfter').textContent = formatNum(stats.codeAfter);
    el('cycleSpread').textContent = formatNum(stats.spread);
  }

  renderCyclesStrip();
  renderCycleSummary();
  if (state.search.trim()) renderSearch();
}

function focusNextEditable(current) {
  const row = current.closest('tr[data-id]');
  if (!row) return;
  const editables = Array.from(row.querySelectorAll('input[data-field], textarea[data-field]'));
  const idx = editables.indexOf(current);
  if (idx >= 0 && idx < editables.length - 1) {
    editables[idx + 1].focus();
    editables[idx + 1].select?.();
  }
}

function renderSettings() {
  el('initialCash').value = state.settings.initial_cash ?? 0;
  el('initialCode').value = state.settings.initial_code ?? 0;
  const locked = !!state.settings.lock_settings;
  el('initialCash').disabled = locked;
  el('initialCode').disabled = locked;
  el('lockBadge').textContent = locked ? 'Заблокировано' : 'Разблокировано';
}

function renderCyclesStrip() {
  const container = el('cyclesStrip');
  const cycles = getSortedCycles();
  container.innerHTML = '';
  if (!cycles.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.textContent = 'Пока нет циклов. Нажмите «+ Новый цикл». '; 
    container.appendChild(empty);
    return;
  }
  for (const cycle of cycles) {
    const stats = cycleStats(cycle.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `cycle-card ${state.selectedCycleId === cycle.id ? 'active' : ''}`;
    card.innerHTML = `
      <h3>${escapeHtml(cycle.cycle_number || 'Без номера')}</h3>
      <div class="cycle-meta">
        <div>${escapeHtml(cycle.operator_name || 'Без оператора')}</div>
        <div>${escapeHtml(cycle.cycle_date || '')}</div>
        <div>Сделок: ${stats.dealsCount}</div>
        <div>Спред: ${formatNum(stats.spread)}</div>
      </div>`;
    card.addEventListener('click', () => {
      state.selectedCycleId = cycle.id;
      render();
    });
    container.appendChild(card);
  }
}

function renderSelectedCycle() {
  const editor = el('cycleEditor');
  const cycle = state.cycles.find((c) => c.id === state.selectedCycleId);
  if (!cycle) {
    editor.classList.add('hidden');
    return;
  }
  editor.classList.remove('hidden');
  el('cycleNumber').value = cycle.cycle_number || '';
  el('cycleOperator').value = cycle.operator_name || '';
  el('cycleDate').value = cycle.cycle_date || todayStr();
  el('cycleStatus').value = cycle.status || 'Открыт';

  const stats = cycleStats(cycle.id);
  el('cycleCashStart').textContent = formatNum(stats.cashStart);
  el('cycleCodeStart').textContent = formatNum(stats.codeStart);
  el('cycleRubFlow').textContent = formatNum(stats.rubFlow);
  el('cycleCodeFlow').textContent = formatNum(stats.codeFlow);
  el('cycleCashAfter').textContent = formatNum(stats.cashAfter);
  el('cycleCodeAfter').textContent = formatNum(stats.codeAfter);
  el('cycleSpread').textContent = formatNum(stats.spread);

  const tbody = el('dealsTbody');
  tbody.innerHTML = '';
  for (const deal of getCycleDeals(cycle.id)) {
    const tr = document.createElement('tr');
    tr.dataset.id = deal.id;
    tr.innerHTML = `
      <td class="row-number">${deal.row_no || ''}</td>
      <td><input data-field="client_name" value="${escapeAttr(deal.client_name || '')}" /></td>
      <td><input data-field="cash_in" type="number" step="0.01" value="${deal.cash_in ?? 0}" /></td>
      <td><input data-field="cash_out" type="number" step="0.01" value="${deal.cash_out ?? 0}" /></td>
      <td><input data-field="code_in" type="number" step="0.01" value="${deal.code_in ?? 0}" /></td>
      <td><input data-field="code_out" type="number" step="0.01" value="${deal.code_out ?? 0}" /></td>
      <td><input data-field="other_rub" type="number" step="0.01" value="${deal.other_rub ?? 0}" /></td>
      <td><input data-field="code_adjustment" type="number" step="0.01" value="${deal.code_adjustment ?? 0}" /></td>
      <td><textarea data-field="notes">${escapeHtml(deal.notes || '')}</textarea></td>
      <td>
        <div class="compact-cell">
          <input data-field="tx_hash" placeholder="Хэш транзакции" value="${escapeAttr(deal.tx_hash || '')}" />
          <div class="compact-file-row">
            <button class="file-upload-btn" type="button" data-action="pick-file">Файл</button>
            <input class="file-upload-input" type="file" data-upload />
            <div class="file-list">${renderFileChips(deal.files || [])}</div>
          </div>
        </div>
      </td>
      <td><button class="danger" data-action="delete-deal" type="button">✕</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderFileChips(files) {
  return (files || []).map((f, index) => `
    <span class="file-chip" data-index="${index}">
      <button type="button" data-action="open-file" data-index="${index}">${escapeHtml(f.name)}</button>
      <button type="button" data-action="remove-file" data-index="${index}">✕</button>
    </span>`).join('');
}

function renderCycleSummary() {
  const tbody = el('cycleSummaryTbody');
  tbody.innerHTML = '';
  for (const cycle of getSortedCycles()) {
    const stats = cycleStats(cycle.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(cycle.cycle_number || '')}</td>
      <td>${escapeHtml(cycle.cycle_date || '')}</td>
      <td>${escapeHtml(cycle.operator_name || '')}</td>
      <td>${stats.dealsCount}</td>
      <td>${formatNum(stats.cashStart)}</td>
      <td>${formatNum(stats.rubFlow)}</td>
      <td>${formatNum(stats.cashAfter)}</td>
      <td>${formatNum(stats.codeStart)}</td>
      <td>${formatNum(stats.codeFlow)}</td>
      <td>${formatNum(stats.codeAfter)}</td>
      <td>${formatNum(stats.spread)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderOperatorFilter() {
  const select = el('excelOperatorFilter');
  const current = select.value || 'all';
  const names = [...new Set(state.cycles.map((c) => (c.operator_name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  select.innerHTML = '<option value="all">Все операторы</option>' + names.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  select.value = names.includes(current) ? current : 'all';
}

function renderSearch() {
  const tbody = el('searchResultsTbody');
  const term = state.search.trim().toLowerCase();
  tbody.innerHTML = '';
  const rows = state.deals.filter((deal) => {
    if (!term) return true;
    return String(deal.client_name || '').toLowerCase().includes(term);
  }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  for (const deal of rows) {
    const cycle = state.cycles.find((c) => c.id === deal.cycle_id);
    const tr = document.createElement('tr');
    tr.className = 'search-hit';
    tr.innerHTML = `
      <td>${escapeHtml(cycle?.cycle_date || '')}</td>
      <td>${escapeHtml(cycle?.cycle_number || '')}</td>
      <td>${escapeHtml(cycle?.operator_name || '')}</td>
      <td>${deal.row_no || ''}</td>
      <td>${escapeHtml(deal.client_name || '')}</td>
      <td>${formatNum(deal.cash_in)}</td>
      <td>${formatNum(deal.cash_out)}</td>
      <td>${formatNum(deal.code_in)}</td>
      <td>${formatNum(deal.code_out)}</td>`;
    tr.addEventListener('click', () => {
      state.selectedCycleId = deal.cycle_id;
      setMainTab('dashboard');
      render();
      const rowEl = document.querySelector(`tr[data-id="${deal.id}"]`);
      if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    tbody.appendChild(tr);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) { return escapeHtml(value).replaceAll("'", '&#39;'); }

async function ensureSettingsRow() {
  const { data, error } = await supabase.from('app_settings').select('*').maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) {
    const payload = { user_id: state.user.id, initial_cash: 0, initial_code: 0, lock_settings: false };
    const { data: inserted, error: insertError } = await supabase.from('app_settings').insert(payload).select().single();
    if (insertError) throw insertError;
    state.settings = inserted;
  } else {
    state.settings = data;
  }
}

async function loadData() {
  await ensureSettingsRow();
  const [{ data: cycles, error: cycleError }, { data: deals, error: dealError }] = await Promise.all([
    supabase.from('cycles').select('*').order('cycle_date', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('deals').select('*').order('row_no', { ascending: true }).order('created_at', { ascending: true }),
  ]);
  if (cycleError) throw cycleError;
  if (dealError) throw dealError;
  state.cycles = cycles || [];
  state.deals = (deals || []).map((d) => ({ ...d, files: Array.isArray(d.files) ? d.files : [] }));
  applyDraftsToState();
  if (!state.selectedCycleId && state.cycles[0]) state.selectedCycleId = state.cycles[0].id;
  if (state.selectedCycleId && !state.cycles.some((c) => c.id === state.selectedCycleId)) {
    state.selectedCycleId = state.cycles[0]?.id || null;
  }
  render();
  flushDraftsToCloud().catch((error) => console.error('Draft flush failed', error));
}

async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signUp(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  showToast('Регистрация выполнена. Проверьте почту, если требуется подтверждение.');
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

async function createCycle() {
  const number = `CYCLE-${String(Date.now()).slice(-6)}`;
  const payload = {
    user_id: state.user.id,
    cycle_number: number,
    operator_name: '',
    cycle_date: todayStr(),
    status: 'Открыт',
  };
  const { data, error } = await supabase.from('cycles').insert(payload).select().single();
  if (error) throw error;
  state.cycles.unshift(data);
  state.selectedCycleId = data.id;
  render();
}

async function updateCycle(field, value, immediate = false) {
  const cycle = state.cycles.find((c) => c.id === state.selectedCycleId);
  if (!cycle) return;
  const normalizedValue = field === 'cycle_date' ? (value || todayStr()) : value;
  const updated = { ...cycle, [field]: normalizedValue };
  state.cycles = state.cycles.map((c) => c.id === cycle.id ? updated : c);
  render();
  const runner = async () => {
    const { error } = await supabase.from('cycles').update({ [field]: normalizedValue }).eq('id', cycle.id);
    if (error) throw error;
  };
  if (immediate) return runner();
  debounceSave(`cycle:${cycle.id}:${field}`, runner, 250);
}

async function deleteCycle() {
  const cycle = state.cycles.find((c) => c.id === state.selectedCycleId);
  if (!cycle) return;
  if (!confirm(`Удалить цикл ${cycle.cycle_number}?`)) return;
  const { error } = await supabase.from('cycles').delete().eq('id', cycle.id);
  if (error) throw error;
  state.cycles = state.cycles.filter((c) => c.id !== cycle.id);
  state.deals = state.deals.filter((d) => d.cycle_id !== cycle.id);
  state.selectedCycleId = state.cycles[0]?.id || null;
  render();
}

async function addDeal() {
  if (!state.selectedCycleId) {
    showToast('Сначала выберите или создайте цикл', true);
    return;
  }
  const rowNo = getCycleDeals(state.selectedCycleId).length + 1;
  const payload = {
    user_id: state.user.id,
    cycle_id: state.selectedCycleId,
    row_no: rowNo,
    client_name: '',
    cash_in: 0,
    cash_out: 0,
    code_in: 0,
    code_out: 0,
    other_rub: 0,
    code_adjustment: 0,
    notes: '',
    tx_hash: '',
    files: [],
  };
  const { data, error } = await supabase.from('deals').insert(payload).select().single();
  if (error) throw error;
  const normalized = { ...data, files: Array.isArray(data.files) ? data.files : [] };
  state.deals.push(normalized);
  render();
  requestAnimationFrame(() => {
    document.querySelector(`tr[data-id="${normalized.id}"] input[data-field="client_name"]`)?.focus();
  });
}

function updateDealLocal(dealId, field, value) {
  const idx = state.deals.findIndex((d) => d.id === dealId);
  if (idx === -1) return;
  const deal = { ...state.deals[idx], [field]: value };
  state.deals[idx] = deal;
  setDraftValue(dealId, field, value);
  refreshCycleMetricsOnly();
}

async function persistDealField(dealId, field, value, immediate = false, notify = false) {
  const runner = async () => {
    const payload = { [field]: ['cash_in','cash_out','code_in','code_out','other_rub','code_adjustment'].includes(field) ? parseNum(value) : value };
    const { error } = await supabase.from('deals').update(payload).eq('id', dealId);
    if (error) throw error;
    clearDraftValue(dealId, field);
    if (notify) showToast('Данные сохранены.');
  };

  if (immediate) {
    return runner();
  }

  debounceSave(`deal:${dealId}:${field}`, runner, 250);
}

async function deleteDeal(dealId) {
  if (!confirm('Удалить строку сделки?')) return;
  const { error } = await supabase.from('deals').delete().eq('id', dealId);
  if (error) throw error;
  state.deals = state.deals.filter((d) => d.id !== dealId);
  resequenceDeals(state.selectedCycleId);
  render();
}

async function resequenceDeals(cycleId) {
  const deals = getCycleDeals(cycleId);
  for (let i = 0; i < deals.length; i += 1) {
    const desired = i + 1;
    if (deals[i].row_no !== desired) {
      deals[i].row_no = desired;
      const idx = state.deals.findIndex((d) => d.id === deals[i].id);
      if (idx !== -1) state.deals[idx] = deals[i];
      await supabase.from('deals').update({ row_no: desired }).eq('id', deals[i].id);
    }
  }
}

async function syncDealFiles(dealId, files) {
  const { error } = await supabase.from('deals').update({ files }).eq('id', dealId);
  if (error) throw error;
  const idx = state.deals.findIndex((d) => d.id === dealId);
  if (idx !== -1) {
    state.deals[idx] = { ...state.deals[idx], files };
  }
  render();
}

async function uploadDealFile(dealId, file) {
  const deal = state.deals.find((d) => d.id === dealId);
  if (!deal || !file) return;
  if ((file.size || 0) > 25 * 1024 * 1024) {
    throw new Error('Файл слишком большой. Допустимый размер — до 25 МБ.');
  }

  showToast('Загрузка файла...');
  const storagePath = buildStoragePath(deal, file);
  const { error: uploadError } = await supabase.storage
    .from('client-files')
    .upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream'
    });

  if (uploadError) {
    throw new Error(`Не удалось сохранить файл в Storage: ${uploadError.message}`);
  }

  const fileRecord = {
    name: file.name,
    bucket: 'client-files',
    path: storagePath,
    mimeType: file.type || 'application/octet-stream',
    size: file.size || 0,
    uploaded_at: new Date().toISOString(),
    mode: 'storage'
  };

  const files = [...(deal.files || []), fileRecord];
  try {
    await syncDealFiles(deal.id, files);
  } catch (error) {
    await supabase.storage.from('client-files').remove([storagePath]);
    throw error;
  }
}

async function openDealFile(dealId, index) {
  const deal = state.deals.find((d) => d.id === dealId);
  const file = deal?.files?.[index];
  if (!file) throw new Error('Файл не найден.');

  if (file.mode === 'inline' && file.inlineData) {
    const blob = dataUrlToBlob(file.inlineData);
    openBlobInNewTab(blob, file.name);
    return;
  }

  if (file.path) {
    const bucket = file.bucket || 'client-files';
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(file.path, 60);
    if (error) throw error;
    window.open(data.signedUrl, '_blank', 'noopener');
    return;
  }

  throw new Error('Файл не найден.');
}

async function removeDealFile(dealId, index) {
  const deal = state.deals.find((d) => d.id === dealId);
  if (!deal) return;
  const files = [...(deal.files || [])];
  const [removed] = files.splice(index, 1);
  if (!removed) return;

  if (removed.path) {
    const bucket = removed.bucket || 'client-files';
    const { error: storageError } = await supabase.storage.from(bucket).remove([removed.path]);
    if (storageError) throw storageError;
  }

  await syncDealFiles(deal.id, files);
}

async function saveSettings(partial, immediate = false) {
  state.settings = { ...state.settings, ...partial };
  render();
  const runner = async () => {
    const { error } = await supabase.from('app_settings').upsert({
      user_id: state.user.id,
      initial_cash: parseNum(state.settings.initial_cash),
      initial_code: parseNum(state.settings.initial_code),
      lock_settings: !!state.settings.lock_settings,
    });
    if (error) throw error;
  };
  if (immediate) return runner();
  debounceSave('settings', runner, 250);
}

function exportBackup() {
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    settings: state.settings,
    cycles: state.cycles,
    deals: state.deals,
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `backup-${todayStr()}.json`);
}

async function importBackup(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload || !Array.isArray(payload.cycles) || !Array.isArray(payload.deals)) {
    throw new Error('Неверный формат JSON');
  }
  if (!confirm('Импорт заменит текущие настройки, циклы и сделки. Продолжить?')) return;

  await supabase.from('deals').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('cycles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('app_settings').upsert({
    user_id: state.user.id,
    initial_cash: parseNum(payload.settings?.initial_cash),
    initial_code: parseNum(payload.settings?.initial_code),
    lock_settings: !!payload.settings?.lock_settings,
  });

  if (payload.cycles.length) {
    const cycles = payload.cycles.map((c) => ({
      id: c.id,
      user_id: state.user.id,
      cycle_number: c.cycle_number,
      operator_name: c.operator_name,
      cycle_date: c.cycle_date,
      status: c.status || 'Открыт',
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    const { error } = await supabase.from('cycles').insert(cycles);
    if (error) throw error;
  }
  if (payload.deals.length) {
    const deals = payload.deals.map((d) => ({
      id: d.id,
      user_id: state.user.id,
      cycle_id: d.cycle_id,
      row_no: d.row_no,
      client_name: d.client_name,
      cash_in: parseNum(d.cash_in),
      cash_out: parseNum(d.cash_out),
      code_in: parseNum(d.code_in),
      code_out: parseNum(d.code_out),
      other_rub: parseNum(d.other_rub),
      code_adjustment: parseNum(d.code_adjustment),
      notes: d.notes,
      tx_hash: d.tx_hash,
      files: Array.isArray(d.files) ? d.files : [],
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));
    const { error } = await supabase.from('deals').insert(deals);
    if (error) throw error;
  }
  await loadData();
  showToast('Импорт завершён.');
}

function filteredCyclesForExcel() {
  const period = el('excelPeriod').value;
  const operator = el('excelOperatorFilter').value;
  const from = el('excelDateFrom').value;
  const to = el('excelDateTo').value;
  const now = new Date();
  let start = null;
  let end = null;

  if (period === 'week') start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (period === 'month') start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  if (period === 'year') start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  if (period === 'custom') {
    start = from ? isoDate(from) : null;
    end = to ? isoDate(to) : null;
  }

  return getSortedCycles().filter((cycle) => {
    if (operator !== 'all' && (cycle.operator_name || '') !== operator) return false;
    const cycleDate = isoDate(cycle.cycle_date);
    if (start && cycleDate && cycleDate < start) return false;
    if (end && cycleDate && cycleDate > end) return false;
    return true;
  });
}

function exportExcel() {
  const scope = el('excelScope').value;
  const cycles = filteredCyclesForExcel();
  const wb = XLSX.utils.book_new();

  if (scope === 'cycles') {
    const rows = cycles.map((cycle) => {
      const stats = cycleStats(cycle.id);
      return {
        'ID цикла': cycle.cycle_number,
        'Дата': cycle.cycle_date,
        'Оператор': cycle.operator_name,
        'Статус': cycle.status,
        'Количество сделок': stats.dealsCount,
        'Касса на начало': stats.cashStart,
        'Руб по циклу': stats.rubFlow,
        'Касса после': stats.cashAfter,
        'Код на начало': stats.codeStart,
        'Код по циклу': stats.codeFlow,
        'Код после': stats.codeAfter,
        'Спред': stats.spread,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Циклы');
  } else {
    const cycleMap = new Map(cycles.map((c) => [c.id, c]));
    const rows = state.deals
      .filter((deal) => cycleMap.has(deal.cycle_id))
      .map((deal) => {
        const cycle = cycleMap.get(deal.cycle_id);
        return {
          'Дата': cycle.cycle_date,
          'ID цикла': cycle.cycle_number,
          'Оператор': cycle.operator_name,
          '#': deal.row_no,
          'Клиент': deal.client_name,
          'Поступило, руб': deal.cash_in,
          'Расход, руб': deal.cash_out,
          'Приход кода': deal.code_in,
          'Расход кода': deal.code_out,
          'Иные платежи': deal.other_rub,
          'Пополнение / вывод кода': deal.code_adjustment,
          'Примечание': deal.notes,
          'Хэш транзакции': deal.tx_hash,
          'Файлы': (deal.files || []).map((f) => f.name).join('; '),
        };
      });
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Сделки');
  }

  XLSX.writeFile(wb, `vasha-sdelka-${scope}-${todayStr()}.xlsx`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  qsa('[data-auth-tab]').forEach((btn) => btn.addEventListener('click', () => setAuthTab(btn.dataset.authTab)));
  qsa('[data-tab]').forEach((btn) => btn.addEventListener('click', () => setMainTab(btn.dataset.tab)));

  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await signIn(el('loginEmail').value, el('loginPassword').value); } catch (err) { showToast(err.message, true); }
  });

  el('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await signUp(el('signupEmail').value, el('signupPassword').value); } catch (err) { showToast(err.message, true); }
  });

  el('signOutBtn').addEventListener('click', async () => {
    try { await signOut(); } catch (err) { showToast(err.message, true); }
  });

  el('refreshDataBtn').addEventListener('click', async () => {
    await checkForAppUpdate(true);
  });

  el('newCycleBtn').addEventListener('click', async () => { try { await createCycle(); } catch (err) { showToast(err.message, true); } });
  el('deleteCycleBtn').addEventListener('click', async () => { try { await deleteCycle(); } catch (err) { showToast(err.message, true); } });
  el('addDealBtn').addEventListener('click', async () => { try { await addDeal(); } catch (err) { showToast(err.message, true); } });

  el('cycleNumber').addEventListener('input', (e) => updateCycle('cycle_number', e.target.value));
  el('cycleOperator').addEventListener('input', (e) => updateCycle('operator_name', e.target.value));
  el('cycleDate').addEventListener('change', (e) => updateCycle('cycle_date', e.target.value, true));
  el('cycleStatus').addEventListener('change', (e) => updateCycle('status', e.target.value, true));
  el('cycleForm').addEventListener('focusout', (e) => {
    if (e.target.id === 'cycleNumber') updateCycle('cycle_number', e.target.value, true).catch((err) => showToast(err.message, true));
    if (e.target.id === 'cycleOperator') updateCycle('operator_name', e.target.value, true).catch((err) => showToast(err.message, true));
  }, true);

  el('settingsForm').addEventListener('input', (e) => {
    if (e.target.id === 'initialCash') saveSettings({ initial_cash: parseNum(e.target.value) });
    if (e.target.id === 'initialCode') saveSettings({ initial_code: parseNum(e.target.value) });
  });
  el('settingsForm').addEventListener('focusout', (e) => {
    if (e.target.id === 'initialCash') saveSettings({ initial_cash: parseNum(e.target.value) }, true).catch((err) => showToast(err.message, true));
    if (e.target.id === 'initialCode') saveSettings({ initial_code: parseNum(e.target.value) }, true).catch((err) => showToast(err.message, true));
  }, true);

  el('lockSettingsBtn').addEventListener('click', () => saveSettings({ lock_settings: true }));
  el('unlockSettingsBtn').addEventListener('click', () => {
    const pass = prompt('Введите пароль для разблокировки начальных данных');
    if (pass === (cfg.unlockPassword || '1111')) saveSettings({ lock_settings: false });
    else showToast('Неверный пароль', true);
  });

  el('dealsTbody').addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || !e.target.dataset.field) return;
    updateDealLocal(tr.dataset.id, e.target.dataset.field, e.target.value);
    persistDealField(tr.dataset.id, e.target.dataset.field, e.target.value);
  });

  el('dealsTbody').addEventListener('focusout', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || !e.target.dataset.field) return;
    try { await persistDealField(tr.dataset.id, e.target.dataset.field, e.target.value, true); } catch (err) { showToast(err.message, true); }
  }, true);

  el('dealsTbody').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (e.target.dataset.field) {
      try { await persistDealField(tr.dataset.id, e.target.dataset.field, e.target.value, true); } catch (err) { showToast(err.message, true); }
      return;
    }
    if (e.target.matches('[data-upload]')) {
      const file = e.target.files?.[0];
      if (!file) return;
      try { await uploadDealFile(tr.dataset.id, file); showToast('Файл сохранён.'); } catch (err) { showToast(err.message, true); }
      e.target.value = '';
    }
  });

  el('dealsTbody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.matches('input[data-field]') || e.target.matches('textarea[data-field]'))) {
      e.preventDefault();
      persistDealField(e.target.closest('tr[data-id]').dataset.id, e.target.dataset.field, e.target.value, true)
        .catch((err) => showToast(err.message, true));
      focusNextEditable(e.target);
    }
  });

  el('dealsTbody').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const action = e.target.dataset.action;
    if (action === 'pick-file') {
      tr.querySelector('[data-upload]')?.click();
      return;
    }
    if (action === 'delete-deal') {
      try { await deleteDeal(tr.dataset.id); } catch (err) { showToast(err.message, true); }
    }
    if (action === 'open-file') {
      try { await openDealFile(tr.dataset.id, Number(e.target.dataset.index)); } catch (err) { showToast(err.message, true); }
    }
    if (action === 'remove-file') {
      try { await removeDealFile(tr.dataset.id, Number(e.target.dataset.index)); } catch (err) { showToast(err.message, true); }
    }
  });

  el('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value || '';
    renderSearch();
  });

  el('exportBackupBtn').addEventListener('click', exportBackup);
  el('importBackupInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { await importBackup(file); } catch (err) { showToast(err.message, true); }
    e.target.value = '';
  });

  el('exportExcelBtn').addEventListener('click', exportExcel);

  window.addEventListener('beforeunload', () => { try { saveDraftStore(); } catch {} });
  window.addEventListener('pagehide', () => { try { saveDraftStore(); } catch {} });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { saveDraftStore(); } catch {} } });
}

async function handleSession(session) {
  state.user = session?.user || null;
  if (!state.user) {
    authView.classList.remove('hidden');
    mainView.classList.add('hidden');
    return;
  }
  authView.classList.add('hidden');
  mainView.classList.remove('hidden');
  el('userEmail').textContent = state.user.email;
  await loadData();
  checkForAppUpdate(false);
}

async function init() {
  bindEvents();
  setAuthTab('login');
  setMainTab('dashboard');

  if (!isConfigured) {
    configWarning.classList.remove('hidden');
    authView.classList.add('hidden');
    mainView.classList.add('hidden');
    return;
  }

  supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  authView.classList.remove('hidden');

  const { data: { session } } = await supabase.auth.getSession();
  await handleSession(session);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    await handleSession(session);
  });

  window.addEventListener('beforeunload', () => {
    saveDraftStore();
  });
}

init().catch((err) => {
  console.error(err);
  showToast(err.message || 'Ошибка инициализации', true);
});
