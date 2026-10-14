import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWalletRoute, layerCapabilities, openWalletTab, type LayerCapabilities } from './layers';

const EXTENSION_ID = 'ckfkljfbjkmkjkkjkpbnmoehfipdcoin';
const WEBVIEW2_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

type Globals = Record<string, unknown>;

function withGlobals(values: Globals, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Globals)[key];
    }
  };
  return Promise.resolve().then(run).finally(restore);
}

/** A browser-like navigator with every API a layer collector could use. */
function fullNavigator(userAgent = CHROME_UA) {
  return {
    userAgent,
    credentials: { get: async () => null, create: async () => null },
    geolocation: { getCurrentPosition: () => undefined },
    bluetooth: { requestDevice: async () => null },
  };
}

const browserApis = (userAgent?: string): Globals => ({
  navigator: fullNavigator(userAgent),
  PublicKeyCredential: function PublicKeyCredential() {},
  isSecureContext: true,
});

function extensionPage(surface: string | undefined, extra: Globals = {}): Globals {
  return {
    ...browserApis(),
    location: { protocol: 'chrome-extension:', host: EXTENSION_ID, hash: '' },
    chrome: { runtime: { id: EXTENSION_ID, getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` } },
    document: { documentElement: { dataset: surface ? { surface } : {} } },
    ...extra,
  };
}

const NOTHING = { passkey: 'none', geolocation: 'none', bluetooth: 'none', wifiRadio: false } as const;

test('desktop on Windows uses the native commands, never WebView2 browser APIs', async () => {
  await withGlobals({ isTauri: true, ...browserApis(WEBVIEW2_UA) }, () => {
    assert.deepEqual(layerCapabilities(), {
      surface: 'desktop', passkey: 'native', geolocation: 'native', bluetooth: 'native', wifiRadio: true, ceremonyInline: true,
    } satisfies LayerCapabilities);
  });
});

test('a non-Windows desktop build has no layer collectors', async () => {
  await withGlobals({ isTauri: true, ...browserApis(MAC_UA) }, () => {
    assert.deepEqual(layerCapabilities(), { surface: 'desktop', ...NOTHING, ceremonyInline: true });
  });
  await withGlobals({ isTauri: true, navigator: { userAgent: '' } }, () => {
    assert.deepEqual(layerCapabilities(), { surface: 'desktop', ...NOTHING, ceremonyInline: true });
  });
});

test('extension side panel: browser collectors, but ceremonies hand off to the full tab', async () => {
  await withGlobals(extensionPage('sidepanel'), () => {
    assert.deepEqual(layerCapabilities(), {
      surface: 'extension', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: false,
    } satisfies LayerCapabilities);
  });
});

test('extension full tab runs ceremonies inline', async () => {
  await withGlobals(extensionPage('tab'), () => {
    assert.deepEqual(layerCapabilities(), {
      surface: 'extension', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: true,
    } satisfies LayerCapabilities);
  });
});

test('an extension popup or an undeclared extension page never runs ceremonies inline', async () => {
  for (const surface of ['popup', undefined, 'other']) {
    await withGlobals(extensionPage(surface), () => {
      assert.equal(layerCapabilities().surface, 'extension');
      assert.equal(layerCapabilities().ceremonyInline, false, String(surface));
    });
  }
});

test('a look-alike extension origin is treated as the web, not as ANTARA', async () => {
  await withGlobals(extensionPage('tab', { location: { protocol: 'chrome-extension:', host: 'a'.repeat(32), hash: '' } }), () => {
    assert.equal(layerCapabilities().surface, 'web');
  });
});

test('web: each collector exists only when its browser API does', async () => {
  await withGlobals({ ...browserApis(), location: { protocol: 'https:', host: 'antara.tech' } }, () => {
    assert.deepEqual(layerCapabilities(), {
      surface: 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: true,
    } satisfies LayerCapabilities);
  });
  // Safari/Firefox: no Web Bluetooth.
  const noBluetooth = { ...fullNavigator(), bluetooth: undefined };
  await withGlobals({ ...browserApis(), navigator: noBluetooth }, () => {
    assert.equal(layerCapabilities().bluetooth, 'none');
    assert.equal(layerCapabilities().passkey, 'browser');
  });
  // No PublicKeyCredential interface: no passkeys even if navigator.credentials exists.
  await withGlobals({ ...browserApis(), PublicKeyCredential: undefined }, () => {
    assert.equal(layerCapabilities().passkey, 'none');
  });
  await withGlobals({ ...browserApis(), navigator: { ...fullNavigator(), credentials: { get: async () => null } } }, () => {
    assert.equal(layerCapabilities().passkey, 'none');
  });
});

test('an insecure context gets no collectors at all', async () => {
  await withGlobals({ ...browserApis(), isSecureContext: false }, () => {
    assert.deepEqual(layerCapabilities(), { surface: 'web', ...NOTHING, ceremonyInline: true });
  });
});

test('plain Node (no browser APIs) reports nothing available', () => {
  assert.deepEqual(layerCapabilities(), { surface: 'web', ...NOTHING, ceremonyInline: true });
});

test('only short wallet anchors are routes', () => {
  for (const route of ['#vault', '#portfolio', '#Vault']) assert.equal(isWalletRoute(route), true, route);
  for (const route of ['', '#', 'vault', '#vault/x', '#vault?x=1', '#a'.padEnd(27, 'b'), '#javascript:alert(1)', '#../x']) {
    assert.equal(isWalletRoute(route), false, route);
  }
});

function tabsRecorder(fail = false) {
  const created: Array<{ url: string; active?: boolean }> = [];
  const create = async (options: { url: string; active?: boolean }) => {
    if (fail) throw new Error('No tab.');
    created.push(options);
  };
  return { created, create };
}

test('openWalletTab from the side panel opens wallet.html<route> and then closes the panel', async () => {
  const { created, create } = tabsRecorder();
  let closed = 0;
  const page = extensionPage('sidepanel');
  const chrome = { ...(page.chrome as object), tabs: { create } };
  await withGlobals({ ...page, chrome, window: { close: () => { closed++; } } }, async () => {
    assert.equal(await openWalletTab('#vault'), true);
    assert.equal(await openWalletTab(), true);
  });
  assert.deepEqual(created, [
    { url: `chrome-extension://${EXTENSION_ID}/wallet.html#vault`, active: true },
    { url: `chrome-extension://${EXTENSION_ID}/wallet.html`, active: true },
  ]);
  assert.equal(closed, 2);
});

