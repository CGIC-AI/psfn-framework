const AUTH_SALT = hexBytes('112233332211');
const STOCK_LINK_KEY = hexBytes('06775f87918dd423005df1d8cf0c142b');
const AUTH_PASS = new TextEncoder().encode('pass');
const AUTH_TIMEOUT_MS = 6_000;
const MIXED_OPERATION_MASK = 0x9999;

// Recovered from BagiBagi's arm64 libjl_bluetooth.so function_E1test. Keeping
// this implementation local means auth material never crosses the network or
// enters browser storage.
const KEY_SCHEDULE_CONSTANTS = hexBytes(
  '64ac285ac9b337c50a10b7a3bab19746' +
  '3d05dc666ef69af80d589567c6aaabec' +
  'a0689b96d4ebbf434936e96a89d8c38a' +
  '946399bc7bbec122bb5c71d51f92575d' +
  '8f44411d51e64017fbfd193234b8612a' +
  'ca236fda39f7a2017fd631e7de8004dd' +
  '2c5982afa8e00fcda1123e30d11cd03a' +
  '33722e4f9002130675ce87c2efb2ad7d' +
  '3815e1529f7a6c2f27c4e281a9cf8dc0' +
  'd7dfff6076148c5e5509e408c74220fc' +
  'd25091d94c629ee8b9a6f91a00210bfa' +
  '359c4e4b6948cb0ec8a45bea8407b418' +
  'f4ae6bdba7cc3f8b4a0c3c25e5544d45' +
  '83ed11f0b05393f27426b59d6d7cf32d' +
  'f156247e471b86bd708e1e3b731603b6' +
  'ac285ac9b337c50a10b7a3bab1974688',
);

const MASKED_SUBSTITUTION = hexBytes(
  '012de293be4515ae780387a4b838cf3f' +
  '08670994eb26a86bbd18341bbbbf72f7' +
  '4035489c512f3b55e3c09fd8d3f38db1' +
  'ffa73edc8677d7a611fbf4ba92916483' +
  'f133efda2cb5b22b88d199cb8c841d14' +
  '819771ca5fa38b573c82c4525c1ce8a0' +
  '04b4854af61354b6df0c1a8edee039fc' +
  '209b244ea9989eabf260d06ceafac7d9' +
  '00d41f6e43bcec5389fe7a5d49c932c2' +
  'f99af86d16db599644e9cde646428f0a' +
  'c1ccb965b0d2c6ac1e4162292e0e7450' +
  '025ac3257b8a2a5bf0060d476f709d7e' +
  '10ce1227d54c4fd679306836757de4ed' +
  '806a9037a25e76aac57f3dafa5e51961' +
  'fd4d7cb70beead4b22f5e7732321c805' +
  'e166ddb3586963560fa1319517073a28',
);

const UNMASKED_SUBSTITUTION = hexBytes(
  '8000b00960efb9fd10129fe469baadf8' +
  'c038c2654f0694fc19de6a1b5d4ea882' +
  '70ede8ec72b315c3ffabb6474401ac25' +
  'c9fa8e411a21cbd30d6efe2658da320f' +
  '20a99d8498059cbb228c63e7c5e173c6' +
  'af245b876627f757f496b1b75c8bd554' +
  '79dfaaf63ea3f111caf5d1177b9383bc' +
  'bd521eebaeccd63508c88ab4e2cdbfd9' +
  'd050593f4d62340a4888b5564c2e6b9e' +
  'd23d3c0313fb9751754a917123be762a' +
  '5ff9d4550bdc37311674d777a7e607db' +
  'a42f46f3614567e30ca23b1c8518041d' +
  '29a08fb25ad8a67eee8d534ba19ac10e' +
  '7a49a52c81c4c7362b7f439533f26c68' +
  '6df00228cedd9bea5e997c1486cfe542' +
  'b840782d3ae9641f92907d396fe08930',
);

export interface Z02AuthIo {
  write(value: Uint8Array): Promise<void>;
  nextNotification(timeoutMs: number): Promise<Uint8Array>;
}

export interface Z02AuthOptions {
  randomBytes?: () => Uint8Array;
  timeoutMs?: number;
}

export function createStockAuthInitCommand(): Uint8Array {
  return Uint8Array.of(0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x00, 0x01, 0xef);
}

export async function authenticateStockZ02(
  io: Z02AuthIo,
  options: Z02AuthOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  const hostChallenge = (options.randomBytes ?? secureRandomChallenge)();
  requireBlock(hostChallenge, 'auth challenge');

  await io.write(createStockAuthInitCommand());
  await io.write(withPrefix(0x00, hostChallenge));

  const deviceProof = await waitForAuthMessage(io, 0x01, 16, timeoutMs);
  if (!equalBytes(deviceProof, computeStockAuthProof(hostChallenge))) {
    throw new Error('Z02 authentication failed');
  }

  await io.write(withPrefix(0x02, AUTH_PASS));
  const deviceChallenge = await waitForAuthMessage(io, 0x00, 16, timeoutMs);
  await io.write(withPrefix(0x01, computeStockAuthProof(deviceChallenge)));

  const pass = await waitForAuthMessage(io, 0x02, AUTH_PASS.length, timeoutMs);
  if (!equalBytes(pass, AUTH_PASS)) {
    throw new Error('Z02 authentication failed');
  }
}

