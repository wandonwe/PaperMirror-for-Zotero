const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const app = $('#appShell');
const workspace = $('#workspace');
const pdfSide = $('#pdfSide');
const translation = $('#translationSide');
const splitter = $('#splitter');
const toast = $('#toast');
const modal = $('#settingsModal');
const STORE_KEY = 'papermirror-demo-v2';
let toastTimer;
let dragging = false;

const defaults = {
  theme: 'light', view: 'split', showOriginal: true, sync: true,
  fontSize: 16, provider: 'bing', baseUrl: 'https://www.bing.com/translator',
  model: '', glossary: 'attention = 注意力\nquery = 查询\nkey = 键\nvalue = 值\nmulti-head attention = 多头注意力',
  notes: [], privacyAccepted: true, localOnly: false
};
let state = { ...defaults, ...readStored() };

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function notify(message, symbol = '✓') {
  toast.querySelector('span').textContent = symbol;
  toast.querySelector('p').textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1900);
}

function setView(view, announce = true) {
  state.view = view;
  workspace.classList.remove('view-source', 'view-overlay');
  if (view !== 'split') workspace.classList.add(`view-${view}`);
  $$('.view-switch button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#mirrorButton').classList.toggle('active', view !== 'source');
  saveState();
  if (announce) notify({ source: '已切换为原文阅读', overlay: '已在 PDF 上覆盖译文', split: '已切换为左右对照' }[view]);
}

function applyState() {
  app.dataset.theme = state.theme;
  document.documentElement.style.setProperty('--article-size', `${state.fontSize}px`);
  $('#fontRange').value = state.fontSize;
  $('#fontValue').textContent = state.fontSize;
  $('#originalToggle').checked = state.showOriginal;
  $('#syncToggle').checked = state.sync;
  translation.classList.toggle('no-original', !state.showOriginal);
  $('#providerSelect').value = state.provider;
  $('#baseUrlInput').value = state.baseUrl;
  $('#modelInput').value = state.model;
  $('#glossaryInput').value = state.glossary;
  $('#privacyAccepted').checked = state.privacyAccepted;
  $('#localOnly').checked = state.localOnly;
  updateGlossaryCount();
  renderNotes();
  setView(state.view, false);
}

$('#originalToggle').addEventListener('change', event => {
  state.showOriginal = event.target.checked; saveState();
  translation.classList.toggle('no-original', !event.target.checked);
  notify(event.target.checked ? '已显示段落原文' : '已切换为纯译文阅读');
});
$('#syncToggle').addEventListener('change', event => {
  state.sync = event.target.checked; saveState();
  notify(event.target.checked ? '同步滚动已开启' : '同步滚动已暂停');
});
$$('.view-switch button').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));

function showExplanation() {
  $('#explainCard').classList.remove('hidden');
  $('#translationScroll').scrollTo({ top: 0, behavior: 'smooth' });
}
$('#explainSelection').addEventListener('click', showExplanation);
$('#inlineExplain').addEventListener('click', showExplanation);
$('#closeExplain').addEventListener('click', () => $('#explainCard').classList.add('hidden'));
$('#translateSelection').addEventListener('click', () => {
  setView('split', false);
  $('#focusedTranslation').scrollIntoView({ behavior: 'smooth', block: 'center' });
  notify('已定位到对应译文');
});

$('#copyButton').addEventListener('click', async () => {
  const text = $$('.translated-article .translation-block>p:last-of-type').map(node => node.innerText).join('\n\n');
  try { await navigator.clipboard.writeText(text); notify('本页译文已复制'); }
  catch { notify('浏览器未授权剪贴板，已完成演示', 'i'); }
});

