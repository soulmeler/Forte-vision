import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import LearningCenter from './components/LearningCenter.jsx';
import ServerConnection from './components/ServerConnection.jsx';
import BatchPanel, { BatchHistory, useBatchManager } from './components/BatchPanel.jsx';
import { isCompletedResult, resultEvents } from './results.js';
import RegulatoryLibrary from './components/RegulatoryLibrary.jsx';
import WorkspaceSignal from './components/WorkspaceSignal.jsx';
import SiteEntrance, { useSiteEntrance } from './components/SiteEntrance.jsx';
import UploadJourney from './components/UploadJourney.jsx';
import usePointerFeedback from './hooks/usePointerFeedback.js';
import { Archive, BookOpen, Plus, ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, CloudUpload, Expand, FileText, Film, FolderOpen, HardDrive, Layers3, LoaderCircle, LockKeyhole, Menu, Pause, Play, PlugZap, RefreshCw, ScanLine, ShieldCheck, Sparkles, Trash2, TriangleAlert, Video, VolumeX, X } from 'lucide-react';

const LazyUploadSculpture=React.lazy(()=>import('./components/UploadSculpture.jsx'));
function UploadSculpture(props){return <React.Suspense fallback={<div className="sculpture-loading" aria-hidden="true"><LoaderCircle size={26} className="spin"/></div>}><LazyUploadSculpture {...props}/></React.Suspense>;}

const STORAGE = { theme: 'vision-forte.theme.v2', video: 'vision-forte.video.v2' };
const THEMES = [{ id:'light', name:'Светлая', color:'#A31551', bg:'#fff' },{ id:'night', name:'Ночная', color:'#61CFFF', bg:'#160b17' },{ id:'sky', name:'Небо', color:'#61CFFF', bg:'#e8f7fd' },{ id:'coral', name:'Коралл', color:'#FC9385', bg:'#fff2ed' },{ id:'magenta', name:'Маджента', color:'#FC9385', bg:'#4A0221' }];
const DEMO_EVENTS = [{ type:'Объект пересёк линию', timecode_sec:12, description:'Объект A переместился между двумя условными зонами. Этот синтетический пример показывает связь события с временной отметкой и кадром.', evidence_frames:[{timestamp_sec:12},{timestamp_sec:13},{timestamp_sec:14}] },{ type:'Изменилось положение объекта', timecode_sec:31, description:'Объект B изменил положение в условной зоне. Второе событие демонстрирует навигацию между несколькими эпизодами в одной записи.', evidence_frames:[{timestamp_sec:31},{timestamp_sec:32}] }];
const MAX_BYTES=300_000_000;
const viewFromHash=()=>window.location.hash==='#instructions'?'instructions':window.location.hash==='#regulations'?'regulations':'workspace';
const time = value => value==null||!Number.isFinite(Number(value))?'Не указано':`${Math.floor(Number(value)/60).toString().padStart(2,'0')}:${Math.floor(Number(value)%60).toString().padStart(2,'0')}`;
const bytes = value => `${(Number(value||0)/1_000_000).toLocaleString('ru-RU',{maximumFractionDigits:1})} МБ`;
const stored = (key,fallback) => {try{return localStorage.getItem(key)||fallback;}catch{return fallback;}};
const remember=(key,value)=>{try{value==null?localStorage.removeItem(key):localStorage.setItem(key,value);}catch{}};
const errorText = error => error?.message||'Не удалось выполнить действие. Повторите попытку.';

async function api(path, options={}) {
  const response=await fetch(`/api/v1${path}`,{credentials:'same-origin',...options,headers:{...(options.body&&typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...options.headers}});
  const data=response.status===204?null:await response.json().catch(()=>null);
  if(!response.ok){if(response.status===401)window.dispatchEvent(new Event('vision:session-expired'));const message=typeof data?.error==='string'?data.error:data?.error?.message||data?.message||data?.detail||`Сервис вернул ошибку ${response.status}.`;const error=new Error(typeof message==='string'?message:'Не удалось выполнить запрос.');error.status=response.status;error.code=data?.error?.code||data?.code;throw error;}
  return data;
}
function frameSource(frame){const image=frame?.image_base64;if(typeof image!=='string')return null;if(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image))return image;if(/^[A-Za-z0-9+/=\s]+$/.test(image))return `data:image/jpeg;base64,${image}`;return null;}

function Badge({children,tone='neutral',icon:Icon}){return <span className={`badge badge-${tone}`}>{Icon&&<Icon size={14}/>} {children}</span>;}
function Button({children,variant='secondary',className='',busy=false,...props}){return <motion.button whileTap={{scale:.98}} className={`button button-${variant} ${className}`} {...props}>{busy&&<LoaderCircle size={17} className="spin"/>}{children}</motion.button>;}

function ThemePicker({theme,onChange,reduced}){
 const [open,setOpen]=useState(false),triggerRef=useRef(null),panelId=useId();
 const current=THEMES.find(item=>item.id===theme);
 const close=()=>{setOpen(false);triggerRef.current?.focus();};
 return <div className="theme-disclosure" onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
   <motion.div id={panelId} className="theme-reveal" aria-hidden={!open} inert={open?undefined:true} initial={false} animate={{height:open?'auto':0,opacity:open?1:0,y:open?0:8}} transition={{duration:reduced?0:.24,ease:[.22,1,.36,1]}}>
    <div className="theme-options"><div className="theme-swatches" role="group" aria-label="Цветовая тема">{THEMES.map(item=><button key={item.id} type="button" className={`theme-swatch ${theme===item.id?'selected':''}`} style={{'--swatch-bg':item.bg,'--swatch-color':item.color}} onClick={()=>{onChange(item.id);close();}} aria-label={`Тема: ${item.name}`} aria-pressed={theme===item.id} title={item.name}><span>{theme===item.id&&<Check size={15}/>}</span></button>)}</div></div>
   </motion.div>
  <button ref={triggerRef} type="button" className="theme-toggle" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>
   <span className="theme-current" style={{'--swatch-bg':current.bg,'--swatch-color':current.color}} aria-hidden="true"/>
   <span className="theme-toggle-copy"><strong>Палитра Forte</strong><small>{current.name}</small></span>
   <motion.span className="theme-toggle-chevron" aria-hidden="true" animate={{rotate:open?0:180}} transition={{duration:reduced?0:.2}}><ChevronDown size={15}/></motion.span>
  </button>
 </div>;
}

function Modal({title,eyebrow,children,onClose,wide=false}){
 const ref=useRef(null),previous=useRef(document.activeElement),closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{const el=ref.current;(el?.querySelector('[data-autofocus]')||el?.querySelector('input,button'))?.focus();const listener=e=>{if(e.key==='Escape'){e.preventDefault();closeRef.current();}if(e.key==='Tab'){const focusable=[...el.querySelectorAll('button:not([disabled]),input:not([disabled]),select,a[href],[tabindex="0"]')];const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',listener);const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',listener);document.body.style.overflow=overflow;previous.current?.isConnected&&previous.current.focus();};},[]);
 return <motion.div className="modal-backdrop" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><motion.section ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title" className={`modal ${wide?'modal-wide':''}`} initial={{opacity:0,y:24,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:12,scale:.98}} transition={{duration:.24}}><header className="modal-header"><div>{eyebrow&&<p className="eyebrow">{eyebrow}</p>}<h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть окно"><X size={21}/></button></header>{children}</motion.section></motion.div>;
}

function SyntheticScene({at=0,mini=false}){
 const gridId=useId().replaceAll(':','');
 const crossed=at>=12,moved=at>=31;
 return <div className={`synthetic ${mini?'synthetic-mini':''}`} role="img" aria-label={`Синтетическая схема, ${time(at)}`}><svg viewBox="0 0 290 530" aria-hidden="true"><defs><pattern id={gridId} width="29" height="29" patternUnits="userSpaceOnUse"><path d="M29 0H0v29" fill="none" stroke="#c8d4d9" strokeWidth=".5"/></pattern></defs><rect width="290" height="530" fill="#e3edf0"/><rect width="290" height="530" fill={`url(#${gridId})`}/><rect x="24" y="63" width="242" height="404" rx="10" fill="#d4e1e5" fillOpacity=".65" stroke="#afc1c9"/><rect x="42" y="87" width="206" height="138" rx="7" fill="#a3c5d3" fillOpacity=".45"/><rect x="42" y="244" width="206" height="201" rx="7" fill="#9aabab" fillOpacity=".2"/><path d="M30 235h230" stroke="#a31551" strokeWidth="1.8" strokeDasharray="6 5"/><text x="53" y="109" fill="#426372" fontFamily="sans-serif" fontSize="8" letterSpacing="1.4">ЗОНА 01</text><text x="53" y="266" fill="#426372" fontFamily="sans-serif" fontSize="8" letterSpacing="1.4">ЗОНА 02</text><g transform={`translate(${crossed?74:160} ${crossed?285:150})`}><rect width="46" height="46" rx="10" fill="#a31551"/><rect x="5" y="5" width="36" height="36" rx="7" fill="none" stroke="#fc9385" strokeOpacity=".45"/><text x="23" y="29" textAnchor="middle" fontFamily="sans-serif" fontWeight="600" fontSize="14" fill="white">A</text></g><g transform={`translate(${moved?165:159} ${moved?370:332}) rotate(${moved?19:0} 20 20)`}><rect width="40" height="40" rx="8" fill="#527b8c"/><text x="20" y="25" textAnchor="middle" fontFamily="sans-serif" fontSize="13" fill="white">B</text></g><path d="M15 48v-9h9m242 0h9v9M15 482v9h9m242 0h9v-9" fill="none" stroke="#68818c"/><text x="24" y="30" fontFamily="sans-serif" fontSize="8" fontWeight="600" letterSpacing="1.2" fill="#52717e">СИНТЕТИЧЕСКИЙ ПРИМЕР</text><text x="266" y="515" textAnchor="end" fontFamily="monospace" fontSize="10" fill="#52717e">{time(at)}</text></svg>{!mini&&<div className="synthetic-note"><span>ДЕМО</span>Не запись пользователя</div>}</div>;
}

