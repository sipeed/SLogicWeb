import { t } from './i18n.js';

export function helpTip(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'help-tip';
  b.textContent = '?';
  b.title = text;
  b.setAttribute('aria-label', `${t('capturePanel.moreInfo')}: ${text}`);
  return b;
}
