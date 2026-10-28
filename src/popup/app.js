'use strict';

const api = window.fixedSitesPopup;
const address = document.getElementById('popup-address-value');
const status = document.getElementById('popup-status');
const buttons = new Map([...document.querySelectorAll('[data-action]')].map((button) => [button.dataset.action, button]));
let copyMessageTimer = 0;
let currentState = {};

function render(next) {
  if (next) currentState = next;
  const state = currentState;
  const currentUrl = String(state.currentUrl || '');
  address.textContent = currentUrl || (state.loading ? '正在打开…' : '当前页面没有地址');
  address.title = currentUrl || '';
  buttons.get('back').disabled = !state.canGoBack;
  buttons.get('forward').disabled = !state.canGoForward;
  buttons.get('reload').disabled = !currentUrl;
  buttons.get('copy').disabled = !currentUrl;
  buttons.get('external').disabled = !state.externalUrlAllowed;
  status.textContent = state.error || (state.loading ? '加载中…' : '');
  status.classList.toggle('is-error', Boolean(state.error));
  status.classList.toggle('is-loading', Boolean(state.loading && !state.error));
}

async function act(action) {
  const button = buttons.get(action);
  if (!button || button.disabled) return;
  try {
    const result = action === 'copy' ? await api.copyUrl() :
      action === 'external' ? await api.openExternal() : await api.navigate(action);
    if (result?.ok === false) {
      status.textContent = result.error || '操作失败';
      status.classList.add('is-error');
      return;
    }
    if (action === 'copy') {
      status.textContent = '已复制地址';
      status.classList.remove('is-error');
      clearTimeout(copyMessageTimer);
      copyMessageTimer = setTimeout(() => render(), 1500);
    }
  } catch (error) {
    status.textContent = error?.message || '操作失败';
    status.classList.add('is-error');
  }
}

for (const [action, button] of buttons) button.addEventListener('click', () => act(action));
api.onStateChanged(render);
api.getState().then(render).catch(() => render({ error: '网页窗口状态不可读取。' }));
