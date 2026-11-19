import { t } from './i18n.js';

export function setHelpTipText(b: HTMLButtonElement, text: string): void {
  b.title = text;
  b.setAttribute('aria-label', `${t('capturePanel.moreInfo')}: ${text}`);
}

export function helpTip(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'help-tip';
  b.textContent = '?';
  setHelpTipText(b, text);
  return b;
}
