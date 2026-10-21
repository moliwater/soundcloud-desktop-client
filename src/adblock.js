// Built-in ad blocker, designed to cost no memory.
//
// Instead of loading a full filter list (tens of thousands of rules, several
// MB of RAM), it gives Chromium a short list of URL patterns. Chromium checks
// them natively in its network code, and the app's JavaScript only runs for
// requests that are actually blocked. Blocking ads also means their scripts,
// images and frames never load, so the page itself uses less memory.
//
// Sources: EasyList (https://github.com/easylist/easylist) for SoundCloud's
// audio ads, plus the ad and tracking hosts observed on soundcloud.com itself
// (October 2026). If ads appear again, add the new host to a list below.

// SoundCloud's own audio-ad endpoint (EasyList: ||soundcloud.com/audio-ads?)
const SOUNDCLOUD_RULES = ['*://*.soundcloud.com/audio-ads*'];

// Ad serving, header bidding and ad verification networks.
const AD_DOMAINS = [
  // Google ad stack
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'adservice.google.com',
  '2mdn.net',
  // Audio ads
  'adswizz.com',
  'tritondigital.com',
  'spotxchange.com',
  'spotx.tv',
  'springserve.com',
  'freewheel.tv',
  'fwmrm.net',
  'stickyadstv.com',
  'tremorhub.com',
  // Header bidding / exchanges
  'amazon-adsystem.com',
  'adnxs.com',
  'adnxs.net',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'indexexchange.com',
  'criteo.com',
  'criteo.net',
  'adsrvr.org',
  '33across.com',
  'sharethrough.com',
  'triplelift.com',
  '3lift.com',
  'lijit.com',
  'sovrn.com',
  'yieldmo.com',
  'smartadserver.com',
  'teads.tv',
  'media.net',
  'contextweb.com',
  'gumgum.com',
  'onetag-sys.com',
  'adform.net',
  'sonobi.com',
  'bidswitch.net',
  'improvedigital.com',
  '360yield.com',
  'richaudience.com',
  'smaato.net',
  'kargo.com',
  'seedtag.com',
  'adkernel.com',
  'emxdgt.com',
  'e-planning.net',
  'yieldlab.net',
  'adtelligent.com',
  'advertising.com',
  'ads.yahoo.com',
  'serving-sys.com',
  'flashtalking.com',
  'adroll.com',
  'taboola.com',
  'outbrain.com',
  'creativecdn.com',
  'smilewanted.com',
  'fastclick.net',
  // Ad wrappers / ad management SoundCloud's pages use
  'aditude.io',
  'aditude.cloud',
  'htlbid.com',
  'prebid.cloud',
  'adtrafficquality.google',
  'script.ac',
  'clean.gg',
  // Ad verification / measurement
  'adsafeprotected.com',
  'doubleverify.com',
  'moatads.com',
  'moatpixel.com',
  'mathtag.com',
  // Ad audience / ID syncing
  'demdex.net',
  'krxd.net',
  'bluekai.com',
  'exelator.com',
  'agkn.com',
  'tapad.com',
  'liadm.com',
  'id5-sync.com',
  'crwdcntrl.net',
  'rlcdn.com',
];

// Tracking hosts SoundCloud's pages load (EasyPrivacy), blocked with ads.
const TRACKING_DOMAINS = [
  'googletagmanager.com',
  'analytics.google.com',
  'analytics.tiktok.com',
  'tiktokw.us',
  'alb.reddit.com',
  'analytics.yahoo.com',
  'appsflyersdk.com',
  'moengage.com',
];
const TRACKING_HOSTS = [
  'eventgateway.soundcloud.com', // SoundCloud's own usage telemetry
  'telemetry.soundcloud.com',
  'wa.onelink.me',
  'ams-pageview-public.s3.amazonaws.com',
];
// Exact pixel addresses, so "Continue with Facebook" sign-in keeps working.
const TRACKING_URLS = ['*://connect.facebook.net/*/fbevents.js*', '*://www.facebook.com/tr*', '*://www.redditstatic.com/ads/*'];

// Always blocked: third-party analytics trackers.
const TRACKER_DOMAINS = ['google-analytics.com', 'scorecardresearch.com', 'quantserve.com'];

const domainPatterns = (domains) => domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
const hostPatterns = (hosts) => hosts.map((h) => `*://${h}/*`);

function patterns(adblock) {
  const list = domainPatterns(TRACKER_DOMAINS);
  if (adblock) {
    list.push(...SOUNDCLOUD_RULES, ...domainPatterns(AD_DOMAINS));
    list.push(...domainPatterns(TRACKING_DOMAINS), ...hostPatterns(TRACKING_HOSTS), ...TRACKING_URLS);
  }
  return list;
}

// Hide the empty boxes that ads would have filled.
const HIDE_CSS = `
  [id^="div-gpt-ad"], [id^="google_ads_"], iframe[src*="doubleclick.net"],
  iframe[src*="googlesyndication.com"], iframe[id^="google_ads_iframe"],
  .sidebarModule .ad-slot, [data-testid*="ad-slot"], .l-ad-banner {
    display: none !important;
  }
`;

let blockedCount = 0;

// Install (or update) the request filter on a session. Electron allows one
// onBeforeRequest listener per session, so this replaces the previous one.
function apply(ses, adblock) {
  ses.webRequest.onBeforeRequest({ urls: patterns(adblock) }, (_details, cb) => {
    blockedCount++;
    cb({ cancel: true });
  });
}

module.exports = { apply, HIDE_CSS, patterns, blocked: () => blockedCount };
