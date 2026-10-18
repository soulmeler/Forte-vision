import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Code2, Copy, Database, FileVideo2, Focus, KeyRound, Layers3, Link2, Play, PlugZap, ScanLine, Server, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import './learning-center.css';

const LESSONS = [
  { short: 'Загрузить', map: 'Файл → платформа', title: 'Начните с одной записи.', text: 'Выберите видео на устройстве или перенесите его в область загрузки. Платформа проверит файл и сохранит отдельную копию для просмотра. На сервер модели видео передаётся только после запуска проверки.', Icon: Upload },
  { short: 'Подключить', map: 'Адрес API и ключ', title: 'Подключите сервер модели.', text: 'Модель работает на отдельном компьютере или сервере Forte с видеокартой. В окне «Сервер модели» укажите адрес API и ключ этого сервера, затем нажмите «Проверить и подключить».', Icon: PlugZap },
  { short: 'Запустить', map: 'Анализ записи', title: 'Проверка начинается по вашей команде.', text: 'Когда сервер модели готов, выберите загруженную запись и нажмите «Проверить видео». Платформа передаст запись на ваш сервер и покажет состояние задачи, а затем результат анализа.', Icon: ScanLine },
  { short: 'Проверить', map: 'Доказательства', title: 'Посмотрите, что стоит за выводом.', text: 'Откройте событие, перейдите к его моменту и рассмотрите кадры. Сопоставьте описание с записью и указанным основанием. Окончательное решение принимает человек.', Icon: Focus },
];

const PRACTICE = [
  { question: 'Модель ещё не подключена. Что можно делать?', options: ['Получить вывод об отсутствии нарушений', 'Загрузить и посмотреть видео', 'Получить результат анализа по имени файла'], correct: 1, explanation: 'Загрузка и просмотр записи доступны до подключения модели. Автоматического вывода пока нет.' },
  { question: 'Когда видео отправляется на сервер модели?', options: ['Сразу после открытия приложения', 'При выборе темы интерфейса', 'После нажатия «Проверить видео»'], correct: 2, explanation: 'Сохранение записи и запуск анализа — отдельные действия. Видео передаётся серверу модели после вашей команды.' },
  { question: 'Что делает «Остановить ожидание»?', options: ['Останавливает ожидание в интерфейсе; задача на сервисе может продолжаться', 'Гарантированно отменяет задачу на сервисе', 'Меняет результат на «Нарушение не обнаружено»'], correct: 0, explanation: 'Это управление ожиданием, а не вердиктом или гарантированной отменой. К записи можно вернуться через список сохранённых видео.' },
];

const UPLOAD_EXAMPLE = `curl --include --request POST 'http://127.0.0.1:3001/api/v1/videos' \\
  --header 'X-API-Key: YOUR_API_KEY' \\
  --form 'file=@./video.mov'`;

const ANALYZE_EXAMPLE = `curl --include --request POST 'http://127.0.0.1:3001/api/v1/videos/VIDEO_ID/analyze' \\
  --header 'X-API-Key: YOUR_API_KEY'`;

const JOB_EXAMPLE = `curl 'http://127.0.0.1:3001/api/v1/jobs/JOB_ID' \\
  --header 'X-API-Key: YOUR_API_KEY'`;

const UPLOAD_RESPONSE = `{
  "video": {
    "id": "VIDEO_ID",
    "original_name": "video.mov"
  }
}`;

function LessonTag({ children, success = false }) {
  return <span className={`lc-tag${success ? ' is-success' : ''}`}>{success ? <Check size={13} /> : <BookOpen size={13} />}{children}</span>;
}

