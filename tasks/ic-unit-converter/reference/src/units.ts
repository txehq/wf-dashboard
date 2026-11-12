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
    label: 'Length',
    minBase: 0,
    minMessage: 'Length and weight cannot be negative',
    units: [
      linear('m', 'Metre (m)', 'm', 1),
      linear('cm', 'Centimetre (cm)', 'cm', 0.01),
      linear('km', 'Kilometre (km)', 'km', 1000),
      linear('in', 'Inch (in)', 'in', 0.0254),
      linear('ft', 'Foot (ft)', 'ft', 0.3048),
      linear('mi', 'Mile (mi)', 'mi', 1609.344),
    ],
  },
  {
    id: 'weight',
    label: 'Weight',
    minBase: 0,
    minMessage: 'Length and weight cannot be negative',
    units: [
      linear('g', 'Gram (g)', 'g', 1),
      linear('kg', 'Kilogram (kg)', 'kg', 1000),
      linear('oz', 'Ounce (oz)', 'oz', 28.349523125),
      linear('lb', 'Pound (lb)', 'lb', 453.59237),
    ],
  },
  {
    id: 'temperature',
    label: 'Temperature',
    minBase: 0,
    minMessage: 'Temperature cannot be below absolute zero',
    units: [
      {
        id: 'c',
        label: 'Celsius (°C)',
        symbol: '°C',
        toBase: (value) => value + 273.15,
        fromBase: (value) => value - 273.15,
      },
      {
        id: 'f',
        label: 'Fahrenheit (°F)',
        symbol: '°F',
        toBase: (value) => ((value + 459.67) * 5) / 9,
        fromBase: (value) => (value * 9) / 5 - 459.67,
      },
      {
        id: 'k',
        label: 'Kelvin (K)',
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