function addNote() {
  const focused = $('.translation-block.focused p:last-of-type') || $('#focusedTranslation p:last-of-type');
  state.notes.unshift({ id: Date.now(), text: focused.innerText, page: Number($('#pageInput').value), date: new Date().toLocaleString('zh-CN') });
  saveState(); renderNotes(); notify('已保存到阅读笔记');
}
$('#noteButton').addEventListener('click', addNote);
$('#notesButton').addEventListener('click', () => $('#notesDrawer').classList.add('open'));
$('#closeNotes').addEventListener('click', () => $('#notesDrawer').classList.remove('open'));
function renderNotes() {
  $('#noteCount').textContent = state.notes.length;
  const host = $('#notesList');
  if (!state.notes.length) { host.innerHTML = '<div class="empty-notes"><b>还没有笔记</b><span>选择段落或点击“保存到笔记”开始记录。</span></div>'; return; }
  host.textContent = '';
  state.notes.forEach(note => {
    const card = document.createElement('article'); card.className = 'note-card';
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.addEventListener('click', () => { state.notes = state.notes.filter(item => item.id !== note.id); saveState(); renderNotes(); });
    const p = document.createElement('p'); p.textContent = note.text;
    const small = document.createElement('small'); small.textContent = `第 ${note.page} 页 · ${note.date}`;
    card.append(remove, p, small); host.append(card);
  });
}

$('#themeButton').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; saveState(); applyState(); notify(state.theme === 'dark' ? '已切换至深色主题' : '已切换至浅色主题'); });
$('#swapButton').addEventListener('click', () => { workspace.classList.toggle('swapped'); notify(workspace.classList.contains('swapped') ? '译文已移至左侧' : '原文已移至左侧'); });
$('#closeButton').addEventListener('click', () => setView('source'));
$('#mirrorButton').addEventListener('click', () => setView(state.view === 'source' ? 'split' : 'source'));

function showPrivacy(onAccept) {
  const dialog = document.createElement('div'); dialog.className = 'privacy-dialog';
  dialog.innerHTML = '<section class="privacy-box"><span class="eyebrow">翻译前确认</span><h3>你的文本将发送至翻译服务商</h3><p>仅发送当前页面中需要翻译的文字，不会上传 PDF 文件、Zotero 数据或阅读笔记。</p><div class="privacy-host">→ www.bing.com</div><div class="privacy-actions"><button class="cancel">取消</button><button class="accept">同意并继续</button></div></section>';
  dialog.querySelector('.cancel').onclick = () => dialog.remove();
  dialog.querySelector('.accept').onclick = () => { dialog.remove(); onAccept(); };
  document.body.append(dialog);
}
function runRefresh() {
  if (translation.classList.contains('refreshing')) return;
  translation.classList.add('refreshing');
  $('.status-row').innerHTML = '<span>正在重新翻译第 6 页…</span><span class="cache-label">0 / 8 个段落</span>';
  let done = 0;
  const timer = setInterval(() => { done += 2; $('.cache-label').textContent = `${done} / 8 个段落`; if (done >= 8) { clearInterval(timer); translation.classList.remove('refreshing'); $('.status-row').innerHTML = '<span><i class="check">✓</i> 第 6 页已翻译</span><span class="cache-label">刚刚更新 · 0.8 秒</span>'; notify('本页译文已更新并写入缓存'); } }, 220);
}
$('#refreshButton').addEventListener('click', () => state.privacyAccepted ? runRefresh() : showPrivacy(runRefresh));
$('#languageButton').addEventListener('click', () => notify('自动识别：英文 → 简体中文'));
$('#providerButton').addEventListener('click', () => { modal.classList.remove('hidden'); activateSettingsTab('provider'); });

