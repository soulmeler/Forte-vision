import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, CalendarDays, ChevronDown, FileText, LoaderCircle, Search, ShieldCheck, X } from 'lucide-react';
import WorkspaceSignal from './WorkspaceSignal.jsx';

const officialUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(adilet\.zan\.kz|nationalbank\.kz|gov\.kz)$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
};
const formatDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00`).toLocaleDateString('ru-RU') : 'не указана';
const shortTitles = {
  V1900019680: 'Кассовые операции и инкассация',
  V2000020075: 'Охрана и устройство кассовых помещений',
  V2600038336: 'Информационная безопасность банков',
  V1700016120: 'Платежность банкнот и монет'
};

export default function RegulatoryLibrary({ reduced = false, onBack }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch('/api/v1/regulatory-sources', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Не удалось получить нормативные источники.');
      const data = await response.json();
      if (data.available === false || !Array.isArray(data.sources)) throw new Error('Каталог источников пока недоступен.');
      setCatalog(data);
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [attempt]);
  const sources = useMemo(() => (catalog?.sources || []).filter(source => [source.title, source.documentNumber, source.scope, source.issuer, ...(source.provisions || []).flatMap(p => [p.reference, p.summary])].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))), [catalog, query]);
  return <section className="regulatory-library" aria-labelledby="regulatory-title">
    <header className="regulatory-heading"><div><p className="eyebrow"><BookOpen size={14}/>ОФИЦИАЛЬНЫЕ ИСТОЧНИКИ</p><h1 id="regulatory-title">Нормативная база</h1><p>Требования Республики Казахстан для проверки кассовых операций. Документы, применимые пункты и границы оценки по видеозаписи.</p></div><WorkspaceSignal variant="document" reduced={reduced}/></header>
    <div className="regulatory-context"><ShieldCheck size={21}/><div><strong>Норма и наблюдение проверяются вместе</strong><p>Ссылка на акт сама по себе не подтверждает нарушение. Учитывайте содержание пункта, условия операции и доступные доказательства.</p></div></div>
    {error ? <div className="regulatory-state" role="alert"><FileText size={28}/><h2>Источники недоступны</h2><p>{error}</p><button className="button button-secondary" onClick={() => setAttempt(n => n + 1)}>Повторить загрузку</button></div> : !catalog ? <div className="regulatory-state" role="status"><LoaderCircle className="spin" size={26}/><p>Загружаем нормативную базу…</p></div> : <>
      <div className="regulatory-toolbar"><label className="regulatory-search"><Search size={18}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название, номер или требование" aria-label="Поиск нормативных источников"/>{query&&<button onClick={()=>setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label><span className="regulatory-count" aria-live="polite">Найдено: {sources.length} из {catalog.sources.length}</span><span className="regulatory-date"><CalendarDays size={15}/>Проверено {formatDate(catalog.checkedAt)}</span></div>
      <div className="regulatory-list">{sources.map((source, index) => <article key={source.id} className="regulatory-card">
        <header><span className="regulatory-index">{String(index + 1).padStart(2,'0')}</span><div><p className="regulatory-issuer">{source.issuer}{source.documentNumber ? ` · № ${source.documentNumber}` : ''}</p><h2>{shortTitles[source.id] || source.title}</h2></div><FileText className="regulatory-card-icon" size={23}/></header>
        <p className="regulatory-scope">{source.scope}</p>
        <div className="regulatory-meta"><span>{source.status || 'Статус уточняется'}</span><span>Принят {formatDate(source.adoptedDate)}</span></div>
        <details className="regulatory-limitations"><summary>Полное наименование акта<ChevronDown size={16}/></summary><p className="regulatory-full-title">{source.title}</p></details>
        {source.provisions?.length > 0 && <details className="regulatory-provisions"><summary><span>Пункты для проверки <small>{source.provisions.length}</small></span><ChevronDown size={17}/></summary><div>{source.provisions.map((provision, i) => <section key={i}><h3>{provision.reference}</h3><p>{provision.summary}</p><div className="regulatory-observability"><span>Что даёт видео</span><p>{provision.videoObservability}</p></div></section>)}</div></details>}
        {source.limitations?.length > 0 && <details className="regulatory-limitations"><summary>Условия применения и ограничения<ChevronDown size={16}/></summary><ul>{source.limitations.map((note,i)=><li key={i}>{note}</li>)}</ul></details>}
        <footer><span>Официальная публикация</span>{officialUrl(source.url) ? <a href={officialUrl(source.url)} target="_blank" rel="noopener noreferrer">Открыть документ<ArrowUpRight size={17}/></a> : <span>Ссылка уточняется</span>}</footer>
      </article>)}</div>
      {!sources.length&&<div className="regulatory-state"><Search size={25}/><h2>Совпадений нет</h2><p>Попробуйте номер постановления или слово «касса».</p><button className="button button-secondary" onClick={()=>setQuery('')}>Показать все источники</button></div>}
      <div className="regulatory-method"><div><span className="eyebrow">ПОРЯДОК ИСПОЛЬЗОВАНИЯ</span><h2>От источника к проверке</h2></div><ol><li><strong>Зафиксировать наблюдение</strong><p>Сохранить описание события, время и кадр из проверяемой записи.</p></li><li><strong>Сопоставить с нормой</strong><p>Проверить точный пункт, редакцию и применимость к операции. Внутренние правила банка не заменяются публичным актом.</p></li><li><strong>Оценить доказательства</strong><p>Если по видео нельзя установить условие нормы, запросить документы или проверку специалиста.</p></li></ol></div>
    </>}
    <div className="regulatory-bottom"><span>Каталог используется для обоснования проверки, а не автоматического юридического заключения.</span><button className="button button-secondary" onClick={onBack}>К проверке видео<ArrowUpRight size={16}/></button></div>
  </section>;
}
