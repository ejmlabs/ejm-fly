export interface ShaderPatch { find: string; replace: string }

/**
 * Applies every patch to a shader source, or returns null if any target text is
 * missing, so a three.js upgrade can never leave a half-patched shader.
 */
export function patchShader(source: string, patches: readonly ShaderPatch[]): string | null {
  let out = source;
  for (const patch of patches) {
    if (!out.includes(patch.find)) return null;
    out = out.replace(patch.find, () => patch.replace);
  }
  return out;
}
