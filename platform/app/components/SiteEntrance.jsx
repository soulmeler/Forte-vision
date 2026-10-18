import { useEffect, useState } from 'react';
import './site-entrance.css';

// A brief visual entrance, independent of API or model readiness.
// Any interaction dismisses it immediately; it never delays a request.
export function useSiteEntrance(reduced) {
  const [entering, setEntering] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (reduced || !entering) {
      if (reduced) setEntering(false);
      return;
    }
    const finish = () => setEntering(false);
    const timer = window.setTimeout(finish, 1050);
    window.addEventListener('pointerdown', finish, { once: true, capture: true });
    window.addEventListener('keydown', finish, { once: true, capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', finish, true);
      window.removeEventListener('keydown', finish, true);
    };
  }, [reduced, entering]);
  return entering;
}

export default function SiteEntrance({ active, dark }) {
  if (!active) return null;
  return <div className="site-entrance" aria-hidden="true">
    <div className="entrance-halo" />
    <div className="entrance-signature">
      <div className="entrance-focus"><i /><i /><i /><i /></div>
      <div className="entrance-wordmark">
        <img src={`/brand/forte-logo-${dark ? 'white' : 'magenta'}.svg`} alt="" />
        <span />
        <strong>vision</strong>
      </div>
      <span className="entrance-caption">Внимание к деталям</span>
      <div className="entrance-trace"><span /></div>
    </div>
  </div>;
}
