import React from 'react';
import { Check, FileVideo, MonitorPlay, Server } from 'lucide-react';
import './upload-journey.css';

export default function UploadJourney({ phase, reduced }) {
  const verifying = phase === 'verifying';
  return <div className={`upload-journey ${verifying ? 'is-verifying' : 'is-transferring'}`} data-reduced={reduced} aria-hidden="true">
    <div className={`upload-journey-node ${verifying ? 'is-done' : 'is-current'}`}>
      <span className="upload-journey-symbol"><FileVideo size={18}/>{verifying && <i><Check size={9}/></i>}</span>
      <strong>Ваш файл</strong><small>{verifying ? 'Передан' : 'Передаём'}</small>
    </div>
    <div className="upload-journey-connector first"><span/><span/><span/></div>
    <div className={`upload-journey-node ${verifying ? 'is-current' : ''}`}>
      <span className="upload-journey-symbol"><Server size={18}/><b/></span>
      <strong>Ваш сервис</strong><small>{verifying ? 'Проверяем' : 'Получает'}</small>
    </div>
    <div className="upload-journey-connector second"><span/><span/><span/></div>
    <div className="upload-journey-node">
      <span className="upload-journey-symbol"><MonitorPlay size={18}/></span>
      <strong>Просмотр</strong><small>Следующий шаг</small>
    </div>
  </div>;
}
