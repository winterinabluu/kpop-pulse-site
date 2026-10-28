// Display-frame routes observed from X's official widgets SDK; these are not Data API collectors.
// Keep the original-page fallback: provider routes and anonymous availability can change.
export function providerFrameUrl(kind, value, origin) {
  if (typeof value !== 'string') throw new TypeError('Invalid X identifier');
  let url;
  if (kind === 'profile' && /^[A-Za-z0-9_]{1,15}$/.test(value)) {
    url = new URL('https://syndication.twitter.com/srv/timeline-profile/screen-name/' + value);
    url.searchParams.set('maxHeight', '460px');
    url.searchParams.set('showHeader', 'true');
    url.searchParams.set('showReplies', 'false');
    url.searchParams.set('hideHeader', 'false');
    url.searchParams.set('hideFooter', 'false');
    url.searchParams.set('hideBorder', 'false');
    url.searchParams.set('hideScrollBar', 'false');
    url.searchParams.set('transparent', 'false');
  } else if (kind === 'post' && /^[1-9][0-9]{0,19}$/.test(value)) {
    url = new URL('https://platform.twitter.com/embed/Tweet.html');
    url.searchParams.set('id', value);
    url.searchParams.set('hideCard', 'false');
    url.searchParams.set('hideThread', 'false');
  } else throw new TypeError('Invalid X frame target');
  url.searchParams.set('dnt', 'true');
  url.searchParams.set('frame', 'false');
  url.searchParams.set('features', 'e30=');
  url.searchParams.set('theme', 'light');
  url.searchParams.set('lang', 'zh-cn');
  // Never send the user's filters, query string, hash or instance identifier to the provider.
  if (origin) url.searchParams.set('origin', new URL(origin).origin);
  return url.href;
}