function UploadIllustration() {
  const [point, setPoint] = useState('file');
  return <div className="lc-visual lc-upload-visual">
    <div className="lc-visual-topline"><span>Учебная схема</span><span>01 / 04</span></div>
    <div className="lc-upload-scene" aria-hidden="true">
      <div className="lc-orbit lc-orbit-one" /><div className="lc-orbit lc-orbit-two" />
      <div className={`lc-floating-file${point === 'file' ? ' is-emphasized' : ''}`}><span className="lc-file-fold" /><FileVideo2 size={44} strokeWidth={1.2} /><span>Ваша запись</span><div className="lc-file-lines"><i /><i /></div></div>
      <div className="lc-transfer-path"><i /><i /><i /><ArrowRight size={20} /></div>
      <div className={`lc-service-stack${point === 'service' ? ' is-emphasized' : ''}`}><div /><div /><div><Server size={38} strokeWidth={1.2} /><span>Платформа</span></div></div>
    </div>
    <div className="lc-mini-switch" aria-label="Часть учебной схемы">
      <button type="button" aria-pressed={point === 'file'} onClick={() => setPoint('file')}><FileVideo2 size={16} />Файл на устройстве</button>
      <button type="button" aria-pressed={point === 'service'} onClick={() => setPoint('service')}><Database size={16} />Копия на платформе</button>
    </div>
    <p className="lc-visual-caption" aria-live="polite">{point === 'file' ? 'Исходный файл остаётся на вашем устройстве. Вы сами выбираете запись для загрузки.' : 'Загруженную копию можно открыть из «Записей в сервисе». Удаление этой копии не удаляет исходный файл на устройстве.'}</p>
  </div>;
}

function ConnectionIllustration() {
  const settings = [
    { Icon: Server, title: 'Адрес API', value: 'Ваш сервер' },
    { Icon: KeyRound, title: 'Ключ сервера', value: 'Доступ к модели' },
    { Icon: ShieldCheck, title: 'Проверка связи', value: 'Готовность модели' },
  ];
  return <div className="lc-visual lc-model-visual">
    <div className="lc-visual-topline"><span>Настройка подключения</span><span>02 / 04</span></div>
    <div className="lc-model-core" aria-hidden="true"><div className="lc-core-orbit" /><div className="lc-core-orbit lc-core-orbit-two" /><div className="lc-core-glass"><PlugZap size={44} strokeWidth={1.1} /></div></div>
    <div className="lc-live-gates">{settings.map(({ Icon, title, value }) => <div key={title}><span className="lc-gate-name"><Icon size={17} />{title}</span><span className="lc-gate-state">{value}</span></div>)}</div>
    <p className="lc-visual-caption">Ключ сервера модели вводится в окне подключения. Он хранится в памяти серверной части платформы до её перезапуска; вычисления выполняются на вашем сервере.</p>
  </div>;
}

function ModelIllustration({ serviceAvailable, authenticated, modelReady }) {
  const gates = [
    { Icon: Server, title: 'Платформа', ready: serviceAvailable, yes: 'Доступен', no: serviceAvailable === null ? 'Проверяем связь' : 'Нет связи' },
    { Icon: KeyRound, title: 'Доступ к платформе', ready: authenticated, yes: 'Подтверждён', no: 'Нужно подключение' },
    { Icon: ScanLine, title: 'Сервер модели', ready: modelReady, yes: 'Готов', no: 'Не готов' },
  ];
  const allReady = gates.every(gate => gate.ready);
  return <div className="lc-visual lc-model-visual">
    <div className="lc-visual-topline"><span>Текущее состояние системы</span><span>03 / 04</span></div>
    <div className={`lc-model-core${allReady ? ' is-ready' : ''}`} aria-hidden="true"><div className="lc-core-orbit" /><div className="lc-core-orbit lc-core-orbit-two" /><div className="lc-core-glass"><ScanLine size={44} strokeWidth={1.1} /></div><span className="lc-core-dot" /></div>
    <div className="lc-live-gates">{gates.map(({ Icon, title, ready, yes, no }) => <div key={title}><span className="lc-gate-name"><Icon size={17} />{title}</span><span className={`lc-gate-state${ready ? ' is-ready' : ''}`}>{ready ? <Check size={14} /> : <span className="lc-gate-dot" />}{ready ? yes : no}</span></div>)}</div>
    <p className="lc-visual-caption">{allReady ? 'Все три условия выполнены. Выберите запись в рабочей области, чтобы запустить её проверку.' : 'Доступ к платформе и связь с сервером модели проверяются отдельно. Для анализа нужны доступный API сервера, верный ключ и готовая модель.'}</p>
  </div>;
}

