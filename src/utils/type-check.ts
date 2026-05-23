export const isArray = (val: unknown): val is unknown[] => {
  return Array.isArray(val);
};

export const isObject = (val: unknown): val is Record<string, unknown> => {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
};

export const isString = (val: unknown): val is string => {
  return typeof val === 'string';
};

export const isNumber = (val: unknown): val is number => {
  return typeof val === 'number';
};

export const isBoolean = (val: unknown): val is boolean => {
  return typeof val === 'boolean';
};
