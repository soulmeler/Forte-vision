import { useEffect } from 'react';

const ATTRIBUTES = ['data-pointer-feedback', 'data-pointer-hover', 'data-pointer-pressed', 'data-pointer-positioned'];
const PROPERTIES = ['--vf-pointer-x', '--vf-pointer-y', '--vf-pointer-radius'];

/**
 * Delegated button feedback: call once near the top of App.
 * CSS owns the decorative ::before layer; React's children and Motion's inline
 * transforms are never changed. No state updates occur during pointer movement.
 */
export default function usePointerFeedback({ reduced = false } = {}) {
  useEffect(() => {
    const finePointer = window.matchMedia('(any-hover: hover) and (any-pointer: fine)');
    const reducedPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const owned = new Map();
    let hovered = null;
    let pressed = null;
    let keyboardPressed = null;
    let pendingPoint = null;
    let animationFrame = 0;
    let disposed = false;

    const reduceMotion = () => reduced || reducedPreference.matches;
    const enabled = button => button?.isConnected && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true';
    const buttonAt = target => target instanceof Element ? target.closest('button, summary') : null;

    function restore(button) {
      const snapshot = owned.get(button);
      if (!snapshot) return;
      window.clearTimeout(snapshot.cleanupTimer);
      snapshot.attributes.forEach(([attribute, value]) => {
        if (value === null) button.removeAttribute(attribute);
        else button.setAttribute(attribute, value);
      });
      snapshot.properties.forEach(([property, value, priority]) => {
        if (value) button.style.setProperty(property, value, priority);
        else button.style.removeProperty(property);
      });
      owned.delete(button);
      if (hovered === button) hovered = null;
      if (pressed === button) pressed = null;
      if (keyboardPressed === button) keyboardPressed = null;
      if (pendingPoint?.button === button) pendingPoint = null;
      if (!owned.size) observer.disconnect();
    }

    const observer = new MutationObserver(() => {
      for (const button of owned.keys()) if (!enabled(button)) restore(button);
    });

    function prepare(button) {
      if (!enabled(button)) return false;
      let snapshot = owned.get(button);
      if (!snapshot) {
        snapshot = {
          attributes: ATTRIBUTES.map(attribute => [attribute, button.getAttribute(attribute)]),
          properties: PROPERTIES.map(property => [property, button.style.getPropertyValue(property), button.style.getPropertyPriority(property)]),
          cleanupTimer: 0,
        };
        owned.set(button, snapshot);
        // Establish a containing block only when the component does not have one.
        if (getComputedStyle(button).position === 'static') button.setAttribute('data-pointer-positioned', 'true');
        button.setAttribute('data-pointer-feedback', 'true');
        button.style.setProperty('--vf-pointer-x', '50%');
        button.style.setProperty('--vf-pointer-y', '50%');
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
      }
      window.clearTimeout(snapshot.cleanupTimer);
      return true;
    }

    function release(button) {
      if (!button || button === hovered || button === pressed || button === keyboardPressed) return;
      const snapshot = owned.get(button);
      if (!snapshot) return;
      if (reduceMotion() || !enabled(button)) restore(button);
      else snapshot.cleanupTimer = window.setTimeout(() => restore(button), 180);
    }

    function flushPoint() {
      animationFrame = 0;
      const point = pendingPoint;
      pendingPoint = null;
      if (!point || !owned.has(point.button) || !enabled(point.button) || disposed) return;
      const rect = point.button.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = reduceMotion() ? rect.width / 2 : Math.min(rect.width, Math.max(0, point.x - rect.left));
      const y = reduceMotion() ? rect.height / 2 : Math.min(rect.height, Math.max(0, point.y - rect.top));
      point.button.style.setProperty('--vf-pointer-x', `${x.toFixed(1)}px`);
      point.button.style.setProperty('--vf-pointer-y', `${y.toFixed(1)}px`);
      point.button.style.setProperty('--vf-pointer-radius', `${Math.min(130, Math.max(30, rect.width * .5)).toFixed(0)}px`);
    }

    function queuePoint(button, event) {
      pendingPoint = { button, x: event.clientX, y: event.clientY };
      if (!animationFrame) animationFrame = window.requestAnimationFrame(flushPoint);
    }

    function leave() {
      const button = hovered;
      hovered = null;
      if (button) {
        button.setAttribute('data-pointer-hover', 'false');
        release(button);
      }
    }

    function enter(event) {
      if (!finePointer.matches || event.pointerType === 'touch') return;
      const button = buttonAt(event.target);
      if (!enabled(button)) { leave(); return; }
      if (hovered !== button) {
        leave();
        if (!prepare(button)) return;
        hovered = button;
        button.setAttribute('data-pointer-hover', 'true');
      }
      queuePoint(button, event);
    }

    function move(event) {
      if (event.pointerType === 'touch' || !finePointer.matches) return;
      const button = buttonAt(event.target);
      if (button !== hovered) { enter(event); return; }
      if (hovered && !reduceMotion()) queuePoint(hovered, event);
    }

    function out(event) {
      if (!hovered) return;
      if (event.relatedTarget instanceof Node && hovered.contains(event.relatedTarget)) return;
      leave();
    }

    function down(event) {
      if (event.button !== 0) return;
      const button = buttonAt(event.target);
      if (!prepare(button)) return;
      if (pressed && pressed !== button) up();
      pressed = button;
      button.setAttribute('data-pointer-pressed', 'true');
      queuePoint(button, event);
    }

    function up() {
      const button = pressed;
      pressed = null;
      if (button) {
        button.setAttribute('data-pointer-pressed', 'false');
        release(button);
      }
    }

    function keydown(event) {
      if (![' ', 'Enter'].includes(event.key) || event.repeat) return;
      const button = buttonAt(event.target);
      if (!prepare(button)) return;
      if (keyboardPressed && keyboardPressed !== button) keyup();
      keyboardPressed = button;
      button.setAttribute('data-pointer-pressed', 'true');
    }

    function keyup(event) {
      if (event && ![' ', 'Enter'].includes(event.key)) return;
      const button = keyboardPressed;
      keyboardPressed = null;
      if (button) {
        button.setAttribute('data-pointer-pressed', 'false');
        release(button);
      }
    }

    function clearInteraction() { leave(); up(); keyup(); }
    function visibilityChange() { if (document.hidden) clearInteraction(); }
    function preferenceChange() {
      clearInteraction();
      for (const button of [...owned.keys()]) restore(button);
    }

    const listeners = [['pointerover', enter], ['pointermove', move], ['pointerout', out], ['pointerdown', down],
      ['pointerup', up], ['pointercancel', clearInteraction], ['keydown', keydown], ['keyup', keyup], ['visibilitychange', visibilityChange]];
    listeners.forEach(([event, handler]) => document.addEventListener(event, handler, { passive: true, capture: true }));
    window.addEventListener('blur', clearInteraction);
    window.addEventListener('scroll', leave, { passive: true, capture: true });
    window.addEventListener('resize', leave, { passive: true });
    finePointer.addEventListener('change', preferenceChange);
    reducedPreference.addEventListener('change', preferenceChange);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      listeners.forEach(([event, handler]) => document.removeEventListener(event, handler, true));
      window.removeEventListener('blur', clearInteraction);
      window.removeEventListener('scroll', leave, true);
      window.removeEventListener('resize', leave);
      finePointer.removeEventListener('change', preferenceChange);
      reducedPreference.removeEventListener('change', preferenceChange);
      observer.disconnect();
      for (const button of [...owned.keys()]) restore(button);
    };
  }, [reduced]);
}
