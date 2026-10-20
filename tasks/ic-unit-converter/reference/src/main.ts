import './style.css';
import { convert } from './convert';
import { formatNumber } from './format';
import { readValue } from './input';
import { categories, findCategory, findUnit } from './units';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing`);
  return el;
}

const categorySelect = element('category', HTMLSelectElement);
const valueInput = element('value', HTMLInputElement);
const valueError = element('value-error', HTMLParagraphElement);
const fromSelect = element('from', HTMLSelectElement);
const toSelect = element('to', HTMLSelectElement);
const swapButton = element('swap', HTMLButtonElement);
const result = element('result', HTMLOutputElement);

function fillUnits(categoryId: string) {
  const { units } = findCategory(categoryId);
  for (const select of [fromSelect, toSelect]) {
    select.replaceChildren(...units.map((u) => new Option(u.label, u.id)));
  }
  fromSelect.selectedIndex = 0;
  toSelect.selectedIndex = 1;
}

function showError(message: string | null) {
  valueError.textContent = message ?? '';
  valueError.hidden = message === null;
  if (message === null) valueInput.removeAttribute('aria-invalid');
  else valueInput.setAttribute('aria-invalid', 'true');
}

function update() {
  const state = readValue(valueInput.value, fromSelect.value);
  if (state.kind !== 'valid') {
    showError(state.kind === 'invalid' ? state.message : null);
    result.value = '—';
    return;
  }
  showError(null);
  const converted = convert(state.value, fromSelect.value, toSelect.value);
  result.value = `${formatNumber(converted)} ${findUnit(toSelect.value).unit.symbol}`;
}

categorySelect.replaceChildren(...categories.map((c) => new Option(c.label, c.id)));
fillUnits(categorySelect.value);

categorySelect.addEventListener('change', () => {
  fillUnits(categorySelect.value);
  update();
});
valueInput.addEventListener('input', update);
fromSelect.addEventListener('change', update);
toSelect.addEventListener('change', update);
swapButton.addEventListener('click', () => {
  const from = fromSelect.value;
  fromSelect.value = toSelect.value;
  toSelect.value = from;
  update();
});

update();
