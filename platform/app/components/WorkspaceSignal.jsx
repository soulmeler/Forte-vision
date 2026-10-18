import React, { useEffect, useRef } from 'react';

/** Decorative geometry, independent of analysis or upload progress. */
export default function WorkspaceSignal({ variant = 'scan', reduced = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    let visible = true;
    const sync = () => { node.dataset.paused = String(reduced || !visible || document.hidden); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(node);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, [reduced]);
  const move = event => {
    if (reduced || event.pointerType === 'touch') return;
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--signal-x', `${((event.clientX - box.left) / box.width - .5) * 12}deg`);
    event.currentTarget.style.setProperty('--signal-y', `${-((event.clientY - box.top) / box.height - .5) * 9}deg`);
  };
  const reset = event => { event.currentTarget.style.setProperty('--signal-x', '0deg'); event.currentTarget.style.setProperty('--signal-y', '0deg'); };
  return <div ref={ref} className={`workspace-signal workspace-signal--${variant}`} aria-hidden="true" onPointerMove={move} onPointerLeave={reset}>
    <div className="signal-coordinate signal-coordinate--a"/><div className="signal-coordinate signal-coordinate--b"/>
    <div className="signal-orbit"><i/></div>
    <div className="signal-depth">
      <div className="signal-sheet signal-sheet--back"/><div className="signal-sheet signal-sheet--middle"/>
      <div className="signal-sheet signal-sheet--front"><span className="signal-glyph"/><span className="signal-rule"/><span className="signal-rule signal-rule--short"/><span className="signal-scan"/></div>
    </div>
    <span className="signal-satellite signal-satellite--a"/><span className="signal-satellite signal-satellite--b"/>
    <div className="signal-baseline"><i/><i/><i/></div>
  </div>;
}