function EvidenceIllustration() {
  const [detail, setDetail] = useState('time');
  const parts = [
    { id: 'time', Icon: Clock3, label: 'Момент', text: 'Таймкод результата переводит плеер к указанному моменту. Посмотрите также контекст до и после события.' },
    { id: 'frame', Icon: Focus, label: 'Кадр', text: 'Откройте кадр крупнее и сравните его с исходной записью. Для события модель возвращает от одного до трёх кадров.' },
    { id: 'rule', Icon: BookOpen, label: 'Основание', text: 'Изучите ссылку, раздел и отметку проверки источника. Если основание не указано, интерфейс не придумывает нормативный документ.' },
  ];
  return <div className="lc-visual lc-evidence-visual">
    <div className="lc-visual-topline"><span>Учебная иллюстрация · не результат</span><span>04 / 04</span></div>
    <div className={`lc-evidence-scene is-${detail}`} aria-hidden="true">
      <div className="lc-mini-video"><div className="lc-scene-grid" /><div className="lc-scene-orb" /><div className="lc-scene-block" /><div className="lc-scene-frame"><i /><i /><i /><i /></div><span className="lc-mini-time">00:12</span><div className="lc-mini-timeline"><i /></div></div>
      <div className="lc-floating-evidence"><Focus size={18} /><span>Кадр события</span><div className="lc-evidence-miniature"><i /><b /></div></div>
      <div className="lc-floating-reference"><BookOpen size={17} /><span>Источник и раздел</span><Link2 size={15} /></div>
    </div>
    <div className="lc-mini-switch lc-evidence-switch" aria-label="Что изучить в результате">{parts.map(({ id, Icon, label }) => <button type="button" key={id} aria-pressed={detail === id} onClick={() => setDetail(id)}><Icon size={16} />{label}</button>)}</div>
    <p className="lc-visual-caption" aria-live="polite">{parts.find(part => part.id === detail).text}</p>
  </div>;
}

function Practice() {
  const [answers, setAnswers] = useState({});
  const answeredCount = Object.keys(answers).length;
  return <details className="lc-disclosure lc-practice">
    <summary><span className="lc-disclosure-icon"><Sparkles size={20} /></span><span><strong>Проверьте себя</strong><span>Три коротких вопроса о работе с записью</span></span><span className="lc-answer-count">{answeredCount} / 3</span><ChevronDown size={19} className="lc-disclosure-chevron" /></summary>
    <div className="lc-practice-body">{PRACTICE.map((question, index) => <fieldset className="lc-question" key={question.question}><legend><span>{String(index + 1).padStart(2, '0')}</span>{question.question}</legend><div className="lc-answer-options">{question.options.map((option, optionIndex) => <label key={option} className={answers[index] === optionIndex ? 'is-selected' : ''}><input type="radio" name={`lc-practice-${index}`} value={optionIndex} checked={answers[index] === optionIndex} onChange={() => setAnswers(previous => ({ ...previous, [index]: optionIndex }))} /><span>{option}</span></label>)}</div>{answers[index] !== undefined && <p className={`lc-answer-feedback${answers[index] === question.correct ? ' is-correct' : ''}`} role="status">{answers[index] === question.correct ? <CheckCircle2 size={18} /> : <CircleHelp size={18} />}<span><strong>{answers[index] === question.correct ? 'Верно. ' : 'Посмотрите на различие. '}</strong>{question.explanation}</span></p>}</fieldset>)}<p className="lc-small-note">Это самопроверка понимания интерфейса. Она не оценивает качество модели и не влияет на ваши записи.</p></div>
  </details>;
}

