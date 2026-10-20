export type CategoryId = 'length' | 'weight' | 'temperature';

export interface Unit {
  id: string;
  label: string;
  symbol: string;
  // Convert a value of this unit to the category's base unit (metre, gram, kelvin) and back.
  toBase: (value: number) => number;
  fromBase: (value: number) => number;
}

export interface Category {
  id: CategoryId;
  label: string;
  // Smallest allowed value, in the base unit.
  minBase: number;
  minMessage: string;
  units: Unit[];
}

function linear(id: string, label: string, symbol: string, factor: number): Unit {
  return {
    id,
    label,
    symbol,
    toBase: (value) => value * factor,
    fromBase: (value) => value / factor,
  };
}

export const categories: Category[] = [
  {
    id: 'length',
    label: '长度',
    minBase: 0,
    minMessage: '长度和重量不能为负数',
    units: [
      linear('m', '米 (m)', 'm', 1),
      linear('cm', '厘米 (cm)', 'cm', 0.01),
      linear('km', '千米 (km)', 'km', 1000),
      linear('in', '英寸 (in)', 'in', 0.0254),
      linear('ft', '英尺 (ft)', 'ft', 0.3048),
      linear('mi', '英里 (mi)', 'mi', 1609.344),
    ],
  },
  {
    id: 'weight',
    label: '重量',
    minBase: 0,
    minMessage: '长度和重量不能为负数',
    units: [
      linear('g', '克 (g)', 'g', 1),
      linear('kg', '千克 (kg)', 'kg', 1000),
      linear('oz', '盎司 (oz)', 'oz', 28.349523125),
      linear('lb', '磅 (lb)', 'lb', 453.59237),
    ],
  },
  {
    id: 'temperature',
    label: '温度',
    minBase: 0,
    minMessage: '温度不能低于绝对零度',
    units: [
      {
        id: 'c',
        label: '摄氏度 (°C)',
        symbol: '°C',
        toBase: (value) => value + 273.15,
        fromBase: (value) => value - 273.15,
      },
      {
        id: 'f',
        label: '华氏度 (°F)',
        symbol: '°F',
        toBase: (value) => ((value + 459.67) * 5) / 9,
        fromBase: (value) => (value * 9) / 5 - 459.67,
      },
      {
        id: 'k',
        label: '开尔文 (K)',
        symbol: 'K',
        toBase: (value) => value,
        fromBase: (value) => value,
      },
    ],
  },
];

export function findCategory(id: string): Category {
  const category = categories.find((c) => c.id === id);
  if (!category) throw new Error(`unknown category: ${id}`);
  return category;
}

export function findUnit(id: string): { category: Category; unit: Unit } {
  for (const category of categories) {
    const unit = category.units.find((u) => u.id === id);
    if (unit) return { category, unit };
  }
  throw new Error(`unknown unit: ${id}`);
}