export default function App(){
 const systemReduced=useReducedMotion();
 const [theme,setTheme]=useState(()=>THEMES.some(t=>t.id===stored(STORAGE.theme,'light'))?stored(STORAGE.theme,'light'):'light');
 const reduced=Boolean(systemReduced);
 usePointerFeedback({reduced});
 const entering=useSiteEntrance(reduced);
 const [view,setView]=useState(viewFromHash);
 const [mode,setMode]=useState('local'),[mobileNav,setMobileNav]=useState(false);
 const [health,setHealth]=useState(null),[capabilities,setCapabilities]=useState(null),[session,setSession]=useState({loading:true,authenticated:false}),[serviceError,setServiceError]=useState(null);
 const [selected,setSelected]=useState(null),[restoring,setRestoring]=useState(false),[previewError,setPreviewError]=useState(false),[duration,setDuration]=useState(null);
 const [upload,setUpload]=useState(null),[dragging,setDragging]=useState(false),[pendingFile,setPendingFile]=useState(null);
 const [archiveFile,setArchiveFile]=useState(null);
 const [job,setJob]=useState(null),[result,setResult]=useState(null),[resultState,setResultState]=useState('idle'),[jobError,setJobError]=useState(null),[jobStage,setJobStage]=useState('queued'),[elapsed,setElapsed]=useState(0),[selectedEvent,setSelectedEvent]=useState(0);
 const [demoState,setDemoState]=useState('events'),[demoAt,setDemoAt]=useState(12),[demoPlaying,setDemoPlaying]=useState(false),[demoStage,setDemoStage]=useState(0),[demoElapsed,setDemoElapsed]=useState(0);
 const [modal,setModal]=useState(null),[frame,setFrame]=useState(null),[notice,setNotice]=useState(null),[keyText,setKeyText]=useState(''),[keyError,setKeyError]=useState(null),[connecting,setConnecting]=useState(false),[deleting,setDeleting]=useState(false),[library,setLibrary]=useState([]),[libraryTotal,setLibraryTotal]=useState(0),[libraryLoading,setLibraryLoading]=useState(false),[libraryError,setLibraryError]=useState(null);
 const navRef=useRef(null),menuRef=useRef(null),inputRef=useRef(null),archiveInputRef=useRef(null),videoRef=useRef(null),xhrRef=useRef(null),demoTimers=useRef([]),jobToken=useRef(0),restoreToken=useRef(0),selectedIdRef=useRef(null),pendingRef=useRef(null);
 const modelReady=health?.model?.ready===true;
 const modelStatus=health?.model?.status;
 const authenticated=session.authenticated===true;
 const maxBytes=Number(capabilities?.max_upload_bytes)||MAX_BYTES;
 const archiveLimits={maxBytes:Number(capabilities?.archive?.max_upload_bytes)||500_000_000,maxFiles:Number(capabilities?.archive?.max_files)||100,maxExpandedBytes:Number(capabilities?.archive?.max_expanded_bytes)||2_000_000_000};
 const formats=Array.isArray(capabilities?.formats)&&capabilities.formats.length?capabilities.formats.filter(f=>/^\.[a-z0-9]+$/i.test(f)):['.mov','.mp4'];
 const formatLabel=formats.map(f=>f.slice(1).toUpperCase()).join(' / ');
 const serverModelLabel=modelReady?'Сервер модели готов':modelStatus==='loading'?'Модель на сервере загружается':modelStatus==='error'?'Проверьте сервер модели':'Сервер модели не подключён';
 const isDemo=mode==='demo';
 const dark=['night','magenta'].includes(theme);
 const activeResult=isDemo?(demoState==='events'?{status:'done',verdict:'violation',violations:DEMO_EVENTS}:demoState==='empty'?{status:'done',verdict:'no_violation',violations:[]}:null):result;
 const needsReview=activeResult?.verdict==='review_required';
 const events=resultEvents(activeResult);
 const activeEvent=events[Math.min(selectedEvent,Math.max(0,events.length-1))];
 const processing=isDemo?['loading','processing'].includes(demoState):Boolean(job);

 useEffect(()=>{const change=()=>setView(viewFromHash());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 useEffect(()=>{const hash=view==='instructions'?'#instructions':view==='regulations'?'#regulations':'#workspace';if(window.location.hash!==hash)window.history.replaceState(null,'',hash);},[view]);
 useEffect(()=>{document.documentElement.dataset.theme=theme;remember(STORAGE.theme,theme);},[theme]);
 useEffect(()=>{document.documentElement.dataset.motion=reduced?'reduced':'full';},[reduced]);
 useEffect(()=>{const expired=()=>setSession({loading:false,authenticated:false});window.addEventListener('vision:session-expired',expired);return()=>window.removeEventListener('vision:session-expired',expired);},[]);
 useEffect(()=>{selectedIdRef.current=selected?.id||null;},[selected]);
 useEffect(()=>{
  if(!mobileNav)return;
  const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  const focusable=()=>[...navRef.current.querySelectorAll('a[href],button:not([disabled])')].filter(el=>el.getClientRects().length>0);
  navRef.current.querySelector('.nav-close')?.focus();
  const keys=e=>{if(e.key==='Escape'){e.preventDefault();setMobileNav(false);}else if(e.key==='Tab'){const items=focusable(),first=items[0],last=items.at(-1);if(e.shiftKey&&(document.activeElement===first||!navRef.current.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!navRef.current.contains(document.activeElement))){e.preventDefault();first?.focus();}}};
  const desktop=window.matchMedia('(min-width: 901px)'),resize=()=>{if(desktop.matches)setMobileNav(false);};desktop.addEventListener('change',resize);document.addEventListener('keydown',keys);
  return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',keys);desktop.removeEventListener('change',resize);menuRef.current?.focus();};
 },[mobileNav]);
 useEffect(()=>{if(!upload)return;const leaving=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',leaving);return()=>window.removeEventListener('beforeunload',leaving);},[Boolean(upload)]);
 useEffect(()=>{pendingRef.current=pendingFile;},[pendingFile]);
 const flash=(message,tone='error')=>setNotice({id:Date.now(),message,tone});
 const batches=useBatchManager({api,authenticated,onNotice:flash});
 const activeBatch=!isDemo&&batches.id;
 const selectedBatchItem=batches.batch?.items?.find(item=>item.video_id===selected?.id);
 const refreshHealth=async()=>{const [h,c]=await Promise.allSettled([api('/health'),api('/capabilities')]);if(h.status==='fulfilled'){setHealth(h.value);setServiceError(null);}else{setHealth(null);setServiceError(errorText(h.reason));}if(c.status==='fulfilled')setCapabilities(c.value);return h.status==='fulfilled'?h.value:null;};
 const restoreVideo=async (id,{reveal=true,jobId=null,useLatest=true}={})=>{
  if(!id||xhrRef.current)return;
  const token=++restoreToken.current;setRestoring(true);
  try{
   const detail=await api(`/videos/${encodeURIComponent(id)}`);
   if(token!==restoreToken.current)return;
   const video=detail.video||detail;
   if(!video||video.id!==id)throw new Error('Сервис вернул другую запись. Обновите список и повторите выбор.');
   const latest=jobId?(detail.latest_job?.job_id!==jobId?await api(`/jobs/${encodeURIComponent(jobId)}`):detail.latest_job):useLatest?detail.latest_job:null;
   if(token!==restoreToken.current)return;
   if(jobId&&latest?.video_id!==id)throw new Error('Результат не относится к выбранной записи. Обновите архив.');
   setJob(null);jobToken.current++;setSelected(video);selectedIdRef.current=video.id;setDuration(video.duration_sec??null);setPreviewError(false);setResult(null);setJobError(null);setResultState('idle');setSelectedEvent(0);setElapsed(0);if(reveal){setMode('local');setView('workspace');}remember(STORAGE.video,video.id);
   if(latest&&latest.video_id===video.id&&['local','server'].includes(latest.source)&&typeof latest.job_id==='string'){
    setJobStage(latest.stage||'queued');
    if(latest.status==='done'){
     if(isCompletedResult(latest)){setResult(latest);setResultState('done');}
     else{setJobError('Сохранённый результат неполон. Повторите проверку записи.');setResultState('error');}
    }else if(latest.status==='failed'){
     setJobError(latest.error?.message||(typeof latest.error==='string'?latest.error:'Предыдущая проверка не завершилась. Можно повторить запуск.'));setResultState('error');
    }else if(latest.status==='processing'){
     const started=Date.parse(latest.created_at);setElapsed(Number.isFinite(started)?Math.max(0,Math.floor((Date.now()-started)/1000)):0);setJob({id:latest.job_id,videoId:video.id,createdAt:latest.created_at});setResultState('processing');
    }
   }
  }catch(error){
   if(token!==restoreToken.current)return;
   if(error.status===404){remember(STORAGE.video,null);flash('Ранее выбранная запись больше не найдена. Выберите другое видео.','info');}else flash(errorText(error));
  }finally{if(token===restoreToken.current)setRestoring(false);}
 };
 useEffect(()=>{
  if(isDemo||!selectedBatchItem?.video_id||!selectedBatchItem.job?.job_id)return;
  restoreVideo(selectedBatchItem.video_id,{reveal:false,jobId:selectedBatchItem.job.job_id});
 },[batches.id,selectedBatchItem?.video_id,selectedBatchItem?.job?.job_id,selectedBatchItem?.job?.status,isDemo]);
 useEffect(()=>{let current=true;refreshHealth();(async()=>{try{let s=await api('/session');if(!current)return;if(!s.authenticated&&s.local_auto_session)s=await api('/session',{method:'POST',body:JSON.stringify({})});if(!current)return;const ok=s?.authenticated===true;setSession({loading:false,authenticated:ok});if(ok){const id=stored(STORAGE.video,null);if(id)await restoreVideo(id,{reveal:false});}}catch(error){if(!current)return;setSession({loading:false,authenticated:false});if(error.status!==401)setServiceError(errorText(error));}})();const timer=setInterval(()=>{if(document.visibilityState==='visible')refreshHealth();},20000);return()=>{current=false;clearInterval(timer);};},[]);
 useEffect(()=>()=>{demoTimers.current.forEach(clearTimeout);jobToken.current++;xhrRef.current?.abort();},[]);
 useEffect(()=>{if(!notice||notice.tone==='error')return;const timer=setTimeout(()=>setNotice(null),6500);return()=>clearTimeout(timer);},[notice]);
 useEffect(()=>{if(!demoPlaying||!isDemo)return;const timer=setInterval(()=>setDemoAt(t=>{if(t>=48){setDemoPlaying(false);return 48;}return t+1;}),1000);return()=>clearInterval(timer);},[demoPlaying,isDemo]);
 useEffect(()=>{
  if(!job)return;
  const token=++jobToken.current,controller=new AbortController();
  const parsedStart=Date.parse(job.createdAt),started=Number.isFinite(parsedStart)?Math.min(parsedStart,Date.now()):Date.now();
  const timeoutMs=Number(capabilities?.job_timeout_ms)||300000;
  let stopped=false,inFlight=false;
  const clock=()=>{if(stopped)return;const age=Date.now()-started;setElapsed(Math.max(0,Math.floor(age/1000)));if(age>=timeoutMs){stopped=true;controller.abort();setJob(null);setResultState('error');setJobError(`За ${Math.ceil(timeoutMs/60000)} мин. результат не получен. Запись считается необработанной.`);}};
  const tick=async()=>{
   if(stopped||inFlight||token!==jobToken.current)return;
   inFlight=true;
   try{
    const response=await api(`/jobs/${encodeURIComponent(job.id)}`,{signal:controller.signal});
    if(stopped||token!==jobToken.current||selectedIdRef.current!==job.videoId)return;
    setJobStage(response.stage||'analyzing');
    if(response.status==='done'){
     if(!isCompletedResult(response))throw new Error('Сервис вернул неполный результат. Попробуйте выполнить проверку ещё раз.');
     stopped=true;setResult(response);setSelectedEvent(0);setResultState('done');setJob(null);
    }else if(response.status==='failed'){
     stopped=true;setJobError(response.error?.message||response.error||'Сервис не смог обработать запись.');setResultState('error');setJob(null);
    }
   }catch(error){if(!stopped){stopped=true;setJobError(errorText(error));setResultState('error');setJob(null);}}
   finally{inFlight=false;}
  };
  clock();tick();const pollTimer=setInterval(tick,1500),clockTimer=setInterval(clock,1000);
  return()=>{stopped=true;controller.abort();clearInterval(pollTimer);clearInterval(clockTimer);};
 },[job]);

 function chooseFile(file){
  if(file?.name?.toLowerCase().endsWith('.zip')){chooseArchive(file);return;}
  if(!file||xhrRef.current)return;if(!formats.some(format=>file.name.toLowerCase().endsWith(format.toLowerCase()))){flash(`Выберите запись в формате ${formatLabel}. Другие форматы пока не поддерживаются.`);return;}if(file.size===0){flash('Файл пуст. Выберите другую видеозапись.');return;}if(file.size>maxBytes){flash(`Запись больше ${bytes(maxBytes)}. Выберите файл меньшего размера.`);return;}
  setMode('local');setPreviewError(false);setNotice(null);if(!authenticated){setPendingFile(file);setKeyError(null);setModal('connection');return;}uploadFile(file);
 }
 function uploadFile(file){
  if(xhrRef.current||!file)return;
  batches.select(null);
  if(view==='instructions')requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'instant'}));
  restoreToken.current++;setRestoring(false);setDragging(false);setUpload({percent:0,loaded:0,total:file.size,name:file.name,phase:'transferring'});setJob(null);jobToken.current++;setResult(null);setResultState('idle');setMode('local');setView('workspace');setMobileNav(false);
  const xhr=new XMLHttpRequest();xhrRef.current=xhr;xhr.open('POST','/api/v1/videos');xhr.withCredentials=true;xhr.responseType='json';xhr.timeout=600000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable&&xhrRef.current===xhr){const ratio=e.loaded/e.total;setUpload({percent:ratio<1?Math.min(99,Math.round(ratio*100)):100,loaded:Math.round(Math.min(1,ratio)*file.size),total:file.size,name:file.name,phase:ratio>=1?'verifying':'transferring'});}};
  xhr.upload.onload=()=>{if(xhrRef.current===xhr)setUpload({percent:100,loaded:file.size,total:file.size,name:file.name,phase:'verifying'});};
  const finish=()=>{if(xhrRef.current!==xhr)return false;xhrRef.current=null;setUpload(null);return true;};
  xhr.onload=()=>{if(!finish())return;const data=xhr.response;if(xhr.status>=200&&xhr.status<300&&data?.video){setSelected(data.video);selectedIdRef.current=data.video.id;setDuration(data.video.duration_sec??null);setPreviewError(false);remember(STORAGE.video,data.video.id);setPendingFile(null);flash('Запись сохранена. Можно открыть видео и запустить проверку.','success');}else{const message=data?.error?.message||data?.error||data?.message||'Не удалось сохранить запись. Попробуйте ещё раз.';flash(typeof message==='string'?message:'Не удалось сохранить запись.');if(xhr.status===401){setSession({loading:false,authenticated:false});setPendingFile(file);setModal('connection');}}};
  xhr.onerror=()=>{if(finish())flash('Связь с платформой прервалась. Проверьте подключение и повторите загрузку.');};
  xhr.ontimeout=()=>{if(finish())flash('Сервис не ответил вовремя. Проверьте «Записи в сервисе» перед повторной загрузкой.');};
  xhr.onabort=()=>{finish();};const data=new FormData();data.append('file',file);xhr.send(data);
 }
 function chooseArchive(file){
  if(!file||xhrRef.current)return;
  if(!/\.zip$/i.test(file.name)){flash('Выберите ZIP-архив с видеозаписями.');return;}
  if(!file.name.trim()||file.name.length>255||/[\u0000-\u001f\u007f]/.test(file.name)){flash('Переименуйте архив: имя должно быть короче 256 символов и не содержать служебных знаков.');return;}
  if(!file.size){flash('Архив пуст. Выберите другой файл.');return;}
  if(file.size>archiveLimits.maxBytes){flash(`Архив больше ${bytes(archiveLimits.maxBytes)}. Разделите записи на несколько ZIP-архивов.`);return;}
  setArchiveFile(file);setNotice(null);setModal('archive-confirm');setMobileNav(false);
 }
 async function selectBatch(value){
  if(xhrRef.current)return;
  batches.select(value);setMode('local');setView('workspace');setModal(null);setMobileNav(false);
  const token=++restoreToken.current;
  setSelected(null);selectedIdRef.current=null;setJob(null);jobToken.current++;setResult(null);setResultState('idle');setDuration(null);remember(STORAGE.video,null);setRestoring(true);
  try{
   const full=Array.isArray(value?.items)?value:(await api(`/batches/${encodeURIComponent(value.id)}`)).batch;
   if(token!==restoreToken.current)return;
   batches.select(full);
   const first=full?.items?.find(item=>item.video_id);
   if(first)await restoreVideo(first.video_id,{jobId:first.job?.job_id,useLatest:false});
  }catch(error){if(token===restoreToken.current)flash(errorText(error));}
  finally{if(token===restoreToken.current)setRestoring(false);}
 }
 async function openBatchHistory(){
  if(xhrRef.current)return;
  setMobileNav(false);
  if(!authenticated){openConnection();return;}
  setModal('batch-history');await batches.loadHistory();
 }
 function uploadArchive(){
  const file=archiveFile;
  if(!file||xhrRef.current)return;
  if(!authenticated){setModal('connection');return;}
  const analyzeAfterUpload=modelReady;
  setModal(null);setView('workspace');setMode('local');setMobileNav(false);setNotice(null);setDragging(false);
  restoreToken.current++;setRestoring(false);jobToken.current++;setJob(null);setResult(null);setResultState('idle');setSelected(null);selectedIdRef.current=null;setDuration(null);remember(STORAGE.video,null);batches.select(null);
  const progress=(percent,loaded,phase)=>setUpload({kind:'archive',percent,loaded,total:file.size,name:file.name,phase});
  progress(0,0,'transferring');
  const xhr=new XMLHttpRequest();xhrRef.current=xhr;xhr.open('POST','/api/v1/batches');xhr.withCredentials=true;xhr.responseType='json';xhr.timeout=600000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable&&xhrRef.current===xhr){const ratio=e.loaded/e.total;progress(ratio<1?Math.min(99,Math.round(ratio*100)):100,Math.round(Math.min(1,ratio)*file.size),ratio>=1?'verifying':'transferring');}};
  xhr.upload.onload=()=>{if(xhrRef.current===xhr)progress(100,file.size,'verifying');};
  const finish=()=>{if(xhrRef.current!==xhr)return false;xhrRef.current=null;setUpload(null);return true;};
  xhr.onload=async()=>{
   if(!finish())return;
   const data=xhr.response;
   if(xhr.status>=200&&xhr.status<300&&data?.batch?.id){
    setArchiveFile(null);await selectBatch(data.batch);
    if(analyzeAfterUpload&&Number(data.batch.counts?.queued)>0){
     const started=await batches.start(data.batch);
     if(started)flash('Архив загружен. Сервер начал последовательную проверку записей.','success');
    }else flash(Number(data.batch.counts?.queued)>0?'Архив загружен. Подключите сервер модели и запустите проверку.':'Архив обработан. Проверьте статусы файлов в списке справа.','info');
   }else{
    const responseMessage=data?.error?.message||data?.error||'Не удалось загрузить архив. Проверьте файл и повторите попытку.';
    flash(typeof responseMessage==='string'?responseMessage:'Не удалось загрузить архив.');
    if(xhr.status===401){setSession({loading:false,authenticated:false});setModal('connection');}
   }
  };
  xhr.onerror=()=>{if(finish())flash('Связь прервалась. Перед повторной загрузкой проверьте историю архивов.');};
  xhr.ontimeout=()=>{if(finish())flash('Платформа не ответила вовремя. Проверьте историю архивов перед повторной загрузкой.');};
  xhr.onabort=()=>{finish();};
  const data=new FormData();data.append('file',file);xhr.send(data);
 }
 function cancelUpload(){if(!xhrRef.current||upload?.phase==='verifying')return;xhrRef.current.abort();setPendingFile(null);setArchiveFile(null);flash('Передача остановлена. Можно выбрать другой файл.','info');if(selected?.id)restoreVideo(selected.id);}
 function newRecording(){if(xhrRef.current)return;batches.select(null);setArchiveFile(null);setView('workspace');pendingRef.current=null;setPendingFile(null);demoTimers.current.forEach(clearTimeout);jobToken.current++;restoreToken.current++;setRestoring(false);setSelected(null);selectedIdRef.current=null;setJob(null);setResult(null);setResultState('idle');setJobError(null);setPreviewError(false);setDuration(null);setSelectedEvent(0);setMode('local');setDemoPlaying(false);setNotice(null);setMobileNav(false);remember(STORAGE.video,null);window.scrollTo({top:0,behavior:reduced?'instant':'smooth'});}
 function switchSource(source){if(xhrRef.current)return;setView('workspace');demoTimers.current.forEach(clearTimeout);setMode(source);setSelectedEvent(0);setDemoPlaying(false);if(source==='demo'){setDemoState('events');setDemoAt(12);}setMobileNav(false);}
 function runDemo(){demoTimers.current.forEach(clearTimeout);setDemoState('loading');setDemoStage(0);setDemoElapsed(0);setSelectedEvent(0);setDemoPlaying(false);setDemoAt(0);const start=Date.now();const interval=setInterval(()=>setDemoElapsed(Math.floor((Date.now()-start)/1000)),1000);demoTimers.current=[interval,setTimeout(()=>{setDemoState('processing');setDemoStage(1);},1200),setTimeout(()=>setDemoStage(2),3200),setTimeout(()=>{clearInterval(interval);setDemoState('events');setDemoAt(12);},5200)];}
 function stopWaiting(){if(isDemo){demoTimers.current.forEach(clearTimeout);setDemoState('stopped');setDemoElapsed(0);}else{setJob(null);jobToken.current++;setResultState('stopped');setElapsed(0);}}
 async function startAnalysis(){if(xhrRef.current||!selected||job||resultState==='starting')return;if(activeBatch&&['queued','processing'].includes(selectedBatchItem?.status)){if(selectedBatchItem.job?.job_id)await restoreVideo(selected.id,{jobId:selectedBatchItem.job.job_id});else flash('Запись находится в очереди архива. Результат появится после проверки.','info');return;}if(!authenticated){openConnection();return;}if(!modelReady){openConnection();return;}const videoId=selected.id,token=++jobToken.current;if(activeBatch)batches.select(null);setResult(null);setJobError(null);setElapsed(0);setResultState('starting');try{const response=await api(`/videos/${encodeURIComponent(videoId)}/analyze`,{method:'POST'});if(token!==jobToken.current||selectedIdRef.current!==videoId)return;if(!response.job_id)throw new Error('Сервис не передал номер задачи.');setJobStage(response.stage||'queued');setJob({id:response.job_id,videoId,createdAt:response.created_at});setResultState('processing');}catch(error){if(token!==jobToken.current||selectedIdRef.current!==videoId)return;setResultState('error');setJobError(errorText(error));await refreshHealth();}}
 async function signIn(e){e.preventDefault();setConnecting(true);setKeyError(null);const key=keyText;setKeyText('');try{const response=await api('/session',{method:'POST',body:JSON.stringify({api_key:key})});if(response?.authenticated===false)throw new Error('Не удалось подтвердить доступ. Проверьте ключ.');setSession({loading:false,authenticated:true});await refreshHealth();flash('Доступ к платформе подтверждён.','success');if(archiveFile){setModal('archive-confirm');}else if(pendingRef.current){setModal(null);const file=pendingRef.current;setPendingFile(null);uploadFile(file);}else if(!selected){await restoreVideo(stored(STORAGE.video,null),{reveal:view!=='instructions'});}}catch(error){setKeyError(error.status===401?'Ключ не принят. Проверьте его и повторите попытку.':errorText(error));}finally{setConnecting(false);}}
 async function deleteVideo(){if(!selected||deleting)return;const deletingId=selected.id;setDeleting(true);try{await api(`/videos/${encodeURIComponent(deletingId)}`,{method:'DELETE'});if(selectedIdRef.current!==deletingId)return;setJob(null);jobToken.current++;restoreToken.current++;setSelected(null);selectedIdRef.current=null;setResult(null);setResultState('idle');setDuration(null);setPreviewError(false);setMode('local');remember(STORAGE.video,null);setModal(null);flash('Запись удалена из платформы.','success');}catch(error){flash(errorText(error));}finally{setDeleting(false);}}
 function seek(value){if(value==null||!Number.isFinite(Number(value)))return;if(isDemo){setDemoAt(Number(value));setDemoPlaying(false);return;}const video=videoRef.current;if(!video||previewError){flash('Предпросмотр недоступен. Временная отметка сохранена, но перейти к кадру пока нельзя.');return;}if(video.readyState<1){flash('Дождитесь подготовки предпросмотра.','info');return;}if(Number.isFinite(video.duration)&&Number(value)>video.duration){flash('Временная отметка находится за пределами этой записи.');return;}video.currentTime=Number(value);video.pause();}
 function selectEvent(index){setSelectedEvent(index);seek(events[index]?.timecode_sec);}
 const closeModal=()=>{if(modal==='archive-confirm'||modal==='connection')setArchiveFile(null);if(modal==='connection'){pendingRef.current=null;setPendingFile(null);}setModal(null);setKeyText('');setKeyError(null);};
 const openConnection=()=>{setKeyError(null);setModal('connection');setMobileNav(false);refreshHealth();};
 const openLibrary=async()=>{if(xhrRef.current)return;setMobileNav(false);if(!authenticated){openConnection();return;}setModal('library');setLibraryLoading(true);setLibraryError(null);try{const response=await api('/videos?limit=100');setLibrary(response.videos||[]);setLibraryTotal(response.total||0);}catch(error){setLibraryError(errorText(error));}finally{setLibraryLoading(false);}};
 const openWorkspace=()=>{if(xhrRef.current)return;setView('workspace');setMobileNav(false);if(view!=='workspace')window.scrollTo({top:0,behavior:'instant'});};
 const openInstructions=()=>{if(xhrRef.current)return;setView('instructions');setMobileNav(false);setModal(null);setDemoPlaying(false);window.scrollTo({top:0,behavior:reduced?'instant':'smooth'});};
 const openRegulations=()=>{if(xhrRef.current)return;setView('regulations');setMobileNav(false);setDemoPlaying(false);window.scrollTo({top:0,behavior:reduced?'instant':'smooth'});};
 const leaveInstructions=()=>{setView('workspace');window.scrollTo({top:0,behavior:reduced?'instant':'smooth'});};
 const completeLearning=()=>{flash('Обучение пройдено. Инструкции всегда доступны в меню.','success');};
 const chooseFromInstructions=()=>{if(xhrRef.current||session.loading)return;inputRef.current?.click();};

 return <MotionConfig reducedMotion={reduced?'always':'never'} transition={{type:'spring',stiffness:330,damping:30}}>
  <SiteEntrance active={entering} dark={dark}/>
  <a className="skip-link" href="#workspace">Перейти к рабочей области</a>
  <div className={`app-shell ${mobileNav?'nav-open':''} ${entering?'is-arriving':''}`} inert={modal?true:undefined}>
   <aside ref={navRef} id="workspace-navigation" className="sidebar" aria-label="Основная навигация" role={mobileNav?'dialog':undefined} aria-modal={mobileNav?true:undefined}>
    <div className="sidebar-header"><a className="brand" href="#workspace" onClick={()=>openWorkspace()} aria-label="vision-forte, рабочая область"><img src={`/brand/forte-logo-${dark?'white':'magenta'}.svg`} alt="Forte"/><span className="brand-divider"/><span className="brand-vision">vision<span>ВИДЕОАНАЛИТИКА</span></span></a><button className="icon-button nav-close" onClick={()=>setMobileNav(false)} aria-label="Закрыть навигацию"><X size={19}/></button></div>
    <div className="sidebar-scroll">
     <div className="workspace-label"><span><ScanLine size={20}/></span><div><strong>Рабочее пространство</strong><small>Контроль кассовых операций</small></div></div>
     <button className="nav-create" onClick={newRecording} disabled={Boolean(upload)}><Plus size={18}/><span>Новая запись</span></button>
     <nav className="nav-group" aria-label="Разделы"><p className="nav-caption">РАБОЧАЯ ОБЛАСТЬ</p><button className={`nav-item ${view==='workspace'?'active':''}`} disabled={Boolean(upload)} aria-current={view==='workspace'?'page':undefined} onClick={()=>openWorkspace()}>{view==='workspace'&&<motion.span className="nav-indicator" layoutId="navigation"/>}<Video size={19}/><span>Проверка видео</span></button><button className="nav-item" disabled={Boolean(upload)} onClick={openLibrary}><FolderOpen size={19}/><span>Записи в сервисе</span></button><button className="nav-item" disabled={Boolean(upload)} onClick={openBatchHistory}><Archive size={19}/><span>Архивы операций</span></button><button className={`nav-item ${view==='instructions'?'active':''}`} disabled={Boolean(upload)} aria-current={view==='instructions'?'page':undefined} onClick={openInstructions}>{view==='instructions'&&<motion.span className="nav-indicator" layoutId="navigation"/>}<BookOpen size={19}/><span>Инструкции</span></button><button className={`nav-item ${view==='regulations'?'active':''}`} disabled={Boolean(upload)} aria-current={view==='regulations'?'page':undefined} onClick={openRegulations}>{view==='regulations'&&<motion.span className="nav-indicator" layoutId="navigation"/>}<ShieldCheck size={19}/><span>Нормативная база</span></button></nav>
    </div>
    <footer className="sidebar-footer"><ThemePicker theme={theme} onChange={setTheme} reduced={reduced}/><button className="sidebar-service" onClick={openConnection}><span className={`status-dot ${serviceError||modelStatus==='error'?'error':modelReady?'ready':''}`}/><span><strong>Сервер модели</strong><small>{serviceError?'Нет связи с платформой':session.loading?'Проверяем…':!authenticated?'Нужен доступ к платформе':modelReady?'Подключён по API':modelStatus==='loading'?'Модель загружается':modelStatus==='error'?'Проверьте подключение':'Настроить API'}</small></span><ArrowUpRight size={15}/></button></footer>
   </aside>
   {mobileNav&&<button className="nav-scrim" aria-label="Закрыть меню" onClick={()=>setMobileNav(false)}/>}
   <main id="workspace" className="main" tabIndex={-1} inert={mobileNav?true:undefined}>
    <div className="topbar"><div className="breadcrumb"><button ref={menuRef} className="mobile-menu icon-button" onClick={()=>setMobileNav(v=>!v)} aria-label={mobileNav?'Закрыть меню':'Открыть меню'} aria-expanded={mobileNav} aria-controls="workspace-navigation"><Menu size={21}/></button><span>Рабочая область</span><span className="breadcrumb-slash">/</span><strong>{view==='instructions'?'Инструкции':view==='regulations'?'Нормативная база':'Проверка видео'}</strong></div><button className="connection-chip" onClick={openConnection}><span className={`status-dot ${modelReady?'ready':serviceError?'error':''}`}/><span>{serviceError?'Нет связи с платформой':serverModelLabel}</span><ArrowUpRight size={14}/></button></div>
    {view==='regulations'?<RegulatoryLibrary reduced={reduced} onBack={()=>openWorkspace()}/>:view==='instructions'?<LearningCenter reduced={reduced} modelReady={modelReady} authenticated={authenticated} serviceAvailable={serviceError?false:health?true:null} canUpload={!session.loading} formatLabel={formatLabel} maxSizeLabel={bytes(maxBytes)} onChooseVideo={chooseFromInstructions} onOpenDemo={()=>{switchSource('demo');window.scrollTo({top:0,behavior:reduced?'instant':'smooth'});}} onOpenConnection={openConnection} onBack={leaveInstructions} onComplete={completeLearning}/>:<>
    <motion.header className="page-heading" initial={{opacity:0,y:12}} animate={{opacity:1,y:0}}><div><h1 className="type-headline">Проверка кассовых операций</h1><p className="page-description">Видеозапись, события и нормативные основания — в одной рабочей области.</p></div></motion.header>
    <div className={`source-strip ${isDemo?'is-demo':''}`}><div className="source-strip-left">{isDemo?<Layers3 size={18}/>:<HardDrive size={18}/>}<div><strong>{isDemo?'Демонстрация интерфейса':selected?'Ваша запись на платформе':'Работа с видеозаписью'}</strong><span>{isDemo?'Синтетический пример · ваше видео не анализируется':selected?'Файл сохранён. Запустите проверку, чтобы получить результат модели.':formatLabel+' до '+bytes(maxBytes)+' · загрузка на платформу · просмотр без модели'}</span></div></div><div className="archive-source-actions"><Button variant="secondary" disabled={Boolean(upload)||session.loading} onClick={()=>archiveInputRef.current?.click()}><Archive size={17}/>Загрузить архив</Button><Button variant="quiet" disabled={Boolean(upload)||restoring} onClick={()=>switchSource(isDemo?'local':'demo')}>{isDemo?<ArrowLeft size={16}/>:<Play size={16}/>}<span>{isDemo?'К вашей записи':'Открыть демо'}</span></Button></div></div>
    <div className={`workspace-grid ${activeBatch?'has-batch':''}`}>
     <motion.section layout className="panel video-panel"><header className="panel-heading"><div><span className="section-index">01</span><h2>{isDemo?'Синтетический пример':'Видеозапись'}</h2></div><Badge icon={isDemo?Layers3:LockKeyhole} tone={isDemo?'demo':'neutral'}>{isDemo?'Демо':'На платформе'}</Badge></header>
      <div className="video-panel-body">
       <AnimatePresence mode="wait" initial={false}>
        {upload?<motion.div key="upload" className={`upload-progress-state ${upload.phase==='verifying'?'is-verifying':''}`} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}}>
         <div className="upload-state-label"><span className="upload-state-orbit"/><span>{upload.kind==='archive'?'ЗАГРУЗКА АРХИВА':'ЗАГРУЗКА ЗАПИСИ'}</span><LockKeyhole size={15}/></div>
         <UploadSculpture reduced={reduced} active progress={upload.percent}/>
         <div className="upload-progress-copy"><div className="upload-title-row"><h3 aria-live="polite">{upload.kind==='archive'?(upload.phase==='verifying'?'Разбираем архив':'Загружаем архив'):upload.phase==='verifying'?'Готовим к просмотру':'Видео уже в пути.'}</h3><span className="upload-percentage">{upload.percent}<small>%</small></span></div><p className="upload-filename" title={upload.name}><Film size={17}/><span>{upload.name}</span></p><div className="upload-progress-track" role="progressbar" aria-label={upload.kind==='archive'?'Передача архива':'Передача видеозаписи'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.percent} aria-valuetext={upload.phase==='verifying'?'Файл передан. Анализ ещё не завершён.':`${upload.percent}% передано`}><motion.div initial={{width:0}} animate={{width:`${upload.percent}%`}} transition={{duration:reduced?0:.3,ease:'easeOut'}}/></div><div className="upload-progress-meta"><span>{bytes(upload.loaded)} из {bytes(upload.total)}</span><span>{upload.phase==='verifying'?'Проверяем файл…':'Безопасная передача'}</span></div>{upload.kind==='archive'?<p className="archive-progress-explanation">{upload.phase==='verifying'?'Архив передан. Платформа проверяет файлы и готовит список записей. Дождитесь завершения подготовки.':'Передаём ZIP-архив на платформу. Проверка видеозаписей ещё не началась.'}</p>:<><UploadJourney phase={upload.phase} reduced={reduced}/><p className="caption">{upload.phase==='verifying'?'Файл получен. Проверяем формат и готовим предпросмотр.':'Запись сохраняется на платформе. Анализ ещё не запускался.'}</p></>}{upload.phase!=='verifying'&&<Button variant="quiet" className="upload-cancel" onClick={cancelUpload}><X size={15}/>Отменить передачу</Button>}</div>
        </motion.div>
        :restoring?<motion.div key="restore" className="state-card compact-state"><LoaderCircle size={32} className="spin"/><h3>Возвращаем вашу запись</h3><p>Загружаем сведения из платформы.</p></motion.div>
        :!selected&&!isDemo?<motion.div key="empty" className={`dropzone ${dragging?'dragging':''}`} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,scale:.98}} onDragEnter={e=>{e.preventDefault();setDragging(true);}} onDragOver={e=>e.preventDefault()} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDragging(false);}} onDrop={e=>{e.preventDefault();setDragging(false);if(e.dataTransfer.files.length!==1){flash('Выберите один видеофайл или ZIP-архив с записями.');return;}chooseFile(e.dataTransfer.files[0]);}}><div className="dropzone-top"><span><span/>{dragging?'ОТПУСТИТЕ, ЧТОБЫ ЗАГРУЗИТЬ':'ГОТОВО К ЗАГРУЗКЕ'}</span><ArrowDown size={17}/></div><UploadSculpture reduced={reduced} active={dragging}/><div className="dropzone-copy"><h3>Загрузите видеозапись</h3><p>Перетащите видео или ZIP-архив сюда<br/>или выберите файл на устройстве.</p><div className="dropzone-actions"><Button variant="primary" onClick={()=>inputRef.current?.click()} disabled={session.loading}><Plus size={18}/><span>Выбрать видео</span></Button><Button variant="quiet" onClick={()=>archiveInputRef.current?.click()} disabled={session.loading}><Archive size={18}/><span>Загрузить архив</span></Button></div><span className="dropzone-format">{formatLabel}<span/>один файл<span/>до {bytes(maxBytes)}</span></div><div className="dropzone-bottom"><ShieldCheck size={15}/><span>Запись обрабатывается на нашем сервере</span></div></motion.div>
        :<motion.div key={isDemo?'demo-player':selected.id} className="loaded-video" initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}}><div className="video-stage"><div className="video-topline"><span><span className="record-dot"/>{isDemo?'ДЕМО / СХЕМА':'ИСХОДНАЯ ЗАПИСЬ'}</span><span>{isDemo?'29 : 53':<VolumeX size={15}/>}</span></div>{isDemo?<SyntheticScene at={demoAt}/>:previewError?<div className="preview-failure"><Film size={36}/><h3>Предпросмотр недоступен</h3><p>Файл сохранён, но браузер не смог воспроизвести эту запись. Это не результат анализа.</p><Button variant="on-dark" onClick={()=>{setPreviewError(false);setTimeout(()=>videoRef.current?.load(),0);}}><RefreshCw size={16}/>Повторить просмотр</Button></div>:<video ref={videoRef} controls muted playsInline preload="metadata" src={selected.preview_url||`/api/v1/videos/${encodeURIComponent(selected.id)}/content`} onLoadedMetadata={e=>setDuration(Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:null)} onError={()=>setPreviewError(true)} aria-label={`Предпросмотр: ${selected.original_name}`}/>}</div>{isDemo&&<div className="demo-controls"><button className="player-play" aria-label={demoPlaying?'Приостановить демо':'Воспроизвести демо'} onClick={()=>{if(demoAt>=48)setDemoAt(0);setDemoPlaying(v=>!v);}}>{demoPlaying?<Pause size={18}/>:<Play size={18}/>}</button><span>{time(demoAt)} <em>/ 00:48</em></span><input type="range" min="0" max="48" value={demoAt} onChange={e=>{setDemoAt(Number(e.target.value));setDemoPlaying(false);}} aria-label="Время синтетической демонстрации"/><button className="player-play" onClick={()=>{setFrame({demo:true,timestamp_sec:demoAt});setModal('frame');}} aria-label="Увеличить синтетический кадр"><Expand size={17}/></button></div>}<div className="file-summary"><span className="file-icon"><Film size={21}/></span><div><strong title={isDemo?'Синтетическая схема':selected.original_name}>{isDemo?'demo-scene · схема':selected.original_name}</strong><p>{isDemo?'00:48 · абстрактные объекты A и B':`${duration==null?'Длительность определяется':time(duration)} · ${bytes(selected.size_bytes)} · ${selected.original_name?.split('.').at(-1)?.toUpperCase()||'Видео'}`}</p></div>{!isDemo&&<div className="file-actions"><button className="icon-button" onClick={()=>inputRef.current?.click()} aria-label="Выбрать другую запись"><RefreshCw size={18}/></button><button className="icon-button danger-icon" onClick={()=>setModal('delete')} aria-label="Удалить запись из сервиса"><Trash2 size={18}/></button></div>}</div>{isDemo?<><Button variant="primary" className="full-width" onClick={runDemo} disabled={processing}><Play size={18}/>Запустить демонстрацию<ArrowRight size={17}/></Button><p className="action-caption"><Layers3 size={14}/>Пример интерфейса. Модель не запускается.</p>{selected&&<div className="preserved-file"><CheckCheck size={15}/><span>Ваша запись <strong>{selected.original_name}</strong> сохранена отдельно.</span></div>}</>:<><Button variant="primary" className="full-width" disabled={!modelReady||processing||resultState==='starting'||Boolean(activeBatch&&['queued','processing'].includes(selectedBatchItem?.status))} busy={resultState==='starting'} onClick={startAnalysis}><ScanLine size={19}/>{processing?'Идёт проверка':activeBatch&&selectedBatchItem?.status==='queued'?'В очереди архива':activeBatch&&selectedBatchItem?.status==='processing'?'Проверяется в архиве':!authenticated&&modelReady?'Подключиться для проверки':'Проверить видео'}<ArrowRight size={17}/></Button><p className="action-caption"><PlugZap size={14}/>{modelReady?'Модель готова. Результат требует проверки человеком.':'Просмотр доступен. Для анализа подключите сервер модели.'}</p></>}</motion.div>}
       </AnimatePresence>
      </div>
     </motion.section>
     <div className="workspace-results-column">
      {activeBatch&&<BatchPanel manager={batches} selectedVideoId={selected?.id} modelReady={modelReady} authenticated={authenticated} onSelect={id=>restoreVideo(id,{jobId:batches.batch?.items?.find(item=>item.video_id===id)?.job?.job_id,useLatest:false})} onConnect={openConnection} onHistory={openBatchHistory} onClose={()=>batches.select(null)} onRetry={()=>setModal('batch-retry')} disabled={Boolean(upload)||restoring}/>}
     <motion.section layout className="panel evidence-panel"><header className="panel-heading result-heading"><h2 id="model-results-title">{activeBatch?'Выбранная запись':'Результат модели'}</h2><span className="section-index">02</span></header>{activeBatch&&selectedBatchItem&&<p className="archive-detail-label">{selectedBatchItem.original_name}</p>}<div id="result-content" role="region" aria-labelledby="model-results-title" className="result-content"><AnimatePresence mode="wait" initial={false}><motion.div className="result-view" key={`${isDemo?'demo':'local'}-${isDemo?demoState:resultState}`} initial={{opacity:0,y:13}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-7}} transition={{duration:.22}}>
       {restoring&&!isDemo?<div className="state-card compact-state"><LoaderCircle size={30} className="spin"/><h3>Открываем запись</h3><p>Загружаем видео и результат проверки.</p></div>:activeBatch&&!selectedBatchItem?<div className="archive-empty-selection"><Film size={28}/><p>Выберите запись в списке архива, чтобы открыть видео и подробный ответ модели.</p></div>:processing||(!isDemo&&resultState==='starting')?<><DemoNotice show={isDemo}/><div className="state-card processing-state"><div className="orbital-loader"><span/><ScanLine size={30}/></div><p className="eyebrow">{isDemo?'ДЕМОНСТРАЦИЯ ПРОЦЕССА':'ПРОВЕРКА ВИДЕО'}</p><h3>{isDemo&&demoState==='loading'?'Готовим пример.':'Ищем важные детали.'}</h3><p>{isDemo?'Показываем этапы на синтетическом сценарии. Ваш файл не анализируется.':'Обработка выполняется на вашем сервере модели. Результат появится здесь.'}</p><div className="process-steps">{(isDemo?['Подготовка записи','Поиск событий','Подготовка доказательств']:['Ожидание запуска','Анализ записи']).map((label,i)=>{const stage=isDemo?demoStage:jobStage==='queued'?0:1;return <div key={label} className={i<stage?'done':i===stage?'current':''}><span>{i<stage?<Check size={12}/>:String(i+1).padStart(2,'0')}</span>{label}</div>;})}</div><div className="elapsed"><Clock3 size={15}/>{time(isDemo?demoElapsed:elapsed)}<span>прошло</span></div><Button variant="quiet" onClick={stopWaiting}>Остановить ожидание</Button></div></>
       :(isDemo&&['error','stopped'].includes(demoState))||(!isDemo&&['error','stopped'].includes(resultState))?<><DemoNotice show={isDemo}/><div className="state-card"><div className="state-icon error"><TriangleAlert size={28}/></div><p className="eyebrow">РЕЗУЛЬТАТ НЕ ПОЛУЧЕН</p><h3>{(isDemo?demoState:resultState)==='stopped'?'Ожидание остановлено.':'Не удалось завершить проверку.'}</h3><p>{(isDemo?demoState:resultState)==='stopped'?'Остановка ожидания не подтверждает отмену серверной задачи. Вывод о нарушениях не сформирован.':isDemo?'Пример технической ошибки. Отсутствие результата не означает отсутствие нарушений.':jobError}</p><Button onClick={isDemo?runDemo:startAnalysis} disabled={!isDemo&&!selected}><RefreshCw size={17}/>{isDemo?'Повторить демо':activeBatch&&['queued','processing'].includes(selectedBatchItem?.status)?'Вернуться к проверке архива':!authenticated?'Подключиться':!modelReady?'Проверить подключение':'Повторить проверку'}</Button></div></>
       :activeResult?.verdict==='no_violation'?<><DemoNotice show={isDemo}/><ResultWarnings warnings={activeResult.warnings}/><div className="state-card clear-state"><div className="clear-orbit"><ShieldCheck size={40} strokeWidth={1.3}/><span/></div><p className="eyebrow">{isDemo?'ДЕМОНСТРАЦИОННЫЙ ИТОГ':'ПРОВЕРКА ЗАВЕРШЕНА'}</p><h3>Нарушение<br/>не обнаружено.</h3><p>{isDemo?'В этом синтетическом сценарии нет событий. Это не вывод о вашей записи.':'Модель не выявила признаков возможных нарушений в этой записи.'}</p>{!isDemo&&activeResult.summary&&<p className="model-response-summary">{activeResult.summary}</p>}{isDemo&&<Button onClick={()=>{setDemoState('events');setDemoAt(12);}}>Пример с событиями<ArrowRight size={16}/></Button>}</div></>
       :(activeResult?.verdict==='violation'||needsReview)?<><DemoNotice show={isDemo}/><ResultWarnings warnings={activeResult.warnings}/><div className="findings-heading"><Badge tone="warning" icon={TriangleAlert}>Требуется проверка</Badge><h3>{needsReview?'Наблюдаемые действия.':'Обнаружены признаки возможных нарушений.'}</h3>{needsReview&&<p>Вывод о нарушениях не сформирован. Проверьте действия по кадрам и исходному видео.</p>}<p>{events.length} {events.length===1?'событие':'события'}{isDemo?' · синтетический пример':' · результат модели'}</p></div>{!isDemo&&activeResult.summary&&<div className="model-response-summary model-response-summary-events"><strong>Ответ модели</strong><p>{activeResult.summary}</p></div>}<ResultCoverage analysis={activeResult.analysis}/>{needsReview&&events.length===0&&<p className="inline-note">Сервер модели не вернул наблюдаемых событий. Это не подтверждает отсутствие нарушений.</p>}<div className="event-list" aria-label="События">{events.map((event,i)=><motion.button key={`${event.type}-${i}`} className={`event-item ${selectedEvent===i?'selected':''}`} whileHover={{x:2}} onClick={()=>selectEvent(i)} aria-pressed={selectedEvent===i}><span className="event-number">{String(i+1).padStart(2,'0')}</span><span className="event-item-copy"><strong>{event.type||'Событие без названия'}</strong><span>{needsReview?`${time(event.start_sec)}–${time(event.end_sec)}`:event.timecode_sec==null?'Время не указано':time(event.timecode_sec)}{isDemo?' · Демо':''}</span></span><ArrowUpRight size={18}/></motion.button>)}</div>{activeEvent&&<motion.div key={selectedEvent} initial={{opacity:0,y:9}} animate={{opacity:1,y:0}} className="event-detail"><div className="detail-title"><h4>Что видно в кадре</h4><button className="time-jump" disabled={activeEvent.timecode_sec==null} onClick={()=>seek(activeEvent.timecode_sec)}><Play size={13}/>{time(activeEvent.timecode_sec)}</button></div><p>{activeEvent.description||'Описание не передано.'}</p><div className="evidence-label"><span>Кадры и доказательства</span><Expand size={14}/></div><div className="frames-row">{(activeEvent.evidence_frames||[]).slice(0,3).map((f,i)=><button className="evidence-frame" key={i} onClick={()=>{setFrame({...f,demo:isDemo,description:activeEvent.description});setModal('frame');}} aria-label={`Увеличить ${isDemo?'синтетический ':''}кадр ${time(f.timestamp_sec)}`}><div>{isDemo?<SyntheticScene at={f.timestamp_sec} mini/>:frameSource(f)?<img src={frameSource(f)} alt={`Доказательство, ${time(f.timestamp_sec)}`}/>:<span className="frame-unavailable"><Film size={22}/>Кадр недоступен</span>}<span className="frame-expand"><Expand size={12}/></span></div><span className="frame-caption">{time(f.timestamp_sec)}{isDemo&&<em>ДЕМО</em>}</span></button>)}</div>{!activeEvent.evidence_frames?.length&&<div className="inline-note"><Film size={16}/>Кадры не переданы сервисом.</div>}{!needsReview&&<RuleReferences refs={activeEvent.rule_refs}/>}</motion.div>}</>
       :<><div className="model-placeholder"><WorkspaceSignal variant="evidence" reduced={reduced}/><p className="eyebrow">РЕЗУЛЬТАТ ПРОВЕРКИ</p><h3>{modelReady?'Сервер модели готов к работе':'Подключите сервер модели'}</h3><p>{modelReady?'Выберите запись и запустите проверку. События и доказательства появятся здесь.':'Укажите адрес API и ключ вашего сервера. Модель обработает видео на сервере, а события и кадры появятся здесь.'}</p><div className="readiness-list"><div><span><HardDrive size={16}/>Платформа</span><strong className={serviceError?'text-error':health?'text-success':''}>{serviceError?'Недоступна':health?'Доступна':'Проверяем'}</strong></div><div><span><PlugZap size={16}/>Сервер модели</span><strong>{modelReady?'Готов к анализу':modelStatus==='loading'?'Модель загружается':modelStatus==='error'?'Не готов к анализу':'Не подключён'}</strong></div></div><div className="model-actions"><Button variant="quiet" onClick={openConnection}>Подключить сервер<ArrowUpRight size={16}/></Button><Button variant="quiet" onClick={openRegulations}><BookOpen size={15}/>Нормативная база</Button></div></div><div className="demo-invitation"><div><span className="demo-symbol"><Layers3 size={19}/></span><div><strong>Сначала — попробовать</strong><p>Весь сценарий на синтетическом примере.</p></div></div><button className="icon-button" aria-label="Открыть демонстрацию" disabled={Boolean(upload)||restoring} onClick={()=>switchSource('demo')}><ArrowRight size={19}/></button></div></>}
       </motion.div></AnimatePresence><div className="decision-note"><ShieldCheck size={15}/><span>Модель помогает заметить. Окончательное решение принимает проверяющий.</span></div></div>
     </motion.section>
     </div>
    </div>
    <div className="workspace-footer">{isDemo?<div className="demo-state-picker"><label htmlFor="demo-state">Сценарий демо</label><div><select id="demo-state" value={['events','empty','error'].includes(demoState)?demoState:'events'} onChange={e=>{demoTimers.current.forEach(clearTimeout);setDemoState(e.target.value);setSelectedEvent(0);setDemoAt(e.target.value==='events'?12:0);}}><option value="events">Есть события</option><option value="empty">Без событий</option><option value="error">Ошибка сервиса</option></select><ChevronDown size={14}/></div></div>:<span className="footer-note"><LockKeyhole size={13}/>Анализ на вашем сервере</span>}</div>
   </>}
   </main>
  </div>
  <input ref={archiveInputRef} type="file" className="visually-hidden" tabIndex={-1} disabled={Boolean(upload)} accept=".zip,application/zip" aria-label="Выберите ZIP-архив с видеозаписями" onChange={e=>{chooseArchive(e.target.files?.[0]);e.target.value='';}}/>
  <input ref={inputRef} type="file" className="visually-hidden" tabIndex={-1} disabled={Boolean(upload)} accept={formats.join(',')} aria-label={`Выберите видеозапись ${formatLabel}`} onChange={e=>{chooseFile(e.target.files?.[0]);e.target.value='';}}/>
  <AnimatePresence>{notice&&<motion.div className={`toast toast-${notice.tone}`} role={notice.tone==='error'?'alert':'status'} key={notice.id} initial={{opacity:0,y:20,scale:.97}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:12}}>{notice.tone==='error'?<TriangleAlert size={20}/>:notice.tone==='success'?<Check size={20}/>:<CircleHelp size={20}/>}<p>{notice.message}</p><button className="icon-button" onClick={()=>setNotice(null)} aria-label="Закрыть уведомление"><X size={17}/></button></motion.div>}</AnimatePresence>
  <AnimatePresence>
  {modal==='archive-confirm'&&archiveFile&&<Modal title="Загрузить архив записей?" eyebrow="ПАКЕТНАЯ ПРОВЕРКА" onClose={closeModal}>
   <div className="modal-body"><div className="archive-confirm-file"><Archive size={29}/><div><strong>{archiveFile.name}</strong><span>{bytes(archiveFile.size)} · ZIP</span></div></div><div className="archive-warning"><Clock3 size={22}/><div><strong>Обработка архива может занять больше времени.</strong><p>Записи будут проверяться последовательно. Время зависит от количества и длительности видео, а также скорости сервера модели.</p></div></div><p className="body-copy">{!authenticated?'Сначала войдите в платформу. Затем подтвердите загрузку архива.':modelReady?'После загрузки автоматически начнётся проверка. Ответ по каждой записи появится в списке справа.':'Архив можно загрузить сейчас. Для анализа понадобится подключить сервер модели и нажать «Проверить архив».'}</p><p className="archive-limits">В архиве нужны видеозаписи. Файлы других форматов будут отмечены как необработанные.<br/>ZIP до {bytes(archiveLimits.maxBytes)} · не более {archiveLimits.maxFiles} видеозаписей.<br/>{formatLabel} · каждая запись до {bytes(maxBytes)} · общий размер после распаковки до {bytes(archiveLimits.maxExpandedBytes)}.</p></div>
   <footer className="modal-footer"><Button onClick={closeModal}>Отмена</Button><Button variant="primary" onClick={uploadArchive}><Archive size={17}/>{!authenticated?'Войти в платформу':modelReady?'Загрузить и проверить':'Загрузить архив'}</Button></footer>
  </Modal>}
  {modal==='batch-retry'&&<Modal title="Повторить неудачные проверки?" eyebrow="АРХИВ ОПЕРАЦИЙ" onClose={closeModal}><div className="modal-body"><div className="archive-warning"><Clock3 size={22}/><div><strong>Повторная обработка может занять больше времени.</strong><p>В очередь попадут записи, для которых анализ завершился ошибкой. Успешные результаты сохранятся.</p></div></div><p className="body-copy">Если файл не удалось извлечь из архива или его формат не поддерживается, исправьте исходный файл и загрузите новый архив.</p></div><footer className="modal-footer"><Button onClick={closeModal}>Отмена</Button><Button variant="primary" disabled={!modelReady||batches.starting} onClick={()=>{setModal(null);batches.start(batches.batch,true);}}><RefreshCw size={16}/>Повторить проверку</Button></footer></Modal>}
  {modal==='batch-history'&&<Modal title="Архивы операций" eyebrow="ХРАНИЛИЩЕ ПЛАТФОРМЫ" onClose={closeModal}><BatchHistory manager={batches} onSelect={selectBatch} onUpload={()=>{closeModal();archiveInputRef.current?.click();}}/><footer className="modal-footer archive-history-footer"><Button onClick={batches.loadHistory} disabled={batches.historyLoading}><RefreshCw size={16}/>Обновить</Button><Button variant="primary" onClick={()=>{closeModal();archiveInputRef.current?.click();}}><Archive size={17}/>Загрузить архив</Button></footer></Modal>}
  {modal==='library'&&<Modal title="Ваши записи." eyebrow="ХРАНИЛИЩЕ ПЛАТФОРМЫ" onClose={closeModal}><div className="modal-body library-body">{libraryLoading?<div className="library-empty"><LoaderCircle size={27} className="spin"/><p>Загружаем список записей…</p></div>:libraryError?<div className="library-empty"><TriangleAlert size={27}/><p>{libraryError}</p><Button onClick={openLibrary}><RefreshCw size={16}/>Повторить</Button></div>:!library.length?<div className="library-empty"><FolderOpen size={33}/><h3>Начните с первой записи.</h3><p>Сохранённые видео будут доступны здесь после загрузки.</p><Button variant="primary" onClick={()=>{closeModal();inputRef.current?.click();}}><CloudUpload size={17}/>Выбрать видео</Button></div>:<><p className="library-intro">Выберите сохранённую запись, чтобы продолжить просмотр.{capabilities?.retention_days?` Сервис хранит файлы ${capabilities.retention_days} дней.`:''}</p><div className="library-list">{library.map(video=><button className={`library-item ${selected?.id===video.id?'selected':''}`} key={video.id} onClick={async()=>{closeModal();batches.select(null);await restoreVideo(video.id);}}><span className="library-item-icon"><Film size={21}/></span><span><strong>{video.original_name}</strong><span>{bytes(video.size_bytes)} · {video.duration_sec==null?'Длительность не указана':time(video.duration_sec)}{video.created_at&&!Number.isNaN(Date.parse(video.created_at))?` · ${new Date(video.created_at).toLocaleDateString('ru-RU')}`:''}</span></span>{selected?.id===video.id?<Check size={18}/>:<ArrowUpRight size={18}/>}</button>)}</div>{libraryTotal>library.length&&<p className="caption">Показаны последние {library.length} из {libraryTotal} записей.</p>}</>}</div><footer className="modal-footer"><Button onClick={openLibrary}><RefreshCw size={16}/>Обновить</Button><Button variant="primary" onClick={()=>{closeModal();inputRef.current?.click();}}><CloudUpload size={17}/>Добавить запись</Button></footer></Modal>}{modal==='connection'&&<Modal title="Сервер модели" eyebrow="ПОДКЛЮЧЕНИЕ ПО API" onClose={closeModal}>
   {authenticated?<ServerConnection api={api} onStatusChange={refreshHealth} onClose={closeModal}/>:<>
    <div className="modal-body"><div className="connection-overview"><div className="connection-visual"><LockKeyhole size={27}/></div><div><strong>Доступ к платформе</strong><p>Сначала войдите в платформу. Затем можно указать адрес и API-ключ отдельного сервера модели.</p></div></div>
     {serviceError&&<p className="field-error" role="alert">{serviceError}</p>}
     {pendingFile&&<div className="inline-note"><CloudUpload size={18}/><span>После входа будет загружена запись <strong>{pendingFile.name}</strong>.</span></div>}
     <form onSubmit={signIn} className="connection-form"><label htmlFor="api-key">Ключ доступа к платформе</label><div className="input-with-icon"><LockKeyhole size={18}/><input id="api-key" type="password" value={keyText} onChange={e=>setKeyText(e.target.value)} placeholder="Введите ключ платформы" autoComplete="off" spellCheck={false} data-autofocus required aria-describedby="key-hint key-error" aria-invalid={Boolean(keyError)}/></div><p id="key-hint" className="field-hint">Ключ создаёт сессию для работы с записями и настройками платформы.</p>{keyError&&<p id="key-error" className="field-error" role="alert">{keyError}</p>}<Button variant="primary" type="submit" className="full-width" busy={connecting} disabled={connecting||!keyText.trim()}>Войти в платформу<ArrowRight size={17}/></Button></form>
    </div><footer className="modal-footer"><Button onClick={()=>refreshHealth()}><RefreshCw size={16}/>Обновить статус</Button><Button variant="quiet" onClick={closeModal}>Закрыть</Button></footer>
   </>}
  </Modal>}
  {modal==='frame'&&frame&&<Modal title="Деталь в фокусе." eyebrow={`${frame.demo?'СИНТЕТИЧЕСКИЙ КАДР':'ДОКАЗАТЕЛЬСТВО'} / ${time(frame.timestamp_sec)}`} onClose={closeModal} wide><div className="modal-body frame-modal-body"><div className="large-evidence">{frame.demo?<SyntheticScene at={frame.timestamp_sec}/>:frameSource(frame)?<img src={frameSource(frame)} alt={`Кадр ${time(frame.timestamp_sec)}`}/>:<div className="preview-failure"><Film size={34}/><h3>Кадр не передан</h3></div>}</div><div className="frame-context"><Badge tone={frame.demo?'demo':'neutral'} icon={frame.demo?Layers3:Film}>{frame.demo?'Демо':'Результат модели'}</Badge><span>{frame.timestamp_sec==null?'Время не указано':`${Number(frame.timestamp_sec).toFixed(3)} с`}</span></div><p className="frame-description">{frame.demo?'Абстрактная синтетическая схема. Этот кадр не извлечён из вашего видео.':frame.description||'Кадр, переданный сервисом анализа.'}</p></div></Modal>}
  {modal==='delete'&&<Modal title="Удалить запись?" eyebrow="ХРАНИЛИЩЕ ПЛАТФОРМЫ" onClose={()=>!deleting&&closeModal()}><div className="modal-body"><div className="delete-file"><Film size={25}/><strong>{selected?.original_name}</strong></div><p className="body-copy">Видео и связанные данные будут удалены из сервиса. Исходный файл на вашем устройстве останется доступен.</p></div><footer className="modal-footer"><Button disabled={deleting} onClick={closeModal}>Оставить запись</Button><Button variant="danger" busy={deleting} disabled={deleting} onClick={deleteVideo}><Trash2 size={17}/>Удалить</Button></footer></Modal>}</AnimatePresence>
 </MotionConfig>;
}