function Troubleshooting({ formatLabel, maxSizeLabel, onOpenConnection }) {
  const questions = [
    ['Формат не подходит', `Выберите видео в формате ${formatLabel}. Одного переименования расширения недостаточно: сервис проверяет содержимое файла.`, false],
    ['Файл слишком большой', `Размер одной записи — до ${maxSizeLabel}. Подготовьте файл подходящего размера и сохраните исходную запись, чтобы не потерять контекст.`, false],
    ['Видео сохранено, но предпросмотр не работает', 'Браузер может не поддерживать кодек внутри MOV или MP4. Сохранённый файл остаётся в сервисе; недоступность предпросмотра сама по себе не является результатом проверки. Автоматическая конвертация не выполняется.', false],
    ['Нужен доступ к платформе или появилась ошибка 401', 'Сессия платформы могла завершиться или её ключ не подошёл. Откройте подключение и подтвердите доступ к записям. Ключ платформы и API-ключ отдельного сервера модели — разные настройки.', true],
    ['Нет связи с сервером модели', 'Проверьте адрес API, ключ и доступность сервера из сети платформы. Модель должна быть запущена на этом сервере. Откройте подключение и повторите проверку связи. Отсутствие связи не является результатом анализа.', true],
    ['Модель пока не готова', 'В окне «Сервер модели» укажите адрес API и ключ вашего сервера. Веса и вычисления остаются на сервере модели. До его готовности можно сохранять и просматривать видео.', true],
    ['Подключение пропало после перезапуска платформы', 'Адрес и ключ сервера модели хранятся в памяти серверной части платформы и не записываются в браузере. После перезапуска платформы задайте подключение заново.', true],
    ['Проверка завершилась ошибкой или истекло время', 'Лимит времени задаётся настройками платформы и включает ожидание в очереди. Ошибка и тайм-аут не дают вердикта. Откройте запись снова, проверьте состояние сервера модели и повторите запуск, когда он готов.', true],
    ['Что будет после «Остановить ожидание»?', 'Интерфейс перестанет ждать ответ. Задача на сервисе может продолжаться — это не гарантированная отмена. Чтобы увидеть актуальное состояние или сохранённый результат, снова откройте запись из «Записей в сервисе».', false],
  ];
  return <section className="lc-troubleshooting" aria-labelledby="lc-troubleshooting-title"><div className="lc-section-heading"><span className="lc-section-kicker">ЕСЛИ ЧТО-ТО НЕ ПОЛУЧИЛОСЬ</span><h3 id="lc-troubleshooting-title">Ответ рядом.</h3><p>Выберите ситуацию — и следующий шаг станет понятнее.</p></div><div className="lc-faq-grid">{questions.map(([title, text, connection]) => <details className="lc-faq" key={title}><summary><span>{title}</span><ChevronDown size={18} /></summary><div><p>{text}</p>{connection && <button type="button" className="lc-text-button" onClick={onOpenConnection}>Открыть подключение<ArrowRight size={16} /></button>}</div></details>)}</div></section>;
}

