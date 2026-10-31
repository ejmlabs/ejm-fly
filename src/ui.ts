import { isPace, type Pace } from './pace.js';

const find = (...ids: string[]): HTMLElement | null =>
  ids.map((id) => document.getElementById(id)).find(Boolean) ?? null;

export interface UIActions {
  share: () => string;
  newSeed: () => void;
  sound: () => void;
  /** The route indicator switch in the info panel. */
  route: (on: boolean) => void;
  /** The switch for following the whale down on its dives. */
  dives: (on: boolean) => void;
  /** The travel speed choice in the info panel. */
  pace: (pace: Pace) => void;
  /** Back to the default follow camera. */
  resetView: () => void;
}

export interface UIController {
  ready: () => void;
  error: (message: string) => void;
  sync: (state: { seed: number; sound: boolean; route: boolean; dives: boolean; pace: Pace }) => void;
  /** Shows the reset view control while the user's own view is on. */
  showReset: (visible: boolean) => void;
  /** Shows or hides the route indicator and sets its text. */
  showRoute: (visible: boolean, text: string) => void;
  announce: (message: string) => void;
  dispose: () => void;
}

export function createUI(actions: UIActions): UIController {
  const veil = find('veil');
  const veilText = find('veilText');
  const about = find('about');
  const aboutBtn = find('aboutBtn');
  const aboutClose = find('aboutClose');
  const shareBtn = find('shareBtn');
  const seedBtn = find('seedBtn');
  const soundBtn = find('soundBtn');
  const seedLabel = find('seedLabel', 'seedValue');
  const hud = find('hud');
  const status = find('status');
  const toast = find('toast');
  const title = find('title');
  const route = find('route');
  const routeToggle = find('routeToggle') as HTMLInputElement | null;
  const diveToggle = find('diveToggle') as HTMLInputElement | null;
  const paceChoice = find('pace');
  const resetBtn = find('resetBtn');

  const controller = new AbortController();
  const { signal } = controller;
  let aboutOpen = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const listen = (el: EventTarget | null | undefined, type: string, handler: EventListener) =>
    el?.addEventListener(type, handler, { signal });

  const wake = () => {
    document.body.classList.remove('is-idle');
    hud?.classList.remove('is-idle');
    title?.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!aboutOpen) {
        document.body.classList.add('is-idle');
        hud?.classList.add('is-idle');
        title?.classList.add('is-idle');
      }
    }, 4500);
  };

  const announce = (message: string) => {
    if (status) status.textContent = message;
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
    }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (status) status.textContent = '';
      toast?.classList.remove('show');
    }, 2200);
  };

  const setAbout = (open: boolean) => {
    if (!about) return;
    aboutOpen = open;
    (about as HTMLElement & { inert: boolean }).inert = !open;
    about.classList.toggle('open', open);
    aboutBtn?.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('about-open', open);
    if (open) (aboutClose ?? about).focus();
    else aboutBtn?.focus();
    wake();
  };

  listen(aboutBtn, 'click', () => { setAbout(!aboutOpen); });
  listen(aboutClose, 'click', () => { setAbout(false); });
  listen(shareBtn, 'click', (event) => {
    event.preventDefault();
    const url = actions.share();
    navigator.clipboard.writeText(url).then(
      () => { announce('link copied'); },
      () => { announce(url); },
    );
  });
  listen(seedBtn, 'click', () => { actions.newSeed(); });
  listen(soundBtn, 'click', () => { actions.sound(); });
  listen(routeToggle, 'change', () => { actions.route(Boolean(routeToggle?.checked)); });
  listen(diveToggle, 'change', () => { actions.dives(Boolean(diveToggle?.checked)); });
  listen(paceChoice, 'change', (event) => {
    const value = (event.target as HTMLInputElement).value;
    if (isPace(value)) actions.pace(value);
  });
  listen(resetBtn, 'click', () => { actions.resetView(); });
  listen(document, 'keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Escape' && aboutOpen) setAbout(false);
  });
  listen(document, 'pointerdown', wake);
  listen(document, 'pointermove', wake);
  wake();

  return {
    ready() {
      document.body.dataset['ready'] = 'true';
      veil?.classList.add('gone');
      setTimeout(() => veil?.setAttribute('hidden', ''), 2000);
      if (hud) hud.inert = false;
    },
    error(message: string) {
      if (veilText) veilText.textContent = message;
      veil?.classList.remove('gone');
      veil?.removeAttribute('hidden');
      document.body.dataset['ready'] = 'error';
    },
    sync({ seed, sound, route: routeOn, dives, pace }) {
      if (seedLabel) seedLabel.textContent = String(seed >>> 0);
      if (routeToggle) routeToggle.checked = routeOn;
      if (diveToggle) diveToggle.checked = dives;
      const paceInput = paceChoice?.querySelector<HTMLInputElement>(`input[value="${pace}"]`);
      if (paceInput) paceInput.checked = true;
      if (soundBtn) {
        soundBtn.setAttribute('aria-pressed', String(sound));
        soundBtn.title = sound ? 'Sound on' : 'Sound off';
      }
    },
    showReset(visible) {
      if (resetBtn) resetBtn.hidden = !visible;
    },
    showRoute(visible, text) {
      if (!route) return;
      if (route.textContent !== text) route.textContent = text;
      route.classList.toggle('show', visible);
    },
    announce,
    dispose() {
      controller.abort();
      clearTimeout(statusTimer);
      clearTimeout(idleTimer);
    },
  };
}
