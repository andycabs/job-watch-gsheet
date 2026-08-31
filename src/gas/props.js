// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The script's own store.
//
// Where the hour of the daily run and the digest destination live: alongside
// the script rather than in the sheet, so they survive somebody clearing a tab
// and never show up as a row anyone can break.
//
// One accessor rather than one per file — two copies collided the moment the
// build flattened them into a single scope, which is the bundler doing a job
// no reviewer was doing.
// ---------------------------------------------------------------------------

export function scriptProperties() {
  const service = globalThis.PropertiesService;
  if (!service) throw new Error('PropertiesService is not available');
  return service.getScriptProperties();
}

/** Reading never throws: a missing store means the setting is simply unset. */
export function readProperty(key, fallback = null) {
  try {
    const value = scriptProperties().getProperty(key);
    return value === null || value === undefined || value === '' ? fallback : value;
  } catch {
    return fallback;
  }
}