test('openWalletTab in the full tab moves to the route instead of opening a second wallet page', async () => {
  const { created, create } = tabsRecorder();
  let closed = 0;
  const page = extensionPage('tab');
  const location = page.location as { hash: string };
  const chrome = { ...(page.chrome as object), tabs: { create } };
  await withGlobals({ ...page, chrome, window: { close: () => { closed++; } } }, async () => {
    assert.equal(await openWalletTab('#vault'), true);
  });
  assert.equal(location.hash, '#vault');
  assert.deepEqual(created, []);
  assert.equal(closed, 0);
});

test('openWalletTab keeps the panel open when Chrome does not open the tab', async () => {
  const { create } = tabsRecorder(true);
  let closed = 0;
  const page = extensionPage('sidepanel');
  const chrome = { ...(page.chrome as object), tabs: { create } };
  await withGlobals({ ...page, chrome, window: { close: () => { closed++; } } }, async () => {
    await assert.rejects(openWalletTab('#vault'), /No tab/);
  });
  assert.equal(closed, 0);
});

test('openWalletTab is false outside the extension or without the tabs API, and refuses other routes', async () => {
  assert.equal(await openWalletTab('#vault'), false);
  await withGlobals(extensionPage('sidepanel'), async () => {
    assert.equal(await openWalletTab('#vault'), false);
    await assert.rejects(openWalletTab('#vault/../../x' as `#${string}`), /Only wallet page anchors/);
    await assert.rejects(openWalletTab('#' as `#${string}`), /Only wallet page anchors/);
  });
});
