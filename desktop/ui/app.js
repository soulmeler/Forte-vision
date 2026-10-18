import { analyzeVideo, validateBaseUrl } from './api.js';

const $ = id => document.getElementById(id);
const state = { file: null, objectUrl: null, sample: false, duration: 0, result: null, selected: 0, busy: false, controller: null, runId: 0 };
let saved = {};
try { saved = JSON.parse(localStorage.getItem('kassa-settings') || '{}'); } catch { /* Storage is optional. */ }
const config = { mode: saved.mode === 'api' ? 'api' : 'demo', baseUrl: 'http://127.0.0.1:8000', apiKey: '' };
try { config.baseUrl = validateBaseUrl(saved.baseUrl || config.baseUrl); } catch { /* Use local default. */ }

function time(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showError(message) { $('error-text').textContent = message; $('error-banner').hidden = false; }
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function clearResult() {
  state.result = null; $('results-content').hidden = true; $('results-empty').hidden = false;
  $('events-list').replaceChildren(); $('timeline').replaceChildren(); $('result-count').textContent = '—';
  $('event-detail').hidden = true;
}
function persistSettings() { try { localStorage.setItem('kassa-settings', JSON.stringify({ mode: config.mode, baseUrl: config.baseUrl })); } catch {} }
function updateMode() {
  const demo = config.mode === 'demo';
  $('mode-text').textContent = demo ? 'Демо-режим' : 'Локальный API';
  $('mode-badge').classList.toggle('connected', !demo);
  $('demo-notice').hidden = !demo;
  $('analyze-button').firstChild.textContent = demo ? 'Запустить демо ' : 'Проверить видео ';
  $('analyze-button').disabled = state.busy || (!state.file && !state.sample) || (!demo && state.sample);
}
function setBusy(busy) {
  state.busy = busy;
  for (const id of ['choose-file', 'replace-file', 'demo-button', 'mode-badge', 'nav-settings', 'connect-shortcut']) $(id).disabled = busy;
  $('cancel-button').hidden = !busy; $('analyze-button').hidden = busy; $('progress-area').hidden = !busy;
  updateMode();
}
function resetMedia() {
  $('video').pause(); $('video').removeAttribute('src'); $('video').load();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null; state.duration = 0;
  $('error-banner').hidden = true; clearResult();
}
function chooseFile(file) {
  if (!file || state.busy) return;
  if (!/\.(mov|mp4|webm)$/i.test(file.name)) return showError('Выберите видео в формате MOV, MP4 или WEBM.');
  if (!file.size || file.size > 300 * 1024 * 1024) return showError('Файл должен быть непустым и занимать не более 300 МБ.');
  resetMedia();
  state.file = file; state.sample = false; state.objectUrl = URL.createObjectURL(file);
  $('dropzone').hidden = true; $('player-area').hidden = false; $('video').hidden = false;
  $('demo-scene').hidden = true; $('illustration-badge').hidden = true;
  $('video').src = state.objectUrl;
  $('file-name').textContent = file.name;
  $('file-meta').textContent = `${(file.size / 1024 / 1024).toFixed(1)} МБ · Чтение метаданных…`;
  $('video-tag').textContent = 'Готово к проверке';
  updateMode();
}
$('video').addEventListener('loadedmetadata', () => {
  if (!state.file) return;
  state.duration = Number.isFinite($('video').duration) ? $('video').duration : 0;
  $('file-meta').textContent = `${time(state.duration)} · ${$('video').videoWidth} × ${$('video').videoHeight} · ${(state.file.size / 1024 / 1024).toFixed(1)} МБ`;
});
$('video').addEventListener('error', () => {
  if (!state.file || !$('video').getAttribute('src')) return;
  $('file-meta').textContent = `${(state.file.size / 1024 / 1024).toFixed(1)} МБ · Предпросмотр недоступен`;
  showError('Предпросмотр этого формата недоступен. Вы можете отправить запись подключённому сервису для проверки.');
});
function loadSample() {
  if (state.busy) return;
  resetMedia(); state.file = null; state.sample = true; state.duration = 36;
  config.mode = 'demo'; persistSettings(); updateMode();
  $('dropzone').hidden = true; $('player-area').hidden = false;
  $('video').hidden = true; $('demo-scene').hidden = false; $('illustration-badge').hidden = false;
  $('file-name').textContent = 'Пример проверки';
  $('file-meta').textContent = 'Учебный сценарий · иллюстрация кассового места';
  $('video-tag').textContent = 'Демонстрация';
  startAnalysis();
}

function demoResult() {
  return { demo: true, verdict: 'violation', violations: [
    { type: 'Пример события для проверки', timecode_sec: 12, description: 'Это демонстрационная карточка. После подключения модели здесь появится описание действия, наблюдаемого на загруженном видео, и объяснение, почему оно требует проверки. Эти сведения не являются результатом анализа вашей записи.', evidence_frames: [10, 12, 14].map(timestamp_sec => ({ timestamp_sec, demo: true })), rule: null },
    { type: 'Пример повторного события', timecode_sec: 26, description: 'В одной записи может быть несколько событий. Каждое получает собственный таймкод, набор кадров и основание. В этом примере показано только поведение интерфейса.', evidence_frames: [25, 26].map(timestamp_sec => ({ timestamp_sec, demo: true })), rule: null }
  ] };
}
async function startAnalysis() {
  if (state.busy || (!state.file && !state.sample)) return;
  if (config.mode === 'api' && !state.file) return showError('Выберите настоящий видеофайл для проверки через API.');
  $('error-banner').hidden = true; clearResult(); setBusy(true);
  const runId = ++state.runId;
  const controller = new AbortController(); state.controller = controller;
  const began = Date.now(); $('elapsed').textContent = '00:00';
  const clock = setInterval(() => $('elapsed').textContent = time((Date.now() - began) / 1000), 500);
  const isDemo = config.mode === 'demo';
  $('progress-title').textContent = isDemo ? 'Подготовка примера' : 'Передача в локальный API';
  $('progress-note').textContent = isDemo ? 'Демонстрация состояний интерфейса. Содержимое видео не анализируется.' : 'Ожидаем ответ сервиса. Видео обрабатывается локально.';
  try {
    let result;
    if (isDemo) {
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve(); }, 1900);
        controller.signal.addEventListener('abort', cancel, { once: true });
      });
      result = demoResult();
    } else {
      result = await analyzeVideo(state.file, config, { signal: controller.signal, onStatus: status => {
        $('progress-title').textContent = status === 'uploading' ? 'Передача в локальный API' : 'Модель анализирует видео';
      } });
    }
    if (runId !== state.runId) return;
    state.result = result; renderResult();
    $('video-tag').textContent = isDemo ? 'Демо завершено' : 'Проверка завершена';
  } catch (error) {
    if (error.name === 'AbortError') toast('Ожидание остановлено. Задача на сервере может продолжать обработку.');
    else { showError(error.message); $('video-tag').textContent = 'Не удалось завершить'; }
  } finally { clearInterval(clock); if (runId === state.runId) { state.controller = null; setBusy(false); } }
}
function renderResult() {
  const result = state.result;
  const actions = result.verdict === 'review_required';
  const events = actions ? result.observed_events : result.violations;
  $('results-empty').hidden = true; $('results-content').hidden = false;
  $('result-count').textContent = events.length.toString();
  const verdict = $('verdict'); verdict.replaceChildren(); verdict.classList.toggle('safe', result.verdict === 'no_violation');
  verdict.append(el('strong', '', actions ? 'Наблюдаемые действия · нужна проверка' : result.demo ? 'Пример результата · 2 события' : result.verdict === 'violation' ? 'Обнаружены признаки возможных нарушений' : 'Нарушение не обнаружено'));
  verdict.append(el('small', '', actions ? 'Проверены передача предмета и уход сотрудника. Нарушения автоматически не устанавливаются.' : result.demo ? 'Учебные данные. Загруженное видео не анализировалось.' : result.verdict === 'violation' ? 'Проверьте каждый эпизод и его основание.' : 'В пределах возможностей подключённого анализатора.'));
  if (actions && result.analysis?.coverage?.complete === false) verdict.append(el('small', '', 'Обработка частичная: часть окон не проверена.'));
  $('events-list').replaceChildren(); $('timeline').replaceChildren();
  events.forEach((event, index) => {
    const button = el('button', 'event-button'); button.type = 'button';
    button.append(el('span', 'event-number', String(index + 1).padStart(2, '0')), el('span', 'event-title', event.type), el('time', '', time(event.timecode_sec)));
    button.addEventListener('click', () => selectEvent(index, true));
    $('events-list').append(button);
    const marker = el('button'); marker.type = 'button'; marker.title = `${time(event.timecode_sec)} — ${event.type}`;
    marker.setAttribute('aria-label', marker.title);
    marker.style.left = `${Math.min(98, Math.max(2, event.timecode_sec / (result.demo ? 36 : state.duration || Math.max(...events.map(e => e.timecode_sec)) + 5) * 100))}%`;
    marker.addEventListener('click', () => selectEvent(index, true)); $('timeline').append(marker);
  });
  $('event-detail').hidden = !events.length;
  if (events.length) selectEvent(0, false);
}
function selectEvent(index, seek) {
  state.selected = index;
  const event = (state.result.verdict === 'review_required' ? state.result.observed_events : state.result.violations)[index];
  [...$('events-list').children].forEach((button, i) => { button.classList.toggle('selected', i === index); button.setAttribute('aria-pressed', String(i === index)); });
  $('event-description').textContent = event.description;
  $('evidence-count').textContent = event.evidence_frames.length;
  $('evidence-grid').replaceChildren();
  event.evidence_frames.forEach(frame => {
    const button = el('button', 'evidence-frame'); button.setAttribute('aria-label', `Открыть кадр ${time(frame.timestamp_sec)}`);
    const image = el('img'); image.src = frame.demo ? 'scene.svg' : 'data:image/jpeg;base64,' + frame.image_base64;
    image.alt = frame.demo ? 'Демонстрационная иллюстрация' : `Кадр события на ${time(frame.timestamp_sec)}`;
    image.addEventListener('error', () => { image.alt = 'Не удалось прочитать JPEG'; });
    button.append(image, el('time', '', time(frame.timestamp_sec)));
    if (frame.demo) button.append(el('span', '', 'ДЕМО'));
    button.addEventListener('click', () => {
      $('evidence-large').src = image.src; $('evidence-title').textContent = `Кадр · ${time(frame.timestamp_sec)}`;
      $('evidence-caption').textContent = frame.demo ? 'Иллюстрация для знакомства с интерфейсом. Не является доказательством нарушения.' : event.description;
      $('evidence-dialog').showModal();
    });
    $('evidence-grid').append(button);
  });
  const rule = $('rule-card'); rule.replaceChildren(); rule.append(el('strong', '', 'ОСНОВАНИЕ'));
  if (state.result.demo) rule.append(el('span', '', 'В реальном результате здесь будет проверенное правило и нормативный источник. Для примера ссылка не выдумывается.'));
  else if (event.rule?.title) {
    rule.append(el('span', '', [event.rule.title, event.rule.section].filter(Boolean).join(' · ')));
    try {
      const url = new URL(event.rule.url);
      if (url.protocol === 'https:' && ['adilet.zan.kz', 'old.adilet.zan.kz', 'nationalbank.kz', 'www.nationalbank.kz', 'zan.gov.kz'].includes(url.hostname) && !url.username && !url.password) {
        const link = el('a', '', 'Открыть нормативный источник ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        if (window.desktop) link.addEventListener('click', event => { event.preventDefault(); window.desktop.openSource(url.href).catch(() => toast('Не удалось открыть источник.')); });
        rule.append(link);
      }
    } catch { /* A rule without a valid URL remains readable. */ }
  } else rule.append(el('span', '', 'Нормативное основание не указано. Перед принятием решения уточните применимое правило.'));
  if (seek && !state.result.demo && state.file) {
    if (!state.duration || event.timecode_sec >= state.duration) toast('Таймкод API недоступен в текущем видеоплеере.');
    else { $('video').currentTime = event.timecode_sec; $('video').pause(); }
  }
}

function settingsFields() {
  const demo = $('settings-form').elements.mode.value === 'demo';
  $('api-url').disabled = demo; $('api-key').disabled = demo;
}
function openSettings() {
  if (state.busy) return;
  $('settings-form').elements.mode.value = config.mode;
  $('api-url').value = config.baseUrl; $('api-key').value = config.apiKey; $('settings-error').textContent = '';
  settingsFields(); $('settings-dialog').showModal();
}
for (const id of ['nav-settings', 'mode-badge', 'connect-shortcut']) $(id).addEventListener('click', openSettings);
$('settings-form').addEventListener('change', settingsFields);
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const mode = $('settings-form').elements.mode.value;
    const baseUrl = mode === 'api' ? validateBaseUrl($('api-url').value.trim()) : config.baseUrl;
    if (mode === 'api' && !$('api-key').value.trim()) throw new Error('Введите API-ключ для подключения.');
    Object.assign(config, { mode, baseUrl, apiKey: $('api-key').value.trim() });
    persistSettings(); clearResult(); updateMode();
    $('video-tag').textContent = state.sample ? 'Демонстрация' : state.file ? 'Готово к проверке' : 'Новая проверка';
    $('settings-dialog').close();
    toast(mode === 'api' ? 'Настройки сохранены. Соединение будет проверено при отправке видео.' : 'Включён демонстрационный режим.');
  } catch (error) { $('settings-error').textContent = error.message; }
});
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('nav-analysis').addEventListener('click', () => document.querySelector('.review-grid').scrollIntoView({ behavior: 'smooth', block: 'start' }));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
for (const id of ['choose-file', 'replace-file']) $(id).addEventListener('click', () => { $('file-input').value = ''; $('file-input').click(); });
$('file-input').addEventListener('change', () => chooseFile($('file-input').files[0]));
$('analyze-button').addEventListener('click', startAnalysis);
$('demo-button').addEventListener('click', loadSample);
$('cancel-button').addEventListener('click', () => state.controller?.abort());
$('dismiss-error').addEventListener('click', () => $('error-banner').hidden = true);
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); if (!state.busy) $('dropzone').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', event => chooseFile(event.dataTransfer.files[0]));
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
window.addEventListener('beforeunload', () => { state.controller?.abort(); if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); });
updateMode();