function DemoNotice({show}){return show?<div className="demo-notice"><Layers3 size={16}/><span>Синтетический пример. Ваша запись не анализировалась.</span></div>:null;}
function ResultWarnings({warnings}){const items=Array.isArray(warnings)?warnings.filter(w=>typeof w==='string'&&w.trim()):[];return items.length?<div className="result-warnings"><TriangleAlert size={18}/><div><strong>Ограничения проверки</strong>{items.map((text,i)=><p key={i}>{text}</p>)}</div></div>:null;}
function RuleReferences({refs}){
 const sources=Array.isArray(refs)?refs:[];
 const safeLink=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};
 return <div className="rule-reference"><FileText size={18}/><div>{sources.length?<><strong>Нормативное основание</strong><p>Статус от адаптера не подтверждает правовую оценку события. Сверьте пункт в нормативной базе.</p>{sources.map((ref,i)=>{const url=safeLink(ref.url);return <div className="rule-source" key={i}>{url?<a href={url} target="_blank" rel="noopener noreferrer">{ref.title||'Источник без названия'}<ArrowUpRight size={13}/></a>:<span>{ref.title||'Источник без названия'}</span>}{ref.section&&<p>{ref.section}</p>}<span className={ref.verified?'text-success':''}>{ref.verified?'Адаптер отметил источник как проверенный':'Источник требует проверки'}</span></div>;})}</>:<><strong>Нормативное основание не указано</strong><p>Проверенный документ и пункт появятся после передачи данных сервисом.</p></>}</div></div>;
}
function ResultCoverage({analysis}){
 const coverage=analysis?.coverage;
 if(!coverage)return null;
 return <div className="inline-note"><ScanLine size={16}/><div><strong>{coverage.complete?'Запланированные окна обработаны':'Проверка выполнена частично'}</strong><p>{coverage.analyzed_windows} из {coverage.candidate_windows} окон · {time(coverage.duration_sec)} видео. {coverage.note}</p></div></div>;
}
