/** Integer extraction answers have no three-digit limit or implicit rounding. */
export function isPortalInteger(value: string) {
  return /^[+-]?[0-9]{1,100}$/.test(value);
}

export function isPortalNumber(value: string) {
  return value.length <= 120 && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value) && Number.isFinite(Number(value));
}
