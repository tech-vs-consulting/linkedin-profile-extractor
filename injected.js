// Runs in the page's MAIN world at document_start.
// Mirrors every Voyager API response back to the content script, which lives in
// the isolated world and cannot see the page's fetch/XHR traffic on its own.
(() => {
  const TAG = '__lpe_voyager__';
  if (window[TAG]) return;
  window[TAG] = true;

  const MAX_BYTES = 4_000_000;

  const isVoyager = (url) =>
    typeof url === 'string' && url.includes('/voyager/api/');

  const publish = (url, text) => {
    if (!text || text.length > MAX_BYTES || text[0] !== '{') return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    window.postMessage({ __lpe: 'voyager', url, payload: json }, '*');
  };

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (isVoyager(url)) {
        response
          .clone()
          .text()
          .then((text) => publish(url, text))
          .catch(() => {});
      }
    } catch {
      /* never break the page */
    }
    return response;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lpeUrl = url;
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (isVoyager(this.__lpeUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            publish(this.__lpeUrl, this.responseText);
          }
        } catch {
          /* ignore */
        }
      });
    }
    return nativeSend.apply(this, arguments);
  };
})();
