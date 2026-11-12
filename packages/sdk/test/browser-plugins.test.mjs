import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startBrowserPlugins } from '../src/browser-plugins.ts';

const disabled = { replay: false, logs: false, pageEvents: false, rageClick: false };

function browserGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test('logs omit object contents and restore the original console on shutdown', t => {
  const original = t.mock.method(console, 'log', () => {});
  const emit = t.mock.fn();
  const stop = startBrowserPlugins({ ...disabled, logs: true }, emit);
  t.after(stop);
  console.log('sample', 12, { private: 'hidden' });
  assert.deepEqual(emit.mock.calls[0].arguments, ['log', 'sample 12 [object]', { kind: 'console', level: 'log' }]);
  assert.equal(original.mock.callCount(), 1);
  stop();
  assert.equal(console.log, original);
  console.log('after disable');
  assert.equal(emit.mock.callCount(), 1);
});

test('disabled sensors leave the console unchanged and allow repeated cleanup', () => {
  const original = console.warn;
  const stop = startBrowserPlugins(disabled, () => assert.fail('unexpected event'));
  stop();
  stop();
  assert.equal(console.warn, original);
});

test('navigation omits query data and stops recording after cleanup', t => {
  const window = new EventTarget();
  const history = { pushState() {}, replaceState() {} };
  browserGlobal(t, 'window', window);
  browserGlobal(t, 'history', history);
  browserGlobal(t, 'location', { pathname: '/checkout', search: '?secret=hidden' });
  const original = history.pushState;
  const emit = t.mock.fn();
  const stop = startBrowserPlugins({ ...disabled, pageEvents: true }, emit);
  t.after(stop);
  history.pushState();
  window.dispatchEvent(new Event('popstate'));
  assert.equal(emit.mock.callCount(), 3);
  for (const call of emit.mock.calls) {
    assert.deepEqual(call.arguments, ['trace', 'Page view', { kind: 'page_view', path: '/checkout' }]);
  }
  stop();
  assert.equal(history.pushState, original);
  window.dispatchEvent(new Event('popstate'));
  assert.equal(emit.mock.callCount(), 3);
});

test('three clustered clicks produce one event and cleanup removes the listener', t => {
  class Button extends EventTarget { tagName = 'BUTTON'; }
  const button = new Button();
  browserGlobal(t, 'document', button);
  browserGlobal(t, 'Element', Button);
  browserGlobal(t, 'location', { pathname: '/checkout' });
  const emit = t.mock.fn();
  const stop = startBrowserPlugins({ ...disabled, rageClick: true }, emit);
  t.after(stop);
  const click = () => button.dispatchEvent(Object.assign(new Event('click'), { clientX: 20, clientY: 30 }));
  click();
  click();
  assert.equal(emit.mock.callCount(), 0);
  click();
  assert.deepEqual(emit.mock.calls[0].arguments, ['trace', 'Rage click', { kind: 'rage_click', path: '/checkout', tag: 'button', clicks: 3 }]);
  stop();
  click();
  click();
  click();
  assert.equal(emit.mock.callCount(), 1);
});