$('#settingsButton').addEventListener('click', () => modal.classList.remove('hidden'));
$('#closeSettings').addEventListener('click', () => modal.classList.add('hidden'));
$('#saveSettings').addEventListener('click', () => { syncSettings(); modal.classList.add('hidden'); notify('设置已保存'); });
modal.addEventListener('click', event => { if (event.target === modal) modal.classList.add('hidden'); });
function activateSettingsTab(name) {
  $$('.settings-nav button').forEach(button => button.classList.toggle('active', button.dataset.settingTab === name));
  $$('.settings-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.settingPane === name));
}
$$('.settings-nav button').forEach(button => button.addEventListener('click', () => activateSettingsTab(button.dataset.settingTab)));

const providerPresets = {
  bing: ['https://www.bing.com/translator', ''],
  openai: ['https://api.openai.com/v1', 'gpt-5.6-terra'],
  deepseek: ['https://api.deepseek.com/v1', 'deepseek-chat'],
  qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  ollama: ['http://localhost:11434/v1', 'qwen3:8b']
};
$('#providerSelect').addEventListener('change', event => {
  const [url, model] = providerPresets[event.target.value];
  $('#baseUrlInput').value = url; $('#modelInput').value = model;
  $('#apiKeyInput').placeholder = ['bing', 'ollama'].includes(event.target.value) ? '该服务无需填写' : '粘贴 API Key';
});
$('#testConnection').addEventListener('click', () => {
  const button = $('#testConnection'); const result = $('#testResult');
  if ($('#localOnly').checked && !$('#baseUrlInput').value.includes('localhost')) { result.textContent = '仅本地模式已阻止此地址'; result.style.color = '#c34d52'; return; }
  button.classList.add('testing'); button.textContent = '正在测试…'; result.textContent = '';
  setTimeout(() => { button.classList.remove('testing'); button.textContent = '测试连接'; result.style.color = ''; result.textContent = '✓ 连接成功 · 326 ms（演示）'; }, 700);
});
function syncSettings() {
  state.provider = $('#providerSelect').value; state.baseUrl = $('#baseUrlInput').value.trim(); state.model = $('#modelInput').value.trim(); state.fontSize = Number($('#fontRange').value); state.glossary = $('#glossaryInput').value; state.privacyAccepted = $('#privacyAccepted').checked; state.localOnly = $('#localOnly').checked; saveState(); applyState();
}
$('#fontRange').addEventListener('input', event => { document.documentElement.style.setProperty('--article-size', `${event.target.value}px`); $('#fontValue').textContent = event.target.value; });
$$('.segmented button').forEach(button => button.addEventListener('click', () => { button.parentElement.querySelectorAll('button').forEach(item => item.classList.remove('active')); button.classList.add('active'); if (button.dataset.defaultView) setView(button.dataset.defaultView, false); }));

function updateGlossaryCount() { const count = $('#glossaryInput').value.split('\n').filter(line => line.trim() && line.includes('=')).length; $('#glossaryCount').textContent = `${count} 条术语`; }
$('#glossaryInput').addEventListener('input', updateGlossaryCount);
$('#clearGlossary').addEventListener('click', () => { $('#glossaryInput').value = ''; updateGlossaryCount(); notify('术语表已清空'); });
$('#exportGlossary').addEventListener('click', () => { const blob = new Blob([$('#glossaryInput').value], { type: 'text/plain' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'papermirror-glossary.txt'; link.click(); URL.revokeObjectURL(link.href); notify('术语表已导出'); });
$('#clearCache').addEventListener('click', event => { event.target.closest('.cache-card').querySelector('small').textContent = '0 个页面 · 0 KB'; notify('翻译缓存已清除'); });

splitter.addEventListener('pointerdown', event => { dragging = true; splitter.setPointerCapture(event.pointerId); document.body.style.cursor = 'col-resize'; });
splitter.addEventListener('pointermove', event => { if (!dragging || window.innerWidth < 700) return; const rect = workspace.getBoundingClientRect(); let ratio = (event.clientX - rect.left) / rect.width; if (workspace.classList.contains('swapped')) ratio = 1 - ratio; ratio = Math.min(.68, Math.max(.36, ratio)); pdfSide.style.flexBasis = `${ratio * 100}%`; });
splitter.addEventListener('pointerup', () => { dragging = false; document.body.style.cursor = ''; });

const pageInput = $('#pageInput');
function changePage(delta) { const next = Math.min(15, Math.max(1, Number(pageInput.value) + delta)); pageInput.value = next; notify(`已跳转至第 ${next} 页（演示内容固定为第 6 页）`); }
$('#prevPage').addEventListener('click', () => changePage(-1)); $('#nextPage').addEventListener('click', () => changePage(1)); pageInput.addEventListener('change', () => changePage(0));
$$('.translation-block').forEach(block => block.addEventListener('click', () => { $$('.translation-block').forEach(item => item.classList.remove('focused')); block.classList.add('focused'); }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { modal.classList.add('hidden'); $('#explainCard').classList.add('hidden'); $('#notesDrawer').classList.remove('open'); } if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); modal.classList.remove('hidden'); } });

applyState();
