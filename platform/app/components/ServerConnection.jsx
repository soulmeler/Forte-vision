import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Globe, LoaderCircle, LockKeyhole, PlugZap, RefreshCw, Server, Unplug } from 'lucide-react';

export default function ServerConnection({ api, onStatusChange, onClose }) {
  const [connection, setConnection] = useState(null);
  const [model, setModel] = useState(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const applyStatus = data => {
    setConnection(data.connection);
    setModel(data.model);
    setError(data.connection?.error?.message || null);
  };

  useEffect(() => {
    let current = true;
    api('/model/connection').then(data => {
      if (!current) return;
      applyStatus(data);
      setBaseUrl(data.connection?.base_url || '');
    }).catch(error => { if (current) setError(error.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api]);

  async function connect(event) {
    event.preventDefault();
    setBusy('connect'); setError(null); setMessage(null);
    const key = apiKey; setApiKey('');
    try {
      const data = await api('/model/connection', { method: 'PUT', body: JSON.stringify({ base_url: baseUrl.trim(), api_key: key }) });
      applyStatus(data); setBaseUrl(data.connection.base_url);
      setMessage(data.model.ready ? 'Сервер модели готов к анализу видео.' : 'Адрес подключён. Ожидаем готовности модели на сервере.');
      await onStatusChange();
    } catch (error) { setError(error.message); }
    finally { setBusy(null); }
  }

  async function updateConnection(action) {
    setBusy(action); setError(null); setMessage(null);
    try {
      const data = await api(`/model/connection${action === 'check' ? '/check' : ''}`, { method: action === 'check' ? 'POST' : 'DELETE' });
      applyStatus(data);
      if (action === 'disconnect') { setApiKey(''); setBaseUrl(''); setMessage('Соединение отключено. Ключ удалён из памяти платформы.'); }
      else if (!data.connection.error) setMessage(data.model.ready ? 'Связь подтверждена. Модель готова к анализу.' : 'Сервер отвечает, но модель ещё не готова.');
      await onStatusChange();
    } catch (error) { setError(error.message); }
    finally { setBusy(null); }
  }

  const status = loading ? 'Проверяем' : !connection?.configured ? 'Не подключён' : model?.ready ? 'Готов к анализу' : model?.status === 'loading' ? 'Модель загружается' : connection?.error ? 'Ошибка подключения' : 'Модель не готова';
  return <>
    <div className="modal-body server-connection-body">
      <div className="connection-overview">
        <div className="connection-visual"><Server size={27}/></div>
        <div><strong>Модель работает на вашем сервере</strong><p>Сейчас это может быть компьютер команды, затем — сервер Forte с GPU. Платформа отправляет видео на этот сервер при запуске проверки.</p></div>
      </div>
      <div className="server-connection-route" aria-label="Платформа обращается к серверу модели по API"><span>Платформа</span><ArrowRight size={14}/><span>API</span><ArrowRight size={14}/><span>Сервер с GPU</span></div>
      <div className="connection-rows" aria-live="polite">
        <div><span>Сервер модели</span><strong className={model?.ready ? 'text-success' : connection?.error ? 'text-error' : ''}>{status}</strong></div>
        {model?.name && <div><span>Модель</span><strong>{model.name}{model.version ? ` · ${model.version}` : ''}</strong></div>}
        {connection?.base_url && <div><span>Подключённый API</span><strong className="server-address">{connection.base_url}</strong></div>}
      </div>
      <form onSubmit={connect} className="connection-form server-connection-form">
        <label htmlFor="model-server-url">Адрес API сервера модели</label>
        <div className="input-with-icon"><Globe size={18}/><input id="model-server-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-server.example/v1/analyze-video" autoComplete="off" spellCheck={false} required disabled={loading || Boolean(busy)} aria-describedby="model-url-hint"/></div>
        <p id="model-url-hint" className="field-hint">Для API команды вставьте полный адрес, заканчивающийся на /v1/analyze-video. Подойдёт HTTPS-ссылка вашего туннеля.</p>
        <label htmlFor="model-server-key">API-ключ сервера модели</label>
        <div className="input-with-icon"><LockKeyhole size={18}/><input id="model-server-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={connection?.key_present ? 'Введите ключ для нового подключения' : 'Введите ключ сервера'} autoComplete="off" spellCheck={false} required disabled={loading || Boolean(busy)} aria-describedby="model-key-hint"/></div>
        <p id="model-key-hint" className="field-hint">Ключ хранится только в памяти сервиса платформы. После его перезапуска адрес и ключ нужно ввести заново.</p>
        {error && <p className="field-error" role="alert">{error}</p>}
        {message && !error && <p className="server-connection-message" role="status"><Check size={16}/>{message}</p>}
        <button className="button button-primary full-width" type="submit" disabled={loading || Boolean(busy) || !baseUrl.trim() || !apiKey.trim()}>{busy === 'connect' ? <LoaderCircle size={17} className="spin"/> : <PlugZap size={17}/>}Проверить и подключить</button>
      </form>
      {connection?.configured && <div className="server-connection-actions"><button className="button button-quiet" disabled={Boolean(busy)} onClick={() => updateConnection('check')}>{busy === 'check' ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>}Проверить связь</button><button className="button button-quiet" disabled={Boolean(busy)} onClick={() => updateConnection('disconnect')}>{busy === 'disconnect' ? <LoaderCircle size={16} className="spin"/> : <Unplug size={16}/>}Отключить</button></div>}
    </div>
    <footer className="modal-footer"><button className="button button-secondary" onClick={onClose}>Готово</button></footer>
  </>;
}