function ApiExample({ code, label }) {
  const [copyState, setCopyState] = useState('idle');
  const feedbackId = useId();
  const copyExample = async () => {
    setCopyState('copying');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };
  return <div className="lc-api-example"><div className="lc-api-example-toolbar"><span>Терминал · curl</span><button type="button" className="lc-api-copy" onClick={copyExample} disabled={copyState === 'copying'} aria-label={`Копировать пример: ${label}`} aria-describedby={feedbackId}>{copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}{copyState === 'copying' ? 'Копируем…' : copyState === 'copied' ? 'Скопировано' : 'Копировать пример'}</button></div><pre tabIndex={0} aria-label={label}><code>{code}</code></pre><p id={feedbackId} className={`lc-api-copy-feedback${copyState === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">{copyState === 'copied' ? 'Пример в буфере обмена. Запрос не выполнялся.' : copyState === 'error' ? 'Браузер не разрешил копирование. Выделите код и скопируйте его вручную.' : copyState === 'copying' ? 'Копируем текст примера…' : 'Копируется только пример с заглушкой ключа.'}</p></div>;
}

function ApiGuide() {
  return <details className="lc-disclosure lc-api"><summary><span className="lc-disclosure-icon"><Code2 size={20} /></span><span><strong>API платформы и сервера модели</strong><span>Маршруты, доступ и жизненный цикл задачи</span></span><ChevronDown size={19} className="lc-disclosure-chevron" /></summary><div className="lc-api-body">
    <p>Модель работает отдельно: откройте «Сервер модели» и укажите адрес API, например <code>http://192.168.1.10:8000/api/v1</code>, и ключ этого сервера. Платформа обращается к нему через свою серверную часть. Видео отправляется только по команде «Проверить видео».</p>
    <p>Подготовленное подключение ожидает <code>GET /health</code>, <code>POST /analyze</code> с файлом и <code>GET /jobs/:id</code>. Схема собственного API команды ещё не получена: после её передачи подключение нужно согласовать с фактическими маршрутами и форматом результата.</p>
    <p>Примеры ниже обращаются к API самой платформы по адресу <code>http://127.0.0.1:3001</code>. Если у вас другой адрес или порт, замените его. Запросы выполняются только в вашем терминале — инструкция ничего не отправляет.</p>
    <section className="lc-api-step"><div className="lc-api-step-heading"><span>01</span><h4>Загрузите и сохраните видео</h4></div><p>Замените <code>YOUR_API_KEY</code> значением <code>FORTE_API_KEY</code> из файла <code>platform/.env</code>. Это ключ платформы, а не ключ сервера модели. Замените <code>./video.mov</code> путём к вашему MOV или MP4. В примере ключ намеренно не указан. Поле <code>file</code> передаёт один файл; <code>curl</code> сам создаёт multipart-запрос.</p><ApiExample code={UPLOAD_EXAMPLE} label="Загрузка видео на платформу" /><div className="lc-api-response"><div className="lc-api-response-heading"><span>201 Created</span><strong>Ожидаемый ответ, сокращённо</strong></div><pre tabIndex={0} aria-label="Пример успешного ответа загрузки"><code>{UPLOAD_RESPONSE}</code></pre><p>Сохраните реальное значение <code>video.id</code> из ответа для следующего шага. Модель на этом шаге не запускается.</p></div></section>
    <section className="lc-api-step"><div className="lc-api-step-heading"><span>02</span><h4>Отдельно запустите готовую модель</h4></div><p>Подставьте полученный <code>video.id</code> вместо <code>VIDEO_ID</code>. Сначала подключите сервер модели через окно подключения. Готовность можно проверить через <code>GET /api/v1/health</code> платформы: для запуска нужно <code>model.ready: true</code>.</p><ApiExample code={ANALYZE_EXAMPLE} label="Запуск модели для сохранённого видео" /><p className="lc-api-outcome"><strong>Ответ: <code>202 Accepted</code> и <code>job_id</code>.</strong> Это принятая задача, а не готовый результат. Пока модель не готова, сервис отвечает <code>503 MODEL_NOT_READY</code>.</p></section>
    <section className="lc-api-step"><div className="lc-api-step-heading"><span>03</span><h4>Получите состояние задачи</h4></div><p>Замените <code>JOB_ID</code> значением <code>job_id</code> из ответа запуска. Запрос можно повторить, пока задача выполняется.</p><ApiExample code={JOB_EXAMPLE} label="Получение состояния задачи" /><div className="lc-api-job-states"><div><code>processing</code><span>В очереди или выполняется</span></div><div><code>done</code><span>Результат готов</span></div><div><code>failed</code><span>Ошибка, вердикта нет</span></div></div></section>
    <div className="lc-api-callout"><PlugZap size={20} /><div><strong>Совместимый маршрут из кейса</strong><p><code>POST /api/v1/analyze</code> принимает видео в поле <code>file</code> и ключ в <code>X-API-Key</code>, затем возвращает задачу. Если модель не готова, ответ — <code>503 MODEL_NOT_READY</code>. Он не запускает демонстрационный сценарий.</p></div></div>
    <div className="lc-api-results"><div><h4>Когда задача готова</h4><p>При <code>verdict=review_required</code> действия находятся в <code>observed_events</code>, а <code>violations</code> пуст. Это не заключение о нарушениях. Сервер модели может вернуть <code>violation</code> или <code>no_violation</code>. Список <code>violations</code> содержит тип, описание, время, кадры и доступные ссылки <code>rule_refs</code>. Читайте также <code>warnings</code> — ограничения проверки.</p></div><div><h4>Когда задача не завершилась</h4><p><code>processing</code> означает очередь или анализ. <code>failed</code> содержит <code>error.code</code> и <code>error.message</code>. Никакое из этих состояний не означает отсутствие нарушений.</p></div></div>
    <p className="lc-api-access-note">Состояние и ограничения доступны без ключа: <code>GET /api/v1/health</code> и <code>GET /api/v1/capabilities</code>. Видео и задачи требуют <code>X-API-Key</code> либо сессионную cookie после <code>POST /api/v1/session</code>. Эти маршруты используют ключ платформы. Отдельный ключ сервера модели хранится только в памяти серверной части до её перезапуска; он не возвращается интерфейсу и не сохраняется в localStorage.</p>
  </div></details>;
}

export default function LearningCenter({ reduced = false, modelReady = false, authenticated = false, serviceAvailable = null, canUpload = true, formatLabel = 'MOV / MP4', maxSizeLabel = '300 МБ', onChooseVideo = () => {}, onOpenDemo = () => {}, onOpenConnection = () => {}, onBack = () => {}, onComplete = () => {} }) {
  const prefersReduced = useReducedMotion();
  const motionReduced = reduced || prefersReduced;
  const rootRef = useRef(null);
  const tabsRef = useRef([]);
  const stepsRef = useRef(null);
  const inView = useInView(rootRef, { amount: 0.05 });
  const id = useId();
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState([0]);
  const [completed, setCompleted] = useState(false);
  const allVisited = visited.length === LESSONS.length;
  const currentLesson = LESSONS[step];
  const selectStep = (index, moveFocus = false) => {
    setStep(index);
    setVisited(previous => previous.includes(index) ? previous : [...previous, index]);
    if (moveFocus) tabsRef.current[index]?.focus({preventScroll:true});
    if(index!==step) window.requestAnimationFrame(()=>stepsRef.current?.scrollIntoView({block:'start',behavior:motionReduced?'instant':'smooth'}));
  };
  const onTabKey = (event, index) => {
    const targets = { ArrowRight: (index + 1) % LESSONS.length, ArrowLeft: (index + LESSONS.length - 1) % LESSONS.length, Home: 0, End: LESSONS.length - 1 };
    if (event.key in targets) { event.preventDefault(); selectStep(targets[event.key], true); }
  };
  const complete = () => {
    if (!allVisited || completed) return;
    setCompleted(true);
    onComplete();
  };
  const lessonDetails = [
    <><div className="lc-lesson-fact"><FileVideo2 size={19} /><span><strong>{formatLabel}</strong><span>Одна запись, до {maxSizeLabel}</span></span></div><ul className="lc-lesson-points"><li>Во время передачи показан реальный объём загрузки. Затем платформа проверяет и сохраняет файл.</li><li>После загрузки запись доступна в плеере и в списке «Записи в сервисе».</li><li>Демо можно открыть отдельно: его учебные события не относятся к вашему видео.</li></ul><button type="button" className="lc-button lc-button-primary" onClick={onChooseVideo} disabled={!canUpload}><Upload size={18} />{canUpload ? 'Выбрать видео' : 'Проверяем доступ…'}<ArrowRight size={17} /></button></>,
    <><div className="lc-lesson-fact"><KeyRound size={20} /><span><strong>Адрес и ключ вашего сервера</strong><span>Настройки доступа к модели задаются отдельно</span></span></div><ul className="lc-lesson-points"><li>Используйте адрес API, доступный из сети платформы, и ключ, выданный сервером модели.</li><li>«Проверить и подключить» проверяет связь и заявленную сервером готовность модели.</li><li>После перезапуска платформы адрес и ключ нужно указать заново.</li></ul><button type="button" className="lc-button lc-button-primary" onClick={onOpenConnection}><PlugZap size={18} />Настроить подключение<ArrowRight size={17} /></button></>,
    <><div className="lc-lesson-fact"><ScanLine size={20} /><span><strong>{modelReady ? 'Сервер сообщает о готовности модели' : 'Сервер модели пока не готов'}</strong><span>{modelReady ? 'Для запуска также нужны доступ и выбранное видео' : 'Это не мешает загрузке и просмотру видео'}</span></span></div><ul className="lc-lesson-points"><li>Подключите сервер по адресу API и ключу. Веса модели и вычисления остаются на сервере.</li><li>После запуска платформа передаёт видео на этот сервер и показывает статус задачи.</li><li>Ошибка, ожидание и отсутствие подключённой модели не являются вердиктом.</li></ul><button type="button" className="lc-button lc-button-primary" onClick={onOpenConnection}><PlugZap size={18} />Проверить подключение<ArrowRight size={17} /></button></>,
    <><div className="lc-lesson-fact"><Focus size={20} /><span><strong>Наблюдение → контекст → решение</strong><span>Описание, момент и кадры читаются вместе</span></span></div><ul className="lc-lesson-points"><li>Клик по таймкоду открывает момент события, а по кадру — увеличенный просмотр.</li><li>Проверьте ограничения результата и ссылки на документы, если модель их вернула.</li><li>«Нарушение не обнаружено» относится к проведённой проверке. Учитывайте указанные ограничения и качество записи.</li></ul><button type="button" className="lc-button lc-button-primary" onClick={onOpenDemo}><Play size={17} />Разобрать учебный пример<ArrowRight size={17} /></button></>,
  ];
  return <section ref={rootRef} className={`learning-center${motionReduced ? ' lc-reduced' : ''}`} data-animate={inView && !motionReduced ? 'true' : 'false'} aria-label="Обучение работе с видео">
    <div className="lc-intro"><div><span className="lc-section-kicker"><BookOpen size={15} />ЧЕТЫРЕ ПОНЯТНЫХ ШАГА</span><h1 className="type-headline">Порядок работы с видео</h1><p>Познакомьтесь с рабочим процессом. Каждый шаг можно открыть отдельно и сразу попробовать в приложении.</p></div><div className="lc-intro-progress"><div className="lc-progress-ring" style={{ '--lc-progress': `${visited.length * 25}%` }} aria-hidden="true"><span>{completed ? <Check size={23} /> : <>{visited.length}<small>/ 4</small></>}</span></div><div><strong>{completed ? 'Знакомство завершено' : `Просмотрено ${visited.length} из 4`}</strong><span>{completed ? 'К инструкции можно вернуться' : 'В удобном для вас порядке'}</span></div></div></div>

    <div ref={stepsRef} className="lc-steps" role="tablist" aria-label="Шаги работы с видео">{LESSONS.map(({ short, map, Icon }, index) => <button type="button" key={short} ref={element => { tabsRef.current[index] = element; }} role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={step === index} tabIndex={step === index ? 0 : -1} className={`lc-step${step === index ? ' is-active' : ''}`} onClick={() => selectStep(index)} onKeyDown={event => onTabKey(event, index)}><span className="lc-step-number">{visited.includes(index) && index !== step ? <Check size={16} /> : String(index + 1).padStart(2, '0')}</span><span className="lc-step-copy"><strong>{short}</strong><span>{map}</span></span><Icon size={22} strokeWidth={1.5} />{step === index && <motion.span className="lc-step-indicator" layoutId={`${id}-active`} transition={{ duration: motionReduced ? 0 : 0.25 }} />}</button>)}</div>

    <div className="lc-lesson-shell"><AnimatePresence mode="wait" initial={false}><motion.div key={step} id={`${id}-panel-${step}`} role="tabpanel" aria-labelledby={`${id}-tab-${step}`} className="lc-lesson" initial={motionReduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: motionReduced ? 0 : -7 }} transition={{ duration: motionReduced ? 0 : 0.2 }}><div className="lc-lesson-copy"><LessonTag>Шаг {step + 1} из 4</LessonTag><h2>{currentLesson.title}</h2><p className="lc-lesson-lead">{currentLesson.text}</p>{lessonDetails[step]}</div>{step === 0 ? <UploadIllustration /> : step === 1 ? <ConnectionIllustration /> : step === 2 ? <ModelIllustration serviceAvailable={serviceAvailable} authenticated={authenticated} modelReady={modelReady} /> : <EvidenceIllustration />}</motion.div></AnimatePresence><div className="lc-lesson-navigation"><button type="button" className="lc-button lc-button-quiet" disabled={step === 0} onClick={() => selectStep(step - 1,true)}><ArrowLeft size={17} />Назад</button><span className="lc-navigation-count" aria-live="polite">{step + 1}<span> / 4</span></span>{step < LESSONS.length - 1 ? <button type="button" className="lc-button lc-button-quiet" onClick={() => selectStep(step + 1,true)}>Следующий шаг<ArrowRight size={17} /></button> : allVisited ? <button type="button" className="lc-button lc-button-primary" disabled={completed} onClick={complete}>{completed ? <CheckCircle2 size={17} /> : null}{completed ? 'Обучение завершено' : 'Завершить обучение'}{!completed && <Check size={17} />}</button> : <button type="button" className="lc-button lc-button-quiet" onClick={() => selectStep(LESSONS.findIndex((_, index) => !visited.includes(index)), true)}>Посмотреть оставшийся шаг<ArrowRight size={17} /></button>}</div></div>

    {completed && <motion.div className="lc-completed" role="status" initial={motionReduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><CheckCircle2 size={23} /><div><strong>Вы прошли все четыре шага.</strong><p>Теперь можно выбрать видео или спокойно исследовать учебный пример.</p></div><button type="button" className="lc-button lc-button-quiet" onClick={onBack}>К рабочей области<ArrowRight size={17} /></button></motion.div>}

    <div className="lc-key-notes"><div><span className="lc-note-icon"><Layers3 size={20} /></span><div><strong>Демо обозначено отдельно</strong><p>Учебный пример помогает освоить интерфейс. Результат проверки вашей записи появляется после анализа на сервере модели.</p></div></div><div><span className="lc-note-icon"><ShieldCheck size={20} /></span><div><strong>Качество проверяется отдельно</strong><p>Готовность модели к запуску не подтверждает её точность. Для этого нужна отдельная оценка на проверочных данных.</p></div></div></div>
    <Practice />
    <Troubleshooting formatLabel={formatLabel} maxSizeLabel={maxSizeLabel} onOpenConnection={onOpenConnection} />
    <ApiGuide />
    <div className="lc-bottom-cta"><div><span className="lc-section-kicker">МОЖНО НАЧИНАТЬ</span><h3>Следующий шаг — ваша запись.</h3><p>Или откройте демо, чтобы сначала освоиться с интерфейсом.</p></div><div><button type="button" className="lc-button lc-button-primary" onClick={onChooseVideo} disabled={!canUpload}><Upload size={18} />{canUpload ? 'Выбрать видео' : 'Проверяем доступ…'}</button><button type="button" className="lc-button lc-button-quiet" onClick={onOpenDemo}><Play size={17} />Открыть демо</button></div></div>
  </section>;
}