export function computeStockAuthProof(challenge: Uint8Array): Uint8Array {
  requireBlock(challenge, 'auth challenge');

  const firstPass = encryptBlock(challenge, expandKey(STOCK_LINK_KEY), false);
  const mixed = new Uint8Array(16);
  for (let index = 0; index < mixed.length; index += 1) {
    mixed[index] = (
      byteAt(AUTH_SALT, index % AUTH_SALT.length)
      + (byteAt(firstPass, index) ^ byteAt(challenge, index))
    ) & 0xff;
  }

  return encryptBlock(mixed, expandKey(transformLinkKey(STOCK_LINK_KEY)), true);
}

async function waitForAuthMessage(
  io: Z02AuthIo,
  type: number,
  payloadLength: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await io.nextNotification(Math.max(1, deadline - Date.now()));
    if (message[0] === type && message.length === payloadLength + 1) return message.slice(1);
  }
  throw new Error('Z02 authentication timed out');
}

function secureRandomChallenge(): Uint8Array {
  const value = new Uint8Array(16);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function expandKey(key: Uint8Array): Uint8Array {
  requireBlock(key, 'link key');
  const schedule = new Uint8Array(17 * 16);
  schedule.set(key);
  const rotated = key.slice();
  let parity = 0;
  for (const keyByte of key) parity ^= keyByte;

  for (let round = 1; round <= 16; round += 1) {
    for (let index = 0; index < rotated.length; index += 1) {
      rotated[index] = rotateLeft3(byteAt(rotated, index));
    }
    parity = rotateLeft3(parity);

    let rotatedIndex = round;
    const constantOffset = (round - 1) * 16;
    for (let index = 0; index < 16; index += 1) {
      const rotatedByte = rotatedIndex === 16 ? parity : byteAt(rotated, rotatedIndex);
      const constant = byteAt(KEY_SCHEDULE_CONSTANTS, constantOffset + 15 - index);
      schedule[round * 16 + index] = (rotatedByte + constant) & 0xff;
      rotatedIndex = rotatedIndex > 15 ? 0 : rotatedIndex + 1;
    }
  }
  return schedule;
}

function encryptBlock(input: Uint8Array, schedule: Uint8Array, mixInput: boolean): Uint8Array {
  let state: Uint8Array = input.slice();
  const original = input.slice();

  for (let round = 0; round < 8; round += 1) {
    if (mixInput && round === 2) combine(state, original, false);
    const keyOffset = round * 32;
    combine(state, schedule.subarray(keyOffset, keyOffset + 16), false);

    for (let index = 0; index < 16; index += 1) {
      const substitution = isMasked(index) ? MASKED_SUBSTITUTION : UNMASKED_SUBSTITUTION;
      state[index] = byteAt(substitution, byteAt(state, index));
    }

    combine(state, schedule.subarray(keyOffset + 16, keyOffset + 32), true);
    state = diffuse(state);
  }

  combine(state, schedule.subarray(256, 272), false);
  return state;
}

function combine(state: Uint8Array, operand: Uint8Array, reverse: boolean): void {
  for (let index = 0; index < 16; index += 1) {
    const add = isMasked(index) === reverse;
    const stateByte = byteAt(state, index);
    const operandByte = byteAt(operand, index);
    state[index] = add ? (stateByte + operandByte) & 0xff : stateByte ^ operandByte;
  }
}

function diffuse(state: Uint8Array): Uint8Array {
  const p01x2 = byteAt(state, 1) + 2 * byteAt(state, 0);
  const p01 = byteAt(state, 1) + byteAt(state, 0);
  const p23x2 = byteAt(state, 3) + 2 * byteAt(state, 2);
  const p23 = byteAt(state, 3) + byteAt(state, 2);
  const p45x2 = byteAt(state, 5) + 2 * byteAt(state, 4);
  const p45 = byteAt(state, 5) + byteAt(state, 4);
  const p67x2 = byteAt(state, 7) + 2 * byteAt(state, 6);
  const p67 = byteAt(state, 7) + byteAt(state, 6);
  const p89x2 = byteAt(state, 9) + 2 * byteAt(state, 8);
  const p89 = byteAt(state, 9) + byteAt(state, 8);
  const p1011x2 = byteAt(state, 11) + 2 * byteAt(state, 10);
  const p1011 = byteAt(state, 11) + byteAt(state, 10);
  const p1213x2 = byteAt(state, 13) + 2 * byteAt(state, 12);
  const p1213 = byteAt(state, 13) + byteAt(state, 12);
  const p1415x2 = byteAt(state, 15) + 2 * byteAt(state, 14);
  const p1415 = byteAt(state, 15) + byteAt(state, 14);

  // This is the native routine's straight-line diffusion graph. Names retain
  // the contributing byte lanes; `x2` identifies its asymmetric coefficient.
  const mix23From45 = p23 + 2 * p45x2;
  const mix1415From1213 = p1415 + 2 * p1213x2;
  const mix1011From89 = p1011 + 2 * p89x2;
  const sum1011And89x2 = p1011 + p89x2;
  const sum1415And1213x2 = p1415 + p1213x2;
  const mix1213From1415 = p1213 + 2 * p1415x2;
  const sum1011x2And89 = p1011x2 + p89;
  const mix45From67 = p45 + 2 * p67x2;
  const sum67x2And45 = p67x2 + p45;
  const sum67And01x2 = p67 + p01x2;
  const mix01From23 = p01 + 2 * p23x2;
  const upperCrossMix = sum1011x2And89 + 2 * mix1213From1415;
  const mix67From01 = p67 + 2 * p01x2;
  const lowerCrossSum = sum67And01x2 + mix23From45;
  const mix89From1011 = p89 + 2 * p1011x2;
  const sum45x2And23 = p45x2 + p23;
  const sum1415x2And1213 = p1415x2 + p1213;

  return Uint8Array.from([
    lowerCrossSum + 2 * upperCrossMix,
    upperCrossMix + lowerCrossSum,
    sum1415And1213x2 + mix01From23 + 2 * (sum67x2And45 + 2 * mix1011From89),
    sum1415And1213x2 + mix01From23 + sum67x2And45 + 2 * mix1011From89,
    sum1415x2And1213 + mix89From1011 + 2 * (sum45x2And23 + 2 * mix67From01),
    sum1415x2And1213 + mix89From1011 + sum45x2And23 + 2 * mix67From01,
    mix1415From1213 + sum1011And89x2 + 2 * (p23x2 + p01 + 2 * mix45From67),
    mix1415From1213 + sum1011And89x2 + p23x2 + p01 + 2 * mix45From67,
    mix1213From1415 + sum1011x2And89 + 2 * (sum67And01x2 + 2 * mix23From45),
    mix1213From1415 + sum1011x2And89 + sum67And01x2 + 2 * mix23From45,
    mix1011From89 + sum67x2And45 + 2 * (sum1415And1213x2 + 2 * mix01From23),
    sum1415And1213x2 + 2 * mix01From23 + mix1011From89 + sum67x2And45,
    mix45From67 + p23x2 + p01 + 2 * (sum1415x2And1213 + 2 * mix89From1011),
    sum1415x2And1213 + 2 * mix89From1011 + mix45From67 + p23x2 + p01,
    mix67From01 + sum45x2And23 + 2 * (sum1011And89x2 + 2 * mix1415From1213),
    sum1011And89x2 + 2 * mix1415From1213 + mix67From01 + sum45x2And23,
  ], value => value & 0xff);
}

function transformLinkKey(key: Uint8Array): Uint8Array {
  return Uint8Array.of(
    byteAt(key, 0) - 0x17,
    byteAt(key, 1) ^ 0xe5,
    byteAt(key, 2) - 0x21,
    byteAt(key, 3) ^ 0xc1,
    byteAt(key, 4) - 0x4d,
    byteAt(key, 5) ^ 0xa7,
    byteAt(key, 6) - 0x6b,
    byteAt(key, 7) ^ 0x83,
    byteAt(key, 8) ^ 0xe9,
    byteAt(key, 9) - 0x1b,
    byteAt(key, 10) ^ 0xdf,
    byteAt(key, 11) - 0x3f,
    byteAt(key, 12) ^ 0xb3,
    byteAt(key, 13) - 0x59,
    byteAt(key, 14) ^ 0x95,
    byteAt(key, 15) - 0x7d,
  );
}

function withPrefix(prefix: number, value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = prefix;
  result.set(value, 1);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= byteAt(left, index) ^ byteAt(right, index);
  }
  return difference === 0;
}

function isMasked(index: number): boolean {
  return (MIXED_OPERATION_MASK & (1 << index)) !== 0;
}

function rotateLeft3(value: number): number {
  return ((value << 3) | (value >>> 5)) & 0xff;
}

function requireBlock(value: Uint8Array, name: string): void {
  if (value.length !== 16) throw new Error(`${name} must be 16 bytes`);
}

function byteAt(value: Uint8Array, index: number): number {
  const result = value[index];
  if (result === undefined) throw new Error('Z02 cipher table index is out of bounds');
  return result;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}
