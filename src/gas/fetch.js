// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Fetching, the way Apps Script does it.
//
// UrlFetchApp returns a response rather than a promise, which is the whole
// reason the build can drop async and await: there is nothing to wait for.
// This wraps it in just enough of the shape boards.js expects — ok, status,
// json() — so that file needs no knowledge of where it is running.
//
// muteHttpExceptions is on because a 404 from a board is an answer, not a
// crash: it means the slug is wrong, and getJSON turns that into a message
// naming the status.
// ---------------------------------------------------------------------------

const urlFetch = () => {
  const found = globalThis.UrlFetchApp;
  if (!found) throw new Error('UrlFetchApp is not available — this runs inside Apps Script');
  return found;
};

export function gasFetch(url, options = {}) {
  const res = urlFetch().fetch(String(url), {
    method: 'get',
    headers: options.headers || {},
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true,
  });

  const status = res.getResponseCode();
  let text = null;
  const body = () => (text === null ? (text = res.getContentText()) : text);

  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => body(),
    json: () => JSON.parse(body()),
  };
}

/** Blocking, because everything here is. */
export function gasSleep(ms) {
  const utils = globalThis.Utilities;
  if (utils && typeof utils.sleep === 'function') utils.sleep(ms);
}
