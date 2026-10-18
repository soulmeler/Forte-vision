import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArrowUpRight, Check, CircleHelp, Clock3, Download, Film, FolderOpen, LoaderCircle, Play, PlugZap, RefreshCw, TriangleAlert, X } from 'lucide-react';
import './batch-panel.css';

const BATCH_STORAGE = 'vision-forte.batch.v1';
const readSelected = () => { try { return localStorage.getItem(BATCH_STORAGE); } catch { return null; } };
const saveSelected = id => { try { id ? localStorage.setItem(BATCH_STORAGE, id) : localStorage.removeItem(BATCH_STORAGE); } catch {} };
const message = error => error?.message || 'Не удалось получить сведения об архиве.';

export function useBatchManager({ api, authenticated, onNotice }) {
  const [id, setId] = useState(readSelected);
  const [batch, setBatch] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const activeId = useRef(id), notice = useRef(onNotice);
  notice.current = onNotice;
  activeId.current = id;

  const select = value => {
    const nextId = typeof value === 'string' ? value : value?.id || null;
    activeId.current = nextId;
    saveSelected(nextId);
    setId(nextId);
    setBatch(typeof value === 'object' ? value : null);
    setError(null);
  };

  useEffect(() => {
    if (!id || !authenticated) return;
    const controller = new AbortController();
    let cancelled = false, inFlight = false;
    setLoading(true);
    const update = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await api(`/batches/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (cancelled || activeId.current !== id) return;
        if (response?.batch?.id !== id) throw new Error('Не удалось подтвердить сведения об архиве.');
        setBatch(response.batch);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(failure.status === 404 ? 'Архив больше не найден. Откройте историю или загрузите другой архив.' : message(failure));
      } finally {
        if (!cancelled) setLoading(false);
        inFlight = false;
      }
    };
    update();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') update(); }, 2500);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [id, authenticated, api]);

  const start = async (value = batch, retryFailed = false) => {
    if (!value?.id || starting) return null;
    setStarting(true);
    try {
      const response = await api(`/batches/${encodeURIComponent(value.id)}/analyze`, {
        method: 'POST', body: JSON.stringify({ retry_failed: retryFailed }),
      });
      if (activeId.current === value.id) { setBatch(response.batch); setError(null); }
      return response.batch;
    } catch (failure) {
      notice.current(message(failure));
      return null;
    } finally { setStarting(false); }
  };

  const loadHistory = async () => {
    setHistoryLoading(true); setHistoryError(null);
    try {
      const response = await api('/batches');
      setHistory(response.batches || []);
    } catch (failure) { setHistoryError(message(failure)); }
    finally { setHistoryLoading(false); }
  };

  const download = async () => {
    if (!id || downloading) return;
    setDownloading(true);
    try {
      const response = await fetch(`/api/v1/batches/${encodeURIComponent(id)}/report.xlsx`, { credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('vision:session-expired'));
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || 'Не удалось скачать таблицу. Повторите попытку.');
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const basename = String(batch?.original_name || id).replace(/\.zip$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || id;
      link.href = href; link.download = `Vision-Forte-${basename}.xlsx`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
    } catch (failure) { notice.current(message(failure)); }
    finally { setDownloading(false); }
  };

  return { id, batch, loading, error, starting, downloading, history, historyLoading, historyError, select, start, loadHistory, download };
}

function itemPresentation(item) {
  if (item.status === 'failed') return { tone: 'error', label: 'Результат не получен', Icon: TriangleAlert, description: item.error?.message || item.job?.error?.message || 'Не удалось проверить запись. Отсутствие результата не означает отсутствие нарушений.' };
  if (item.status === 'processing') return { tone: 'processing', label: 'Проверяется', Icon: LoaderCircle, description: 'Модель обрабатывает запись на сервере.' };
  if (item.status !== 'done') return { tone: 'neutral', label: 'В очереди', Icon: Clock3, description: 'Проверка этой записи ещё не завершена.' };
  const result = item.job;
  const events = result?.verdict === 'review_required' ? result.observed_events : result?.violations;
  const explanation = typeof result?.summary === 'string' && result.summary.trim() ? result.summary : events?.[0]?.description;
  if (result?.verdict === 'no_violation') return { tone: 'success', label: 'Не обнаружено', Icon: Check, description: explanation || 'Модель не обнаружила признаков нарушений.', events: [] };
  if (result?.verdict === 'violation') return { tone: 'warning', label: 'Возможное нарушение', Icon: TriangleAlert, description: explanation || 'Модель отметила признаки нарушения. Проверьте события и исходную запись.', events };
  return { tone: 'warning', label: 'Требует просмотра', Icon: CircleHelp, description: explanation || 'Однозначный вывод о нарушениях не сформирован. Требуется просмотр сотрудником.', events };
}

export default function BatchPanel({ manager, selectedVideoId, modelReady, authenticated, onSelect, onConnect, onHistory, onClose, onRetry, disabled = false }) {
  const { batch, loading, error, starting, downloading } = manager;
  const counts = batch?.counts || {};
  const total = Number(counts.total) || 0;
  const done = Number(counts.done) || 0;
  const failed = Number(counts.failed) || 0;
  const complete = done + failed;
  const running = batch?.status === 'processing';
  const retryable = batch?.items?.some(item => item.status === 'failed' && item.video_id);
  return <section className="panel batch-panel" aria-labelledby="batch-results-title">
    <header className="panel-heading batch-heading"><div><Archive size={20}/><h2 id="batch-results-title">Результаты архива</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть список архива" title="Закрыть список. Обработка на сервере продолжится."><X size={18}/></button></header>
    {!batch ? <div className="batch-loading" role="status">{loading ? <><LoaderCircle size={24} className="spin"/>Загружаем сведения об архиве…</> : <><TriangleAlert size={22}/>{error || 'Архив не выбран.'}</>}<button type="button" className="button button-secondary" onClick={onHistory}><FolderOpen size={17}/>История архивов</button></div> : <>
      <div className="batch-overview">
        <strong className="batch-filename" title={batch.original_name}>{batch.original_name}</strong>
        <div className="batch-progress-label"><span>{running ? 'Идёт обработка' : batch.status === 'paused' ? 'Обработка приостановлена' : complete === total ? 'Обработка завершена' : 'Готов к проверке'}</span><strong>{complete} / {total}</strong></div>
        <progress className="batch-progress" max={Math.max(1, total)} value={complete} aria-label={`Обработка архива: завершено ${complete} из ${total}`}/>
        <div className="batch-counts" aria-live="polite"><span><Check size={14}/>{done} с результатом</span>{Number(counts.processing) > 0 && <span><LoaderCircle size={14} className="spin"/>{counts.processing} проверяется</span>}{Number(counts.queued) > 0 && <span><Clock3 size={14}/>{counts.queued} в очереди</span>}{failed > 0 && <span className="text-error"><TriangleAlert size={14}/>{failed} без результата</span>}</div>
        {error && <p className="batch-alert" role="alert">{error} Показаны последние полученные сведения.</p>}
        {!authenticated ? <button className="button button-secondary" onClick={onConnect}><PlugZap size={16}/>Войти в платформу</button> : !modelReady && (running || Number(counts.queued) > 0 || retryable) ? <div className="batch-connection-note"><p>Для продолжения нужен доступный сервер модели. Загруженные записи сохранены.</p><button type="button" className="button button-secondary" onClick={onConnect}><PlugZap size={16}/>Подключить сервер</button></div> : null}
        <div className="batch-actions">
          {!running && Number(counts.queued) > 0 && <button type="button" className="button button-primary" disabled={disabled || starting || !modelReady || !authenticated} onClick={() => manager.start()}>{starting ? <LoaderCircle size={16} className="spin"/> : <Play size={16}/>} {batch.status === 'paused' ? 'Продолжить проверку' : 'Проверить архив'}</button>}
          {!running && retryable && <button type="button" className="button button-secondary" disabled={disabled || starting || !modelReady || !authenticated} onClick={onRetry}><RefreshCw size={16}/>Повторить ошибки</button>}
          <button type="button" className="button button-secondary" disabled={downloading || !authenticated} onClick={manager.download}>{downloading ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>}Скачать Excel</button>
          <button type="button" className="button button-quiet" onClick={onHistory} disabled={disabled}><FolderOpen size={16}/>История</button>
        </div>
        <p className="batch-export-note">{complete < total ? 'Excel содержит текущие результаты и статус каждой незавершённой записи.' : failed ? 'В Excel ошибки отмечены отдельно от выводов модели.' : 'Excel содержит ответ модели по каждой записи и найденные события.'}</p>
        {running && <p className="batch-export-note">Можно перейти к другим записям. Обработка продолжится, пока сервис платформы запущен.</p>}
      </div>
      <div className="batch-file-list" aria-label="Записи в архиве">
        {(batch.items || []).map((item, index) => {
          const presentation = itemPresentation(item), Icon = presentation.Icon;
          return <button key={item.id} type="button" className={`batch-file ${item.video_id === selectedVideoId ? 'selected' : ''}`} disabled={disabled || !item.video_id} onClick={() => onSelect(item.video_id)} aria-pressed={Boolean(item.video_id && item.video_id === selectedVideoId)}>
            <span className="batch-file-top"><span className="batch-file-number">{String(index + 1).padStart(2, '0')}</span><strong title={item.original_name}>{item.original_name}</strong>{item.video_id && <ArrowUpRight size={16}/>}</span>
            <span className={`batch-verdict batch-verdict-${presentation.tone}`}><Icon size={14} className={item.status === 'processing' ? 'spin' : ''}/>{presentation.label}</span>
            <span className="batch-file-description">{presentation.description}</span>
            {presentation.events?.length > 1 && <span className="batch-file-hint">Событий: {presentation.events.length}. Откройте запись, чтобы увидеть все.</span>}
            {item.job?.warnings?.length > 0 && <span className="batch-file-warning">{item.job.warnings.join(' ')}</span>}
            {!item.video_id && <span className="batch-file-hint">Предпросмотр недоступен</span>}
          </button>;
        })}
      </div>
      <p className="batch-decision-note">Модель помогает заметить. Окончательное решение принимает проверяющий.</p>
    </>}
  </section>;
}

export function BatchHistory({ manager, onSelect, onUpload }) {
  return <div className="modal-body batch-history">
    {manager.historyLoading ? <div className="batch-loading"><LoaderCircle size={26} className="spin"/><p>Загружаем архивы…</p></div> : manager.historyError ? <div className="batch-loading"><TriangleAlert size={25}/><p role="alert">{manager.historyError}</p><button className="button button-secondary" onClick={manager.loadHistory}><RefreshCw size={16}/>Повторить</button></div> : manager.history.length ? <><p className="library-intro">Откройте архив, чтобы посмотреть результаты или продолжить проверку.</p><div className="library-list">{manager.history.map(batch => <button key={batch.id} className={`library-item ${manager.id === batch.id ? 'selected' : ''}`} onClick={() => onSelect(batch)}><span className="library-item-icon"><Archive size={21}/></span><span><strong>{batch.original_name}</strong><span>{batch.counts?.total || 0} записей · {batch.counts?.done || 0} с результатом{batch.counts?.failed ? ` · ${batch.counts.failed} без результата` : ''}{batch.created_at && !Number.isNaN(Date.parse(batch.created_at)) ? ` · ${new Date(batch.created_at).toLocaleDateString('ru-RU')}` : ''}</span></span><ArrowUpRight size={18}/></button>)}</div></> : <div className="batch-loading"><Archive size={32}/><h3>Архивов пока нет</h3><p>Загрузите ZIP с видеозаписями операций.</p><button type="button" className="button button-primary" onClick={onUpload}><Archive size={17}/>Загрузить архив</button></div>}
  </div>;
}
