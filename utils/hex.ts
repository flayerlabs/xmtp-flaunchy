export function numToHex(num: number): `0x${string}` {
  return `0x${num.toString(16).toUpperCase()}`;
}
