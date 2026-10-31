/** The 2D context of a canvas the page made itself; a browser without one cannot draw the scene's textures. */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  return context;
}
