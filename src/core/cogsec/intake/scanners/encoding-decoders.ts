const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase32(value: string): Buffer | null {
  const clean = value.toUpperCase().replace(/=+$/u, '');
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of clean) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xFF);
      accumulator &= (1 << bits) - 1;
    }
  }
  return Buffer.from(output);
}

export function decodeBase58(value: string): Buffer | null {
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    decoded = (decoded * 58n) + BigInt(digit);
  }
  let hex = decoded.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const body = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const leadingZeroes = value.match(/^1{1,2048}/u)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

export function decodeAscii85(value: string): Buffer | null {
  const clean = value.replace(/^<~/u, '').replace(/~>$/u, '').replace(/\s/gu, '');
  const output: number[] = [];
  let group = '';
  const flush = (candidate: string, final: boolean): boolean => {
    const originalLength = candidate.length;
    const padded = candidate.padEnd(5, 'u');
    let number = 0;
    for (const character of padded) {
      const digit = character.charCodeAt(0) - 33;
      if (digit < 0 || digit > 84) return false;
      number = (number * 85) + digit;
    }
    if (number > 0xFFFFFFFF) return false;
    const bytes = [
      Math.floor(number / 0x1000000) & 0xFF,
      Math.floor(number / 0x10000) & 0xFF,
      Math.floor(number / 0x100) & 0xFF,
      number & 0xFF,
    ];
    output.push(...bytes.slice(0, final ? originalLength - 1 : 4));
    return true;
  };
  for (const character of clean) {
    if (character === 'z' && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    group += character;
    if (group.length === 5) {
      if (!flush(group, false)) return null;
      group = '';
    }
  }
  if (group.length === 1 || (group.length > 1 && !flush(group, true))) return null;
  return Buffer.from(output);
}

export function decodeUtf7(value: string): Buffer | null {
  const encoded = value.slice(1, -1).replace(/,/gu, '/');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  let text = '';
  for (let index = 0; index < bytes.length; index += 2) {
    text += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
  }
  return Buffer.from(text, 'utf8');
}

export function rotateAscii(text: string, amount: number): string {
  let output = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      output += String.fromCharCode(((code - 65 - amount + 26) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      output += String.fromCharCode(((code - 97 - amount + 26) % 26) + 97);
    } else {
      output += character;
    }
  }
  return output;
}

export function decodeAtbash(text: string): string {
  let output = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) output += String.fromCharCode(90 - (code - 65));
    else if (code >= 97 && code <= 122) output += String.fromCharCode(122 - (code - 97));
    else output += character;
  }
  return output;
}
