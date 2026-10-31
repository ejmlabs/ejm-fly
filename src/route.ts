/** Seconds the indicator stays after a region change before it fades. */
export const ROUTE_SECONDS = 6;

export interface RouteIndicator {
  /** Whether the indicator is showing, and what it says: the region and the distance swum. */
  readonly visible: boolean;
  readonly text: string;
  /** Turns it on (by default it shows at once for ROUTE_SECONDS, so the switch answers) or off. */
  setEnabled: (on: boolean, region: number, metres: number, show?: boolean) => void;
  /** Call every frame: a change of region brings it in, and ROUTE_SECONDS later it goes. */
  update: (dt: number, region: number, metres: number) => void;
}

const label = (name: string, metres: number): string => {
  const km = metres / 1000;
  return `${name} · ${String(km < 100 ? km.toFixed(1) : Math.round(km))} km`;
};

/** The route indicator's state, apart from the page: off until asked for, in on a region change, out after six seconds. */
export function createRoute(names: readonly string[]): RouteIndicator {
  let enabled = false;
  let region = -1;
  let left = 0;
  const state = { visible: false, text: '' };

  const read = (metres: number): void => {
    state.text = label(names[region] ?? '', metres);
  };

  return {
    get visible() {
      return state.visible;
    },
    get text() {
      return state.text;
    },
    setEnabled(on, current, metres, show = true) {
      enabled = on;
      region = current;
      left = on && show ? ROUTE_SECONDS : 0;
      if (left > 0) read(metres);
      state.visible = left > 0;
    },
    update(dt, current, metres) {
      if (!enabled) return;
      if (current !== region) {
        region = current;
        left = ROUTE_SECONDS;
      }
      if (left > 0) {
        left = Math.max(0, left - dt);
        read(metres);
      }
      state.visible = left > 0;
    },
  };
}
