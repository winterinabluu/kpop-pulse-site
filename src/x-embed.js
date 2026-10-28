import { providerFrameUrl } from './x-frame.mjs';

const instance = new URLSearchParams(location.hash.slice(1)).get('instance');
const root = document.querySelector('#x-provider-root');
let started = false;
function send(phase) { parent.postMessage({type:'kpop-x-status', instance, phase}, '*'); }
if (parent === window || !instance) {
  root.textContent = '请从 Kpop Pulse 页面选择 X 内容。';
} else {
  window.addEventListener('message', event => {
    const data = event.data;
    if (started || event.source !== parent || event.origin !== new URL(document.URL).origin ||
        data?.type !== 'kpop-x-start' || data.instance !== instance) return;
    let url;
    try { url = providerFrameUrl(data.kind, data.value, document.URL); }
    catch { send('unavailable'); return; }
    started = true;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.className = 'x-provider-frame'; frame.title = data.kind === 'profile' ? 'X 官方时间线' : 'X 原帖';
    frame.referrerPolicy = 'no-referrer'; frame.src = url;
    let finished = false;
    const stop = () => {
      if (finished) return; finished = true; root.replaceChildren(); send('unavailable');
    };
    const timer = setTimeout(stop, 10000);
    frame.addEventListener('load', () => {
      if (finished) return; finished = true; clearTimeout(timer);
      // A cross-origin load event proves a frame was established, not that X returned posts.
      send('ready');
    });
    frame.addEventListener('error', stop);
    root.replaceChildren(frame);
  });
}
